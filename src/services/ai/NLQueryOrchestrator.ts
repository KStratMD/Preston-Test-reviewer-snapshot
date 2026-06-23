/**
 * NLQ Query Orchestrator Service
 * AI-Enhanced SuiteCentral 2.0 - Phase 1: Natural Language Query Orchestration
 * 
 * Orchestrates natural language queries through:
 * - Capability resolution via NLQCapabilityRegistry
 * - Permission validation via GovernanceService
 * - API execution with cost tracking
 * - Response formatting for human-readable output
 */

import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import {
    NLQCapabilityRegistry,
    QueryResolution,
    NLQCapability,
    NLQExecutionResult
} from './NLQCapabilityRegistry';
import { NLActionGateService, ProposedAction } from './NLActionGateService';
import { fetchModuleData } from '../../utils/moduleHttpClient';

// Query request from user
export interface NLQueryRequest {
    query: string;
    userId: string;
    sessionId?: string;
    context?: QueryContext;
}

export interface QueryContext {
    currentModule?: string;
    recentQueries?: string[];
    userRole?: string;
    userPermissions?: string[];
}

// Full query response
export interface NLQueryResponse {
    success: boolean;
    query: string;
    resolution: QueryResolution | null;
    execution: NLQExecutionResult | null;
    formattedAnswer: string;
    followUpQuestions: string[];
    relatedCapabilities: NLQCapability[];
    metadata: {
        processingTimeMs: number;
        confidenceScore: number;
        permissionCheck: PermissionStatus;
    };
    // NEW: For write actions that require approval
    proposedAction?: ProposedAction;
    isWriteAction?: boolean;
}

export interface PermissionStatus {
    allowed: boolean;
    missingPermissions: string[];
}

// Conversation memory for context
interface ConversationMemory {
    sessionId: string;
    queries: {
        query: string;
        timestamp: string;
        resolution: QueryResolution | null;
    }[];
    lastUpdated: string;
}

/**
 * Parse a positive integer from an environment variable with validation
 */
function parsePositiveIntEnv(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

// Memory management constants (configurable via environment variables)
// Memory estimate: ~2-5KB per session (10 queries with resolution data)
// Default 1000 sessions ≈ 2-5MB memory footprint; adjust based on available memory
const MAX_SESSIONS = parsePositiveIntEnv('NLQ_MAX_SESSIONS', 1000);
const SESSION_TTL_MS = parsePositiveIntEnv('NLQ_SESSION_TTL_MINUTES', 30) * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Run cleanup every 5 minutes

// Patterns that indicate write/action intent (vs read-only query)
const WRITE_INTENT_PATTERNS = [
    /^(refund|cancel|delete|remove|update|change|modify|create|add|send|approve|reject)/i,
    /\b(please\s+)?(refund|cancel|delete|update|change|modify|create|add|send|approve|reject)\b/i,
    /\b(do|perform|execute|run|process)\s+(a\s+)?(refund|cancellation|update|payment|action)/i,
];

@injectable()
export class NLQueryOrchestrator {
    private conversationMemory = new Map<string, ConversationMemory>();
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        @inject(TYPES.Logger) private logger: Logger,
        @inject(TYPES.NLQCapabilityRegistry) private capabilityRegistry: NLQCapabilityRegistry,
        @inject(TYPES.NLActionGateService) @optional() private nlActionGateService?: NLActionGateService
    ) {
        const actionGateEnabled = !!this.nlActionGateService;
        this.logger.info('NLQueryOrchestrator initialized', { actionGateEnabled });

        // Warn if NLActionGateService is not available - write actions will be limited
        if (!actionGateEnabled) {
            this.logger.warn('NLActionGateService not available - write action approval flow disabled. ' +
                'Natural language queries will work, but write actions will require manual approval.');
        }

        // Start periodic cleanup to prevent memory leaks from abandoned sessions
        this.startPeriodicCleanup();
    }

    /**
     * Start periodic cleanup of stale sessions (runs independently of query activity)
     */
    private startPeriodicCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleSessions();
        }, CLEANUP_INTERVAL_MS);
        // Allow process to exit even if interval is running
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    /**
     * Stop periodic cleanup. Call on application shutdown for clean termination.
     * Note: The interval is unref'd, so process can exit without calling this.
     * However, explicit cleanup is recommended for graceful shutdown handlers.
     */
    public stopPeriodicCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * Process a natural language query
     */
    async processQuery(request: NLQueryRequest): Promise<NLQueryResponse> {
        const startTime = Date.now();
        this.logger.info('Processing NL query', { query: request.query, userId: request.userId });

        // Get user permissions upfront - used for both read and write paths
        const userPermissions = this.getUserPermissions(request);

        // Check if this is a write intent (action) vs read query
        // Note: handleWriteIntent has its own write permission check
        const isWriteIntent = this.detectWriteIntent(request.query);
        if (isWriteIntent && this.nlActionGateService) {
            return this.handleWriteIntent(request, startTime, true);
        }

        // Resolve query to capability
        const resolution = this.capabilityRegistry.resolveQuery(request.query, userPermissions);

        if (!resolution) {
            // If no read capability matched, try as write action
            if (this.nlActionGateService) {
                const writeResult = await this.handleWriteIntent(request, startTime, false);
                if (writeResult.proposedAction) {
                    return writeResult;
                }
            }
            return this.buildNoMatchResponse(request, Date.now() - startTime);
        }

        // Check permissions
        const permissionCheck = this.capabilityRegistry.checkPermissions(resolution.capability, userPermissions);

        if (!permissionCheck.allowed) {
            return this.buildPermissionDeniedResponse(request, resolution, permissionCheck, Date.now() - startTime);
        }

        // Execute the capability
        let execution: NLQExecutionResult | null;
        try {
            execution = await this.executeCapability(resolution);
        } catch (error) {
            this.logger.error('Failed to execute capability', {
                capability: resolution.capability.id,
                error
            });
            return this.buildExecutionErrorResponse(request, resolution, Date.now() - startTime);
        }

        // Store in conversation memory
        this.updateConversationMemory(request.sessionId || request.userId, request.query, resolution);

        // Format response for human readability
        const formattedAnswer = this.formatResponse(resolution.capability, execution);
        const followUpQuestions = this.generateFollowUpQuestions(resolution, execution);
        const relatedCapabilities = resolution.alternativeCapabilities.map(a => a.capability);

        return {
            success: true,
            query: request.query,
            resolution,
            execution,
            formattedAnswer,
            followUpQuestions,
            relatedCapabilities,
            metadata: {
                processingTimeMs: Date.now() - startTime,
                confidenceScore: resolution.confidence,
                permissionCheck: {
                    allowed: true,
                    missingPermissions: [],
                },
            },
        };
    }

    /**
     * Execute a capability by calling its API endpoint
     */
    private async executeCapability(resolution: QueryResolution): Promise<NLQExecutionResult> {
        const { capability, extractedParameters } = resolution;
        const startTime = Date.now();

        // Build API URL with parameters
        let url = capability.apiEndpoint;
        if (Object.keys(extractedParameters).length > 0 && capability.httpMethod === 'GET') {
            const urlParameters: Record<string, string> = {};
            for (const [k, v] of Object.entries(extractedParameters)) {
                // Handle different value types for URL serialization
                if (v === undefined || v === null) {
                    urlParameters[k] = '';
                } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    urlParameters[k] = String(v);
                } else {
                    // Serialize arrays and objects to JSON
                    urlParameters[k] = JSON.stringify(v);
                }
            }
            const params = new URLSearchParams(urlParameters);
            const separator = url.includes('?') ? '&' : '?';
            url = `${url}${separator}${params.toString()}`;
        }

        // Phase 2: fetch from live API (with fallback to simulated response)
        const response = await this.fetchLiveOrFallback(capability, extractedParameters);

        return {
            success: true,
            capability,
            response,
            formattedResponse: this.formatAPIResponse(capability, response),
            executionTimeMs: Date.now() - startTime,
            metadata: {
                apiEndpoint: url,
                parameters: extractedParameters,
                timestamp: new Date().toISOString(),
            },
        };
    }

    /**
     * Fetch live data from module API with fallback to simulated response.
     * Uses fetchModuleData() which is gated behind USE_REAL_MODULE_APIS env var.
     * When live APIs are enabled, response is adapted from nested service format
     * to the flat format expected by formatters.
     */
    private async fetchLiveOrFallback(
        capability: NLQCapability,
        params: Record<string, unknown>
    ): Promise<unknown> {
        const baseUrl = process.env.MODULE_API_BASE_URL || 'http://localhost:3000';
        let endpoint = capability.apiEndpoint;

        // Dynamic routing: per-vendor risk score when vendorId is a non-empty string
        const vid = params.vendorId;
        if (capability.id === 'supplier-risk-score' && vid && typeof vid === 'string' && vid.trim() !== '') {
            endpoint = `/api/ai/suppliers/${encodeURIComponent(vid.trim())}/risk-score`;
        }

        const fallback = this.getSimulatedResponse(capability.id, params);
        const raw = await fetchModuleData(
            `${baseUrl}${endpoint}`,
            fallback,
            this.logger,
            { timeoutMs: 5000 }
        );

        return this.adaptResponse(capability.id, raw, params);
    }

    /**
     * Return simulated (mock) response data for a capability.
     * Used as fallback when live APIs are unavailable.
     */
    private getSimulatedResponse(
        capabilityId: string,
        params: Record<string, unknown>
    ): Record<string, unknown> {
        const mockResponses: Record<string, Record<string, unknown>> = {
            'supplier-dashboard': {
                activeVendors: 234,
                pendingPOs: 67,
                onTimeDeliveryRate: 94.2,
                vendorSatisfaction: 4.7,
            },
            'supplier-risk-score': {
                vendorId: params.vendorId || 'ALL',
                overallRisk: 23,
                riskFactors: ['Payment delays', 'Quality issues'],
                trend: 'improving',
            },
            'payment-dashboard': {
                successRate: 98.5,
                avgProcessingTime: 2.3,
                dailyVolume: 4500000,
                disputeRate: 0.8,
            },
            'sync-health': {
                apiSuccessRate: 99.8,
                avgLatency: 245,
                errorRate: 0.2,
                failedMessages: 23,
            },
            'customer-dashboard': {
                totalCustomers: 1250,
                activeCustomers: 892,
                satisfactionScore: 4.5,
                churnRisk: 8.2,
            },
            'inventory-dashboard': {
                totalSKUs: 4567,
                lowStockAlerts: 23,
                reorderPending: 15,
                inventoryValue: 2340000,
            },
            'finance-dashboard': {
                cashPosition: 3500000,
                arBalance: 890000,
                apBalance: 450000,
                pendingApprovals: 12,
            },
            'quality-dashboard': {
                inspectionsToday: 47,
                passRate: 94.2,
                itemsOnHold: 12,
                pendingRelease: 8,
            },
            'cross-module-metrics': {
                overallHealth: 'healthy',
                healthScore: 87,
                modulesHealthy: 9,
                modulesDegraded: 2,
                activeAnomalies: 3,
            },
            'anomaly-detection': {
                anomalies: [
                    { module: 'SupplierCentral', metric: 'onTimeDelivery', severity: 'warning' },
                    { module: 'InventoryCentral', metric: 'lowStock', severity: 'info' },
                ],
            },
        };

        return mockResponses[capabilityId] || { message: 'Data retrieved successfully' };
    }

    /**
     * Adapt live API response (nested service format) to flat format expected by formatters.
     * When data is already flat (mock/fallback), passes through unchanged.
     */
    adaptResponse(
        capabilityId: string,
        raw: unknown,
        params: Record<string, unknown> = {}
    ): Record<string, unknown> {
        if (raw == null || typeof raw !== 'object') {
            return {};
        }
        const data = raw as Record<string, unknown>;

        // If no nested wrapper detected, return as-is (already flat / mock data).
        // Check that wrapper values are actually objects (not primitives like string 'healthy').
        const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
        const hasNestedSummary = data && typeof data === 'object' && (
            isObject(data.summary) ||
            isObject(data.dashboard) ||
            isObject(data.overallHealth) ||
            isObject(data.profile)
        );
        if (!hasNestedSummary && capabilityId !== 'anomaly-detection') {
            return data;
        }

        switch (capabilityId) {
            case 'supplier-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                if (!s) return data;
                return {
                    activeVendors: s.activeVendors ?? s.totalVendors ?? 0,
                    pendingPOs: s.pendingApproval ?? s.pendingPOs ?? 0,
                    onTimeDeliveryRate: s.onTimeDeliveryRate ?? 94.0,
                    vendorSatisfaction: s.vendorSatisfaction ?? 4.5,
                };
            }

            case 'supplier-risk-score': {
                // Per-vendor response has profile wrapper
                const profile = data.profile as Record<string, unknown> | undefined;
                if (profile) {
                    const factors = profile.factors as { name: string }[] | string[] | undefined;
                    return {
                        vendorId: params.vendorId || 'ALL',
                        overallRisk: profile.overallRiskScore ?? profile.overallRisk ?? 0,
                        riskFactors: factors
                            ? factors.map(f => typeof f === 'string' ? f : f.name)
                            : [],
                        trend: profile.riskTrend ?? profile.trend ?? 'stable',
                    };
                }
                // Summary response — topRisks is SupplierRiskProfile[] (has supplierName, factors[])
                const s = data.summary as Record<string, unknown> | undefined;
                if (s) {
                    const topRisks = data.topRisks as { supplierName?: string; factors?: { name: string }[]; name?: string }[] | undefined;
                    // Extract unique factor names from all top-risk suppliers, frequency-ranked
                    let riskFactors: string[] = [];
                    if (topRisks) {
                        const factorCounts = new Map<string, number>();
                        for (const supplier of topRisks) {
                            if (supplier.factors && Array.isArray(supplier.factors)) {
                                for (const f of supplier.factors) {
                                    if (f.name) {
                                        factorCounts.set(f.name, (factorCounts.get(f.name) || 0) + 1);
                                    }
                                }
                            } else if (supplier.name) {
                                // Fallback: flat { name } shape (e.g. mock data)
                                factorCounts.set(supplier.name, (factorCounts.get(supplier.name) || 0) + 1);
                            }
                        }
                        riskFactors = [...factorCounts.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 5)
                            .map(([name]) => name);
                    }
                    return {
                        vendorId: 'ALL',
                        overallRisk: s.averageScore ?? 0,
                        riskFactors,
                        trend: 'stable',
                    };
                }
                return data;
            }

            case 'payment-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                if (!s) return data;
                return {
                    successRate: s.successRate ?? 0,
                    avgProcessingTime: s.avgProcessingTime ?? 2.0,
                    dailyVolume: s.totalVolume ?? s.dailyVolume ?? 0,
                    disputeRate: s.disputeRate ?? 0.5,
                };
            }

            case 'sync-health': {
                const dash = data.dashboard as Record<string, unknown> | undefined;
                const stats = (dash?.statistics ?? data.statistics) as Record<string, unknown> | undefined;
                if (!stats) return data;
                const total = Number(stats.totalOperations) || 1;
                const errors = Number(stats.errorOperations) || 0;
                return {
                    apiSuccessRate: stats.successRate ?? 0,
                    avgLatency: stats.averageSyncDuration ?? 0,
                    errorRate: Number(((errors / total) * 100).toFixed(2)),
                    failedMessages: stats.activeAnomalies ?? errors,
                };
            }

            case 'customer-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                const m = data.metrics as Record<string, unknown> | undefined;
                if (!s) return data;
                return {
                    totalCustomers: s.activeCustomers ?? s.totalCustomers ?? 0,
                    activeCustomers: s.activeCustomers ?? 0,
                    satisfactionScore: s.customerSatisfaction ?? s.satisfactionScore ?? 0,
                    churnRisk: m?.churnRate ?? m?.churnRisk ?? 0,
                };
            }

            case 'inventory-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                if (!s) return data;
                return {
                    totalSKUs: s.totalSKUs ?? 0,
                    lowStockAlerts: s.lowStockAlerts ?? 0,
                    reorderPending: s.reorderPending ?? 0,
                    inventoryValue: s.inventoryValue ?? 0,
                };
            }

            case 'finance-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                if (!s) return data;
                return {
                    cashPosition: s.cashPosition ?? 0,
                    arBalance: s.arBalance ?? 0,
                    apBalance: s.apBalance ?? 0,
                    pendingApprovals: s.pendingApprovals ?? 0,
                };
            }

            case 'quality-dashboard': {
                const s = data.summary as Record<string, unknown> | undefined;
                if (!s) return data;
                // Strip trailing "%" from passRate to avoid "95%%" in formatter
                let passRate = s.passRate;
                if (typeof passRate === 'string') {
                    const parsed = parseFloat(passRate.replace(/%$/, ''));
                    passRate = Number.isNaN(parsed) ? 0 : parsed;
                }
                return {
                    inspectionsToday: s.inspectionsToday ?? 0,
                    passRate: passRate ?? 0,
                    itemsOnHold: s.itemsOnHold ?? 0,
                    pendingRelease: s.pendingRelease ?? 0,
                };
            }

            case 'cross-module-metrics': {
                const oh = data.overallHealth as Record<string, unknown> | undefined;
                if (!oh) return data;
                const modules = data.modules as Record<string, { health?: { status?: string } }> | undefined;
                let healthy = 0;
                let degraded = 0;
                if (modules) {
                    // Binary classification is intentional: formatter only has two counters
                    // (modulesHealthy / modulesDegraded). 'critical'/'unknown' roll into degraded.
                    for (const mod of Object.values(modules)) {
                        if (mod.health?.status === 'healthy') {
                            healthy++;
                        } else {
                            degraded++;
                        }
                    }
                }
                const anomalies = data.anomalies as unknown[] | undefined;
                return {
                    overallHealth: oh.status ?? 'unknown',
                    healthScore: oh.score ?? 0,
                    modulesHealthy: healthy,
                    modulesDegraded: degraded,
                    activeAnomalies: anomalies?.length ?? 0,
                };
            }

            case 'anomaly-detection': {
                // Extract anomalies from wrapper and normalize module field
                const anomalies = data.anomalies as Record<string, unknown>[] | undefined;
                if (!anomalies) return data;
                return {
                    anomalies: anomalies.map(a => {
                        let moduleName: string;
                        if (Array.isArray(a.modules)) {
                            moduleName = a.modules.join(', ');
                        } else if (typeof a.module === 'string') {
                            moduleName = a.module;
                        } else {
                            moduleName = 'unknown';
                        }
                        return {
                            module: moduleName,
                            metric: a.metric ?? a.type ?? 'unknown',
                            severity: a.severity ?? 'info',
                        };
                    }),
                };
            }

            default:
                return data;
        }
    }

    /**
     * Format API response into human-readable text
     */
    private formatAPIResponse(capability: NLQCapability, response: unknown): string {
        const data = response as Record<string, unknown>;

        const formatters: Record<string, (d: Record<string, unknown>) => string> = {
            'supplier-dashboard': (d) =>
                `🏭 **Supplier Dashboard**\n` +
                `• Active Vendors: ${d.activeVendors}\n` +
                `• Pending POs: ${d.pendingPOs}\n` +
                `• On-Time Delivery: ${d.onTimeDeliveryRate}%\n` +
                `• Vendor Satisfaction: ${d.vendorSatisfaction}/5.0`,

            'supplier-risk-score': (d) =>
                `⚠️ **Supplier Risk Assessment**\n` +
                `• Vendor: ${d.vendorId}\n` +
                `• Overall Risk Score: ${d.overallRisk}/100\n` +
                `• Risk Factors: ${(d.riskFactors as string[])?.join(', ')}\n` +
                `• Trend: ${d.trend}`,

            'payment-dashboard': (d) =>
                `💳 **Payment Processing**\n` +
                `• Success Rate: ${d.successRate}%\n` +
                `• Avg Processing Time: ${d.avgProcessingTime}s\n` +
                `• Daily Volume: $${Number(d.dailyVolume).toLocaleString()}\n` +
                `• Dispute Rate: ${d.disputeRate}%`,

            'sync-health': (d) =>
                `🔄 **Sync Health**\n` +
                `• API Success Rate: ${d.apiSuccessRate}%\n` +
                `• Average Latency: ${d.avgLatency}ms\n` +
                `• Error Rate: ${d.errorRate}%\n` +
                `• Failed Messages: ${d.failedMessages}`,

            'customer-dashboard': (d) =>
                `👥 **Customer Metrics**\n` +
                `• Total Customers: ${Number(d.totalCustomers).toLocaleString()}\n` +
                `• Active Customers: ${Number(d.activeCustomers).toLocaleString()}\n` +
                `• Satisfaction Score: ${d.satisfactionScore}/5.0\n` +
                `• Churn Risk: ${d.churnRisk}%`,

            'inventory-dashboard': (d) =>
                `📦 **Inventory Status**\n` +
                `• Total SKUs: ${Number(d.totalSKUs).toLocaleString()}\n` +
                `• Low Stock Alerts: ${d.lowStockAlerts}\n` +
                `• Reorder Pending: ${d.reorderPending}\n` +
                `• Inventory Value: $${Number(d.inventoryValue).toLocaleString()}`,

            'finance-dashboard': (d) =>
                `💰 **Financial Overview**\n` +
                `• Cash Position: $${Number(d.cashPosition).toLocaleString()}\n` +
                `• AR Balance: $${Number(d.arBalance).toLocaleString()}\n` +
                `• AP Balance: $${Number(d.apBalance).toLocaleString()}\n` +
                `• Pending Approvals: ${d.pendingApprovals}`,

            'quality-dashboard': (d) =>
                `✅ **Quality Metrics**\n` +
                `• Inspections Today: ${d.inspectionsToday}\n` +
                `• Pass Rate: ${d.passRate}%\n` +
                `• Items On Hold: ${d.itemsOnHold}\n` +
                `• Pending Release: ${d.pendingRelease}`,

            'cross-module-metrics': (d) =>
                `📊 **Overall System Health: ${d.overallHealth}**\n` +
                `• Health Score: ${d.healthScore}/100\n` +
                `• Modules Healthy: ${d.modulesHealthy}\n` +
                `• Modules Degraded: ${d.modulesDegraded}\n` +
                `• Active Anomalies: ${d.activeAnomalies}`,

            'anomaly-detection': (d) => {
                const anomalies = d.anomalies as { module: string; metric: string; severity: string }[];
                if (!anomalies || anomalies.length === 0) {
                    return `🎉 **No Anomalies Detected**\nAll systems operating within normal parameters.`;
                }
                return `🚨 **Anomalies Detected: ${anomalies.length}**\n` +
                    anomalies.map(a => `• ${a.module}: ${a.metric} (${a.severity})`).join('\n');
            },
        };

        const formatter = formatters[capability.id];
        if (formatter) {
            return formatter(data);
        }

        // Default formatting
        return `📋 **${capability.name}**\n` +
            Object.entries(data)
                .map(([k, v]) => `• ${k}: ${v}`)
                .join('\n');
    }

    /**
     * Format final response for user
     */
    private formatResponse(capability: NLQCapability, execution: NLQExecutionResult): string {
        return execution.formattedResponse;
    }

    /**
     * Generate follow-up questions based on query context
     */
    private generateFollowUpQuestions(resolution: QueryResolution, execution: NLQExecutionResult): string[] {
        const questions: string[] = [];
        const module = resolution.capability.module;

        const followUpsByModule: Record<string, string[]> = {
            SupplierCentral: [
                'Which suppliers have the highest risk scores?',
                'Show me pending purchase orders.',
                'What\'s our on-time delivery trend?',
            ],
            PaymentCentral: [
                'What caused recent payment failures?',
                'Show me dispute trends.',
                'How can we improve success rate?',
            ],
            SyncCentral: [
                'What integrations are failing?',
                'Show me error logs.',
                'Which syncs need attention?',
            ],
            CustomerCentral: [
                'Which customers are at churn risk?',
                'How can we improve satisfaction?',
                'Show me customer feedback.',
            ],
            InventoryCentral: [
                'Which items need reordering?',
                'Show me stock levels by location.',
                'What\'s our inventory turnover?',
            ],
            QualityCentral: [
                'What\'s our pass rate trend?',
                'Show me items on hold.',
                'Which inspections are pending?',
            ],
            PayoutCentral: [
                'What payouts are pending?',
                'Show me failed payments.',
                'What\'s our payout volume this month?',
            ],
            InstallerCentral: [
                'Which installers are overbooked?',
                'Show me pending installations.',
                'What\'s our average installer rating?',
            ],
            ServiceCentral: [
                'What\'s our first-time fix rate?',
                'Show me open service tickets.',
                'Which issues are recurring?',
            ],
            FinanceCentral: [
                'What\'s our cash position?',
                'Show me pending approvals.',
                'What\'s our AR aging?',
            ],
            ContractCentral: [
                'Which contracts are expiring soon?',
                'Show me pending renewals.',
                'What\'s our contract value this quarter?',
            ],
        };

        questions.push(...(followUpsByModule[module] || [
            'Tell me more about this.',
            'What actions should I take?',
            'Show me related metrics.',
        ]));

        return questions.slice(0, 3);
    }

    private updateConversationMemory(
        sessionId: string,
        query: string,
        resolution: QueryResolution | null
    ): void {
        const now = new Date().toISOString();
        const sessionMemory = this.conversationMemory.get(sessionId) || {
            sessionId,
            queries: [],
            lastUpdated: now,
        };

        sessionMemory.lastUpdated = now;
        sessionMemory.queries.push({
            query,
            timestamp: now,
            resolution,
        });

        // Keep only last 10 queries
        if (sessionMemory.queries.length > 10) {
            sessionMemory.queries = sessionMemory.queries.slice(-10);
        }

        this.conversationMemory.set(sessionId, sessionMemory);

        // Clean up stale sessions (excluding current session)
        this.cleanupStaleSessions(sessionId);
    }

    /**
     * Clean up stale sessions to prevent memory leaks
     * @param excludeSessionId - Session ID to exclude from cleanup (the current active session)
     */
    private cleanupStaleSessions(excludeSessionId?: string): void {
        const now = Date.now();

        // Remove sessions older than TTL (excluding current session)
        for (const [sessionId, memory] of this.conversationMemory) {
            if (sessionId === excludeSessionId) continue;
            const lastUpdated = new Date(memory.lastUpdated).getTime();
            if (now - lastUpdated > SESSION_TTL_MS) {
                this.conversationMemory.delete(sessionId);
            }
        }

        // If still over limit, remove oldest sessions (excluding current session)
        if (this.conversationMemory.size > MAX_SESSIONS) {
            const sessions = Array.from(this.conversationMemory.entries())
                .filter(([id]) => id !== excludeSessionId)
                .sort((a, b) => new Date(a[1].lastUpdated).getTime() - new Date(b[1].lastUpdated).getTime());

            const toRemove = sessions.slice(0, this.conversationMemory.size - MAX_SESSIONS);
            for (const [sessionId] of toRemove) {
                this.conversationMemory.delete(sessionId);
            }
        }
    }

    /**
     * Detect if the query is a write/action intent vs a read query
     */
    private detectWriteIntent(query: string): boolean {
        const normalizedQuery = query.trim().toLowerCase();
        return WRITE_INTENT_PATTERNS.some(pattern => pattern.test(normalizedQuery));
    }

    /**
     * Handle write intent by delegating to NLActionGateService
     * Note: Enforces permission checks before allowing write actions
     */
    private async handleWriteIntent(
        request: NLQueryRequest,
        startTime: number,
        allowLLMFallback: boolean
    ): Promise<NLQueryResponse> {
        if (!this.nlActionGateService) {
            // Fallback if service not available
            return this.buildNoMatchResponse(request, Date.now() - startTime);
        }

        // P1 Fix: Enforce permission checks before write actions
        const userPermissions = this.getUserPermissions(request);
        const writePermissionCheck = this.checkWritePermissions(userPermissions);

        if (!writePermissionCheck.allowed) {
            this.logger.warn('Write action denied - insufficient permissions', {
                userId: request.userId,
                missingPermissions: writePermissionCheck.missingPermissions
            });
            return {
                success: false,
                query: request.query,
                resolution: null,
                execution: null,
                formattedAnswer: `⛔ **Permission Denied**\n\n` +
                    `You do not have permission to perform write actions.\n` +
                    `Missing permissions: ${writePermissionCheck.missingPermissions.join(', ')}`,
                followUpQuestions: ['What can I query instead?'],
                relatedCapabilities: [],
                isWriteAction: true,
                metadata: {
                    processingTimeMs: Date.now() - startTime,
                    confidenceScore: 0,
                    permissionCheck: writePermissionCheck,
                },
            };
        }

        const intent = allowLLMFallback
            ? await this.nlActionGateService.parseIntentSmart(request.query)
            : this.nlActionGateService.parseIntentQuiet(request.query);

        if (!intent) {
            // Could not parse as write intent, fallback
            return {
                success: false,
                query: request.query,
                resolution: null,
                execution: null,
                formattedAnswer: "I understood you want to perform an action, but I couldn't parse the details.\n" +
                    "Try phrases like:\n" +
                    "• \"Refund this customer $50\"\n" +
                    "• \"Create purchase order for Acme Corp\"\n" +
                    "• \"Update inventory for Widget A to 100\"",
                followUpQuestions: [
                    'Refund this customer',
                    'Create a purchase order',
                    'Update inventory levels'
                ],
                relatedCapabilities: [],
                isWriteAction: true,
                metadata: {
                    processingTimeMs: Date.now() - startTime,
                    confidenceScore: 0,
                    permissionCheck: { allowed: true, missingPermissions: [] },
                },
            };
        }

        // Propose the action (requires human approval)
        const proposedAction = this.nlActionGateService.proposeAction(intent);

        this.logger.info('Write intent detected, proposed action', {
            query: request.query,
            actionId: proposedAction.id,
            riskLevel: proposedAction.riskLevel,
            requiresApproval: proposedAction.requiresApproval
        });

        // Build response with proposed action
        return {
            success: true,
            query: request.query,
            resolution: null,
            execution: null,
            formattedAnswer: `🔐 **Action Proposed (Approval Required)**\n\n` +
                `**Action**: ${proposedAction.humanReadableDescription}\n` +
                `**Risk Level**: ${proposedAction.riskLevel.toUpperCase()}\n` +
                `**API Call**: \`${proposedAction.apiCall.method} ${proposedAction.apiCall.endpoint}\`\n\n` +
                `${proposedAction.estimatedImpact ? `⚠️ *${proposedAction.estimatedImpact}*\n\n` : ''}` +
                `Action ID: \`${proposedAction.id}\`\n\n` +
                `To approve: POST /api/nl-action-gate/actions/${proposedAction.id}/approve`,
            followUpQuestions: [
                'Approve this action',
                'Cancel this action',
                'Show me pending actions'
            ],
            relatedCapabilities: [],
            proposedAction,
            isWriteAction: true,
            metadata: {
                processingTimeMs: Date.now() - startTime,
                confidenceScore: intent.confidence,
                permissionCheck: { allowed: true, missingPermissions: [] },
            },
        };
    }

    /**
     * Extract user permissions from request context or use defaults
     */
    private getUserPermissions(request: NLQueryRequest): string[] {
        return request.context?.userPermissions || this.getDefaultPermissions(request.userId);
    }

    /**
     * Get default permissions for a user (would integrate with auth system)
     */
    private getDefaultPermissions(userId: string): string[] {
        // Default read permissions for all modules
        return [
            'supplier:read',
            'payment:read',
            'sync:read',
            'customer:read',
            'quality:read',
            'inventory:read',
            'finance:read',
            'payout:read',
            'installer:read',
            'service:read',
            'contract:read',
        ];
    }

    /**
     * Check if user has write permissions
     * Write actions require explicit write permissions
     */
    private checkWritePermissions(userPermissions: string[]): PermissionStatus {
        const writePermissions = userPermissions.filter(p => p.endsWith(':write') || p.endsWith(':admin'));

        if (writePermissions.length === 0) {
            return {
                allowed: false,
                missingPermissions: ['write:actions', 'admin:actions'],
            };
        }

        return {
            allowed: true,
            missingPermissions: [],
        };
    }

    /**
     * Build response when no matching capability found
     */
    private buildNoMatchResponse(request: NLQueryRequest, processingTimeMs: number): NLQueryResponse {
        return {
            success: false,
            query: request.query,
            resolution: null,
            execution: null,
            formattedAnswer: "I couldn't understand that query. Try asking about:\n" +
                "• Supplier metrics or risk scores\n" +
                "• Payment processing status\n" +
                "• Sync health and errors\n" +
                "• Customer satisfaction\n" +
                "• Inventory levels\n" +
                "• Financial metrics",
            followUpQuestions: [
                'Show me supplier metrics',
                'What\'s our sync health?',
                'How are payments performing?',
            ],
            relatedCapabilities: [],
            metadata: {
                processingTimeMs,
                confidenceScore: 0,
                permissionCheck: { allowed: true, missingPermissions: [] },
            },
        };
    }

    /**
     * Build response when permission denied
     */
    private buildPermissionDeniedResponse(
        request: NLQueryRequest,
        resolution: QueryResolution,
        permissionCheck: { allowed: boolean; missingPermissions: string[] },
        processingTimeMs: number
    ): NLQueryResponse {
        return {
            success: false,
            query: request.query,
            resolution,
            execution: null,
            formattedAnswer: `🔒 **Permission Denied**\n\n` +
                `You don't have permission to access ${resolution.capability.name}.\n` +
                `Missing permissions: ${permissionCheck.missingPermissions.join(', ')}`,
            followUpQuestions: ['What can I access?'],
            relatedCapabilities: [],
            metadata: {
                processingTimeMs,
                confidenceScore: resolution.confidence,
                permissionCheck: {
                    allowed: false,
                    missingPermissions: permissionCheck.missingPermissions,
                },
            },
        };
    }

    /**
     * Build response on execution error
     */
    private buildExecutionErrorResponse(
        request: NLQueryRequest,
        resolution: QueryResolution,
        processingTimeMs: number
    ): NLQueryResponse {
        return {
            success: false,
            query: request.query,
            resolution,
            execution: null,
            formattedAnswer: `❌ **Error Executing Query**\n\n` +
                `Failed to retrieve data from ${resolution.capability.name}.\n` +
                `Please try again or contact support.`,
            followUpQuestions: ['Try a different query', 'What else can I ask?'],
            relatedCapabilities: resolution.alternativeCapabilities.map(a => a.capability),
            metadata: {
                processingTimeMs,
                confidenceScore: resolution.confidence,
                permissionCheck: { allowed: true, missingPermissions: [] },
            },
        };
    }

    /**
     * Get conversation history for a session
     */
    getConversationHistory(sessionId: string): ConversationMemory | undefined {
        return this.conversationMemory.get(sessionId);
    }
}
