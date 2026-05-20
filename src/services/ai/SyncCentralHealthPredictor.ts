/**
 * SyncCentral Health Predictor Service
 * 
 * ML-based failure prediction for integrations. Analyzes sync job history
 * to predict integration failures before they occur.
 * 
 * Phase 2 Implementation - AI-Enhanced SuiteCentral 2.0
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';
import { fetchModuleData, useRealModuleApis } from '../../utils/moduleHttpClient';

// SuiteCentral modules for type safety
type SyncCentralModule = 'SyncCentral';

// Health prediction risk levels
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// Trend direction
type TrendDirection = 'improving' | 'stable' | 'degrading' | 'volatile';

/**
 * Early warning indicator for potential issues
 */
interface EarlyWarning {
    id: string;
    metric: string;
    trend: TrendDirection;
    deviation: number;  // Standard deviations from normal
    description: string;
    severity: RiskLevel;
    detectedAt: string;
}

/**
 * Historical data point for trend analysis
 */
interface HistoricalDataPoint {
    timestamp: string;
    successRate: number;
    avgLatencyMs: number;
    errorCount: number;
    recordsProcessed: number;
}

/**
 * Integration health baseline
 */
interface HealthBaseline {
    integrationId: string;
    avgSuccessRate: number;
    avgLatencyMs: number;
    avgErrorRate: number;
    stdDevSuccessRate: number;
    stdDevLatencyMs: number;
    stdDevErrorRate: number;
    dataPoints: number;
    lastUpdated: string;
}

/**
 * Health prediction for a single integration
 */
export interface SyncHealthPrediction {
    integrationId: string;
    integrationName: string;
    connectorType: string;
    failureProbability: number;  // 0-1
    predictedFailureWindow?: string;  // e.g., "next 24 hours"
    riskLevel: RiskLevel;
    currentHealth: {
        successRate: number;
        avgLatencyMs: number;
        errorRate: number;
        lastSyncTime?: string;
    };
    earlyWarnings: EarlyWarning[];
    recommendedActions: string[];
    confidence: number;
    analysisTimestamp: string;
}

/**
 * Aggregated health prediction response
 */
export interface SyncHealthPredictionResponse {
    success: boolean;
    timestamp: string;
    overallHealth: {
        status: 'healthy' | 'degraded' | 'critical';
        score: number;  // 0-100
        integrationsAtRisk: number;
        totalIntegrations: number;
    };
    predictions: SyncHealthPrediction[];
    systemAlerts: SystemAlert[];
}

/**
 * System-level alert
 */
interface SystemAlert {
    id: string;
    severity: RiskLevel;
    title: string;
    message: string;
    affectedIntegrations: string[];
    suggestedActions: string[];
    createdAt: string;
}

/**
 * Configuration for the predictor
 */
interface PredictorConfig {
    // Thresholds for risk levels
    lowRiskMaxProbability: number;
    mediumRiskMaxProbability: number;
    highRiskMaxProbability: number;
    // Early warning thresholds (standard deviations)
    warningDeviationThreshold: number;
    criticalDeviationThreshold: number;
    // Analysis window
    analysisWindowHours: number;
    // Weights for failure probability calculation
    weights: {
        recentErrorRate: number;
        latencyTrend: number;
        successRateTrend: number;
        historicalReliability: number;
    };
}

const DEFAULT_CONFIG: PredictorConfig = {
    lowRiskMaxProbability: 0.2,
    mediumRiskMaxProbability: 0.5,
    highRiskMaxProbability: 0.8,
    warningDeviationThreshold: 1.5,
    criticalDeviationThreshold: 2.5,
    analysisWindowHours: 24,
    weights: {
        recentErrorRate: 0.35,
        latencyTrend: 0.2,
        successRateTrend: 0.3,
        historicalReliability: 0.15,
    },
};

/**
 * Mock integration data for demo mode
 */
const MOCK_INTEGRATIONS = [
    { id: 'int-001', name: 'NetSuite → Salesforce', connectorType: 'netsuite', baseSuccessRate: 0.98 },
    { id: 'int-002', name: 'SAP → Business Central', connectorType: 'sap', baseSuccessRate: 0.95 },
    { id: 'int-003', name: 'HubSpot → NetSuite', connectorType: 'hubspot', baseSuccessRate: 0.99 },
    { id: 'int-004', name: 'ShipStation → WMS', connectorType: 'shipstation', baseSuccessRate: 0.92 },
    { id: 'int-005', name: 'Stripe → NetSuite', connectorType: 'stripe', baseSuccessRate: 0.97 },
    { id: 'int-006', name: 'Oracle → Data Lake', connectorType: 'oracle', baseSuccessRate: 0.88 },
    { id: 'int-007', name: 'QuickBooks → Reporting', connectorType: 'quickbooks', baseSuccessRate: 0.96 },
    { id: 'int-008', name: 'Shopify → Inventory', connectorType: 'shopify', baseSuccessRate: 0.94 },
];

/**
 * API endpoint for SyncCentral integrations list
 */
const SYNC_CENTRAL_INTEGRATIONS_ENDPOINT = '/api/sync-orchestrator/integrations';

/** Integration data structure from API */
interface IntegrationData {
    id: string;
    name: string;
    connectorType: string;
    baseSuccessRate?: number;
}

@injectable()
export class SyncCentralHealthPredictor {
    private readonly logger: Logger;
    private readonly config: PredictorConfig;
    private baselines = new Map<string, HealthBaseline>();
    private historicalData = new Map<string, HistoricalDataPoint[]>();
    private integrations: IntegrationData[] = [...MOCK_INTEGRATIONS];
    private dataInitialized = false;

    constructor(
        @inject(TYPES.Logger) loggerInstance?: Logger
    ) {
        this.logger = loggerInstance || logger;
        this.config = DEFAULT_CONFIG;
        this.initializeMockData();
    }

    /**
     * Fetch real integration data from SyncCentral API if feature flag enabled.
     * Falls back to mock data if API is unavailable.
     */
    private async fetchRealIntegrations(): Promise<IntegrationData[]> {
        const baseUrl = process.env.MODULE_API_BASE_URL || 'http://localhost:3000';
        const endpoint = `${baseUrl}${SYNC_CENTRAL_INTEGRATIONS_ENDPOINT}`;

        const result = await fetchModuleData<{ integrations?: IntegrationData[] }>(
            endpoint,
            { integrations: MOCK_INTEGRATIONS },
            this.logger,
            { timeoutMs: 5000 }
        );

        // Transform API response to our internal format
        const integrations = result.integrations || MOCK_INTEGRATIONS;

        // Ensure baseSuccessRate is set (default to 0.95 if not provided)
        return integrations.map(int => ({
            ...int,
            baseSuccessRate: int.baseSuccessRate ?? 0.95,
        }));
    }

    /**
     * Ensure data is initialized, fetching real data if feature flag enabled.
     * This is called lazily before predictions to support async data fetching.
     */
    private async ensureDataInitialized(): Promise<void> {
        if (this.dataInitialized && !useRealModuleApis()) {
            return; // Already initialized with mock data
        }

        if (useRealModuleApis()) {
            try {
                const realIntegrations = await this.fetchRealIntegrations();
                this.integrations = realIntegrations;

                // Clear mock data and rebuild baselines/history for real integrations
                // This ensures predictions work correctly with real integration IDs
                this.baselines.clear();
                this.historicalData.clear();
                this.rebuildBaselinesForIntegrations(realIntegrations);

                this.logger.info('Using real SyncCentral integration data', {
                    count: realIntegrations.length,
                });
            } catch (error) {
                this.logger.warn('Failed to fetch real integrations, using mock data', { error });
                this.integrations = [...MOCK_INTEGRATIONS];
            }
        }

        this.dataInitialized = true;
    }

    /**
     * Rebuild baselines and historical data for a list of integrations.
     * Used when switching from mock to real API data.
     */
    private rebuildBaselinesForIntegrations(integrations: IntegrationData[]): void {
        for (const integration of integrations) {
            // Generate historical data points (last 24 hours, hourly)
            const history: HistoricalDataPoint[] = [];
            const now = Date.now();

            for (let i = 24; i >= 0; i--) {
                const timestamp = new Date(now - i * 60 * 60 * 1000).toISOString();
                const variation = (Math.random() - 0.5) * 0.1;
                const successRate = Math.min(1, Math.max(0.7, (integration.baseSuccessRate ?? 0.95) + variation));

                history.push({
                    timestamp,
                    successRate,
                    avgLatencyMs: 200 + Math.random() * 300,
                    errorCount: Math.floor((1 - successRate) * 100),
                    recordsProcessed: 500 + Math.floor(Math.random() * 1000),
                });
            }

            this.historicalData.set(integration.id, history);

            // Calculate baseline from history
            const avgSuccessRate = history.reduce((sum, p) => sum + p.successRate, 0) / history.length;
            const avgLatencyMs = history.reduce((sum, p) => sum + p.avgLatencyMs, 0) / history.length;
            const avgErrorRate = history.reduce((sum, p) => sum + (p.errorCount / p.recordsProcessed), 0) / history.length;

            const stdDevSuccessRate = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow(p.successRate - avgSuccessRate, 2), 0) / history.length
            );
            const stdDevLatencyMs = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow(p.avgLatencyMs - avgLatencyMs, 2), 0) / history.length
            );
            const stdDevErrorRate = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow((p.errorCount / p.recordsProcessed) - avgErrorRate, 2), 0) / history.length
            );

            this.baselines.set(integration.id, {
                integrationId: integration.id,
                avgSuccessRate,
                stdDevSuccessRate,
                avgLatencyMs,
                stdDevLatencyMs,
                avgErrorRate,
                stdDevErrorRate,
                dataPoints: history.length,
                lastUpdated: new Date().toISOString(),
            });
        }
    }

    /**
     * Initialize mock historical data for demo mode
     */
    private initializeMockData(): void {
        for (const integration of MOCK_INTEGRATIONS) {
            // Generate historical data points (last 24 hours, hourly)
            const history: HistoricalDataPoint[] = [];
            const now = Date.now();

            for (let i = 24; i >= 0; i--) {
                const timestamp = new Date(now - i * 60 * 60 * 1000).toISOString();
                // Add some realistic variation
                const variation = (Math.random() - 0.5) * 0.1;
                const successRate = Math.min(1, Math.max(0.7, integration.baseSuccessRate + variation));

                history.push({
                    timestamp,
                    successRate,
                    avgLatencyMs: 200 + Math.random() * 300,
                    errorCount: Math.floor((1 - successRate) * 100),
                    recordsProcessed: 500 + Math.floor(Math.random() * 1000),
                });
            }

            this.historicalData.set(integration.id, history);

            // Calculate baseline
            const avgSuccessRate = history.reduce((sum, p) => sum + p.successRate, 0) / history.length;
            const avgLatencyMs = history.reduce((sum, p) => sum + p.avgLatencyMs, 0) / history.length;
            const avgErrorRate = history.reduce((sum, p) => sum + (p.errorCount / p.recordsProcessed), 0) / history.length;

            // Calculate standard deviations
            const stdDevSuccessRate = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow(p.successRate - avgSuccessRate, 2), 0) / history.length
            );
            const stdDevLatencyMs = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow(p.avgLatencyMs - avgLatencyMs, 2), 0) / history.length
            );
            const stdDevErrorRate = Math.sqrt(
                history.reduce((sum, p) => sum + Math.pow((p.errorCount / p.recordsProcessed) - avgErrorRate, 2), 0) / history.length
            );

            this.baselines.set(integration.id, {
                integrationId: integration.id,
                avgSuccessRate,
                avgLatencyMs,
                avgErrorRate,
                stdDevSuccessRate: stdDevSuccessRate || 0.01,
                stdDevLatencyMs: stdDevLatencyMs || 10,
                stdDevErrorRate: stdDevErrorRate || 0.01,
                dataPoints: history.length,
                lastUpdated: new Date().toISOString(),
            });
        }

        this.logger.info('SyncCentralHealthPredictor initialized with mock data', {
            integrations: MOCK_INTEGRATIONS.length,
        });
    }

    /**
     * Get health predictions for all integrations.
     * Uses real API data when USE_REAL_MODULE_APIS=true, otherwise uses mock data.
     */
    async getAllPredictions(): Promise<SyncHealthPredictionResponse> {
        this.logger.info('Generating health predictions for all integrations');

        // Ensure we have the latest integration data
        await this.ensureDataInitialized();

        const predictions: SyncHealthPrediction[] = [];
        let integrationsAtRisk = 0;
        let totalHealthScore = 0;

        for (const integration of this.integrations) {
            const prediction = await this.getPrediction(integration.id);
            if (prediction) {
                predictions.push(prediction);
                if (prediction.riskLevel === 'high' || prediction.riskLevel === 'critical') {
                    integrationsAtRisk++;
                }
                totalHealthScore += (1 - prediction.failureProbability) * 100;
            }
        }

        const avgHealthScore = predictions.length > 0
            ? Math.round(totalHealthScore / predictions.length)
            : 100;

        // Determine overall status
        let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
        if (integrationsAtRisk > predictions.length * 0.3) {
            overallStatus = 'critical';
        } else if (integrationsAtRisk > 0 || avgHealthScore < 85) {
            overallStatus = 'degraded';
        }

        // Generate system alerts
        const systemAlerts = this.generateSystemAlerts(predictions);

        return {
            success: true,
            timestamp: new Date().toISOString(),
            overallHealth: {
                status: overallStatus,
                score: avgHealthScore,
                integrationsAtRisk,
                totalIntegrations: predictions.length,
            },
            predictions,
            systemAlerts,
        };
    }

    /**
     * Get health prediction for a specific integration.
     * Uses real API data when USE_REAL_MODULE_APIS=true, otherwise uses mock data.
     */
    async getPrediction(integrationId: string): Promise<SyncHealthPrediction | null> {
        // Ensure we have the latest integration data
        await this.ensureDataInitialized();

        const integration = this.integrations.find(i => i.id === integrationId);
        if (!integration) {
            this.logger.warn('Integration not found', { integrationId });
            return null;
        }

        const baseline = this.baselines.get(integrationId);
        const history = this.historicalData.get(integrationId);

        if (!baseline || !history || history.length === 0) {
            this.logger.warn('No baseline data for integration', { integrationId });
            return null;
        }

        // Get recent data points (last 6 hours)
        const recentHistory = history.slice(-6);
        const latestPoint = recentHistory[recentHistory.length - 1];

        // Detect early warnings
        const earlyWarnings = this.detectEarlyWarnings(integrationId, baseline, recentHistory);

        // Calculate failure probability
        const failureProbability = this.calculateFailureProbability(baseline, recentHistory, earlyWarnings);

        // Determine risk level
        const riskLevel = this.getRiskLevel(failureProbability);

        // Generate recommended actions
        const recommendedActions = this.generateRecommendations(riskLevel, earlyWarnings);

        // Calculate confidence based on data quality
        const confidence = Math.min(0.95, 0.7 + (history.length / 100) * 0.25);

        return {
            integrationId,
            integrationName: integration.name,
            connectorType: integration.connectorType,
            failureProbability: Math.round(failureProbability * 1000) / 1000,
            predictedFailureWindow: failureProbability > 0.5 ? 'next 24 hours' : undefined,
            riskLevel,
            currentHealth: {
                successRate: latestPoint.successRate,
                avgLatencyMs: latestPoint.avgLatencyMs,
                errorRate: latestPoint.errorCount / latestPoint.recordsProcessed,
                lastSyncTime: latestPoint.timestamp,
            },
            earlyWarnings,
            recommendedActions,
            confidence,
            analysisTimestamp: new Date().toISOString(),
        };
    }

    /**
     * Detect early warning signs
     */
    private detectEarlyWarnings(
        integrationId: string,
        baseline: HealthBaseline,
        recentHistory: HistoricalDataPoint[]
    ): EarlyWarning[] {
        const warnings: EarlyWarning[] = [];

        if (recentHistory.length < 2) return warnings;

        const latest = recentHistory[recentHistory.length - 1];

        // Check success rate deviation
        const successRateDeviation = (baseline.avgSuccessRate - latest.successRate) / (baseline.stdDevSuccessRate || 0.01);
        if (successRateDeviation > this.config.warningDeviationThreshold) {
            warnings.push({
                id: `${integrationId}-success-rate-${Date.now()}`,
                metric: 'successRate',
                trend: 'degrading',
                deviation: successRateDeviation,
                description: `Success rate (${(latest.successRate * 100).toFixed(1)}%) is ${successRateDeviation.toFixed(1)} standard deviations below normal`,
                severity: successRateDeviation > this.config.criticalDeviationThreshold ? 'critical' : 'high',
                detectedAt: new Date().toISOString(),
            });
        }

        // Check latency trend
        const latencyDeviation = (latest.avgLatencyMs - baseline.avgLatencyMs) / (baseline.stdDevLatencyMs || 10);
        if (latencyDeviation > this.config.warningDeviationThreshold) {
            warnings.push({
                id: `${integrationId}-latency-${Date.now()}`,
                metric: 'latency',
                trend: 'degrading',
                deviation: latencyDeviation,
                description: `Latency (${latest.avgLatencyMs.toFixed(0)}ms) is ${latencyDeviation.toFixed(1)} standard deviations above normal`,
                severity: latencyDeviation > this.config.criticalDeviationThreshold ? 'high' : 'medium',
                detectedAt: new Date().toISOString(),
            });
        }

        // Check for increasing error trend
        const errorTrend = this.calculateTrend(recentHistory.map(p => p.errorCount));
        if (errorTrend > 0.3) {
            warnings.push({
                id: `${integrationId}-error-trend-${Date.now()}`,
                metric: 'errorRate',
                trend: 'degrading',
                deviation: errorTrend * 3,
                description: 'Error count showing upward trend over recent sync cycles',
                severity: errorTrend > 0.5 ? 'high' : 'medium',
                detectedAt: new Date().toISOString(),
            });
        }

        // Check for volatility
        const successRates = recentHistory.map(p => p.successRate);
        const volatility = this.calculateVolatility(successRates);
        if (volatility > 0.1) {
            warnings.push({
                id: `${integrationId}-volatility-${Date.now()}`,
                metric: 'stability',
                trend: 'volatile',
                deviation: volatility * 10,
                description: 'Integration showing unstable performance with high variability',
                severity: volatility > 0.2 ? 'high' : 'medium',
                detectedAt: new Date().toISOString(),
            });
        }

        return warnings;
    }

    /**
     * Calculate failure probability using weighted factors
     */
    private calculateFailureProbability(
        baseline: HealthBaseline,
        recentHistory: HistoricalDataPoint[],
        earlyWarnings: EarlyWarning[]
    ): number {
        const latest = recentHistory[recentHistory.length - 1];
        const weights = this.config.weights;

        // Factor 1: Recent error rate impact
        const errorRate = latest.errorCount / latest.recordsProcessed;
        const errorRateFactor = Math.min(1, errorRate * 5);

        // Factor 2: Latency trend impact
        const latencyRatio = latest.avgLatencyMs / baseline.avgLatencyMs;
        const latencyFactor = Math.min(1, Math.max(0, (latencyRatio - 1) * 0.5));

        // Factor 3: Success rate trend impact
        const successRates = recentHistory.map(p => p.successRate);
        const successTrend = this.calculateTrend(successRates);
        const successFactor = Math.min(1, Math.max(0, -successTrend + 0.3));

        // Factor 4: Historical reliability
        const historicalFactor = Math.min(1, Math.max(0, 1 - baseline.avgSuccessRate));

        // Early warning boost
        const warningBoost = earlyWarnings.reduce((sum, w) => {
            const severityWeight = w.severity === 'critical' ? 0.15 : w.severity === 'high' ? 0.1 : 0.05;
            return sum + severityWeight;
        }, 0);

        // Weighted combination
        const baseProbability = (
            errorRateFactor * weights.recentErrorRate +
            latencyFactor * weights.latencyTrend +
            successFactor * weights.successRateTrend +
            historicalFactor * weights.historicalReliability
        );

        // Add warning boost with diminishing returns
        const finalProbability = Math.min(0.95, baseProbability + Math.tanh(warningBoost));

        return finalProbability;
    }

    /**
     * Calculate linear trend coefficient
     */
    private calculateTrend(values: number[]): number {
        if (values.length < 2) return 0;

        const n = values.length;
        const sumX = (n * (n - 1)) / 2;
        const sumY = values.reduce((a, b) => a + b, 0);
        const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
        const sumX2 = values.reduce((sum, _, x) => sum + x * x, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        return slope;
    }

    /**
     * Calculate volatility (coefficient of variation)
     */
    private calculateVolatility(values: number[]): number {
        if (values.length < 2) return 0;

        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        if (mean === 0) return 0;

        const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
        return Math.sqrt(variance) / mean;
    }

    /**
     * Determine risk level from failure probability
     */
    private getRiskLevel(probability: number): RiskLevel {
        if (probability <= this.config.lowRiskMaxProbability) return 'low';
        if (probability <= this.config.mediumRiskMaxProbability) return 'medium';
        if (probability <= this.config.highRiskMaxProbability) return 'high';
        return 'critical';
    }

    /**
     * Generate recommended actions based on risk and warnings
     */
    private generateRecommendations(riskLevel: RiskLevel, warnings: EarlyWarning[]): string[] {
        const recommendations: string[] = [];

        if (riskLevel === 'low') {
            recommendations.push('Continue monitoring - no immediate action required');
            return recommendations;
        }

        // Add recommendations based on warnings
        for (const warning of warnings) {
            switch (warning.metric) {
                case 'successRate':
                    recommendations.push('Investigate recent sync failures for root cause');
                    recommendations.push('Check source system data quality');
                    break;
                case 'latency':
                    recommendations.push('Review API rate limits and throttling');
                    recommendations.push('Check network connectivity to target system');
                    break;
                case 'errorRate':
                    recommendations.push('Review error logs for patterns');
                    recommendations.push('Validate field mappings are current');
                    break;
                case 'stability':
                    recommendations.push('Check for intermittent connectivity issues');
                    recommendations.push('Review scheduled maintenance windows');
                    break;
            }
        }

        // Add severity-based recommendations
        if (riskLevel === 'critical') {
            recommendations.unshift('PRIORITY: Consider pausing integration for investigation');
            recommendations.push('Notify integration team for immediate review');
        } else if (riskLevel === 'high') {
            recommendations.unshift('Schedule investigation within next 4 hours');
        }

        // Deduplicate
        return [...new Set(recommendations)];
    }

    /**
     * Generate system-level alerts
     */
    private generateSystemAlerts(predictions: SyncHealthPrediction[]): SystemAlert[] {
        const alerts: SystemAlert[] = [];

        const criticalIntegrations = predictions.filter(p => p.riskLevel === 'critical');
        const highRiskIntegrations = predictions.filter(p => p.riskLevel === 'high');

        if (criticalIntegrations.length > 0) {
            alerts.push({
                id: `system-critical-${Date.now()}`,
                severity: 'critical',
                title: 'Critical Integration Health Alert',
                message: `${criticalIntegrations.length} integration(s) are at critical risk of failure`,
                affectedIntegrations: criticalIntegrations.map(p => p.integrationName),
                suggestedActions: [
                    'Immediately review critical integrations',
                    'Check for common failure patterns',
                    'Prepare rollback procedures if needed',
                ],
                createdAt: new Date().toISOString(),
            });
        }

        if (highRiskIntegrations.length >= 3) {
            alerts.push({
                id: `system-high-risk-${Date.now()}`,
                severity: 'high',
                title: 'Multiple High-Risk Integrations Detected',
                message: `${highRiskIntegrations.length} integrations showing elevated failure risk`,
                affectedIntegrations: highRiskIntegrations.map(p => p.integrationName),
                suggestedActions: [
                    'Review system-wide health metrics',
                    'Check for infrastructure issues',
                    'Schedule proactive maintenance',
                ],
                createdAt: new Date().toISOString(),
            });
        }

        return alerts;
    }
}
