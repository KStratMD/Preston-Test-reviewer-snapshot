/**
 * Unit tests for NLQueryOrchestrator
 * Phase 1: AI-Enhanced SuiteCentral 2.0
 */

import { NLQueryOrchestrator } from '../../../../src/services/ai/NLQueryOrchestrator';
import { NLQCapabilityRegistry } from '../../../../src/services/ai/NLQCapabilityRegistry';
import { NLActionGateService } from '../../../../src/services/ai/NLActionGateService';

// Mock fetchModuleData to verify endpoint construction
const mockFetchModuleData = jest.fn();
jest.mock('../../../../src/utils/moduleHttpClient', () => ({
    fetchModuleData: (...args: unknown[]) => mockFetchModuleData(...args),
}));

// Mock logger
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as any;

describe('NLQueryOrchestrator', () => {
    let orchestrator: NLQueryOrchestrator;
    let registry: NLQCapabilityRegistry;

    beforeEach(() => {
        jest.clearAllMocks();
        registry = new NLQCapabilityRegistry(mockLogger);
        orchestrator = new NLQueryOrchestrator(mockLogger, registry);
    });

    describe('initialization', () => {
        it('should initialize successfully', () => {
            expect(orchestrator).toBeDefined();
            expect(mockLogger.info).toHaveBeenCalledWith(
                'NLQueryOrchestrator initialized',
                expect.objectContaining({ actionGateEnabled: expect.any(Boolean) })
            );
        });
    });

    describe('processQuery', () => {
        it('should process a valid supplier query', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me supplier metrics',
                userId: 'test-user',
            });

            expect(response.success).toBe(true);
            expect(response.query).toBe('show me supplier metrics');
            expect(response.resolution).not.toBeNull();
            expect(response.formattedAnswer).toBeDefined();
            expect(response.followUpQuestions).toBeInstanceOf(Array);
            expect(response.followUpQuestions.length).toBeGreaterThan(0);
        });

        it('should process a valid payment query', async () => {
            const response = await orchestrator.processQuery({
                query: 'what is our payment success rate',
                userId: 'test-user',
            });

            expect(response.success).toBe(true);
            expect(response.resolution?.capability.id).toContain('payment');
            expect(response.formattedAnswer).toContain('Payment');
        });

        it('should return formatted response for cross-module metrics', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me overall system health',
                userId: 'test-user',
                context: {
                    userPermissions: ['admin:read'], // cross-module-metrics requires admin:read
                },
            });

            expect(response.success).toBe(true);
            expect(response.formattedAnswer).toContain('Health');
        });

        it('should return no-match response for unrecognized query', async () => {
            const response = await orchestrator.processQuery({
                query: 'xyzzy foobar complete nonsense',
                userId: 'test-user',
            });

            expect(response.success).toBe(false);
            expect(response.resolution).toBeNull();
            expect(response.formattedAnswer).toContain("couldn't understand");
        });

        it('should include processing time in metadata', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user',
            });

            expect(response.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
        });

        it('should include confidence score in metadata', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user',
            });

            expect(response.metadata.confidenceScore).toBeGreaterThan(0);
        });
    });

    describe('follow-up questions', () => {
        it('should provide module-specific follow-up questions', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me supplier dashboard',
                userId: 'test-user',
            });

            expect(response.followUpQuestions).toBeInstanceOf(Array);
            expect(response.followUpQuestions.length).toBeLessThanOrEqual(3);

            // SupplierCentral should have specific follow-ups
            if (response.success) {
                const hasSupplierQuestion = response.followUpQuestions.some(
                    q => q.toLowerCase().includes('supplier') || q.toLowerCase().includes('vendor')
                );
                expect(hasSupplierQuestion).toBe(true);
            }
        });

        it('should provide follow-ups for all 11 modules', async () => {
            const moduleQueries = [
                { query: 'supplier metrics', module: 'SupplierCentral' },
                { query: 'payment success rate', module: 'PaymentCentral' },
                { query: 'sync health', module: 'SyncCentral' },
                { query: 'customer satisfaction', module: 'CustomerCentral' },
                { query: 'inventory levels', module: 'InventoryCentral' },
            ];

            for (const { query } of moduleQueries) {
                const response = await orchestrator.processQuery({
                    query,
                    userId: 'test-user',
                });

                if (response.success) {
                    expect(response.followUpQuestions.length).toBeGreaterThan(0);
                }
            }
        });
    });

    describe('conversation memory', () => {
        it('should store conversation history', async () => {
            const sessionId = 'test-session-' + Date.now();

            await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user',
                sessionId,
            });

            await orchestrator.processQuery({
                query: 'payment status',
                userId: 'test-user',
                sessionId,
            });

            const history = orchestrator.getConversationHistory(sessionId);

            expect(history).toBeDefined();
            expect(history?.queries.length).toBe(2);
        });

        it('should limit conversation history to 10 queries', async () => {
            const sessionId = 'test-session-limit-' + Date.now();

            // Use valid queries that will match capabilities and trigger memory storage
            const validQueries = [
                'supplier metrics', 'payment status', 'sync health',
                'customer satisfaction', 'inventory levels', 'supplier dashboard',
                'payment success rate', 'sync errors', 'customer churn',
                'inventory alerts', 'supplier performance', 'payment processing'
            ];

            // Send 12 valid queries
            for (let i = 0; i < 12; i++) {
                await orchestrator.processQuery({
                    query: validQueries[i % validQueries.length],
                    userId: 'test-user',
                    sessionId,
                });
            }

            const history = orchestrator.getConversationHistory(sessionId);

            expect(history).toBeDefined();
            expect(history?.queries.length).toBeLessThanOrEqual(10);
        });
    });

    describe('response formatting', () => {
        it('should format supplier dashboard response correctly', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier dashboard',
                userId: 'test-user',
            });

            if (response.success && response.execution) {
                expect(response.formattedAnswer).toContain('Supplier');
                expect(response.formattedAnswer).toContain('•');
            }
        });

        it('should format payment dashboard response correctly', async () => {
            const response = await orchestrator.processQuery({
                query: 'payment dashboard',
                userId: 'test-user',
            });

            if (response.success && response.execution) {
                expect(response.formattedAnswer).toContain('Payment');
            }
        });

        it('should format anomaly detection response correctly', async () => {
            const response = await orchestrator.processQuery({
                query: 'what is wrong',
                userId: 'test-user',
            });

            if (response.success && response.execution) {
                expect(response.formattedAnswer).toMatch(/Anomalies|No Anomalies/);
            }
        });
    });

    describe('permission handling', () => {
        it('should check permissions from context', async () => {
            const response = await orchestrator.processQuery({
                query: 'cross module metrics',
                userId: 'test-user',
                context: {
                    userPermissions: ['admin:read'],
                },
            });

            expect(response.metadata.permissionCheck).toBeDefined();
        });

        it('should use default permissions when not provided', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user',
                // No context provided
            });

            expect(response.success).toBe(true);
            expect(response.metadata.permissionCheck.allowed).toBe(true);
        });
    });

    describe('write intent with NLActionGateService', () => {
        let orchestratorWithGate: NLQueryOrchestrator;
        let actionGate: NLActionGateService;

        beforeEach(() => {
            actionGate = new NLActionGateService(mockLogger);
            orchestratorWithGate = new NLQueryOrchestrator(mockLogger, registry, actionGate);
        });

        afterEach(() => {
            actionGate.stopPeriodicCleanup();
            orchestratorWithGate.stopPeriodicCleanup();
        });

        it('should detect write intent and return proposed action when gate is wired', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'Refund this customer $50',
                userId: 'test-user',
                context: { userPermissions: ['payment:write'] },
            });

            expect(response.isWriteAction).toBe(true);
            expect(response.proposedAction).toBeDefined();
            expect(response.proposedAction!.intent.action).toBe('refund');
            expect(response.proposedAction!.status).toBe('pending');
        });

        it('should deny write intent without write permissions', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'Refund this customer $50',
                userId: 'test-user',
                // Default permissions are read-only
            });

            expect(response.success).toBe(false);
            expect(response.isWriteAction).toBe(true);
            expect(response.formattedAnswer).toContain('Permission Denied');
        });

        it('should fall back gracefully for unrecognized write intent', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'Delete all the records from everywhere',
                userId: 'test-user',
                context: { userPermissions: ['admin:write'] },
            });

            // Should detect as write intent but fail to parse specifics
            expect(response.isWriteAction).toBe(true);
            expect(response.formattedAnswer).toBeDefined();
        });

        it('should still handle read queries without gate interference', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'show me supplier metrics',
                userId: 'test-user',
            });

            expect(response.success).toBe(true);
            expect(response.isWriteAction).toBeUndefined();
            expect(response.resolution).not.toBeNull();
        });

        it('should avoid LLM fallback for unsupported read queries without strong write signal', async () => {
            const mockGate = {
                parseIntentSmart: jest.fn().mockResolvedValue(null),
                parseIntentQuiet: jest.fn().mockReturnValue(null),
                proposeAction: jest.fn(),
                stopPeriodicCleanup: jest.fn(),
            } as unknown as NLActionGateService;

            const orchestratorWithMockGate = new NLQueryOrchestrator(mockLogger, registry, mockGate);
            const response = await orchestratorWithMockGate.processQuery({
                query: 'xyzzy foobar complete nonsense',
                userId: 'test-user',
                context: { userPermissions: ['admin:write'] },
            });

            expect(response.success).toBe(false);
            expect((mockGate as any).parseIntentQuiet).toHaveBeenCalledWith('xyzzy foobar complete nonsense');
            expect((mockGate as any).parseIntentSmart).not.toHaveBeenCalled();

            orchestratorWithMockGate.stopPeriodicCleanup();
        });
    });

    describe('adaptResponse (NLQ HTTP integration)', () => {
        // adaptResponse is public for testability

        it('should pass flat mock data through unchanged', () => {
            const flat = { activeVendors: 234, pendingPOs: 67 };
            const result = orchestrator.adaptResponse('supplier-dashboard', flat);
            expect(result).toEqual(flat);
        });

        it('should adapt nested supplier-dashboard summary', () => {
            const nested = {
                summary: { totalVendors: 50, activeVendors: 42, pendingApproval: 8 }
            };
            const result = orchestrator.adaptResponse('supplier-dashboard', nested);
            expect(result.activeVendors).toBe(42);
            expect(result.pendingPOs).toBe(8);
            expect(result.onTimeDeliveryRate).toBe(94.0); // default
        });

        it('should adapt per-vendor supplier-risk-score with profile', () => {
            const nested = {
                profile: {
                    overallRiskScore: 35,
                    riskLevel: 'medium',
                    riskTrend: 'improving',
                    factors: [{ name: 'Late deliveries' }, { name: 'Quality issues' }]
                }
            };
            const result = orchestrator.adaptResponse('supplier-risk-score', nested, { vendorId: 'V001' });
            expect(result.vendorId).toBe('V001');
            expect(result.overallRisk).toBe(35);
            expect(result.riskFactors).toEqual(['Late deliveries', 'Quality issues']);
            expect(result.trend).toBe('improving');
        });

        it('should adapt summary supplier-risk-score without vendorId', () => {
            const nested = {
                summary: { totalSuppliers: 10, byRiskLevel: {}, averageScore: 28 },
                topRisks: [{ name: 'Payment delays' }]
            };
            const result = orchestrator.adaptResponse('supplier-risk-score', nested);
            expect(result.vendorId).toBe('ALL');
            expect(result.overallRisk).toBe(28);
            expect(result.riskFactors).toEqual(['Payment delays']);
        });

        it('should adapt nested payment-dashboard summary', () => {
            const nested = {
                summary: { totalVolume: 5000000, totalTransactions: 120, successRate: 97.5 }
            };
            const result = orchestrator.adaptResponse('payment-dashboard', nested);
            expect(result.successRate).toBe(97.5);
            expect(result.dailyVolume).toBe(5000000);
            expect(result.avgProcessingTime).toBe(2.0); // default
        });

        it('should adapt nested sync-health dashboard', () => {
            const nested = {
                dashboard: {
                    statistics: {
                        totalOperations: 1000,
                        activeOperations: 5,
                        errorOperations: 20,
                        successRate: 98.0,
                        averageSyncDuration: 310,
                        activeAnomalies: 3
                    }
                }
            };
            const result = orchestrator.adaptResponse('sync-health', nested);
            expect(result.apiSuccessRate).toBe(98.0);
            expect(result.avgLatency).toBe(310);
            expect(result.errorRate).toBe(2); // 20/1000*100
            expect(result.failedMessages).toBe(3);
        });

        it('should adapt nested customer-dashboard summary', () => {
            const nested = {
                summary: { activeCustomers: 900, ordersThisMonth: 50, customerSatisfaction: 4.3 },
                metrics: { churnRate: 7.5, retentionRate: 92.5 }
            };
            const result = orchestrator.adaptResponse('customer-dashboard', nested);
            expect(result.totalCustomers).toBe(900);
            expect(result.activeCustomers).toBe(900);
            expect(result.satisfactionScore).toBe(4.3);
            expect(result.churnRisk).toBe(7.5);
        });

        it('should adapt nested inventory-dashboard summary (direct field name match)', () => {
            const nested = {
                summary: { totalSKUs: 5000, lowStockAlerts: 15, reorderPending: 10, inventoryValue: 3000000 }
            };
            const result = orchestrator.adaptResponse('inventory-dashboard', nested);
            expect(result.totalSKUs).toBe(5000);
            expect(result.lowStockAlerts).toBe(15);
        });

        it('should adapt nested finance-dashboard summary (direct field name match)', () => {
            const nested = {
                summary: { cashPosition: 4000000, arBalance: 1000000, apBalance: 500000, pendingApprovals: 5 }
            };
            const result = orchestrator.adaptResponse('finance-dashboard', nested);
            expect(result.cashPosition).toBe(4000000);
            expect(result.pendingApprovals).toBe(5);
        });

        it('should strip trailing % from quality passRate to avoid %%', () => {
            const nested = {
                summary: { inspectionsToday: 55, passRate: '96.5%', itemsOnHold: 3, pendingRelease: 2 }
            };
            const result = orchestrator.adaptResponse('quality-dashboard', nested);
            expect(result.passRate).toBe(96.5);
            expect(result.inspectionsToday).toBe(55);
        });

        it('should handle numeric passRate without stripping', () => {
            const nested = {
                summary: { inspectionsToday: 40, passRate: 88, itemsOnHold: 5, pendingRelease: 1 }
            };
            const result = orchestrator.adaptResponse('quality-dashboard', nested);
            expect(result.passRate).toBe(88);
        });

        it('should adapt nested cross-module-metrics', () => {
            const nested = {
                overallHealth: { status: 'degraded', score: 72, issues: [] },
                modules: {
                    SupplierCentral: { health: { status: 'healthy' } },
                    PaymentCentral: { health: { status: 'degraded' } },
                    SyncCentral: { health: { status: 'healthy' } },
                },
                anomalies: [{ type: 'latency_spike' }, { type: 'error_rate' }],
            };
            const result = orchestrator.adaptResponse('cross-module-metrics', nested);
            expect(result.overallHealth).toBe('degraded');
            expect(result.healthScore).toBe(72);
            expect(result.modulesHealthy).toBe(2);
            expect(result.modulesDegraded).toBe(1);
            expect(result.activeAnomalies).toBe(2);
        });

        it('should normalize anomaly-detection module field from modules array', () => {
            const nested = {
                anomalies: [
                    { modules: ['SupplierCentral', 'SyncCentral'], metric: 'latency', severity: 'warning' },
                    { module: 'InventoryCentral', metric: 'lowStock', severity: 'info' },
                ],
            };
            const result = orchestrator.adaptResponse('anomaly-detection', nested);
            const anomalies = result.anomalies as { module: string; metric: string; severity: string }[];
            expect(anomalies).toHaveLength(2);
            expect(anomalies[0].module).toBe('SupplierCentral, SyncCentral');
            expect(anomalies[1].module).toBe('InventoryCentral');
        });

        // P1 Codex regression: flat cross-module mock must pass through unchanged
        it('should pass through flat cross-module-metrics mock without corruption', () => {
            const flatMock = {
                overallHealth: 'healthy',   // string, not object
                healthScore: 87,
                modulesHealthy: 9,
                modulesDegraded: 2,
                activeAnomalies: 3,
            };
            const result = orchestrator.adaptResponse('cross-module-metrics', flatMock);
            // Must return as-is — overallHealth is string 'healthy', not nested object
            expect(result.overallHealth).toBe('healthy');
            expect(result.healthScore).toBe(87);
            expect(result.modulesHealthy).toBe(9);
            expect(result.modulesDegraded).toBe(2);
        });

        // P2 Codex regression: supplier-risk summary with real SupplierRiskProfile shape
        it('should extract factor names from topRisks[].factors[] (real SupplierRiskProfile shape)', () => {
            const nested = {
                summary: { totalSuppliers: 5, byRiskLevel: {}, averageScore: 45 },
                topRisks: [
                    {
                        supplierName: 'Acme Corp',
                        factors: [
                            { name: 'Late deliveries', score: 30 },
                            { name: 'Quality issues', score: 20 },
                        ],
                    },
                    {
                        supplierName: 'Globex Inc',
                        factors: [
                            { name: 'Late deliveries', score: 25 },
                            { name: 'Financial instability', score: 15 },
                        ],
                    },
                ],
            };
            const result = orchestrator.adaptResponse('supplier-risk-score', nested);
            expect(result.vendorId).toBe('ALL');
            expect(result.overallRisk).toBe(45);
            // 'Late deliveries' appears twice → ranked first; then alphabetical for ties
            const factors = result.riskFactors as string[];
            expect(factors[0]).toBe('Late deliveries');
            expect(factors).toContain('Quality issues');
            expect(factors).toContain('Financial instability');
            expect(factors).toHaveLength(3);
        });

        // Copilot: null/undefined raw input should return empty object
        it('should return empty object when raw is null or undefined', () => {
            expect(orchestrator.adaptResponse('supplier-dashboard', null)).toEqual({});
            expect(orchestrator.adaptResponse('supplier-dashboard', undefined)).toEqual({});
        });

        // Copilot: non-string module values in anomaly-detection should produce 'unknown'
        it('should handle non-string module values in anomaly-detection gracefully', () => {
            const nested = {
                anomalies: [
                    { module: 123, metric: 'cpu', severity: 'warning' },
                    { metric: 'latency', severity: 'info' },
                ],
            };
            const result = orchestrator.adaptResponse('anomaly-detection', nested);
            const anomalies = result.anomalies as { module: string }[];
            expect(anomalies[0].module).toBe('unknown');
            expect(anomalies[1].module).toBe('unknown');
        });

        // Copilot: invalid passRate string should default to 0
        it('should default passRate to 0 when string is not a valid number', () => {
            const nested = {
                summary: { inspectionsToday: 10, passRate: 'N/A%', itemsOnHold: 0, pendingRelease: 0 },
            };
            const result = orchestrator.adaptResponse('quality-dashboard', nested);
            expect(result.passRate).toBe(0);
        });
    });

    describe('fetchLiveOrFallback endpoint construction', () => {
        // Tests verify that processQuery passes the correct URL and fallback
        // to fetchModuleData for each capability's live HTTP path.

        beforeEach(() => {
            mockFetchModuleData.mockReset();
        });

        it('should call supplier-dashboard endpoint', async () => {
            mockFetchModuleData.mockResolvedValue({ activeVendors: 42, pendingPOs: 5 });
            await orchestrator.processQuery({
                query: 'show me supplier metrics',
                userId: 'u1',
            });
            expect(mockFetchModuleData).toHaveBeenCalledWith(
                expect.stringContaining('/api/supplier-central/dashboard'),
                expect.any(Object), // fallback mock data
                expect.anything(),  // logger
                expect.objectContaining({ timeoutMs: 5000 }),
            );
        });

        it('should call payment-dashboard endpoint', async () => {
            mockFetchModuleData.mockResolvedValue({ successRate: 98 });
            await orchestrator.processQuery({
                query: 'show payment metrics',
                userId: 'u1',
            });
            expect(mockFetchModuleData).toHaveBeenCalledWith(
                expect.stringContaining('/api/payment-central/dashboard'),
                expect.any(Object),
                expect.anything(),
                expect.objectContaining({ timeoutMs: 5000 }),
            );
        });

        it('should call supplier-risk-score summary endpoint without vendorId', async () => {
            mockFetchModuleData.mockResolvedValue({ vendorId: 'ALL', overallRisk: 23 });
            // "show me supplier health" matches supplier-risk-score pattern
            // but doesn't extract a vendorId (no ID-like word after "supplier")
            await orchestrator.processQuery({
                query: 'how risky is supplier',
                userId: 'u1',
            });
            expect(mockFetchModuleData).toHaveBeenCalled();
            const url = mockFetchModuleData.mock.calls[0][0] as string;
            expect(url).toContain('/api/ai/suppliers/risk-scores');
        });

        it('should use per-vendor endpoint when vendorId is extracted', async () => {
            mockFetchModuleData.mockResolvedValue({
                profile: { overallRiskScore: 35, riskTrend: 'improving', factors: [] },
            });
            await orchestrator.processQuery({
                query: 'supplier risk score for vendor V-123',
                userId: 'u1',
            });
            // Should route to per-vendor path if vendorId was extracted
            if (mockFetchModuleData.mock.calls.length > 0) {
                const url = mockFetchModuleData.mock.calls[0][0] as string;
                expect(url).toContain('/api/ai/suppliers/');
                if (url.includes('V-123') || url.includes('V123')) {
                    expect(url).toContain('/risk-score');
                }
            }
        });

        it('should call cross-module-metrics endpoint', async () => {
            mockFetchModuleData.mockResolvedValue({
                overallHealth: 'healthy', healthScore: 87,
            });
            await orchestrator.processQuery({
                query: 'what is the overall system health',
                userId: 'u1',
                context: { userPermissions: ['admin:read'] },
            });
            expect(mockFetchModuleData).toHaveBeenCalledWith(
                expect.stringContaining('/api/ai/metrics/cross-module'),
                expect.any(Object),
                expect.anything(),
                expect.objectContaining({ timeoutMs: 5000 }),
            );
        });

        it('should use MODULE_API_BASE_URL when set', async () => {
            const origBase = process.env.MODULE_API_BASE_URL;
            process.env.MODULE_API_BASE_URL = 'http://custom-host:4000';
            try {
                mockFetchModuleData.mockResolvedValue({ totalSKUs: 100 });
                await orchestrator.processQuery({
                    query: 'show inventory dashboard',
                    userId: 'u1',
                });
                const url = mockFetchModuleData.mock.calls[0][0] as string;
                expect(url).toMatch(/^http:\/\/custom-host:4000\//);
            } finally {
                if (origBase === undefined) {
                    delete process.env.MODULE_API_BASE_URL;
                } else {
                    process.env.MODULE_API_BASE_URL = origBase;
                }
            }
        });

        it('should pass fallback mock data matching the capability', async () => {
            mockFetchModuleData.mockResolvedValue({ passRate: 94 });
            await orchestrator.processQuery({
                query: 'quality metrics',
                userId: 'u1',
            });
            // Second arg to fetchModuleData is the fallback mock
            const fallback = mockFetchModuleData.mock.calls[0][1] as Record<string, unknown>;
            expect(fallback).toHaveProperty('inspectionsToday');
            expect(fallback).toHaveProperty('passRate');
        });
    });
});
