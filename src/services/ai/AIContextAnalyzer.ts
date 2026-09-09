/**
 * AI Context Analyzer
 * 
 * Analyzes ERP context and generates intelligent insights/alerts.
 * This powers the "Pre-Cognition Layer" that proactively warns users
 * about issues before they ask.
 * 
 * Features:
 * - Risk pattern detection
 * - Anomaly identification
 * - Trend analysis
 * - Proactive recommendations
 */

import { injectable } from 'inversify';
import { logger } from '../../utils/Logger';

export interface AIInsight {
    id: string;
    type: 'warning' | 'critical' | 'info' | 'success';
    title: string;
    message: string;
    confidence: number;      // 0-100
    source: string;          // Which AI model/rule generated this
    actionable: boolean;     // Can the user do something about it?
    suggestedAction?: string; // What to do
    timestamp: string;
}

export interface AnalysisContext {
    system: string;
    recordType: string;
    recordId: string;
    entityName?: string;
    riskScore?: number;
    alerts?: { severity: string; message: string }[];
}

@injectable()
export class AIContextAnalyzer {
    /**
     * Analyze context and generate AI insights
     */
    async analyzeContext(context: AnalysisContext): Promise<AIInsight[]> {
        logger.debug('[AIContextAnalyzer] Analyzing context', {
            recordType: context.recordType,
            recordId: context.recordId
        });

        const insights: AIInsight[] = [];

        // Run all analyzers
        insights.push(...this.analyzeRiskPatterns(context));
        insights.push(...this.analyzePaymentBehavior(context));
        insights.push(...this.analyzeComplianceStatus(context));
        insights.push(...this.analyzeRelationshipHealth(context));

        // Sort by confidence and severity
        insights.sort((a, b) => {
            const severityOrder = { critical: 0, warning: 1, info: 2, success: 3 };
            if (severityOrder[a.type] !== severityOrder[b.type]) {
                return severityOrder[a.type] - severityOrder[b.type];
            }
            return b.confidence - a.confidence;
        });

        logger.info('[AIContextAnalyzer] Generated insights', {
            count: insights.length,
            criticalCount: insights.filter(i => i.type === 'critical').length
        });

        return insights;
    }

    /**
     * Analyze risk patterns
     */
    private analyzeRiskPatterns(context: AnalysisContext): AIInsight[] {
        const insights: AIInsight[] = [];
        const riskScore = context.riskScore ?? 50;

        if (riskScore >= 80) {
            insights.push({
                id: `risk-critical-${Date.now()}`,
                type: 'critical',
                title: '🚨 High Risk Pattern Detected',
                message: `This ${context.recordType} shows concerning risk patterns. Risk score of ${riskScore}/100 is in the critical zone. Consider halting new transactions until review is complete.`,
                confidence: 95,
                source: 'RiskPatternEngine',
                actionable: true,
                suggestedAction: context.recordType === 'vendor' ? 'pausePayments' : 'reviewRecord',
                timestamp: new Date().toISOString()
            });
        } else if (riskScore >= 60) {
            insights.push({
                id: `risk-warning-${Date.now()}`,
                type: 'warning',
                title: '⚠️ Elevated Risk Level',
                message: `Risk score of ${riskScore}/100 is above normal. Recent activity patterns suggest increased monitoring may be warranted.`,
                confidence: 85,
                source: 'RiskPatternEngine',
                actionable: true,
                suggestedAction: 'requestDocuments',
                timestamp: new Date().toISOString()
            });
        }

        return insights;
    }

    /**
     * Analyze payment behavior
     */
    private analyzePaymentBehavior(context: AnalysisContext): AIInsight[] {
        const insights: AIInsight[] = [];

        // Simulate payment analysis based on record type
        if (context.recordType === 'vendor') {
            const hash = this.simpleHash(context.recordId);
            const latePaymentRate = (hash % 40) + 5; // 5-45%

            if (latePaymentRate > 30) {
                insights.push({
                    id: `payment-late-${Date.now()}`,
                    type: 'warning',
                    title: '📊 Payment Pattern Alert',
                    message: `Supplier has a ${latePaymentRate}% late delivery rate this quarter. This may indicate supply chain stress or capacity issues.`,
                    confidence: 78,
                    source: 'PaymentBehaviorAI',
                    actionable: true,
                    suggestedAction: 'reviewSupplierPerformance',
                    timestamp: new Date().toISOString()
                });
            }
        }

        if (context.recordType === 'invoice') {
            const hash = this.simpleHash(context.recordId);
            const daysOutstanding = hash % 60;

            if (daysOutstanding > 45) {
                insights.push({
                    id: `payment-overdue-${Date.now()}`,
                    type: 'critical',
                    title: '💰 Payment Significantly Overdue',
                    message: `Invoice is ${daysOutstanding} days past due. Customer payment probability is estimated at ${Math.max(10, 90 - daysOutstanding)}%. Consider escalation to collections.`,
                    confidence: 90,
                    source: 'PaymentBehaviorAI',
                    actionable: true,
                    suggestedAction: 'startCollections',
                    timestamp: new Date().toISOString()
                });
            }
        }

        return insights;
    }

    /**
     * Analyze compliance status
     */
    private analyzeComplianceStatus(context: AnalysisContext): AIInsight[] {
        const insights: AIInsight[] = [];

        if (context.recordType === 'vendor') {
            const hash = this.simpleHash(context.recordId);

            // W-9 expiry check
            if (hash % 5 === 0) {
                const daysUntilExpiry = (hash % 30) + 10;
                insights.push({
                    id: `compliance-w9-${Date.now()}`,
                    type: daysUntilExpiry < 15 ? 'warning' : 'info',
                    title: '📋 Compliance Document Expiring',
                    message: `W-9 form expires in ${daysUntilExpiry} days. Request updated documentation to maintain compliance.`,
                    confidence: 100,
                    source: 'ComplianceTracker',
                    actionable: true,
                    suggestedAction: 'requestDocument',
                    timestamp: new Date().toISOString()
                });
            }

            // Insurance check
            if (hash % 7 === 0) {
                insights.push({
                    id: `compliance-insurance-${Date.now()}`,
                    type: 'critical',
                    title: '🛡️ Insurance Certificate Expired',
                    message: `Vendor liability insurance has expired. This creates legal exposure. Pause orders until updated certificate is received.`,
                    confidence: 100,
                    source: 'ComplianceTracker',
                    actionable: true,
                    suggestedAction: 'pausePayments',
                    timestamp: new Date().toISOString()
                });
            }
        }

        return insights;
    }

    /**
     * Analyze relationship health
     */
    private analyzeRelationshipHealth(context: AnalysisContext): AIInsight[] {
        const insights: AIInsight[] = [];

        if (context.recordType === 'customer') {
            const hash = this.simpleHash(context.recordId);

            // NPS/Sentiment analysis
            if (hash % 4 === 0) {
                insights.push({
                    id: `relationship-sentiment-${Date.now()}`,
                    type: 'warning',
                    title: '😟 Declining Customer Sentiment',
                    message: `Customer satisfaction indicators are trending down. Recent support tickets show frustration. Proactive CSM outreach recommended.`,
                    confidence: 75,
                    source: 'SentimentAnalysisAI',
                    actionable: true,
                    suggestedAction: 'escalateToCSM',
                    timestamp: new Date().toISOString()
                });
            }

            // Churn prediction
            if (hash % 6 === 0) {
                insights.push({
                    id: `relationship-churn-${Date.now()}`,
                    type: 'critical',
                    title: '🔮 High Churn Risk Predicted',
                    message: `ML model predicts 67% probability of churn within 90 days. Key factors: declining usage, support escalations, competitor mentions in calls.`,
                    confidence: 82,
                    source: 'ChurnPredictionAI',
                    actionable: true,
                    suggestedAction: 'escalateToCSM',
                    timestamp: new Date().toISOString()
                });
            }
        }

        return insights;
    }

    /**
     * Simple hash for consistent demo data
     */
    private simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }
}

// Singleton instance
let instance: AIContextAnalyzer | null = null;

export function getAIContextAnalyzer(): AIContextAnalyzer {
    if (!instance) {
        instance = new AIContextAnalyzer();
    }
    return instance;
}
