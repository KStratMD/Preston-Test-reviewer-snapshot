import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import crypto from 'crypto';

/**
 * Schema Registry Service
 * 
 * Implements the "Schema Drift Shield" from Grand Unified Strategy 2026.
 * 
 * Purpose: Solve the "It broke and I don't know why" problem.
 * 
 * Mechanism:
 * 1. Hash the expected schema for each integration
 * 2. Run Projected vs Actual diff before every sync
 * 3. If drift detected → Block Sync → Alert Admin → Suggest Mapping Fix
 */

export interface SchemaDefinition {
    system: string;
    objectType: string;
    version: string;
    fields: SchemaField[];
    lastUpdated: Date;
}

export interface SchemaField {
    name: string;
    type: string;
    required: boolean;
    inferred?: boolean;
    enumValues?: string[];
    maxLength?: number;
    format?: string;
}

export interface SchemaDrift {
    field: string;
    changeType: 'added' | 'removed' | 'modified';
    expected?: SchemaField;
    actual?: SchemaField;
    severity: 'low' | 'medium' | 'high' | 'critical';
    suggestedFix?: string;
}

export interface SchemaValidationResult {
    isValid: boolean;
    hash: string;
    expectedHash?: string;
    drifts: SchemaDrift[];
    timestamp: Date;
    shouldBlockSync: boolean;
    alertMessage?: string;
}

@injectable()
export class SchemaRegistryService {
    private schemaStore = new Map<string, { schema: SchemaDefinition; hash: string }>();
    private logger: Logger;

    constructor(
        @inject(TYPES.Logger) logger: Logger
    ) {
        this.logger = logger;
        this.logger.info('[SchemaRegistry] Service initialized');
    }

    /**
     * Register a schema for an integration endpoint
     */
    registerSchema(system: string, objectType: string, schema: SchemaDefinition): string {
        const key = this.getSchemaKey(system, objectType);
        const hash = this.hashSchema(schema);

        this.schemaStore.set(key, { schema, hash });
        this.logger.info(`[SchemaRegistry] Registered schema: ${key} (hash: ${hash.substring(0, 8)}...)`);

        return hash;
    }

    /**
     * Validate incoming data against registered schema
     * Returns drift analysis and sync recommendation
     */
    validateSchema(system: string, objectType: string, actualFields: SchemaField[]): SchemaValidationResult {
        const key = this.getSchemaKey(system, objectType);
        const registered = this.schemaStore.get(key);

        if (!registered) {
            this.logger.debug(`[SchemaRegistry] No schema registered for: ${key}`);
            return {
                isValid: true, // Allow if no schema registered
                hash: this.hashFields(actualFields),
                drifts: [],
                timestamp: new Date(),
                shouldBlockSync: false
            };
        }

        const expectedFields = registered.schema.fields;
        const actualHash = this.hashFields(actualFields);
        const drifts = this.detectDrifts(expectedFields, actualFields);

        const criticalDrifts = drifts.filter(d => d.severity === 'critical');
        const highDrifts = drifts.filter(d => d.severity === 'high');

        const shouldBlockSync = criticalDrifts.length > 0;
        const isValid = drifts.length === 0;

        const result: SchemaValidationResult = {
            isValid,
            hash: actualHash,
            expectedHash: registered.hash,
            drifts,
            timestamp: new Date(),
            shouldBlockSync,
            alertMessage: this.generateAlertMessage(drifts, system, objectType)
        };

        if (drifts.length > 0) {
            this.logger.warn(`[SchemaRegistry] Schema drift detected for ${key}:`, {
                driftCount: drifts.length,
                critical: criticalDrifts.length,
                high: highDrifts.length,
                shouldBlock: shouldBlockSync
            });
        }

        return result;
    }

    /**
     * Detect differences between expected and actual schemas
     */
    private detectDrifts(expected: SchemaField[], actual: SchemaField[]): SchemaDrift[] {
        const drifts: SchemaDrift[] = [];
        const actualMap = new Map(actual.map(f => [f.name, f]));
        const expectedMap = new Map(expected.map(f => [f.name, f]));

        // Check for removed or modified fields
        for (const expectedField of expected) {
            const actualField = actualMap.get(expectedField.name);

            if (!actualField) {
                // Field was removed
                drifts.push({
                    field: expectedField.name,
                    changeType: 'removed',
                    expected: expectedField,
                    severity: expectedField.required ? 'critical' : 'high',
                    suggestedFix: expectedField.required
                        ? `CRITICAL: Required field "${expectedField.name}" is missing. Add it back to the source system or update the mapping.`
                        : `Field "${expectedField.name}" was removed. Update the mapping to remove references.`
                });
            } else if (!this.fieldsEqual(expectedField, actualField)) {
                // Field was modified
                const severity = this.assessModificationSeverity(expectedField, actualField);
                drifts.push({
                    field: expectedField.name,
                    changeType: 'modified',
                    expected: expectedField,
                    actual: actualField,
                    severity,
                    suggestedFix: this.suggestModificationFix(expectedField, actualField)
                });
            }
        }

        // Check for added fields
        for (const actualField of actual) {
            if (!expectedMap.has(actualField.name)) {
                drifts.push({
                    field: actualField.name,
                    changeType: 'added',
                    actual: actualField,
                    severity: 'low',
                    suggestedFix: `New field "${actualField.name}" detected. Consider adding it to the mapping if needed.`
                });
            }
        }

        return drifts;
    }

    /**
     * Assess severity of a field modification
     */
    private assessModificationSeverity(expected: SchemaField, actual: SchemaField): SchemaDrift['severity'] {
        // Type change is critical
        if (expected.type !== actual.type) {
            return 'critical';
        }

        // Required becoming optional is critical (data loss risk), optional becoming required is high
        if (expected.required !== actual.required) {
            return actual.required ? 'high' : 'critical';
        }

        // Enum value removal is high
        if (expected.enumValues && actual.enumValues) {
            const removed = expected.enumValues.filter(v => !actual.enumValues!.includes(v));
            if (removed.length > 0) {
                return 'high';
            }
        }

        // MaxLength reduction is medium
        if (expected.maxLength && actual.maxLength && actual.maxLength < expected.maxLength) {
            return 'medium';
        }

        return 'low';
    }

    /**
     * Suggest a fix for a field modification
     */
    private suggestModificationFix(expected: SchemaField, actual: SchemaField): string {
        if (expected.type !== actual.type) {
            return `Type changed from "${expected.type}" to "${actual.type}". Update transformation logic to handle new type.`;
        }

        if (expected.enumValues && actual.enumValues) {
            const removed = expected.enumValues.filter(v => !actual.enumValues!.includes(v));
            if (removed.length > 0) {
                return `Enum values removed: [${removed.join(', ')}]. Update mappings to handle missing values.`;
            }
        }

        if (expected.maxLength !== actual.maxLength) {
            return `MaxLength changed from ${expected.maxLength} to ${actual.maxLength}. Update validation rules.`;
        }

        return `Field "${expected.name}" was modified. Review and update mapping as needed.`;
    }

    /**
     * Generate human-readable alert message
     */
    private generateAlertMessage(drifts: SchemaDrift[], system: string, objectType: string): string | undefined {
        if (drifts.length === 0) return undefined;

        const critical = drifts.filter(d => d.severity === 'critical');
        const high = drifts.filter(d => d.severity === 'high');

        if (critical.length > 0) {
            return `⚠️ CRITICAL: Schema for ${system}.${objectType} has ${critical.length} critical changes. Sync blocked. Review immediately: ${critical.map(d => d.field).join(', ')}`;
        }

        if (high.length > 0) {
            return `⚠️ WARNING: Schema for ${system}.${objectType} has ${high.length} high-severity changes. Review recommended: ${high.map(d => d.field).join(', ')}`;
        }

        return `ℹ️ INFO: Schema for ${system}.${objectType} has ${drifts.length} minor changes detected.`;
    }

    /**
     * Compare two fields for equality
     */
    private fieldsEqual(a: SchemaField, b: SchemaField): boolean {
        return (
            a.name === b.name &&
            a.type === b.type &&
            a.required === b.required &&
            a.maxLength === b.maxLength &&
            a.format === b.format &&
            JSON.stringify(a.enumValues?.sort()) === JSON.stringify(b.enumValues?.sort())
        );
    }

    /**
     * Generate deterministic hash for a schema
     */
    private hashSchema(schema: SchemaDefinition): string {
        return this.hashFields(schema.fields);
    }

    /**
     * Generate deterministic hash for field array
     */
    private hashFields(fields: SchemaField[]): string {
        const normalized = fields
            .map(f => ({
                name: f.name,
                type: f.type,
                required: f.required,
                enumValues: f.enumValues?.sort(),
                maxLength: f.maxLength,
                format: f.format
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        // Note: Object keys are deterministic since we construct normalized objects
        // with consistent key order above (name, type, required, enumValues, maxLength, format)
        return crypto.createHash('sha256')
            .update(JSON.stringify(normalized))
            .digest('hex');
    }

    /**
     * Get unique key for schema storage
     */
    private getSchemaKey(system: string, objectType: string): string {
        return `${system.toLowerCase()}:${objectType.toLowerCase()}`;
    }

    /**
     * Get all registered schemas
     */
    getRegisteredSchemas(): { key: string; hash: string; fieldCount: number }[] {
        const result: { key: string; hash: string; fieldCount: number }[] = [];

        for (const [key, value] of this.schemaStore) {
            result.push({
                key,
                hash: value.hash,
                fieldCount: value.schema.fields.length
            });
        }

        return result;
    }

    /**
     * Clear a registered schema
     */
    clearSchema(system: string, objectType: string): boolean {
        const key = this.getSchemaKey(system, objectType);
        return this.schemaStore.delete(key);
    }
}
