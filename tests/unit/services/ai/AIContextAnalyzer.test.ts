/**
 * Unit tests for AIContextAnalyzer
 *
 * Tests all analysis methods and insight generation logic.
 */

import { AIContextAnalyzer, getAIContextAnalyzer } from '../../../../src/services/ai/AIContextAnalyzer';

describe('AIContextAnalyzer', () => {
    let analyzer: AIContextAnalyzer;

    beforeEach(() => {
        analyzer = new AIContextAnalyzer();
    });

    describe('analyzeContext', () => {
        it('should return array of insights', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345'
            });

            expect(Array.isArray(insights)).toBe(true);
        });

        it('should sort insights by severity (critical first)', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345',
                riskScore: 85 // High risk to ensure critical insight
            });

            if (insights.length > 1) {
                const severityOrder = { critical: 0, warning: 1, info: 2, success: 3 };
                for (let i = 1; i < insights.length; i++) {
                    const prevSeverity = severityOrder[insights[i - 1].type];
                    const currSeverity = severityOrder[insights[i].type];
                    expect(prevSeverity).toBeLessThanOrEqual(currSeverity);
                }
            }
        });

        it('should handle context with alerts', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345',
                alerts: [{ severity: 'high', message: 'Test alert' }]
            });

            expect(Array.isArray(insights)).toBe(true);
        });
    });

    describe('risk pattern analysis', () => {
        it('should generate critical insight for high risk score (>=80)', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-HIGH-RISK',
                riskScore: 85
            });

            const criticalRiskInsight = insights.find(
                i => i.type === 'critical' && i.source === 'RiskPatternEngine'
            );

            expect(criticalRiskInsight).toBeDefined();
            expect(criticalRiskInsight?.message).toContain('85');
            expect(criticalRiskInsight?.actionable).toBe(true);
        });

        it('should generate warning insight for elevated risk (60-79)', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-ELEVATED-RISK',
                riskScore: 65
            });

            const warningInsight = insights.find(
                i => i.type === 'warning' && i.source === 'RiskPatternEngine'
            );

            expect(warningInsight).toBeDefined();
            expect(warningInsight?.message).toContain('65');
        });

        it('should not generate risk insight for normal risk (<60)', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-NORMAL',
                riskScore: 40
            });

            const riskInsight = insights.find(i => i.source === 'RiskPatternEngine');

            expect(riskInsight).toBeUndefined();
        });

        it('should suggest pausePayments action for high-risk vendors', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-HIGH-RISK',
                riskScore: 90
            });

            const criticalInsight = insights.find(
                i => i.type === 'critical' && i.source === 'RiskPatternEngine'
            );

            expect(criticalInsight?.suggestedAction).toBe('pausePayments');
        });
    });

    describe('payment behavior analysis', () => {
        it('should analyze vendor payment patterns', async () => {
            // Run multiple times to get variation
            let foundPaymentInsight = false;

            for (let i = 0; i < 20; i++) {
                const insights = await analyzer.analyzeContext({
                    system: 'NetSuite',
                    recordType: 'vendor',
                    recordId: `V-PAY-${i}`
                });

                if (insights.some(i => i.source === 'PaymentBehaviorAI')) {
                    foundPaymentInsight = true;
                    break;
                }
            }

            // Should find payment insight for some vendors
            expect(foundPaymentInsight).toBe(true);
        });

        it('should analyze invoice payment status', async () => {
            // Run multiple times to get variation
            let foundOverdueInsight = false;

            for (let i = 0; i < 20; i++) {
                const insights = await analyzer.analyzeContext({
                    system: 'NetSuite',
                    recordType: 'invoice',
                    recordId: `INV-${i}`
                });

                if (insights.some(i => i.title?.includes('Overdue'))) {
                    foundOverdueInsight = true;
                    break;
                }
            }

            expect(foundOverdueInsight).toBe(true);
        });
    });

    describe('compliance analysis', () => {
        it('should check W-9 expiry for vendors', async () => {
            // V-1 has hash % 5 === 0 (hash = 84090)
            // This is verified to trigger W-9 expiry check
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-1'
            });

            // W-9 expiry check generates "Compliance Document Expiring" title
            // with message containing "W-9"
            const complianceInsight = insights.find(
                i => i.source === 'ComplianceTracker' && i.message?.includes('W-9')
            );

            expect(complianceInsight).toBeDefined();
            expect(complianceInsight?.title).toContain('Compliance Document');
            expect(complianceInsight?.actionable).toBe(true);
        });

        it('should detect expired insurance for vendors', async () => {
            // V-2 has hash % 7 === 0 (hash = 84091)
            // This triggers insurance expired check
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-2'
            });

            const insuranceInsight = insights.find(i => i.title?.includes('Insurance'));

            expect(insuranceInsight).toBeDefined();
            expect(insuranceInsight?.type).toBe('critical');
            expect(insuranceInsight?.source).toBe('ComplianceTracker');
        });
    });

    describe('relationship health analysis', () => {
        it('should analyze customer sentiment', async () => {
            // C-2 has hash % 4 === 0 (hash = 65832)
            // This triggers sentiment analysis
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'customer',
                recordId: 'C-2'
            });

            const sentimentInsight = insights.find(i => i.source === 'SentimentAnalysisAI');

            expect(sentimentInsight).toBeDefined();
            expect(sentimentInsight?.title).toContain('Sentiment');
        });

        it('should predict customer churn risk', async () => {
            // C-2 has hash % 6 === 0 (hash = 65832)
            // This triggers churn prediction
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'customer',
                recordId: 'C-2'
            });

            const churnInsight = insights.find(i => i.source === 'ChurnPredictionAI');

            expect(churnInsight).toBeDefined();
            expect(churnInsight?.title).toContain('Churn');
            expect(churnInsight?.type).toBe('critical');
        });
    });

    describe('insight structure', () => {
        it('should return insights with all required fields', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345',
                riskScore: 85
            });

            insights.forEach(insight => {
                expect(insight.id).toBeDefined();
                expect(insight.type).toMatch(/^(warning|critical|info|success)$/);
                expect(insight.title).toBeDefined();
                expect(insight.message).toBeDefined();
                expect(typeof insight.confidence).toBe('number');
                expect(insight.confidence).toBeGreaterThanOrEqual(0);
                expect(insight.confidence).toBeLessThanOrEqual(100);
                expect(insight.source).toBeDefined();
                expect(typeof insight.actionable).toBe('boolean');
                expect(insight.timestamp).toBeDefined();
            });
        });

        it('should generate valid ISO timestamp', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345',
                riskScore: 85
            });

            insights.forEach(insight => {
                const date = new Date(insight.timestamp);
                expect(date.toString()).not.toBe('Invalid Date');
            });
        });

        it('should include suggestedAction for actionable insights', async () => {
            const insights = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-12345',
                riskScore: 85
            });

            const actionableInsights = insights.filter(i => i.actionable);

            actionableInsights.forEach(insight => {
                expect(insight.suggestedAction).toBeDefined();
            });
        });
    });

    describe('hash consistency', () => {
        it('should generate consistent insights for the same recordId', async () => {
            const insights1 = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-CONSISTENT'
            });

            const insights2 = await analyzer.analyzeContext({
                system: 'NetSuite',
                recordType: 'vendor',
                recordId: 'V-CONSISTENT'
            });

            // Same source patterns should appear
            const sources1 = insights1.map(i => i.source).sort();
            const sources2 = insights2.map(i => i.source).sort();

            expect(sources1).toEqual(sources2);
        });
    });

    describe('singleton instance', () => {
        it('should return the same instance via getAIContextAnalyzer', () => {
            const instance1 = getAIContextAnalyzer();
            const instance2 = getAIContextAnalyzer();

            expect(instance1).toBe(instance2);
        });
    });
});
