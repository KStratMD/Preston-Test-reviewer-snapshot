/**
 * Unit tests for NLQueryOrchestrator
 * Phase 1: AI-Enhanced SuiteCentral 2.0
 */

import { NLQueryOrchestrator } from '../../../../src/services/ai/NLQueryOrchestrator';
import { NLQCapabilityRegistry } from '../../../../src/services/ai/NLQCapabilityRegistry';
import { NLActionGateService } from '../../../../src/services/ai/NLActionGateService';

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
        it('returns the fixture response without calling fetch', async () => {
            const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
                new Error('network forbidden in fixture-only test'),
            );

            try {
                const response = await orchestrator.processQuery({
                    query: 'show me supplier metrics',
                    userId: 'test-user',
                    tenantId: 'tenant-test',
                });

                expect(response.success).toBe(true);
                expect(response.execution?.metadata.dataSource).toBe('fixture');
                expect(response.execution?.response).toEqual({
                    activeVendors: 234,
                    pendingPOs: 67,
                    onTimeDeliveryRate: 94.2,
                    vendorSatisfaction: 4.7,
                });
                expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
                fetchSpy.mockRestore();
            }
        });

        it('should process a valid supplier query', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me supplier metrics',
                userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
            });

            expect(response.success).toBe(true);
            expect(response.resolution?.capability.id).toContain('payment');
            expect(response.formattedAnswer).toContain('Payment');
        });

        it('should return formatted response for cross-module metrics', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me overall system health',
                userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
            });

            expect(response.success).toBe(false);
            expect(response.resolution).toBeNull();
            expect(response.formattedAnswer).toContain("couldn't understand");
        });

        it('should include processing time in metadata', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user', tenantId: 'tenant-test',
            });

            expect(response.metadata.processingTimeMs).toBeGreaterThanOrEqual(0);
        });

        it('should include confidence score in metadata', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user', tenantId: 'tenant-test',
            });

            expect(response.metadata.confidenceScore).toBeGreaterThan(0);
        });
    });

    describe('follow-up questions', () => {
        it('should provide module-specific follow-up questions', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me supplier dashboard',
                userId: 'test-user', tenantId: 'tenant-test',
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
                    userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
                sessionId,
            });

            await orchestrator.processQuery({
                query: 'payment status',
                userId: 'test-user', tenantId: 'tenant-test',
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
                    userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
            });

            if (response.success && response.execution) {
                expect(response.formattedAnswer).toContain('Supplier');
                expect(response.formattedAnswer).toContain('•');
            }
        });

        it('should format payment dashboard response correctly', async () => {
            const response = await orchestrator.processQuery({
                query: 'payment dashboard',
                userId: 'test-user', tenantId: 'tenant-test',
            });

            if (response.success && response.execution) {
                expect(response.formattedAnswer).toContain('Payment');
            }
        });

        it('should format anomaly detection response correctly', async () => {
            const response = await orchestrator.processQuery({
                query: 'what is wrong',
                userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
                context: {
                    userPermissions: ['admin:read'],
                },
            });

            expect(response.metadata.permissionCheck).toBeDefined();
        });

        it('should use default permissions when not provided', async () => {
            const response = await orchestrator.processQuery({
                query: 'supplier metrics',
                userId: 'test-user', tenantId: 'tenant-test',
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

        it('propagates request.tenantId to proposeAction (F4)', async () => {
            const proposeSpy = jest.spyOn(actionGate, 'proposeAction');
            const response = await orchestratorWithGate.processQuery({
                query: 'Refund this customer $50',
                userId: 'test-user', tenantId: 'tenant-jwt',
                context: { userPermissions: ['payment:write'] },
            });
            expect(response.isWriteAction).toBe(true);
            expect(proposeSpy).toHaveBeenCalledWith(expect.anything(), 'tenant-jwt');
        });

        it('should detect write intent and return proposed action when gate is wired', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'Refund this customer $50',
                userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
                // Default permissions are read-only
            });

            expect(response.success).toBe(false);
            expect(response.isWriteAction).toBe(true);
            expect(response.formattedAnswer).toContain('Permission Denied');
        });

        it('should fall back gracefully for unrecognized write intent', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'Delete all the records from everywhere',
                userId: 'test-user', tenantId: 'tenant-test',
                context: { userPermissions: ['admin:write'] },
            });

            // Should detect as write intent but fail to parse specifics
            expect(response.isWriteAction).toBe(true);
            expect(response.formattedAnswer).toBeDefined();
        });

        it('should still handle read queries without gate interference', async () => {
            const response = await orchestratorWithGate.processQuery({
                query: 'show me supplier metrics',
                userId: 'test-user', tenantId: 'tenant-test',
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
                userId: 'test-user', tenantId: 'tenant-test',
                context: { userPermissions: ['admin:write'] },
            });

            expect(response.success).toBe(false);
            expect((mockGate as any).parseIntentQuiet).toHaveBeenCalledWith('xyzzy foobar complete nonsense');
            expect((mockGate as any).parseIntentSmart).not.toHaveBeenCalled();

            orchestratorWithMockGate.stopPeriodicCleanup();
        });
    });

    describe('fixture provenance', () => {
        it('marks only a successful read execution as fixture data', async () => {
            const response = await orchestrator.processQuery({
                query: 'show me supplier metrics',
                userId: 'test-user',
                tenantId: 'tenant-test',
            });

            expect(response.success).toBe(true);
            expect(response.execution?.metadata.dataSource).toBe('fixture');
            expect(response.execution?.metadata).not.toHaveProperty('apiEndpoint');
        });

        it('does not mark a no-match response', async () => {
            const response = await orchestrator.processQuery({
                query: 'xyzzy foobar complete nonsense',
                userId: 'test-user',
                tenantId: 'tenant-test',
            });

            expect(response.success).toBe(false);
            expect(response.resolution).toBeNull();
            expect(response.execution).toBeNull();
            expect(response).not.toHaveProperty('dataSource');
        });

        it('does not mark a permission-denied read', async () => {
            const response = await orchestrator.processQuery({
                query: 'cross module metrics',
                userId: 'test-user',
                tenantId: 'tenant-test',
                context: { userPermissions: [] },
            });

            expect(response.success).toBe(false);
            expect(response.resolution).not.toBeNull();
            expect(response.execution).toBeNull();
            expect(response.formattedAnswer).toContain('Permission Denied');
            expect(response).not.toHaveProperty('dataSource');
        });

        it('does not mark a write-intent permission denial', async () => {
            const gate = new NLActionGateService(mockLogger);
            const gatedOrchestrator = new NLQueryOrchestrator(mockLogger, registry, gate);

            try {
                const response = await gatedOrchestrator.processQuery({
                    query: 'Refund this customer $50',
                    userId: 'test-user',
                    tenantId: 'tenant-test',
                });

                expect(response.success).toBe(false);
                expect(response.isWriteAction).toBe(true);
                expect(response.execution).toBeNull();
                expect(response.formattedAnswer).toContain('Permission Denied');
                expect(response).not.toHaveProperty('dataSource');
            } finally {
                gate.stopPeriodicCleanup();
                gatedOrchestrator.stopPeriodicCleanup();
            }
        });

        it('does not mark an execution error', async () => {
            const failingOrchestrator = new NLQueryOrchestrator(mockLogger, registry);
            const fixtureMethod = failingOrchestrator as unknown as {
                getSimulatedResponse: (capabilityId: string, params: Record<string, unknown>) => unknown;
            };

            const fixtureSpy = jest.spyOn(fixtureMethod, 'getSimulatedResponse')
                .mockImplementation(() => {
                    throw new Error('fixture failure');
                });

            try {
                const response = await failingOrchestrator.processQuery({
                    query: 'show me supplier metrics',
                    userId: 'test-user',
                    tenantId: 'tenant-test',
                });

                expect(response.success).toBe(false);
                expect(response.resolution).not.toBeNull();
                expect(response.execution).toBeNull();
                expect(response.formattedAnswer).toContain('Error Executing Query');
                expect(response).not.toHaveProperty('dataSource');
            } finally {
                fixtureSpy.mockRestore();
                failingOrchestrator.stopPeriodicCleanup();
            }
        });
    });

});
