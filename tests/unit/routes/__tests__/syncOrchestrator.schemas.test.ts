/**
 * SyncOrchestrator Schema Routes Tests
 * PR B: Schema Drift Wiring
 */

import express from 'express';
import request from 'supertest';

// Mock inversify container before importing the router
const mockSchemaRegistry = {
    registerSchema: jest.fn(),
    validateSchema: jest.fn(),
    getRegisteredSchemas: jest.fn().mockReturnValue([]),
    clearSchema: jest.fn(),
};

const mockOrchestrator = {
    getOperations: jest.fn().mockResolvedValue([]),
    createOperation: jest.fn(),
    executeSync: jest.fn(),
    getAIConflictSuggestion: jest.fn(),
    resolveConflict: jest.fn(),
    getAnomalyAlerts: jest.fn().mockResolvedValue([]),
    getStatistics: jest.fn().mockResolvedValue({
        totalOperations: 0, activeOperations: 0, pausedOperations: 0,
        errorOperations: 0, totalSyncsToday: 0, successRate: 100,
        averageSyncDuration: 0, activeAnomalies: 0,
    }),
};

jest.mock('../../../../src/inversify/inversify.config', () => ({
    container: {
        get: jest.fn((type: symbol) => {
            const typeStr = type.toString();
            if (typeStr.includes('SchemaRegistryService')) return mockSchemaRegistry;
            if (typeStr.includes('SyncCentralOrchestrator')) return mockOrchestrator;
            throw new Error(`Unknown type: ${typeStr}`);
        }),
    },
}));

jest.mock('../../../../src/inversify/types', () => ({
    TYPES: {
        SyncCentralOrchestrator: Symbol.for('SyncCentralOrchestrator'),
        SchemaRegistryService: Symbol.for('SchemaRegistryService'),
    },
}));

// Import router after mocks
import { syncOrchestratorRouter } from '../../../../src/routes/syncOrchestrator';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/sync-orchestrator', syncOrchestratorRouter);
    return app;
}

describe('SyncOrchestrator Schema Routes', () => {
    let app: express.Application;

    beforeEach(() => {
        jest.clearAllMocks();
        mockSchemaRegistry.getRegisteredSchemas.mockReturnValue([]);
        app = createApp();
    });

    describe('route base path', () => {
        it('should respond under /api/sync-orchestrator/schemas', async () => {
            const res = await request(app).get('/api/sync-orchestrator/schemas');
            expect(res.status).toBe(200);
        });

        it('should return 404 for /api/sync-central/schemas (wrong mount)', async () => {
            const res = await request(app).get('/api/sync-central/schemas');
            expect(res.status).toBe(404);
        });
    });

    describe('POST /schemas', () => {
        it('should return 201 on success', async () => {
            mockSchemaRegistry.registerSchema.mockReturnValue('abc123hash');
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    schema: {
                        fields: [{ name: 'email', type: 'string', required: true }],
                    },
                });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.hash).toBe('abc123hash');
        });

        it('should return 400 for missing system', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    objectType: 'contacts',
                    schema: { fields: [{ name: 'email', type: 'string', required: true }] },
                });
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toContain('system');
        });

        it('should return 400 for missing objectType', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    system: 'netsuite',
                    schema: { fields: [{ name: 'email', type: 'string', required: true }] },
                });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('objectType');
        });

        it('should return 400 for missing fields', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({ system: 'netsuite', objectType: 'contacts', schema: {} });
            expect(res.status).toBe(400);
        });

        it('should return 400 for invalid field shape', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    schema: {
                        fields: [{ name: 'email' }], // missing type and required
                    },
                });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('type');
        });

        it('should return 400 for duplicate field names', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    schema: {
                        fields: [
                            { name: 'email', type: 'string', required: true },
                            { name: 'email', type: 'integer', required: false },
                        ],
                    },
                });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('duplicate');
        });

        it('should strip caller-supplied `inferred` flag from registered fields', async () => {
            mockSchemaRegistry.registerSchema.mockReturnValue('hash123');
            await request(app)
                .post('/api/sync-orchestrator/schemas')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    schema: {
                        fields: [
                            { name: 'email', type: 'string', required: true, inferred: true },
                        ],
                    },
                });
            expect(mockSchemaRegistry.registerSchema).toHaveBeenCalled();
            const callArgs = mockSchemaRegistry.registerSchema.mock.calls[0];
            const persistedFields = callArgs[2].fields;
            expect(persistedFields[0]).not.toHaveProperty('inferred');
            expect(persistedFields[0].name).toBe('email');
            expect(persistedFields[0].required).toBe(true);
        });
    });

    describe('GET /schemas', () => {
        it('should return array and count', async () => {
            mockSchemaRegistry.getRegisteredSchemas.mockReturnValue([
                { key: 'netsuite:contacts', hash: 'abc', fieldCount: 3 },
            ]);
            const res = await request(app).get('/api/sync-orchestrator/schemas');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.schemas).toHaveLength(1);
            expect(res.body.count).toBe(1);
        });
    });

    describe('POST /schemas/validate', () => {
        it('should return validation result', async () => {
            mockSchemaRegistry.validateSchema.mockReturnValue({
                isValid: true, hash: 'abc', drifts: [],
                timestamp: new Date(), shouldBlockSync: false,
            });
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas/validate')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    fields: [{ name: 'email', type: 'string', required: true }],
                });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.validation.isValid).toBe(true);
        });

        it('should return 400 for missing inputs', async () => {
            const res = await request(app)
                .post('/api/sync-orchestrator/schemas/validate')
                .send({ system: 'netsuite' }); // missing objectType and fields
            expect(res.status).toBe(400);
        });

        it('should strip caller-supplied `inferred` flag before validating', async () => {
            mockSchemaRegistry.validateSchema.mockReturnValue({
                isValid: true, hash: 'abc', drifts: [],
                timestamp: new Date(), shouldBlockSync: false,
            });
            await request(app)
                .post('/api/sync-orchestrator/schemas/validate')
                .send({
                    system: 'netsuite',
                    objectType: 'contacts',
                    fields: [{ name: 'email', type: 'string', required: true, inferred: true }],
                });
            expect(mockSchemaRegistry.validateSchema).toHaveBeenCalled();
            const callArgs = mockSchemaRegistry.validateSchema.mock.calls[0];
            const passedFields = callArgs[2];
            expect(passedFields[0]).not.toHaveProperty('inferred');
        });
    });

    describe('DELETE /schemas/:system/:objectType', () => {
        it('should return 200 on success', async () => {
            mockSchemaRegistry.clearSchema.mockReturnValue(true);
            const res = await request(app)
                .delete('/api/sync-orchestrator/schemas/netsuite/contacts');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('should return 404 when not found', async () => {
            mockSchemaRegistry.clearSchema.mockReturnValue(false);
            const res = await request(app)
                .delete('/api/sync-orchestrator/schemas/netsuite/contacts');
            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
        });
    });

    describe('GET /dashboard', () => {
        it('should include registeredSchemas in dashboard response', async () => {
            mockSchemaRegistry.getRegisteredSchemas.mockReturnValue([
                { key: 'netsuite:contacts', hash: 'abc', fieldCount: 3 },
            ]);
            const res = await request(app).get('/api/sync-orchestrator/dashboard');
            expect(res.status).toBe(200);
            expect(res.body.dashboard.registeredSchemas).toBeDefined();
            expect(res.body.dashboard.registeredSchemas).toHaveLength(1);
        });
    });

    describe('blocked sync API semantics', () => {
        it('should return HTTP 200 even when blocked by schema drift', async () => {
            mockOrchestrator.executeSync.mockResolvedValue({
                operationId: 'op_1',
                startedAt: new Date(),
                completedAt: new Date(),
                status: 'failed',
                recordsProcessed: 0,
                recordsCreated: 0,
                recordsUpdated: 0,
                recordsSkipped: 5,
                recordsFailed: 0,
                conflicts: [],
                errors: [{
                    errorCode: 'SCHEMA_DRIFT_BLOCKED',
                    message: 'Sync blocked due to critical schema drift',
                    retryable: false,
                    retryCount: 0,
                    maxRetries: 0,
                }],
                schemaValidation: {
                    isValid: false,
                    hash: 'xyz',
                    drifts: [{ field: 'email', changeType: 'modified', severity: 'critical' }],
                    timestamp: new Date(),
                    shouldBlockSync: true,
                    alertMessage: 'CRITICAL drift',
                },
            });

            const res = await request(app)
                .post('/api/sync-orchestrator/operations/op_1/execute');
            expect(res.status).toBe(200);
            expect(res.body.result.status).toBe('failed');
            expect(res.body.result.errors[0].errorCode).toBe('SCHEMA_DRIFT_BLOCKED');
            expect(res.body.result.schemaValidation).toBeDefined();
            expect(res.body.result.schemaValidation.drifts).toHaveLength(1);
        });
    });
});
