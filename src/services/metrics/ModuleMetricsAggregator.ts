/**
 * Module Metrics Aggregator Service
 * AI-Enhanced SuiteCentral 2.0 - Phase 1: Cross-Module Intelligence
 * 
 * Aggregates KPIs from all 11 SuiteCentral modules for unified monitoring,
 * anomaly detection, and cross-module correlation analysis.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import { fetchModuleData, useRealModuleApis } from '../../utils/moduleHttpClient';

// Module metric types for all 11 SuiteCentral modules
export interface ModuleMetrics {
    module: SuiteCentralModule;
    timestamp: string;
    kpis: Record<string, number>;
    health: ModuleHealth;
    trends: MetricTrend[];
}

export type SuiteCentralModule =
    | 'SupplierCentral'
    | 'PaymentCentral'
    | 'SyncCentral'
    | 'CustomerCentral'
    | 'QualityCentral'
    | 'PayoutCentral'
    | 'InstallerCentral'
    | 'ServiceCentral'
    | 'InventoryCentral'
    | 'FinanceCentral'
    | 'ContractCentral';

/**
 * Valid module names constant - shared across services and routers
 */
export const VALID_MODULES: readonly SuiteCentralModule[] = [
    'SupplierCentral', 'PaymentCentral', 'SyncCentral', 'CustomerCentral',
    'QualityCentral', 'PayoutCentral', 'InstallerCentral', 'ServiceCentral',
    'InventoryCentral', 'FinanceCentral', 'ContractCentral'
] as const;

/**
 * Type guard to validate if a string is a valid SuiteCentralModule
 */
export function isValidModule(module: string): module is SuiteCentralModule {
    return VALID_MODULES.includes(module as SuiteCentralModule);
}

export interface ModuleHealth {
    status: 'healthy' | 'degraded' | 'critical';
    score: number; // 0-100
    lastUpdated: string;
    issues: HealthIssue[];
}

export interface HealthIssue {
    severity: 'info' | 'warning' | 'critical';
    message: string;
    metric: string;
    timestamp: string;
}

export interface MetricTrend {
    metric: string;
    direction: 'improving' | 'stable' | 'declining';
    percentChange: number;
    period: '1h' | '24h' | '7d' | '30d';
}

export interface CrossModuleAnomaly {
    id: string;
    timestamp: string;
    modules: SuiteCentralModule[];
    severity: 'info' | 'warning' | 'critical';
    type: AnomalyType;
    metric: string;
    currentValue: number;
    expectedRange: { min: number; max: number };
    deviation: number;
    correlatedEvents: CorrelatedEvent[];
    suggestedActions: string[];
    confidence: number;
}

export type AnomalyType =
    | 'threshold_breach'
    | 'trend_deviation'
    | 'correlation_break'
    | 'pattern_anomaly'
    | 'seasonality_deviation';

export interface CorrelatedEvent {
    module: SuiteCentralModule;
    event: string;
    timestamp: string;
    relevanceScore: number;
}

export interface AggregatedMetrics {
    timestamp: string;
    modules: Map<SuiteCentralModule, ModuleMetrics>;
    overallHealth: ModuleHealth;
    anomalies: CrossModuleAnomaly[];
    correlations: ModuleCorrelation[];
}

export interface ModuleCorrelation {
    sourceModule: SuiteCentralModule;
    targetModule: SuiteCentralModule;
    correlationType: 'causal' | 'temporal' | 'statistical';
    strength: number; // -1 to 1 (Pearson correlation coefficient)
    description: string;
    confidence: number; // 0-1 based on sample size
    sampleSize: number; // Number of data points used
}

// API endpoint paths for each module
const MODULE_ENDPOINTS: Record<SuiteCentralModule, string> = {
    SupplierCentral: '/api/supplier-central/dashboard',
    PaymentCentral: '/api/payment-central/dashboard',
    SyncCentral: '/api/sync-orchestrator/dashboard',
    CustomerCentral: '/api/customer-central/dashboard',
    QualityCentral: '/api/quality-central/dashboard',
    PayoutCentral: '/api/payout-central/dashboard',
    InstallerCentral: '/api/installer-central/dashboard',
    ServiceCentral: '/api/service-central/dashboard',
    InventoryCentral: '/api/inventory-central/dashboard',
    FinanceCentral: '/api/finance-central/dashboard',
    ContractCentral: '/api/contract-central/dashboard',
};

// Thresholds for anomaly detection per module
const ANOMALY_THRESHOLDS: Record<SuiteCentralModule, Record<string, { min: number; max: number }>> = {
    SupplierCentral: {
        onTimeDeliveryRate: { min: 85, max: 100 },
        pendingPOs: { min: 0, max: 500 },
        vendorSatisfaction: { min: 3.5, max: 5.0 },
    },
    PaymentCentral: {
        successRate: { min: 95, max: 100 },
        disputeRate: { min: 0, max: 3 },
        avgProcessingTime: { min: 0, max: 5 },
    },
    SyncCentral: {
        apiSuccessRate: { min: 98, max: 100 },
        avgLatency: { min: 0, max: 500 },
        errorRate: { min: 0, max: 2 },
    },
    CustomerCentral: {
        satisfactionScore: { min: 4.0, max: 5.0 },
        churnRisk: { min: 0, max: 15 },
        responseTime: { min: 0, max: 24 },
    },
    QualityCentral: {
        passRate: { min: 90, max: 100 },
        itemsOnHold: { min: 0, max: 50 },
        inspectionsBacklog: { min: 0, max: 20 },
    },
    PayoutCentral: {
        pendingPayouts: { min: 0, max: 200 },
        failedPayments: { min: 0, max: 10 },
        processingDelay: { min: 0, max: 48 },
    },
    InstallerCentral: {
        avgRating: { min: 4.0, max: 5.0 },
        pendingJobs: { min: 0, max: 100 },
        utilizationRate: { min: 60, max: 100 },
    },
    ServiceCentral: {
        firstTimeFixRate: { min: 80, max: 100 },
        openTickets: { min: 0, max: 150 },
        avgResolutionTime: { min: 0, max: 72 },
    },
    InventoryCentral: {
        stockoutRate: { min: 0, max: 5 },
        lowStockAlerts: { min: 0, max: 50 },
        turnoverRatio: { min: 4, max: 20 },
    },
    FinanceCentral: {
        cashPosition: { min: 500000, max: 100000000 },
        pendingApprovals: { min: 0, max: 50 },
        arAgingDays: { min: 0, max: 45 },
    },
    ContractCentral: {
        expiringSoon: { min: 0, max: 30 },
        renewalRate: { min: 75, max: 100 },
        activeContracts: { min: 100, max: 10000 },
    },
};

@injectable()
export class ModuleMetricsAggregator {
    private metricsCache = new Map<SuiteCentralModule, ModuleMetrics>();
    private anomalyHistory: CrossModuleAnomaly[] = [];

    // Time-series health score history for correlation analysis
    private healthScoreHistory = new Map<SuiteCentralModule, { timestamp: number; score: number }[]>();
    private readonly HISTORY_WINDOW_SIZE = 50; // Keep last 50 data points
    private readonly MIN_CORRELATION_SAMPLES = 5; // Minimum samples for correlation

    // Mutex flag to prevent concurrent metric collection (avoid race conditions).
    // Note: Simple boolean mutex has a small race window; acceptable for Phase 1 with
    // mock data. For production with high concurrency, consider async-mutex library.
    private isCollecting = false;

    constructor(
        @inject(TYPES.Logger) private logger: Logger
    ) {
        this.logger.info('ModuleMetricsAggregator initialized for cross-module intelligence');
    }

    /**
     * Collect metrics from all 11 SuiteCentral modules
     * Uses a mutex flag to prevent concurrent collection and race conditions
     */
    async collectAllModuleMetrics(): Promise<AggregatedMetrics> {
        // Prevent concurrent collection to avoid race conditions on healthScoreHistory
        if (this.isCollecting) {
            this.logger.warn('Metric collection already in progress, returning cached data');
            return {
                timestamp: new Date().toISOString(),
                modules: this.metricsCache,
                overallHealth: this.calculateOverallHealth(this.metricsCache),
                anomalies: this.anomalyHistory.slice(-50),
                correlations: this.detectCrossModuleCorrelations(this.metricsCache),
            };
        }

        this.isCollecting = true;
        const timestamp = new Date().toISOString();
        const modules = new Map<SuiteCentralModule, ModuleMetrics>();
        const anomalies: CrossModuleAnomaly[] = [];

        try {
            this.logger.info('Collecting metrics from all SuiteCentral modules');

            // Collect from each module in parallel
            const moduleNames = Object.keys(MODULE_ENDPOINTS) as SuiteCentralModule[];
            const metricsPromises = moduleNames.map(async (module) => {
                try {
                    const metrics = await this.fetchModuleMetrics(module);
                    modules.set(module, metrics);
                    this.metricsCache.set(module, metrics);

                    // Record health score for correlation analysis
                    this.recordHealthScore(module, metrics.health.score);

                    // Check for anomalies
                    const moduleAnomalies = this.detectAnomalies(module, metrics);
                    anomalies.push(...moduleAnomalies);
                } catch (error) {
                    this.logger.error(`Failed to collect metrics for ${module}`, error);
                }
            });

            await Promise.all(metricsPromises);

            // Detect cross-module correlations
            const correlations = this.detectCrossModuleCorrelations(modules);

            // Calculate overall health
            const overallHealth = this.calculateOverallHealth(modules);

            return {
                timestamp,
                modules,
                overallHealth,
                anomalies,
                correlations,
            };
        } finally {
            this.isCollecting = false;
        }
    }

    /**
     * Fetch metrics from a specific module's dashboard API.
     * Uses real HTTP when USE_REAL_MODULE_APIS=true, otherwise returns mock data.
     */
    private async fetchModuleMetrics(module: SuiteCentralModule): Promise<ModuleMetrics> {
        const endpoint = MODULE_ENDPOINTS[module];

        try {
            // Get mock data as fallback
            const mockKpis = await this.getMockModuleKPIs(module);

            // Try real API if feature flag enabled, otherwise use mock data
            // fetchModuleData handles the feature flag check internally
            const baseUrl = process.env.MODULE_API_BASE_URL || 'http://localhost:3000';
            const fullEndpoint = `${baseUrl}${endpoint}`;

            const kpis = await fetchModuleData<Record<string, number>>(
                fullEndpoint,
                mockKpis,
                this.logger,
                { timeoutMs: 5000 }
            );

            if (useRealModuleApis()) {
                this.logger.debug('Using real module API data', { module, endpoint });
            }

            return {
                module,
                timestamp: new Date().toISOString(),
                kpis,
                health: this.calculateModuleHealth(module, kpis),
                trends: this.calculateTrends(module, kpis),
            };
        } catch (error) {
            this.logger.error(`Error fetching metrics for ${module} from ${endpoint}`, error);
            throw error;
        }
    }

    /**
     * Get mock KPIs for each module (would be replaced with real API calls)
     */
    private async getMockModuleKPIs(module: SuiteCentralModule): Promise<Record<string, number>> {
        // Mock KPIs aligned with ANOMALY_THRESHOLDS keys for proper anomaly detection
        const mockKPIs: Record<SuiteCentralModule, Record<string, number>> = {
            SupplierCentral: {
                activeVendors: 234,
                pendingPOs: 67,
                onTimeDeliveryRate: 94.2,
                vendorSatisfaction: 4.7,
            },
            PaymentCentral: {
                successRate: 98.5,
                avgProcessingTime: 2.3,
                dailyVolume: 4500000,
                disputeRate: 0.8,
            },
            SyncCentral: {
                apiSuccessRate: 99.8,
                avgLatency: 245,
                errorRate: 0.2,
                failedMessages: 23,
            },
            CustomerCentral: {
                totalCustomers: 1250,
                activeCustomers: 892,
                satisfactionScore: 4.5,
                churnRisk: 8.2,
                responseTime: 4.5, // Added: aligns with threshold
            },
            QualityCentral: {
                inspectionsToday: 47,
                passRate: 94.2,
                itemsOnHold: 12,
                pendingRelease: 8,
                inspectionsBacklog: 8, // Added: aligns with threshold
            },
            PayoutCentral: {
                pendingPayouts: 156,
                processedToday: 89,
                failedPayments: 3,
                totalPendingAmount: 47300,
                processingDelay: 12, // Added: aligns with threshold
            },
            InstallerCentral: {
                activeInstallers: 234,
                pendingJobs: 67,
                completedToday: 45,
                avgRating: 4.7,
                utilizationRate: 78, // Added: aligns with threshold
            },
            ServiceCentral: {
                openTickets: 89,
                dispatchedToday: 34,
                firstTimeFixRate: 87.5,
                avgResolutionTime: 4.2,
            },
            InventoryCentral: {
                totalSKUs: 4567,
                lowStockAlerts: 23,
                reorderPending: 15,
                inventoryValue: 2340000,
                stockoutRate: 2.1, // Added: aligns with threshold
                turnoverRatio: 8.5, // Added: aligns with threshold
            },
            FinanceCentral: {
                cashPosition: 3500000,
                arBalance: 890000,
                apBalance: 450000,
                pendingApprovals: 12,
                arAgingDays: 32, // Added: aligns with threshold
            },
            ContractCentral: {
                activeContracts: 342,
                expiringSoon: 18,
                pendingRenewals: 7,
                totalValue: 4500000,
                renewalRate: 92, // Added: aligns with threshold
            },
        };

        return mockKPIs[module] || {};
    }

    /**
     * Calculate health score for a module based on KPIs
     */
    private calculateModuleHealth(module: SuiteCentralModule, kpis: Record<string, number>): ModuleHealth {
        const thresholds = ANOMALY_THRESHOLDS[module];
        const issues: HealthIssue[] = [];
        let healthScore = 100;

        for (const [metric, value] of Object.entries(kpis)) {
            const threshold = thresholds[metric];
            if (threshold) {
                if (value < threshold.min) {
                    const severity = value < threshold.min * 0.8 ? 'critical' : 'warning';
                    issues.push({
                        severity,
                        message: `${metric} is below threshold (${value} < ${threshold.min})`,
                        metric,
                        timestamp: new Date().toISOString(),
                    });
                    healthScore -= severity === 'critical' ? 25 : 10;
                } else if (value > threshold.max) {
                    const severity = value > threshold.max * 1.2 ? 'critical' : 'warning';
                    issues.push({
                        severity,
                        message: `${metric} exceeds threshold (${value} > ${threshold.max})`,
                        metric,
                        timestamp: new Date().toISOString(),
                    });
                    healthScore -= severity === 'critical' ? 25 : 10;
                }
            }
        }

        healthScore = Math.max(0, healthScore);

        return {
            status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'critical',
            score: healthScore,
            lastUpdated: new Date().toISOString(),
            issues,
        };
    }

    /**
     * Calculate trends for metrics over time
     */
    private calculateTrends(module: SuiteCentralModule, kpis: Record<string, number>): MetricTrend[] {
        const trends: MetricTrend[] = [];
        const cachedMetrics = this.metricsCache.get(module);

        // Metrics where an increase is bad (higher = worse)
        const negativeMetrics = new Set([
            'disputeRate', 'errorRate', 'churnRisk', 'processingDelay',
            'failedPayments', 'stockoutRate', 'arAgingDays', 'pendingPOs',
            'itemsOnHold', 'openTickets', 'avgResolutionTime', 'avgLatency',
            'expiringSoon', 'lowStockAlerts', 'pendingApprovals'
        ]);

        for (const [metric, currentValue] of Object.entries(kpis)) {
            const previousValue = cachedMetrics?.kpis[metric];
            if (previousValue !== undefined) {
                // Handle division by zero/near-zero: avoid misleading extreme percentages
                const NEAR_ZERO_THRESHOLD = 0.01;
                let percentChange: number;
                if (Math.abs(previousValue) < NEAR_ZERO_THRESHOLD) {
                    // Near-zero values produce unstable percentages; use absolute change instead
                    percentChange = currentValue - previousValue;
                } else {
                    percentChange = ((currentValue - previousValue) / previousValue) * 100;
                }

                // For negative metrics, decreases are improving
                const isNegativeMetric = negativeMetrics.has(metric);
                let direction: 'improving' | 'stable' | 'declining';
                if (Math.abs(percentChange) <= 1) {
                    direction = 'stable';
                } else if (isNegativeMetric) {
                    direction = percentChange < 0 ? 'improving' : 'declining';
                } else {
                    direction = percentChange > 0 ? 'improving' : 'declining';
                }

                trends.push({
                    metric,
                    direction,
                    percentChange,
                    period: '1h',
                });
            }
        }

        return trends;
    }

    /**
     * Detect anomalies in module metrics
     */
    private detectAnomalies(module: SuiteCentralModule, metrics: ModuleMetrics): CrossModuleAnomaly[] {
        const anomalies: CrossModuleAnomaly[] = [];
        const thresholds = ANOMALY_THRESHOLDS[module];

        for (const [metric, value] of Object.entries(metrics.kpis)) {
            const threshold = thresholds[metric];
            if (threshold && (value < threshold.min || value > threshold.max)) {
                // Use absolute difference when threshold is 0 for more meaningful deviation
                let deviation: number;
                if (value < threshold.min) {
                    deviation = threshold.min === 0
                        ? Math.abs(value - threshold.min)
                        : (threshold.min - value) / threshold.min;
                } else {
                    deviation = threshold.max === 0
                        ? Math.abs(value - threshold.max)
                        : (value - threshold.max) / threshold.max;
                }

                anomalies.push({
                    id: `${module}-${metric}-${Date.now()}`,
                    timestamp: new Date().toISOString(),
                    modules: [module],
                    severity: deviation > 0.3 ? 'critical' : deviation > 0.1 ? 'warning' : 'info',
                    type: 'threshold_breach',
                    metric,
                    currentValue: value,
                    expectedRange: threshold,
                    deviation: deviation * 100,
                    correlatedEvents: [],
                    suggestedActions: this.generateSuggestedActions(module, metric, value, threshold),
                    confidence: 0.95,
                });
            }
        }

        this.anomalyHistory.push(...anomalies);

        // Limit anomaly history size to prevent memory leaks using in-place splice
        const MAX_ANOMALY_HISTORY = 1000;
        const CLEANUP_BATCH_SIZE = 100;
        if (this.anomalyHistory.length > MAX_ANOMALY_HISTORY + CLEANUP_BATCH_SIZE) {
            // Batch cleanup: remove excess entries in-place
            const excess = this.anomalyHistory.length - MAX_ANOMALY_HISTORY;
            this.anomalyHistory.splice(0, excess);
        }

        return anomalies;
    }

    /**
     * Generate suggested actions for anomalies
     */
    private generateSuggestedActions(
        module: SuiteCentralModule,
        metric: string,
        value: number,
        threshold: { min: number; max: number }
    ): string[] {
        const isBelow = value < threshold.min;

        const actionsByModule: Record<string, string[]> = {
            SupplierCentral: isBelow
                ? ['Review supplier performance', 'Contact underperforming vendors', 'Identify backup suppliers']
                : ['Evaluate vendor capacity', 'Consider order throttling', 'Review procurement policies'],
            PaymentCentral: isBelow
                ? ['Investigate failed transactions', 'Review processor status', 'Check for system issues']
                : ['Review dispute patterns', 'Adjust fraud detection', 'Update payment policies'],
            SyncCentral: isBelow
                ? ['Check integration health', 'Review error logs', 'Restart failed syncs']
                : ['Investigate bottlenecks', 'Optimize data flows', 'Scale infrastructure'],
            CustomerCentral: isBelow
                ? ['Review customer feedback', 'Improve support response', 'Launch retention campaign']
                : ['Investigate churn drivers', 'Review pricing strategy', 'Enhance customer experience'],
            QualityCentral: isBelow
                ? ['Investigate defect causes', 'Review inspection checkpoints', 'Tighten quality control procedures']
                : ['Analyze defect patterns', 'Update quality standards', 'Share best practices with suppliers'],
            PayoutCentral: isBelow
                ? ['Verify payout calculations', 'Check pending approvals', 'Communicate with payees about delays']
                : ['Review payout rules', 'Validate high-value payouts for anomalies', 'Monitor payout frequency trends'],
            InstallerCentral: isBelow
                ? ['Review installer schedules', 'Identify capacity or skills gaps', 'Prioritize overdue installations']
                : ['Check for overbooking risks', 'Balance workload across installers', 'Optimize routing and time slots'],
            ServiceCentral: isBelow
                ? ['Review open service tickets', 'Improve triage and prioritization', 'Deploy additional support resources']
                : ['Investigate repeat issues', 'Optimize first-time fix processes', 'Enhance knowledge base content'],
            InventoryCentral: isBelow
                ? ['Check stock accuracy', 'Adjust reorder points', 'Coordinate replenishment with suppliers']
                : ['Review excess or obsolete inventory', 'Optimize safety stock levels', 'Plan clearance or transfers'],
            FinanceCentral: isBelow
                ? ['Review cash flow forecasts', 'Delay non-essential spending', 'Reconcile critical accounts']
                : ['Validate unusual revenue or margin spikes', 'Review financial controls', 'Update budget and forecasts'],
            ContractCentral: isBelow
                ? ['Review contract pipeline and renewals', 'Identify at-risk contracts', 'Engage account owners for recovery plans']
                : ['Investigate aggressive terms or discounts', 'Validate contract compliance', 'Update contract approval policies'],
        };

        return actionsByModule[module] || ['Review metrics', 'Investigate root cause', 'Contact support'];
    }

    /**
     * Record health score for a module (for time-series correlation analysis)
     */
    private recordHealthScore(module: SuiteCentralModule, score: number): void {
        let history = this.healthScoreHistory.get(module);
        if (!history) {
            history = [];
            this.healthScoreHistory.set(module, history);
        }

        history.push({ timestamp: Date.now(), score });

        // Keep only recent history
        if (history.length > this.HISTORY_WINDOW_SIZE) {
            history.splice(0, history.length - this.HISTORY_WINDOW_SIZE);
        }
    }

    /**
     * Calculate Pearson correlation coefficient between two arrays
     * Returns value from -1 (negative correlation) to 1 (positive correlation)
     */
    private calculatePearsonCorrelation(x: number[], y: number[]): number {
        const n = Math.min(x.length, y.length);
        if (n < 2) return 0;

        // Calculate means
        const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
        const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

        // Calculate covariance and standard deviations
        let covariance = 0;
        let stdDevX = 0;
        let stdDevY = 0;

        for (let i = 0; i < n; i++) {
            const diffX = x[i] - meanX;
            const diffY = y[i] - meanY;
            covariance += diffX * diffY;
            stdDevX += diffX * diffX;
            stdDevY += diffY * diffY;
        }

        // Guard against division by zero
        if (stdDevX === 0 || stdDevY === 0) {
            return 0;
        }

        return covariance / Math.sqrt(stdDevX * stdDevY);
    }

    /**
     * Get aligned health score arrays for two modules
     */
    private getAlignedHealthScores(
        source: SuiteCentralModule,
        target: SuiteCentralModule
    ): { sourceScores: number[]; targetScores: number[]; sampleSize: number } {
        const sourceHistory = this.healthScoreHistory.get(source) || [];
        const targetHistory = this.healthScoreHistory.get(target) || [];

        // Match by timestamp proximity (within 60 seconds)
        const TIMESTAMP_TOLERANCE = 60000;
        const sourceScores: number[] = [];
        const targetScores: number[] = [];

        for (const sourcePoint of sourceHistory) {
            const matchingTarget = targetHistory.find(
                tp => Math.abs(tp.timestamp - sourcePoint.timestamp) < TIMESTAMP_TOLERANCE
            );
            if (matchingTarget) {
                sourceScores.push(sourcePoint.score);
                targetScores.push(matchingTarget.score);
            }
        }

        return { sourceScores, targetScores, sampleSize: sourceScores.length };
    }

    /**
     * Detect correlations between modules using Pearson correlation coefficient
     */
    private detectCrossModuleCorrelations(modules: Map<SuiteCentralModule, ModuleMetrics>): ModuleCorrelation[] {
        const correlations: ModuleCorrelation[] = [];

        // Known causal relationships between modules
        const knownCorrelations = [
            {
                source: 'SupplierCentral' as SuiteCentralModule,
                target: 'QualityCentral' as SuiteCentralModule,
                type: 'causal' as const,
                description: 'Supplier delivery issues may impact quality inspection backlog',
            },
            {
                source: 'InventoryCentral' as SuiteCentralModule,
                target: 'InstallerCentral' as SuiteCentralModule,
                type: 'causal' as const,
                description: 'Low stock alerts may delay installation jobs',
            },
            {
                source: 'CustomerCentral' as SuiteCentralModule,
                target: 'ServiceCentral' as SuiteCentralModule,
                type: 'temporal' as const,
                description: 'Customer satisfaction correlates with first-time fix rate',
            },
            {
                source: 'PaymentCentral' as SuiteCentralModule,
                target: 'FinanceCentral' as SuiteCentralModule,
                type: 'causal' as const,
                description: 'Payment failures directly impact cash position',
            },
            {
                source: 'ContractCentral' as SuiteCentralModule,
                target: 'PayoutCentral' as SuiteCentralModule,
                type: 'temporal' as const,
                description: 'Contract renewals trigger commission payouts',
            },
        ];

        // Calculate correlation strength using Pearson correlation on historical data
        for (const known of knownCorrelations) {
            const sourceMetrics = modules.get(known.source);
            const targetMetrics = modules.get(known.target);

            if (sourceMetrics && targetMetrics) {
                // Get aligned health score history
                const { sourceScores, targetScores, sampleSize } = this.getAlignedHealthScores(
                    known.source,
                    known.target
                );

                let strength: number;
                let confidence: number;

                if (sampleSize >= this.MIN_CORRELATION_SAMPLES) {
                    // Use Pearson correlation for statistical strength
                    strength = this.calculatePearsonCorrelation(sourceScores, targetScores);
                    // Confidence increases with sample size (asymptotic to 1)
                    confidence = 1 - Math.exp(-sampleSize / 20);
                } else {
                    // Fallback: use health score similarity when not enough historical data
                    strength = 1 - Math.abs(sourceMetrics.health.score - targetMetrics.health.score) / 100;
                    confidence = sampleSize / this.MIN_CORRELATION_SAMPLES;
                }

                correlations.push({
                    sourceModule: known.source,
                    targetModule: known.target,
                    correlationType: known.type,
                    strength: Math.round(strength * 1000) / 1000,
                    description: known.description,
                    confidence: Math.round(confidence * 100) / 100,
                    sampleSize,
                });
            }
        }

        return correlations;
    }

    /**
     * Calculate overall system health from all modules
     */
    private calculateOverallHealth(modules: Map<SuiteCentralModule, ModuleMetrics>): ModuleHealth {
        const healthScores = Array.from(modules.values()).map(m => m.health.score);

        // Guard against empty module set to prevent NaN from 0/0
        if (healthScores.length === 0) {
            return {
                status: 'critical',
                score: 0,
                lastUpdated: new Date().toISOString(),
                issues: [],
            };
        }

        const avgHealth = healthScores.reduce((a, b) => a + b, 0) / healthScores.length;

        const allIssues = Array.from(modules.values())
            .flatMap(m => m.health.issues)
            .filter(i => i.severity !== 'info');

        return {
            status: avgHealth >= 80 ? 'healthy' : avgHealth >= 50 ? 'degraded' : 'critical',
            score: avgHealth,
            lastUpdated: new Date().toISOString(),
            issues: allIssues,
        };
    }

    /**
     * Get recent anomalies across all modules
     */
    getRecentAnomalies(limit = 50): CrossModuleAnomaly[] {
        return this.anomalyHistory.slice(-limit);
    }

    /**
     * Get cached metrics for a specific module
     */
    getModuleMetrics(module: SuiteCentralModule): ModuleMetrics | undefined {
        return this.metricsCache.get(module);
    }

    /**
     * Get all correlations between modules
     */
    getCorrelations(): ModuleCorrelation[] {
        // Return correlations computed from cached metrics
        return this.detectCrossModuleCorrelations(this.metricsCache);
    }
}
