/**
 * NLActionGateRouter tests
 * PR C: Verifies errorCode → HTTP status mappings and route behavior
 */

import request from 'supertest';
import express from 'express';

// Mock the inversify container before importing the router
const mockExecuteAction = jest.fn();
const mockParseIntentSmart = jest.fn();
const mockProposeAction = jest.fn();
const mockApproveAction = jest.fn();
const mockRejectAction = jest.fn();
const mockGetPendingActions = jest.fn();

const mockService = {
    executeAction: mockExecuteAction,
    parseIntentSmart: mockParseIntentSmart,
    proposeAction: mockProposeAction,
    approveAction: mockApproveAction,
    rejectAction: mockRejectAction,
    getPendingActions: mockGetPendingActions,
};

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

jest.mock('../../../../src/inversify/inversify.config', () => ({
    container: {
        get: jest.fn((type: symbol) => {
            const typeName = type.toString();
            if (typeName.includes('NLActionGateService')) return mockService;
            if (typeName.includes('Logger')) return mockLogger;
            return {};
        }),
        // PR 6 R2 (Codex BM-2): NLActionGateRouter.getService() now resolves
        // via getAsync because the NLActionGateService binding became
        // toDynamicValue(async). Mock the async path too so the router's
        // `await container.getAsync(...)` resolves to the same mockService.
        getAsync: jest.fn(async (type: symbol) => {
            const typeName = type.toString();
            if (typeName.includes('NLActionGateService')) return mockService;
            if (typeName.includes('Logger')) return mockLogger;
            return {};
        }),
    },
}));

import router from '../../../../src/routes/NLActionGateRouter';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/nl-action-gate', router);
    return app;
}

describe('NLActionGateRouter', () => {
    let app: express.Application;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp();
    });

    describe('POST /actions/:id/execute — errorCode → HTTP status mapping', () => {
        it('should return 404 for not_found errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Action not found',
                errorCode: 'not_found',
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-fake/execute');
            expect(res.status).toBe(404);
            expect(res.body.errorCode).toBe('not_found');
        });

        it('should return 409 for not_approved errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Action is pending, not approved',
                errorCode: 'not_approved',
                proposedAction: { id: 'nla-1', status: 'pending' },
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-1/execute');
            expect(res.status).toBe(409);
            expect(res.body.errorCode).toBe('not_approved');
        });

        it('should return 501 for not_implemented errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: "Action 'cancel' is not yet implemented",
                errorCode: 'not_implemented',
                proposedAction: { id: 'nla-2', intent: { action: 'cancel' } },
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-2/execute');
            expect(res.status).toBe(501);
            expect(res.body.errorCode).toBe('not_implemented');
        });

        it('should return 400 for validation_error errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Missing required parameter: invoiceId',
                errorCode: 'validation_error',
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-3/execute');
            expect(res.status).toBe(400);
            expect(res.body.errorCode).toBe('validation_error');
        });

        it('should return 502 for dispatch_error errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'PaymentCentralService not available',
                errorCode: 'dispatch_error',
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-4/execute');
            expect(res.status).toBe(502);
            expect(res.body.errorCode).toBe('dispatch_error');
        });

        it('should return 400 as default for unknown errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Something unexpected',
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-5/execute');
            expect(res.status).toBe(400);
        });

        it('should return 200 on successful execution', async () => {
            mockExecuteAction.mockResolvedValue({
                success: true,
                proposedAction: { id: 'nla-6', status: 'executed' },
                executionResult: { message: 'Done' },
                executedAt: new Date(),
            });

            const res = await request(app).post('/api/nl-action-gate/actions/nla-6/execute');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('POST /parse', () => {
        it('should return 400 when input is missing', async () => {
            const res = await request(app).post('/api/nl-action-gate/parse').send({});
            expect(res.status).toBe(400);
        });

        it('should return 422 when intent cannot be parsed', async () => {
            mockParseIntentSmart.mockResolvedValue(null);
            const res = await request(app).post('/api/nl-action-gate/parse').send({ input: 'gibberish' });
            expect(res.status).toBe(422);
        });

        it('should return parsed intent on success', async () => {
            mockParseIntentSmart.mockResolvedValue({
                action: 'refund',
                targetSystem: 'payment',
                operation: 'POST',
                parameters: { amount: 50 },
                confidence: 0.8,
                rawInput: 'refund $50',
            });
            const res = await request(app).post('/api/nl-action-gate/parse').send({ input: 'refund $50' });
            expect(res.status).toBe(200);
            expect(res.body.intent.action).toBe('refund');
        });
    });
});
