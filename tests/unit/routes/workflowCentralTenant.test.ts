/**
 * F5b Task 9: workflowCentral off the SYSTEM_IDENTITY fallback + strict
 * actor resolution (the isPreAuth body-actor path is deleted). Services are
 * mocked at the container boundary; attestReadsOnly() simulates the gate's
 * reads-only anonymous demo attestation.
 */
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const mockGetDashboard = jest.fn();
const mockStartInstance = jest.fn();
const mockCancelInstance = jest.fn();
const mockDelegateTask = jest.fn();
const mockCompleteTask = jest.fn();

const mockWorkflowService = {
  getDashboard: mockGetDashboard,
  getMetrics: jest.fn(),
  startInstance: mockStartInstance,
  cancelInstance: mockCancelInstance,
  delegateTask: mockDelegateTask,
};

const mockOperatorService = {
  completeTask: mockCompleteTask,
  getTaskForOperator: jest.fn(),
};

const mockEngine = { hydrationReady: true };
const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('WorkflowEngineService')) return mockEngine;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
    getAsync: jest.fn(async (type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('WorkflowCentralOperatorService')) return mockOperatorService;
      if (typeName.includes('WorkflowCentralService')) return mockWorkflowService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
  },
}));

// eslint-disable-next-line import/first
import { workflowCentralRouter } from '../../../src/routes/workflowCentral';
// eslint-disable-next-line import/first
import { attestReadsOnly } from './central/centralRouterHarness';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../src/services/governance/demoTenant';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(attestReadsOnly());
  app.use('/api/workflow-central', workflowCentralRouter);
  return app;
}

function createAuthedApp(userId: string, tenantId = 'tenant-a') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { tenantId, id: userId };
    next();
  });
  app.use('/api/workflow-central', workflowCentralRouter);
  return app;
}

describe('workflowCentral tenant + actor resolution (F5b)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEngine.hydrationReady = true;
    app = createApp();
  });

  it('no longer imports extractIdentityContext or SYSTEM_IDENTITY', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/routes/workflowCentral.ts'),
      'utf8',
    );
    expect(src).not.toContain('extractIdentityContext');
    expect(src).not.toContain('SYSTEM_IDENTITY');
  });

  it('resolves a gate-attested anonymous dashboard read to the demo tenant', async () => {
    mockGetDashboard.mockResolvedValue({ ok: true });
    const res = await request(app).get('/api/workflow-central/dashboard').set('x-test-demo', '1');
    expect(res.status).toBe(200);
    expect(mockGetDashboard).toHaveBeenCalledWith(CENTRAL_DEMO_TENANT_ID, undefined);
  });

  it('401s an unattested credential-free dashboard read (the removed fallback)', async () => {
    const res = await request(app).get('/api/workflow-central/dashboard');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockGetDashboard).not.toHaveBeenCalled();
  });

  // Bodies are OTHERWISE VALID so the 401 is the identity refusal, not a 400.
  // POST /tasks/:id/complete validates actionId BEFORE identity — omitting it
  // yields 400 and proves nothing.
  it.each([
    ['/api/workflow-central/instances', { workflowId: 'wf-1', startedBy: 'attacker' }],
    ['/api/workflow-central/instances/i1/cancel', { reason: 'r', cancelledBy: 'attacker' }],
    ['/api/workflow-central/tasks/t1/complete', { actionId: 'approve', completedBy: 'attacker' }],
    [
      '/api/workflow-central/tasks/t1/delegate',
      { newAssigneeId: 'n1', newAssigneeName: 'Nia', delegatedBy: 'attacker' },
    ],
  ])(
    '401s the anonymous write %s (harness attests reads only; writes have no actor)',
    async (writePath, body) => {
      const res = await request(app).post(writePath).set('x-test-demo', '1').send(body);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'identity_required' });
    },
  );

  // REGRESSION COVERAGE, NOT RED-PHASE PROOF. The pre-migration code already
  // prefers the verified subject for an AUTHENTICATED caller: isPreAuth is
  // `tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId`,
  // and both are false once req.user carries a real tenant. This case passes
  // before and after; it exists so a later refactor cannot quietly reintroduce
  // the body-actor path (Codex review round 3).
  it('uses the verified subject as the actor and ignores the body actor', async () => {
    mockStartInstance.mockResolvedValue({ id: 'inst-1' });
    const authed = createAuthedApp('user-1');
    const res = await request(authed)
      .post('/api/workflow-central/instances')
      .send({ workflowId: 'wf-1', startedBy: 'attacker' });
    expect(res.status).toBe(201);
    expect(mockStartInstance).toHaveBeenCalledWith(
      expect.objectContaining({ startedBy: 'user-1' }),
    );
  });

  // THIS is the red-phase proof for the actor change: pre-migration, an
  // unauthenticated POST resolves to SYSTEM_IDENTITY, isPreAuth is TRUE, and
  // the body actor is honored — so the handler returns 2xx with
  // startedBy: 'attacker'. Post-migration the gate/helper refuses it outright.
  it('401s the anonymous write instead of honoring the body actor', async () => {
    mockStartInstance.mockResolvedValue({ id: 'inst-1' });
    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId: 'wf-1', startedBy: 'attacker' });
    expect(res.status).toBe(401);
    expect(mockStartInstance).not.toHaveBeenCalled();
  });
});
