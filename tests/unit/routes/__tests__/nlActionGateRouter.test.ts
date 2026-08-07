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
import { ActionCapacityExceededError } from '../../../../src/services/ai/NLActionGateService';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/nl-action-gate', router);
    return app;
}

/**
 * F4: identity-requiring handlers (propose/approve/reject/execute/pending)
 * narrow req.user directly — stub the verified user BEFORE the router, the
 * unit stand-in for the mount's authMiddleware.
 */
function createAuthedApp(user: { id: string; tenantId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = user; next(); });
    app.use('/api/nl-action-gate', router);
    return app;
}

describe('NLActionGateRouter', () => {
    let app: express.Application;
    let authed: express.Application;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp();
        authed = createAuthedApp({ id: 'user-7', tenantId: 'tenant-a' });
    });

    describe('F4 — verified identity required', () => {
        it('execute without verified identity → 401 identity_required; service untouched', async () => {
            // Deliberately anonymous (createApp, no user): pins the 401 path.
            const res = await request(app).post('/api/nl-action-gate/actions/nla-1/execute');
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ success: false, error: 'identity_required' });
            expect(mockExecuteAction).not.toHaveBeenCalled();
        });

        it('approve passes the VERIFIED user + tenant to the service and ignores body userId', async () => {
            mockApproveAction.mockReturnValue({ id: 'nla-1', status: 'approved', approvedBy: 'user-7' });
            const res = await request(authed)
                .post('/api/nl-action-gate/actions/nla-1/approve')
                .send({ userId: 'forged-user' });
            expect(res.status).toBe(200);
            expect(mockApproveAction).toHaveBeenCalledWith('nla-1', 'user-7', 'tenant-a');
        });

        it('pending scopes to the verified tenant', async () => {
            mockGetPendingActions.mockReturnValue([]);
            await request(authed).get('/api/nl-action-gate/pending');
            expect(mockGetPendingActions).toHaveBeenCalledWith('tenant-a');
        });

        it('reject passes the verified tenant', async () => {
            mockRejectAction.mockReturnValue({ id: 'nla-1', status: 'rejected' });
            const res = await request(authed)
                .post('/api/nl-action-gate/actions/nla-1/reject')
                .send({ reason: 'nope' });
            expect(res.status).toBe(200);
            expect(mockRejectAction).toHaveBeenCalledWith('nla-1', 'tenant-a', 'nope');
        });

        // Codex R3 (#1055): capacity refusal is client-recoverable, not 500.
        it('propose maps ActionCapacityExceededError to 429 capacity_exceeded', async () => {
            mockParseIntentSmart.mockResolvedValue({ action: 'refund', targetSystem: 'payment', operation: 'POST', parameters: {}, confidence: 1, rawInput: 'refund' });
            mockProposeAction.mockImplementation(() => { throw new ActionCapacityExceededError('tenant-a'); });

            const res = await request(authed)
                .post('/api/nl-action-gate/propose')
                .send({ input: 'refund $50' });
            expect(res.status).toBe(429);
            expect(res.body).toMatchObject({ success: false, error: 'capacity_exceeded' });
        });
    });

    /**
     * PR3 follow-up: the private helper used to accept a JWT claiming the
     * retired `__system__` sentinel in EITHER claim, so a token minted by any
     * holder of JWT_SECRET reached `executeAction` (operationType
     * 'connector_write') and stamped `approvedBy` on approve. Same defect class
     * PR3 closed in fullPipelineDemo/hubSpot.
     */
    describe('PR3 follow-up — sentinel-claiming JWTs are refused', () => {
        const sentinelTenant = () => createAuthedApp({ id: 'user-7', tenantId: SYSTEM_IDENTITY.tenantId });
        const sentinelUser = () => createAuthedApp({ id: SYSTEM_IDENTITY.userId, tenantId: 'tenant-a' });

        it('execute refuses a sentinel TENANT claim; the connector_write dispatch is untouched', async () => {
            const res = await request(sentinelTenant()).post('/api/nl-action-gate/actions/nla-1/execute');
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ success: false, error: 'identity_required' });
            expect(mockExecuteAction).not.toHaveBeenCalled();
        });

        it('execute refuses a sentinel USER claim; the connector_write dispatch is untouched', async () => {
            const res = await request(sentinelUser()).post('/api/nl-action-gate/actions/nla-1/execute');
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ success: false, error: 'identity_required' });
            expect(mockExecuteAction).not.toHaveBeenCalled();
        });

        it('approve refuses a sentinel USER claim rather than stamping it as approvedBy', async () => {
            const res = await request(sentinelUser()).post('/api/nl-action-gate/actions/nla-1/approve').send({});
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ success: false, error: 'identity_required' });
            expect(mockApproveAction).not.toHaveBeenCalled();
        });

        it('approve refuses a sentinel TENANT claim', async () => {
            const res = await request(sentinelTenant()).post('/api/nl-action-gate/actions/nla-1/approve').send({});
            expect(res.status).toBe(401);
            expect(mockApproveAction).not.toHaveBeenCalled();
        });

        it('propose refuses a sentinel TENANT claim before any parse work', async () => {
            const res = await request(sentinelTenant())
                .post('/api/nl-action-gate/propose')
                .send({ input: 'refund $50' });
            expect(res.status).toBe(401);
            expect(mockParseIntentSmart).not.toHaveBeenCalled();
            expect(mockProposeAction).not.toHaveBeenCalled();
        });

        it('reject refuses a sentinel TENANT claim', async () => {
            const res = await request(sentinelTenant())
                .post('/api/nl-action-gate/actions/nla-1/reject')
                .send({ reason: 'nope' });
            expect(res.status).toBe(401);
            expect(mockRejectAction).not.toHaveBeenCalled();
        });

        it('pending refuses a sentinel TENANT claim rather than listing system-scoped actions', async () => {
            const res = await request(sentinelTenant()).get('/api/nl-action-gate/pending');
            expect(res.status).toBe(401);
            expect(mockGetPendingActions).not.toHaveBeenCalled();
        });

        it('a sentinel USER with a real tenant still scopes tenant-only reads (no over-tightening)', async () => {
            // pending needs only a tenant. Refusing here would be a behavior
            // change beyond the sentinel fix, so pin that it does NOT happen.
            mockGetPendingActions.mockReturnValue([]);
            const res = await request(sentinelUser()).get('/api/nl-action-gate/pending');
            expect(res.status).toBe(200);
            expect(mockGetPendingActions).toHaveBeenCalledWith('tenant-a');
        });
    });

    describe('POST /actions/:id/execute — errorCode → HTTP status mapping', () => {
        it('should return 404 for not_found errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Action not found',
                errorCode: 'not_found',
            });

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-fake/execute');
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

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-1/execute');
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

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-2/execute');
            expect(res.status).toBe(501);
            expect(res.body.errorCode).toBe('not_implemented');
        });

        it('should return 400 for validation_error errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Missing required parameter: invoiceId',
                errorCode: 'validation_error',
            });

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-3/execute');
            expect(res.status).toBe(400);
            expect(res.body.errorCode).toBe('validation_error');
        });

        it('should return 502 for dispatch_error errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'PaymentCentralService not available',
                errorCode: 'dispatch_error',
            });

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-4/execute');
            expect(res.status).toBe(502);
            expect(res.body.errorCode).toBe('dispatch_error');
        });

        it('should return 400 as default for unknown errorCode', async () => {
            mockExecuteAction.mockResolvedValue({
                success: false,
                error: 'Something unexpected',
            });

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-5/execute');
            expect(res.status).toBe(400);
        });

        it('should return 200 on successful execution', async () => {
            mockExecuteAction.mockResolvedValue({
                success: true,
                proposedAction: { id: 'nla-6', status: 'executed' },
                executionResult: { message: 'Done' },
                executedAt: new Date(),
            });

            const res = await request(authed).post('/api/nl-action-gate/actions/nla-6/execute');
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
