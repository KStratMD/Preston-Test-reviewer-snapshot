import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import type { MDMRepository } from '../../database/repositories/MDMRepository';
import type { MDMSurvivorshipRuleRow } from '../../database/types';

/**
 * Survivorship Rule Engine
 *
 * Golden Record MDM - Determines which source system is authoritative for each field.
 *
 * Rule Types:
 * - source_priority: Prefer values from specific systems
 * - most_recent: Use the most recently updated value
 * - most_complete: Use the value with most data
 * - frequency: Use the most common value
 * - custom: User-defined logic
 */

export type SurvivorshipStrategy =
    | 'source_priority'
    | 'most_recent'
    | 'most_complete'
    | 'frequency'
    | 'custom';

export interface SurvivorshipRule {
    id: string;
    entityType: 'vendor' | 'customer' | 'product' | '*';
    fieldName: string;
    strategy: SurvivorshipStrategy;
    config?: {
        sourcePriority?: string[]; // For source_priority
        customFn?: string;          // For custom (function name)
    };
    priority: number;
}

export interface FieldValue {
    value: unknown;
    sourceSystem: string;
    updatedAt?: Date;
    confidence?: number;
}

export interface SurvivorshipResult {
    field: string;
    selectedValue: unknown;
    selectedSource: string;
    reason: string;
    alternativeValues: FieldValue[];
    hasConflict: boolean;
}

// Default survivorship rules
const DEFAULT_RULES: SurvivorshipRule[] = [
    // Vendor rules
    { id: 'v-name', entityType: 'vendor', fieldName: 'name', strategy: 'most_complete', priority: 1 },
    { id: 'v-email', entityType: 'vendor', fieldName: 'email', strategy: 'most_recent', priority: 2 },
    { id: 'v-phone', entityType: 'vendor', fieldName: 'phone', strategy: 'most_recent', priority: 2 },
    { id: 'v-address', entityType: 'vendor', fieldName: 'address', strategy: 'most_complete', priority: 3 },
    { id: 'v-taxId', entityType: 'vendor', fieldName: 'taxId', strategy: 'source_priority', config: { sourcePriority: ['netsuite', 'bc'] }, priority: 1 },

    // Customer rules
    { id: 'c-name', entityType: 'customer', fieldName: 'name', strategy: 'most_complete', priority: 1 },
    { id: 'c-email', entityType: 'customer', fieldName: 'email', strategy: 'most_recent', priority: 2 },
    { id: 'c-phone', entityType: 'customer', fieldName: 'phone', strategy: 'most_recent', priority: 2 },
    { id: 'c-creditLimit', entityType: 'customer', fieldName: 'creditLimit', strategy: 'source_priority', config: { sourcePriority: ['netsuite'] }, priority: 1 },

    // Product rules
    { id: 'p-name', entityType: 'product', fieldName: 'name', strategy: 'most_complete', priority: 1 },
    { id: 'p-sku', entityType: 'product', fieldName: 'sku', strategy: 'source_priority', config: { sourcePriority: ['netsuite', 'bc'] }, priority: 1 },
    { id: 'p-price', entityType: 'product', fieldName: 'price', strategy: 'source_priority', config: { sourcePriority: ['netsuite'] }, priority: 1 },
    { id: 'p-description', entityType: 'product', fieldName: 'description', strategy: 'most_complete', priority: 2 },

    // Fallback for all entity types
    { id: 'default', entityType: '*', fieldName: '*', strategy: 'most_recent', priority: 999 }
];

@injectable()
export class SurvivorshipRuleEngine {
    private rules = new Map<string, SurvivorshipRule>();
    private logger: Logger;
    private mdmRepository?: MDMRepository;
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    constructor(
        @inject(TYPES.Logger) logger: Logger,
        @inject(TYPES.MDMRepository) @optional() mdmRepository?: MDMRepository
    ) {
        this.logger = logger;
        this.mdmRepository = mdmRepository;
        this.initializeDefaultRules();
        this.logger.info('[Survivorship] Rule engine initialized', {
            ruleCount: this.rules.size
        });
    }

    /**
     * Load rules from database on first use. Falls back to in-memory defaults
     * if no DB is available or the DB load fails.
     */
    async ensureInitialized(): Promise<void> {
        if (this.initialized || !this.mdmRepository) return;
        // Shared promise prevents concurrent loads from racing
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInitialize();
        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    private async doInitialize(): Promise<void> {
        try {
            const rows = await this.mdmRepository!.listSurvivorshipRules();
            if (rows.length > 0) {
                this.rules.clear();
                for (const row of rows) {
                    this.rules.set(row.id, this.rowToRule(row));
                }
            } else {
                this.logger.warn('[Survivorship] No rules in DB, keeping in-memory defaults');
            }
            this.initialized = true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn('[Survivorship] DB load failed, will retry on next call', { error: message });
            // Do NOT set initialized = true — allow retry on next call
        }
    }

    /**
     * Apply survivorship rules to determine the winning value for a field
     */
    applyRule(
        entityType: string,
        fieldName: string,
        values: FieldValue[]
    ): SurvivorshipResult {
        if (values.length === 0) {
            return {
                field: fieldName,
                selectedValue: null,
                selectedSource: 'none',
                reason: 'No values provided',
                alternativeValues: [],
                hasConflict: false
            };
        }

        if (values.length === 1) {
            return {
                field: fieldName,
                selectedValue: values[0].value,
                selectedSource: values[0].sourceSystem,
                reason: 'Only one source',
                alternativeValues: [],
                hasConflict: false
            };
        }

        // Find applicable rule
        const rule = this.findRule(entityType, fieldName);

        // Apply the strategy
        const result = this.executeStrategy(rule, values);

        // Override field name with actual field (wildcard rules have '*' as fieldName)
        result.field = fieldName;

        this.logger.debug('[Survivorship] Rule applied', {
            entityType,
            fieldName,
            strategy: rule.strategy,
            selectedSource: result.selectedSource
        });

        return result;
    }

    /**
     * Apply survivorship to merge multiple entity records
     */
    mergeEntities(
        entityType: string,
        entities: { sourceSystem: string; data: Record<string, unknown>; updatedAt?: Date }[]
    ): { mergedData: Record<string, unknown>; conflicts: SurvivorshipResult[] } {
        const allFields = new Set<string>();
        const conflicts: SurvivorshipResult[] = [];
        const mergedData: Record<string, unknown> = {};

        // Collect all fields
        for (const entity of entities) {
            Object.keys(entity.data).forEach(f => allFields.add(f));
        }

        // Apply survivorship to each field
        for (const fieldName of allFields) {
            const values: FieldValue[] = entities
                .filter(e => e.data[fieldName] !== undefined)
                .map(e => ({
                    value: e.data[fieldName],
                    sourceSystem: e.sourceSystem,
                    updatedAt: e.updatedAt
                }));

            const result = this.applyRule(entityType, fieldName, values);
            mergedData[fieldName] = result.selectedValue;

            if (result.hasConflict) {
                conflicts.push(result);
            }
        }

        this.logger.info('[Survivorship] Entities merged', {
            entityType,
            sourceCount: entities.length,
            fieldCount: allFields.size,
            conflictCount: conflicts.length
        });

        return { mergedData, conflicts };
    }

    /**
     * Get all rules for an entity type
     */
    async getRules(entityType?: string): Promise<SurvivorshipRule[]> {
        await this.ensureInitialized();
        const rules = Array.from(this.rules.values());
        if (!entityType) return rules;
        return rules.filter(r => r.entityType === entityType || r.entityType === '*');
    }

    /**
     * Add or update a rule (write-through: DB + cache)
     */
    async setRule(rule: SurvivorshipRule): Promise<void> {
        await this.ensureInitialized();
        if (this.mdmRepository) {
            // Preserve is_default status for existing rules (seeded defaults stay protected)
            const existing = await this.mdmRepository.findSurvivorshipRuleById(rule.id);
            const isDefault = existing ? existing.is_default : 0;
            await this.mdmRepository.upsertSurvivorshipRule({
                id: rule.id,
                entity_type: rule.entityType,
                field_name: rule.fieldName,
                strategy: rule.strategy,
                config: rule.config || {},
                priority: rule.priority,
                is_default: isDefault,
            });
        }
        this.rules.set(rule.id, rule);
        this.logger.info('[Survivorship] Rule updated', { ruleId: rule.id });
    }

    /**
     * Remove a rule. Returns a discriminated result for proper HTTP status mapping.
     */
    async removeRule(ruleId: string): Promise<'deleted' | 'not_found' | 'is_default'> {
        await this.ensureInitialized();
        if (this.mdmRepository) {
            const existing = await this.mdmRepository.findSurvivorshipRuleById(ruleId);
            if (!existing) return 'not_found';
            if (existing.is_default === 1) return 'is_default';
            const deletedInDb = await this.mdmRepository.deleteSurvivorshipRule(ruleId);
            if (!deletedInDb) return 'not_found';
            this.rules.delete(ruleId);
            this.logger.info('[Survivorship] Rule removed', { ruleId });
            return 'deleted';
        }
        // In-memory mode (no repo)
        const deleted = this.rules.delete(ruleId);
        if (deleted) {
            this.logger.info('[Survivorship] Rule removed', { ruleId });
            return 'deleted';
        }
        return 'not_found';
    }

    // ==================== Private Methods ====================

    private initializeDefaultRules(): void {
        for (const rule of DEFAULT_RULES) {
            this.rules.set(rule.id, rule);
        }
    }

    /**
     * Convert a DB row (snake_case) to a domain SurvivorshipRule (camelCase)
     */
    private rowToRule(row: MDMSurvivorshipRuleRow): SurvivorshipRule {
        const config = row.config as Record<string, unknown>;
        return {
            id: row.id,
            entityType: row.entity_type as SurvivorshipRule['entityType'],
            fieldName: row.field_name,
            strategy: row.strategy as SurvivorshipStrategy,
            config: Object.keys(config).length > 0 ? config as SurvivorshipRule['config'] : undefined,
            priority: row.priority,
        };
    }

    private findRule(entityType: string, fieldName: string): SurvivorshipRule {
        // Collect candidates at each specificity tier, pick lowest priority number
        // (lower priority = higher precedence).  This makes tie-breaking
        // deterministic even when multiple rules share (entity_type, field_name).

        // Tier 1: exact match on both entity + field
        const exact = this.collectCandidates(
            r => r.entityType === entityType && r.fieldName === fieldName
        );
        if (exact) return exact;

        // Tier 2: exact entity, wildcard field
        const wildcardField = this.collectCandidates(
            r => r.entityType === entityType && r.fieldName === '*'
        );
        if (wildcardField) return wildcardField;

        // Tier 3: wildcard entity, exact field
        const wildcardEntity = this.collectCandidates(
            r => r.entityType === '*' && r.fieldName === fieldName
        );
        if (wildcardEntity) return wildcardEntity;

        // Tier 4: default rule
        return this.rules.get('default') || DEFAULT_RULES[DEFAULT_RULES.length - 1];
    }

    /** Return the lowest-priority-number rule that matches predicate, or null. */
    private collectCandidates(
        predicate: (r: SurvivorshipRule) => boolean
    ): SurvivorshipRule | null {
        let best: SurvivorshipRule | null = null;
        for (const rule of this.rules.values()) {
            if (predicate(rule) && (best === null || rule.priority < best.priority)) {
                best = rule;
            }
        }
        return best;
    }

    private executeStrategy(rule: SurvivorshipRule, values: FieldValue[]): SurvivorshipResult {
        switch (rule.strategy) {
            case 'source_priority':
                return this.strategySourcePriority(rule, values);

            case 'most_recent':
                return this.strategyMostRecent(rule, values);

            case 'most_complete':
                return this.strategyMostComplete(rule, values);

            case 'frequency':
                return this.strategyFrequency(rule, values);

            default:
                return this.strategyMostRecent(rule, values);
        }
    }

    private strategySourcePriority(rule: SurvivorshipRule, values: FieldValue[]): SurvivorshipResult {
        const priorities = rule.config?.sourcePriority || [];

        for (const source of priorities) {
            const match = values.find(v => v.sourceSystem === source);
            if (match && match.value !== null && match.value !== undefined) {
                return {
                    field: rule.fieldName,
                    selectedValue: match.value,
                    selectedSource: match.sourceSystem,
                    reason: `Source priority: ${source}`,
                    alternativeValues: values.filter(v => v !== match),
                    hasConflict: this.detectConflict(values)
                };
            }
        }

        // Fallback to first value
        return {
            field: rule.fieldName,
            selectedValue: values[0].value,
            selectedSource: values[0].sourceSystem,
            reason: 'Fallback (no priority source found)',
            alternativeValues: values.slice(1),
            hasConflict: this.detectConflict(values)
        };
    }

    private strategyMostRecent(rule: SurvivorshipRule, values: FieldValue[]): SurvivorshipResult {
        const sorted = [...values].sort((a, b) => {
            const dateA = a.updatedAt?.getTime() || 0;
            const dateB = b.updatedAt?.getTime() || 0;
            return dateB - dateA;
        });

        const selected = sorted[0];
        return {
            field: rule.fieldName,
            selectedValue: selected.value,
            selectedSource: selected.sourceSystem,
            reason: 'Most recently updated',
            alternativeValues: sorted.slice(1),
            hasConflict: this.detectConflict(values)
        };
    }

    private strategyMostComplete(rule: SurvivorshipRule, values: FieldValue[]): SurvivorshipResult {
        const sorted = [...values].sort((a, b) => {
            const lenA = this.getValueLength(a.value);
            const lenB = this.getValueLength(b.value);
            return lenB - lenA;
        });

        const selected = sorted[0];
        return {
            field: rule.fieldName,
            selectedValue: selected.value,
            selectedSource: selected.sourceSystem,
            reason: 'Most complete value',
            alternativeValues: sorted.slice(1),
            hasConflict: this.detectConflict(values)
        };
    }

    private strategyFrequency(rule: SurvivorshipRule, values: FieldValue[]): SurvivorshipResult {
        const frequency = new Map<string, { count: number; value: FieldValue }>();

        for (const v of values) {
            const key = JSON.stringify(v.value);
            const existing = frequency.get(key);
            if (existing) {
                existing.count++;
            } else {
                frequency.set(key, { count: 1, value: v });
            }
        }

        const sorted = Array.from(frequency.values()).sort((a, b) => b.count - a.count);
        const selected = sorted[0].value;

        return {
            field: rule.fieldName,
            selectedValue: selected.value,
            selectedSource: selected.sourceSystem,
            reason: `Most frequent (${sorted[0].count}/${values.length})`,
            alternativeValues: values.filter(v => v !== selected),
            hasConflict: this.detectConflict(values)
        };
    }

    private detectConflict(values: FieldValue[]): boolean {
        if (values.length <= 1) return false;

        const normalized = values.map(v => JSON.stringify(v.value));
        return new Set(normalized).size > 1;
    }

    private getValueLength(value: unknown): number {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'string') return value.length;
        if (Array.isArray(value)) return value.length;
        if (typeof value === 'object') return Object.keys(value).length;
        return String(value).length;
    }
}
