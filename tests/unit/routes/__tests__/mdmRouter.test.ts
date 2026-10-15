import 'reflect-metadata';
import request from 'supertest';
import express from 'express';
import { Container } from 'inversify';
import { TYPES } from '../../../../src/inversify/types';
import { container as globalContainer } from '../../../../src/inversify/inversify.config';
import MDMRouter from '../../../../src/routes/MDMRouter';
import { Logger } from '../../../../src/utils/Logger';

// Mock services
const mockGoldenRecordService = {
    listGoldenRecords: jest.fn(),
    getGoldenRecord: jest.fn(),
    createGoldenRecord: jest.fn(),
    createFromEntities: jest.fn(),
    resolveConflict: jest.fn(),
    getStatistics: jest.fn(),
    requestSync: jest.fn(),
    getPendingSyncRequests: jest.fn(),
    approveSyncRequest: jest.fn()
};

const mockEntityMatchingService = {
    findMatches: jest.fn()
};

const mockSurvivorshipRuleEngine = {
    getRules: jest.fn(),
    setRule: jest.fn(),
    removeRule: jest.fn(),
    applyRule: jest.fn(),
    mergeEntities: jest.fn(),
    ensureInitialized: jest.fn(),
};

const mockMDMFeedbackService = {
    recordConflict: jest.fn(),
    analyzeConflictPatterns: jest.fn(),
    getMappingQualityAdjustments: jest.fn(),
    getTopConflictingFields: jest.fn(),
    getStatistics: jest.fn(),
    getConflictHistory: jest.fn(),
    getFieldStats: jest.fn()
};

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
};

describe('MDM Router Integration Tests', () => {
    let app: express.Application;

    beforeAll(() => {
        // Unbind existing if bound to avoid duplicates in global container (best effort)
        try { globalContainer.unbind(TYPES.GoldenRecordService); } catch { }
        try { globalContainer.unbind(TYPES.EntityMatchingService); } catch { }
        try { globalContainer.unbind(TYPES.SurvivorshipRuleEngine); } catch { }
        try { globalContainer.unbind(TYPES.MDMFeedbackService); } catch { }
        try { globalContainer.unbind(TYPES.Logger); } catch { }

        // Rebind mocks
        globalContainer.bind(TYPES.GoldenRecordService).toConstantValue(mockGoldenRecordService as any);
        globalContainer.bind(TYPES.EntityMatchingService).toConstantValue(mockEntityMatchingService as any);
        globalContainer.bind(TYPES.SurvivorshipRuleEngine).toConstantValue(mockSurvivorshipRuleEngine as any);
        globalContainer.bind(TYPES.MDMFeedbackService).toConstantValue(mockMDMFeedbackService as any);
        globalContainer.bind(TYPES.Logger).toConstantValue(mockLogger as any);

        app = express();
        app.use(express.json());
        // Mock auth middleware
        app.use((req: any, res, next) => {
            req.user = { id: 'test-user', username: 'tester', roles: ['admin'], permissions: ['mdm:write', 'admin'] };
            next();
        });
        app.use('/api/mdm', MDMRouter);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/mdm/entities', () => {
        it('should return list of golden records', async () => {
            mockGoldenRecordService.listGoldenRecords.mockResolvedValue([{ id: '1', data: { name: 'Test' } }]);

            const res = await request(app).get('/api/mdm/entities');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.records).toHaveLength(1);
            expect(mockGoldenRecordService.listGoldenRecords).toHaveBeenCalled();
        });
    });

    describe('GET /api/mdm/entities/:id', () => {
        it('should return golden record by id', async () => {
            mockGoldenRecordService.getGoldenRecord.mockResolvedValue({ id: '1', data: { name: 'Test' } });

            const res = await request(app).get('/api/mdm/entities/1');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.record.id).toBe('1');
        });

        it('should return 404 if not found', async () => {
            mockGoldenRecordService.getGoldenRecord.mockResolvedValue(undefined);

            const res = await request(app).get('/api/mdm/entities/999');

            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/mdm/match', () => {
        it('should return matches based on entity logic', async () => {
            mockEntityMatchingService.findMatches.mockResolvedValue([{ matchScore: 0.9 }]);

            const res = await request(app)
                .post('/api/mdm/match')
                .send({
                    entity: { id: '1', entityType: 'vendor' },
                    candidates: [{ id: '2', entityType: 'vendor' }]
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.matches).toHaveLength(1);
        });
    });

    describe('GET /api/mdm/statistics', () => {
        it('should return MDM statistics', async () => {
            mockGoldenRecordService.getStatistics.mockResolvedValue({ totalRecords: 100 });

            const res = await request(app).get('/api/mdm/statistics');

            expect(res.status).toBe(200);
            expect(res.body.statistics.totalRecords).toBe(100);
        });
    });

    describe('POST /api/mdm/sync/:id', () => {
        it('should return 404 when golden record not found', async () => {
            mockGoldenRecordService.requestSync.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/mdm/sync/gr-missing')
                .send({ targetSystems: ['netsuite'], requestedBy: 'user' });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Golden record not found');
        });

        it('should create sync request for existing record', async () => {
            mockGoldenRecordService.requestSync.mockResolvedValue({
                id: 'sync-1', goldenRecordId: 'gr-1', status: 'pending',
                targetSystems: ['netsuite'], requestedBy: 'user', createdAt: new Date(),
            });

            const res = await request(app)
                .post('/api/mdm/sync/gr-1')
                .send({ targetSystems: ['netsuite'], requestedBy: 'user' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.request.status).toBe('pending');
        });
    });

    describe('POST /api/mdm/conflicts/:id/resolve', () => {
        it('should resolve conflict if authorized', async () => {
            mockGoldenRecordService.resolveConflict.mockResolvedValue(true);

            const res = await request(app)
                .post('/api/mdm/conflicts/1/resolve')
                .send({ fieldName: 'name', selectedValue: 'New Name', resolvedBy: 'user' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockGoldenRecordService.resolveConflict).toHaveBeenCalledWith('1', 'name', 'New Name', 'user');
        });
    });

    describe('GET /api/mdm/rules', () => {
        it('should return survivorship rules', async () => {
            mockSurvivorshipRuleEngine.getRules.mockResolvedValue([
                { id: 'v-name', entityType: 'vendor', fieldName: 'name', strategy: 'most_complete', priority: 1 },
            ]);

            const res = await request(app).get('/api/mdm/rules');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.rules).toHaveLength(1);
        });
    });

    describe('PUT /api/mdm/rules', () => {
        it('should update a rule', async () => {
            mockSurvivorshipRuleEngine.setRule.mockResolvedValue(undefined);

            const res = await request(app)
                .put('/api/mdm/rules')
                .send({ rule: { id: 'v-name', entityType: 'vendor', fieldName: 'name', strategy: 'most_recent', priority: 1 } });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(mockSurvivorshipRuleEngine.setRule).toHaveBeenCalled();
        });

        it('should return 400 when rule is missing', async () => {
            const res = await request(app).put('/api/mdm/rules').send({});

            expect(res.status).toBe(400);
        });
    });

    describe('DELETE /api/mdm/rules/:id', () => {
        it('should delete a user rule', async () => {
            mockSurvivorshipRuleEngine.removeRule.mockResolvedValue('deleted');

            const res = await request(app).delete('/api/mdm/rules/custom-1');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('Rule removed');
        });

        it('should return 404 for non-existent rule', async () => {
            mockSurvivorshipRuleEngine.removeRule.mockResolvedValue('not_found');

            const res = await request(app).delete('/api/mdm/rules/nonexistent');

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Rule not found');
        });

        it('should return 409 for default rule', async () => {
            mockSurvivorshipRuleEngine.removeRule.mockResolvedValue('is_default');

            const res = await request(app).delete('/api/mdm/rules/v-name');

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Cannot delete default rule');
        });

        it('should return 403 without write permission', async () => {
            // Create a separate app with no permissions
            const noPermApp = express();
            noPermApp.use(express.json());
            noPermApp.use((req: any, res, next) => {
                req.user = { id: 'test-user', username: 'tester', roles: ['user'], permissions: ['mdm:read'] };
                next();
            });
            noPermApp.use('/api/mdm', MDMRouter);

            const res = await request(noPermApp).delete('/api/mdm/rules/custom-1');
            expect(res.status).toBe(403);
        });
    });

    describe('feedback endpoints', () => {
        it('should return conflict history with pagination metadata', async () => {
            mockMDMFeedbackService.getConflictHistory.mockResolvedValue({
                records: [{ fieldName: 'email', sourceA: 'ns', sourceB: 'bc', resolution: 'pending' }],
                total: 1,
                offset: 0,
                limit: 50
            });

            const res = await request(app).get('/api/mdm/feedback/history');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.total).toBe(1);
            expect(res.body.records).toHaveLength(1);
        });

        it('should return detailed field stats for a specific field', async () => {
            mockMDMFeedbackService.getFieldStats.mockResolvedValue([
                {
                    fieldName: 'email',
                    sourceSystem: 'netsuite',
                    targetSystem: 'bc',
                    conflictCount: 3,
                    resolutionCount: 2,
                    autoResolutionCount: 1,
                    manualResolutionCount: 1,
                    autoResolutionRate: 0.5,
                    manualResolutionRate: 0.5,
                    avgTimeSinceLastConflict: 1000,
                    lastConflictAt: new Date(),
                    commonIssues: []
                }
            ]);

            const res = await request(app).get('/api/mdm/feedback/stats/email');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.fieldName).toBe('email');
            expect(res.body.count).toBe(1);
        });
    });
});
