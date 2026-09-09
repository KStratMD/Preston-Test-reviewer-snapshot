import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';

/**
 * Predictive Operations Service
 * 
 * Implements the "Predictive Ops" features from Grand Unified Strategy 2026.
 * 
 * Features:
 * 1. Inventory Depletion Velocity - Predict when stock runs out
 * 2. API Latency Trend - Predict integration health issues
 * 3. Payment Failure Probability - Flag high-risk transactions
 */

export interface InventoryPrediction {
    itemId: string;
    itemName: string;
    currentStock: number;
    dailyVelocity: number; // Units sold per day
    daysUntilDepletion: number;
    predictedDepletionDate: Date;
    confidence: number;
    recommendation: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface LatencyPrediction {
    integrationId: string;
    integrationName: string;
    currentLatencyMs: number;
    averageLatencyMs: number;
    trend: 'improving' | 'stable' | 'degrading';
    predictedLatencyMs: number;
    predictedAt: Date;
    healthScore: number; // 0-100
    anomalyDetected: boolean;
    recommendation: string;
}

export interface PaymentRiskPrediction {
    transactionId: string;
    amount: number;
    currency: string;
    failureProbability: number;
    riskFactors: string[];
    recommendation: string;
}

// In-memory storage for historical data
interface HistoricalDataPoint {
    timestamp: Date;
    value: number;
}

@injectable()
export class PredictiveOperationsService {
    private inventoryHistory = new Map<string, HistoricalDataPoint[]>();
    private latencyHistory = new Map<string, HistoricalDataPoint[]>();
    private logger: Logger;

    constructor(
        @inject(TYPES.Logger) logger: Logger
    ) {
        this.logger = logger;
        this.logger.info('[PredictiveOps] Service initialized');
        this.initializeDemoData();
    }

    /**
     * Predict when inventory will run out
     */
    predictInventoryDepletion(itemId: string, itemName: string, currentStock: number): InventoryPrediction {
        const history = this.inventoryHistory.get(itemId) || [];
        const dailyVelocity = this.calculateDailyVelocity(history, currentStock);

        const daysUntilDepletion = dailyVelocity > 0 ? Math.round(currentStock / dailyVelocity) : 999;
        const predictedDepletionDate = new Date(Date.now() + daysUntilDepletion * 24 * 60 * 60 * 1000);

        const riskLevel = this.assessInventoryRisk(daysUntilDepletion);
        const recommendation = this.generateInventoryRecommendation(daysUntilDepletion, dailyVelocity);

        const prediction: InventoryPrediction = {
            itemId,
            itemName,
            currentStock,
            dailyVelocity: Math.round(dailyVelocity * 10) / 10,
            daysUntilDepletion,
            predictedDepletionDate,
            confidence: history.length >= 7 ? 0.85 : 0.6 + (history.length * 0.03),
            recommendation,
            riskLevel
        };

        this.logger.info('[PredictiveOps] Inventory prediction:', {
            itemId,
            daysUntilDepletion,
            riskLevel
        });

        return prediction;
    }

    /**
     * Predict API latency trends and detect anomalies
     */
    predictLatencyTrend(integrationId: string, integrationName: string, currentLatencyMs: number): LatencyPrediction {
        // Record current latency
        this.recordLatency(integrationId, currentLatencyMs);

        const history = this.latencyHistory.get(integrationId) || [];
        const averageLatencyMs = this.calculateAverage(history);
        const trend = this.detectTrend(history);
        const predictedLatencyMs = this.predictNextLatency(history, trend);
        const anomalyDetected = this.detectAnomaly(currentLatencyMs, averageLatencyMs, history);
        const healthScore = this.calculateHealthScore(currentLatencyMs, averageLatencyMs, anomalyDetected);

        const prediction: LatencyPrediction = {
            integrationId,
            integrationName,
            currentLatencyMs,
            averageLatencyMs: Math.round(averageLatencyMs),
            trend,
            predictedLatencyMs: Math.round(predictedLatencyMs),
            predictedAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
            healthScore,
            anomalyDetected,
            recommendation: this.generateLatencyRecommendation(trend, anomalyDetected, healthScore)
        };

        if (anomalyDetected) {
            this.logger.warn('[PredictiveOps] Latency anomaly detected:', {
                integrationId,
                currentLatencyMs,
                averageLatencyMs,
                trend
            });
        }

        return prediction;
    }

    /**
     * Predict payment failure risk
     */
    predictPaymentRisk(transactionId: string, amount: number, currency: string, metadata?: Record<string, unknown>): PaymentRiskPrediction {
        const riskFactors: string[] = [];
        let failureProbability = 0.02; // Base 2% failure rate

        // Risk factor: High amount
        if (amount > 10000) {
            riskFactors.push('High transaction amount');
            failureProbability += 0.05;
        }

        // Risk factor: International currency
        if (currency !== 'USD' && currency !== 'EUR') {
            riskFactors.push('Non-standard currency');
            failureProbability += 0.03;
        }

        // Risk factor: First-time customer (simulated)
        if (metadata?.isFirstTime) {
            riskFactors.push('First-time transaction');
            failureProbability += 0.08;
        }

        // Risk factor: Weekend transaction
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            riskFactors.push('Weekend transaction');
            failureProbability += 0.02;
        }

        // Risk factor: Night hours
        const hour = new Date().getHours();
        if (hour < 6 || hour > 22) {
            riskFactors.push('Off-hours transaction');
            failureProbability += 0.03;
        }

        const prediction: PaymentRiskPrediction = {
            transactionId,
            amount,
            currency,
            failureProbability: Math.min(failureProbability, 0.95),
            riskFactors,
            recommendation: this.generatePaymentRecommendation(failureProbability, riskFactors)
        };

        return prediction;
    }

    /**
     * Record latency measurement for an integration
     */
    recordLatency(integrationId: string, latencyMs: number): void {
        if (!this.latencyHistory.has(integrationId)) {
            this.latencyHistory.set(integrationId, []);
        }

        const history = this.latencyHistory.get(integrationId)!;
        history.push({
            timestamp: new Date(),
            value: latencyMs
        });

        // Keep only last 100 data points
        if (history.length > 100) {
            history.shift();
        }
    }

    /**
     * Record inventory level for an item
     */
    recordInventory(itemId: string, stockLevel: number): void {
        if (!this.inventoryHistory.has(itemId)) {
            this.inventoryHistory.set(itemId, []);
        }

        const history = this.inventoryHistory.get(itemId)!;
        history.push({
            timestamp: new Date(),
            value: stockLevel
        });

        // Keep only last 30 days
        if (history.length > 30) {
            history.shift();
        }
    }

    /**
     * Get overall system health dashboard
     */
    getSystemHealthDashboard(): {
        inventoryAlerts: InventoryPrediction[];
        latencyAlerts: LatencyPrediction[];
        overallHealth: number;
    } {
        const inventoryAlerts: InventoryPrediction[] = [];
        const latencyAlerts: LatencyPrediction[] = [];

        // Generate sample alerts for demo
        inventoryAlerts.push(
            this.predictInventoryDepletion('WIDGET-A', 'Widget Type A', 45),
            this.predictInventoryDepletion('GADGET-B', 'Gadget Model B', 12)
        );

        latencyAlerts.push(
            this.predictLatencyTrend('netsuite-sync', 'NetSuite Sync', 180),
            this.predictLatencyTrend('stripe-payments', 'Stripe Payments', 95)
        );

        // Calculate overall health
        const healthScores = latencyAlerts.map(l => l.healthScore);
        const avgHealth = healthScores.reduce((a, b) => a + b, 0) / healthScores.length;

        const criticalInventory = inventoryAlerts.filter(i => i.riskLevel === 'critical').length;
        const overallHealth = Math.max(0, avgHealth - (criticalInventory * 10));

        return {
            inventoryAlerts: inventoryAlerts.filter(i => i.riskLevel !== 'low'),
            latencyAlerts: latencyAlerts.filter(l => l.trend === 'degrading' || l.anomalyDetected),
            overallHealth: Math.round(overallHealth)
        };
    }

    // ==================== Private Helper Methods ====================

    private calculateDailyVelocity(history: HistoricalDataPoint[], currentStock: number): number {
        if (history.length < 2) {
            // Estimate based on current stock (assume 5% daily)
            return currentStock * 0.05;
        }

        const oldest = history[0];
        const daysDiff = (Date.now() - oldest.timestamp.getTime()) / (24 * 60 * 60 * 1000);
        const stockDiff = oldest.value - currentStock;

        return daysDiff > 0 ? stockDiff / daysDiff : 0;
    }

    private assessInventoryRisk(daysUntilDepletion: number): InventoryPrediction['riskLevel'] {
        if (daysUntilDepletion <= 3) return 'critical';
        if (daysUntilDepletion <= 7) return 'high';
        if (daysUntilDepletion <= 14) return 'medium';
        return 'low';
    }

    private generateInventoryRecommendation(days: number, velocity: number): string {
        if (days <= 3) {
            return `URGENT: Reorder immediately. Current velocity of ${velocity.toFixed(1)} units/day will deplete stock in ${days} days.`;
        }
        if (days <= 7) {
            return `Reorder recommended within 48 hours to avoid stockout.`;
        }
        if (days <= 14) {
            return `Monitor closely. Consider placing reorder this week.`;
        }
        return `Stock levels healthy. Next review in ${Math.floor(days / 2)} days.`;
    }

    private calculateAverage(history: HistoricalDataPoint[]): number {
        if (history.length === 0) return 0;
        const sum = history.reduce((acc, dp) => acc + dp.value, 0);
        return sum / history.length;
    }

    private detectTrend(history: HistoricalDataPoint[]): LatencyPrediction['trend'] {
        if (history.length < 3) return 'stable';

        // Compare first third to last third
        const third = Math.floor(history.length / 3);
        const firstThird = history.slice(0, third);
        const lastThird = history.slice(-third);

        const avgFirst = this.calculateAverage(firstThird);
        const avgLast = this.calculateAverage(lastThird);

        const changePercent = ((avgLast - avgFirst) / avgFirst) * 100;

        if (changePercent > 15) return 'degrading';
        if (changePercent < -10) return 'improving';
        return 'stable';
    }

    private predictNextLatency(history: HistoricalDataPoint[], trend: LatencyPrediction['trend']): number {
        const avg = this.calculateAverage(history);
        const multiplier = trend === 'degrading' ? 1.1 : trend === 'improving' ? 0.95 : 1.0;
        return avg * multiplier;
    }

    private detectAnomaly(current: number, average: number, history: HistoricalDataPoint[]): boolean {
        if (history.length < 5) return false;

        // Calculate standard deviation
        const variance = history.reduce((acc, dp) => acc + Math.pow(dp.value - average, 2), 0) / history.length;
        const stdDev = Math.sqrt(variance);

        // Anomaly if current is more than 2 standard deviations from mean
        return Math.abs(current - average) > 2 * stdDev;
    }

    private calculateHealthScore(current: number, average: number, anomalyDetected: boolean): number {
        let score = 100;

        // Reduce for high latency
        if (current > 500) score -= 30;
        else if (current > 300) score -= 20;
        else if (current > 200) score -= 10;

        // Reduce for latency above average
        if (current > average * 1.5) score -= 15;

        // Reduce for anomaly
        if (anomalyDetected) score -= 20;

        return Math.max(0, score);
    }

    private generateLatencyRecommendation(trend: string, anomalyDetected: boolean, healthScore: number): string {
        if (anomalyDetected) {
            return 'Anomaly detected! Investigate immediately. Check API endpoints, network, and third-party service status.';
        }
        if (trend === 'degrading') {
            return 'Performance degrading. Review recent changes and consider scaling resources.';
        }
        if (healthScore < 50) {
            return 'Low health score. Schedule performance review and optimization.';
        }
        if (trend === 'improving') {
            return 'Performance improving. Recent optimizations are effective.';
        }
        return 'Integration performing within normal parameters.';
    }

    private generatePaymentRecommendation(probability: number, factors: string[]): string {
        if (probability > 0.2) {
            return `High failure risk (${(probability * 100).toFixed(0)}%). Consider: ${factors.slice(0, 2).join(', ')}. Enable enhanced fraud checks.`;
        }
        if (probability > 0.1) {
            return `Moderate risk. Monitor transaction closely.`;
        }
        return `Normal risk profile. Standard processing recommended.`;
    }

    private initializeDemoData(): void {
        // Initialize demo inventory history
        const demoItems = ['WIDGET-A', 'GADGET-B', 'COMPONENT-C'];
        const now = Date.now();

        for (const itemId of demoItems) {
            const history: HistoricalDataPoint[] = [];
            let stock = 100;

            for (let i = 14; i >= 0; i--) {
                history.push({
                    timestamp: new Date(now - i * 24 * 60 * 60 * 1000),
                    value: stock
                });
                stock -= Math.floor(Math.random() * 8) + 2; // Decrease 2-10 units per day
            }

            this.inventoryHistory.set(itemId, history);
        }

        // Initialize demo latency history
        const demoIntegrations = ['netsuite-sync', 'stripe-payments', 'shopify-orders'];

        for (const integrationId of demoIntegrations) {
            const history: HistoricalDataPoint[] = [];
            const baseLatency = 100 + Math.floor(Math.random() * 100);

            for (let i = 24; i >= 0; i--) {
                history.push({
                    timestamp: new Date(now - i * 60 * 60 * 1000),
                    value: baseLatency + Math.floor(Math.random() * 50) - 25
                });
            }

            this.latencyHistory.set(integrationId, history);
        }

        this.logger.info('[PredictiveOps] Demo data initialized');
    }
}
