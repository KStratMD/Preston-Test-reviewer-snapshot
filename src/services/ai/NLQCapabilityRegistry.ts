/**
 * NLQ Capability Registry Service
 * AI-Enhanced SuiteCentral 2.0 - Phase 1: Natural Language Query Orchestration
 * 
 * Provides a strict query-to-API orchestrator with:
 * - Capability registration for all SuiteCentral modules
 * - Permission gating per capability
 * - Query pattern matching and intent resolution
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { SuiteCentralModule } from '../metrics/ModuleMetricsAggregator';

// NLQ Capability definition
export interface NLQCapability {
    id: string;
    name: string;
    module: SuiteCentralModule;
    apiEndpoint: string;
    httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE';
    description: string;
    queryPatterns: string[];
    requiredPermissions: string[];
    parameters?: NLQParameter[];
    responseMapping?: ResponseMapping;
    examples: QueryExample[];
}

export interface NLQParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'array';
    required: boolean;
    description: string;
    extractionPatterns: string[];
    defaultValue?: string | number | boolean;
}

export interface ResponseMapping {
    summaryField: string;
    detailFields: string[];
    formatTemplate: string;
}

export interface QueryExample {
    query: string;
    intent: string;
    extractedParams: Record<string, unknown>;
}

// Query resolution result
export interface QueryResolution {
    capability: NLQCapability;
    confidence: number;
    extractedParameters: Record<string, unknown>;
    matchedPattern: string;
    alternativeCapabilities: AlternativeCapability[];
}

export interface AlternativeCapability {
    capability: NLQCapability;
    confidence: number;
    reason: string;
}

// Permission check result
export interface PermissionCheckResult {
    allowed: boolean;
    missingPermissions: string[];
    reason?: string;
}

// Query execution result
export interface NLQExecutionResult {
    success: boolean;
    capability: NLQCapability;
    response: unknown;
    formattedResponse: string;
    executionTimeMs: number;
    metadata: {
        apiEndpoint: string;
        parameters: Record<string, unknown>;
        timestamp: string;
    };
}

// Configurable confidence threshold for query matching (via environment variable)
const MIN_CONFIDENCE = (() => {
    const raw = process.env.NLQ_MIN_CONFIDENCE;
    const parsed = raw ? parseFloat(raw) : NaN;
    // Valid range: 0.1 to 1.0, default 0.3 for flexible fuzzy matching
    return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 1.0 ? parsed : 0.3;
})();

@injectable()
export class NLQCapabilityRegistry {
    private capabilities = new Map<string, NLQCapability>();

    constructor(
        @inject(TYPES.Logger) private logger: Logger
    ) {
        this.logger.info('NLQCapabilityRegistry initialized');
        this.registerDefaultCapabilities();
    }

    /**
     * Register a new NLQ capability
     */
    register(capability: NLQCapability): void {
        this.capabilities.set(capability.id, capability);

        this.logger.info(`Registered NLQ capability: ${capability.name}`, {
            id: capability.id,
            module: capability.module,
            patterns: capability.queryPatterns.length,
        });
    }

    /**
     * Resolve a natural language query to a capability
     */
    resolveQuery(query: string, userPermissions: string[]): QueryResolution | null {
        const normalizedQuery = query.toLowerCase();
        const matches: { capability: NLQCapability; confidence: number; pattern: string }[] = [];

        // Find matching capabilities
        for (const capability of this.capabilities.values()) {
            for (const pattern of capability.queryPatterns) {
                const confidence = this.calculatePatternMatch(normalizedQuery, pattern.toLowerCase());
                if (confidence > MIN_CONFIDENCE) {
                    matches.push({ capability, confidence, pattern });
                }
            }
        }

        if (matches.length === 0) {
            this.logger.debug('No matching capabilities found for query', { query });
            return null;
        }

        // Sort by confidence and get best match
        matches.sort((a, b) => b.confidence - a.confidence);
        const bestMatch = matches[0];

        // Check permissions
        const permissionCheck = this.checkPermissions(bestMatch.capability, userPermissions);
        if (!permissionCheck.allowed) {
            this.logger.warn('Permission denied for capability', {
                capability: bestMatch.capability.id,
                missingPermissions: permissionCheck.missingPermissions,
            });
        }

        // Extract parameters from query
        const extractedParameters = this.extractParameters(query, bestMatch.capability);

        return {
            capability: bestMatch.capability,
            confidence: bestMatch.confidence,
            extractedParameters,
            matchedPattern: bestMatch.pattern,
            alternativeCapabilities: matches.slice(1, 4).map(m => ({
                capability: m.capability,
                confidence: m.confidence,
                reason: `Matched pattern: "${m.pattern}"`,
            })),
        };
    }

    /**
     * Calculate pattern match confidence using fuzzy matching
     */
    private calculatePatternMatch(query: string, pattern: string): number {
        // Check for keyword matches
        // Filter out empty strings to avoid inflating denominator
        const patternWords = pattern.split(/\s+/).filter(w => w.length > 0);
        const queryWords = query.split(/\s+/).filter(w => w.length > 0);

        // Handle edge case of empty pattern
        if (patternWords.length === 0) {
            return 0;
        }

        // Minimum length for fuzzy substring matching to avoid spurious matches
        const MIN_FUZZY_WORD_LENGTH = 3;
        let matchedWords = 0;

        for (const patternWord of patternWords) {
            // For very short words, only count exact matches
            if (patternWord.length < MIN_FUZZY_WORD_LENGTH) {
                if (queryWords.includes(patternWord)) {
                    matchedWords++;
                }
                continue;
            }

            // For longer words, allow fuzzy substring matching
            if (queryWords.some(qw =>
                qw.length >= MIN_FUZZY_WORD_LENGTH &&
                (qw.includes(patternWord) || patternWord.includes(qw))
            )) {
                matchedWords++;
            }
        }

        const baseScore = matchedWords / patternWords.length;

        // Boost score for exact phrase matches
        if (query.includes(pattern)) {
            return Math.min(1, baseScore + 0.3);
        }

        return baseScore;
    }

    /**
     * Check if user has required permissions for a capability
     */
    checkPermissions(capability: NLQCapability, userPermissions: string[]): PermissionCheckResult {
        const missingPermissions: string[] = [];

        for (const required of capability.requiredPermissions) {
            if (!userPermissions.includes(required) && !userPermissions.includes('admin:*')) {
                missingPermissions.push(required);
            }
        }

        return {
            allowed: missingPermissions.length === 0,
            missingPermissions,
            reason: missingPermissions.length > 0
                ? `Missing permissions: ${missingPermissions.join(', ')}`
                : undefined,
        };
    }

    /**
     * Extract parameters from query based on capability definition
     */
    private extractParameters(query: string, capability: NLQCapability): Record<string, unknown> {
        const params: Record<string, unknown> = {};

        if (!capability.parameters) {
            return params;
        }

        for (const param of capability.parameters) {
            for (const pattern of param.extractionPatterns) {
                const regex = new RegExp(pattern, 'i');
                const match = query.match(regex);
                if (match && match[1]) {
                    params[param.name] = this.convertParameterValue(match[1], param.type);
                    break;
                }
            }

            // Use default if required and not found
            if (params[param.name] === undefined && param.defaultValue !== undefined) {
                params[param.name] = param.defaultValue;
            }
        }

        return params;
    }

    /**
     * Convert extracted parameter to correct type
     */
    private convertParameterValue(value: string, type: string): unknown {
        switch (type) {
            case 'number': {
                const parsed = parseFloat(value);
                return Number.isNaN(parsed) ? undefined : parsed;
            }
            case 'boolean':
                return value.toLowerCase() === 'true' || value === '1' || value === 'yes';
            case 'date': {
                // Supports ISO 8601, RFC 2822, and common formats parseable by Date constructor
                // Examples: "2024-01-15", "2024-01-15T10:30:00Z", "Jan 15, 2024"
                const date = new Date(value);
                if (Number.isNaN(date.getTime())) {
                    return undefined; // Return undefined for invalid/unparseable date
                }
                return date.toISOString();
            }
            case 'array':
                return value.split(',').map(v => v.trim());
            default:
                return value;
        }
    }

    /**
     * Get all registered capabilities
     */
    getAllCapabilities(): NLQCapability[] {
        return Array.from(this.capabilities.values());
    }

    /**
     * Get capabilities for a specific module
     */
    getModuleCapabilities(module: SuiteCentralModule): NLQCapability[] {
        return Array.from(this.capabilities.values()).filter(c => c.module === module);
    }

    /**
     * Register default capabilities for all SuiteCentral modules
     */
    private registerDefaultCapabilities(): void {
        // SupplierCentral capabilities
        this.register({
            id: 'supplier-risk-score',
            name: 'Supplier Risk Score',
            module: 'SupplierCentral',
            apiEndpoint: '/api/ai/suppliers/risk-scores',
            httpMethod: 'GET',
            description: 'Get risk score for a specific supplier',
            queryPatterns: [
                'supplier risk',
                'vendor risk',
                'supplier health',
                'vendor health score',
                'how risky is supplier',
                'supplier risk score',
            ],
            requiredPermissions: ['supplier:read'],
            parameters: [
                {
                    name: 'vendorId',
                    type: 'string',
                    required: false,
                    description: 'Vendor ID to check (supports alphanumeric with dashes/spaces)',
                    // Improved patterns to handle common vendor ID formats: ABC-123, ABC 123, ABC_123
                    // Non-greedy quantifier with whitespace/punctuation lookahead for proper matching in context
                    extractionPatterns: ['vendor[:\\s]+([\\w-]+?)(?:\\s|[?.,]|$)', 'supplier[:\\s]+([\\w-]+?)(?:\\s|[?.,]|$)'],
                },
            ],
            examples: [
                { query: 'What is the risk for vendor ABC123?', intent: 'get_risk_score', extractedParams: { vendorId: 'ABC123' } },
                { query: 'Show me supplier health', intent: 'get_all_risks', extractedParams: {} },
            ],
        });

        this.register({
            id: 'supplier-dashboard',
            name: 'Supplier Dashboard',
            module: 'SupplierCentral',
            apiEndpoint: '/api/supplier-central/dashboard',
            httpMethod: 'GET',
            description: 'Get supplier dashboard metrics',
            queryPatterns: [
                'supplier metrics',
                'supplier dashboard',
                'vendor overview',
                'how many vendors',
                'supplier kpis',
                'pending purchase orders',
                'po status',
            ],
            requiredPermissions: ['supplier:read'],
            examples: [
                { query: 'Show me supplier metrics', intent: 'get_dashboard', extractedParams: {} },
            ],
        });

        // PaymentCentral capabilities
        this.register({
            id: 'payment-dashboard',
            name: 'Payment Dashboard',
            module: 'PaymentCentral',
            apiEndpoint: '/api/payment-central/dashboard',
            httpMethod: 'GET',
            description: 'Get payment processing metrics',
            queryPatterns: [
                'payment metrics',
                'payment dashboard',
                'payment success rate',
                'payment volume',
                'daily payments',
                'failed payments',
                'dispute rate',
            ],
            requiredPermissions: ['payment:read'],
            examples: [
                { query: 'What is our payment success rate?', intent: 'get_metrics', extractedParams: {} },
            ],
        });

        // SyncCentral capabilities
        this.register({
            id: 'sync-health',
            name: 'Sync Health',
            module: 'SyncCentral',
            apiEndpoint: '/api/sync-orchestrator/dashboard',
            httpMethod: 'GET',
            description: 'Get integration sync health metrics',
            queryPatterns: [
                'sync health',
                'sync status',
                'integration health',
                'api success rate',
                'sync failures',
                'failed syncs',
                'sync metrics',
            ],
            requiredPermissions: ['sync:read'],
            examples: [
                { query: 'How healthy are our syncs?', intent: 'get_health', extractedParams: {} },
            ],
        });

        // CustomerCentral capabilities
        this.register({
            id: 'customer-dashboard',
            name: 'Customer Dashboard',
            module: 'CustomerCentral',
            apiEndpoint: '/api/customer-central/dashboard',
            httpMethod: 'GET',
            description: 'Get customer metrics and insights',
            queryPatterns: [
                'customer metrics',
                'customer dashboard',
                'customer satisfaction',
                'how many customers',
                'customer health',
                'churn risk',
                'customer overview',
            ],
            requiredPermissions: ['customer:read'],
            examples: [
                { query: 'What is our customer satisfaction?', intent: 'get_satisfaction', extractedParams: {} },
            ],
        });

        // InventoryCentral capabilities
        this.register({
            id: 'inventory-dashboard',
            name: 'Inventory Dashboard',
            module: 'InventoryCentral',
            apiEndpoint: '/api/inventory-central/dashboard',
            httpMethod: 'GET',
            description: 'Get inventory metrics',
            queryPatterns: [
                'inventory metrics',
                'stock levels',
                'low stock',
                'inventory health',
                'how many skus',
                'reorder alerts',
                'inventory value',
            ],
            requiredPermissions: ['inventory:read'],
            examples: [
                { query: 'How many low stock alerts?', intent: 'get_alerts', extractedParams: {} },
            ],
        });

        // FinanceCentral capabilities
        this.register({
            id: 'finance-dashboard',
            name: 'Finance Dashboard',
            module: 'FinanceCentral',
            apiEndpoint: '/api/finance-central/dashboard',
            httpMethod: 'GET',
            description: 'Get financial metrics',
            queryPatterns: [
                'cash flow',
                'cash position',
                'finance metrics',
                'ar balance',
                'ap balance',
                'pending approvals',
                'financial health',
            ],
            requiredPermissions: ['finance:read'],
            examples: [
                { query: 'What is our cash position?', intent: 'get_cash', extractedParams: {} },
            ],
        });

        // QualityCentral capabilities
        this.register({
            id: 'quality-dashboard',
            name: 'Quality Dashboard',
            module: 'QualityCentral',
            apiEndpoint: '/api/quality-central/dashboard',
            httpMethod: 'GET',
            description: 'Get quality metrics',
            queryPatterns: [
                'quality metrics',
                'pass rate',
                'inspection status',
                'items on hold',
                'quality scores',
                'inspection backlog',
            ],
            requiredPermissions: ['quality:read'],
            examples: [
                { query: 'What is our pass rate?', intent: 'get_pass_rate', extractedParams: {} },
            ],
        });

        // Cross-module capabilities
        this.register({
            id: 'cross-module-metrics',
            name: 'Cross-Module Metrics',
            module: 'SyncCentral',
            apiEndpoint: '/api/ai/metrics/cross-module',
            httpMethod: 'GET',
            description: 'Get aggregated metrics across all modules',
            queryPatterns: [
                'overall health',
                'system health',
                'all metrics',
                'cross module',
                'overall status',
                'business health',
                'everything',
            ],
            requiredPermissions: ['admin:read'],
            examples: [
                { query: 'How healthy is the overall system?', intent: 'get_overall_health', extractedParams: {} },
            ],
        });

        this.register({
            id: 'anomaly-detection',
            name: 'Anomaly Detection',
            module: 'SyncCentral',
            apiEndpoint: '/api/ai/anomalies',
            httpMethod: 'GET',
            description: 'Get detected anomalies across modules',
            queryPatterns: [
                'anomalies',
                'what is wrong',
                'issues',
                'problems',
                'alerts',
                'something wrong',
                'unusual activity',
            ],
            requiredPermissions: ['admin:read'],
            examples: [
                { query: 'What anomalies have been detected?', intent: 'get_anomalies', extractedParams: {} },
            ],
        });

        this.logger.info(`Registered ${this.capabilities.size} default NLQ capabilities`);
    }
}
