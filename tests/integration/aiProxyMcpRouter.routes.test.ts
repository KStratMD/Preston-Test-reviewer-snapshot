/**
 * F2 (D1 evidence, Codex round-4 finding 3): signed-JWT → real gate → real
 * MCPRouter. Proves tenant scoping end-to-end: a tenant-A JWT reaches
 * integration_status with ITS tenant id for subscriptions and never receives
 * the global operation map; an anonymous demo call gets the fixture.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mountAiProxyRoutes } from '../../src/middleware/setup/RouteSetup';
import { createMCPRouter } from '../../src/routes/ai-proxy/MCPRouter';

const fakeTenantService = { requireActive: jest.fn(async () => undefined) } as any;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

async function createApp(demo: boolean) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const governanceService = { validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }) } as any;
  const orchestrator = { executeAgent: jest.fn() } as any;
  const syncOrchestrator = { getOperations: jest.fn().mockResolvedValue([]) } as any;
  const syncService = { getSubscriptions: jest.fn().mockResolvedValue({ subscriptions: [], totalCount: 0 }) } as any;

  const mcpRouter = await createMCPRouter({ logger, governanceService, orchestrator, syncOrchestrator, syncService } as any);
  const family = express.Router();
  family.use('/mcp', mcpRouter);

  const app = express();
  app.use(express.json());
  mountAiProxyRoutes(app, fakeTenantService, family, { isDemoRuntime: () => demo });
  return { app, syncOrchestrator, syncService };
}

const STATUS_CALL = { jsonrpc: '2.0', id: 'it-1', method: 'tools/call', params: { name: 'suitecentral.integration_status', arguments: {} } };

describe('/api/ai/proxy/mcp — real router behind the real mount (F2)', () => {
  beforeAll(() => {
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'integration-test-secret-ai-proxy-mcp';
  });

  beforeEach(() => {
    delete process.env.MCP_GATEWAY_ENABLED;
    jest.clearAllMocks();
  });

  it('signed tenant-A JWT: subscriptions scoped to tenant-a, global operations withheld', async () => {
    const { app, syncOrchestrator, syncService } = await createApp(false);
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 'tenant-a', roles: ['user'] });

    const res = await request(app)
      .post('/api/ai/proxy/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send(STATUS_CALL)
      .expect(200);

    expect(syncService.getSubscriptions).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(syncOrchestrator.getOperations).not.toHaveBeenCalled();
    expect(res.body.result?.structuredContent?.operationsWithheld).toBe(true);
  });

  it('signed platform-admin JWT receives the global operation view', async () => {
    const { app, syncOrchestrator } = await createApp(false);
    const token = signToken({ id: 'a1', username: 'a1', tenantId: 't-1', roles: ['admin'] });

    await request(app)
      .post('/api/ai/proxy/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send(STATUS_CALL)
      .expect(200);

    expect(syncOrchestrator.getOperations).toHaveBeenCalled();
  });

  it('anonymous demo call gets the fixture — no service reads', async () => {
    const { app, syncOrchestrator, syncService } = await createApp(true);

    const res = await request(app).post('/api/ai/proxy/mcp').send(STATUS_CALL).expect(200);

    expect(res.body.result?.structuredContent?.demoFixture).toBe(true);
    expect(syncOrchestrator.getOperations).not.toHaveBeenCalled();
    expect(syncService.getSubscriptions).not.toHaveBeenCalled();
  });

  it('anonymous call outside a demo runtime → 401 before the router', async () => {
    const { app } = await createApp(false);
    await request(app).post('/api/ai/proxy/mcp').send(STATUS_CALL).expect(401);
  });
});
