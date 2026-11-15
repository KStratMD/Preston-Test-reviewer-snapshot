/**
 * F2 zero-spend ruling: anonymous requests must never reach the orchestrator
 * through MappingRouter — its paid handlers delegate via next() to the
 * rule-based aiMapping router mounted after it in aiProxy.ts. Also pins the
 * D1 attribution direction: authenticated requests DO invoke the agent.
 */
import express from 'express';
import request from 'supertest';
import { createMappingRouter } from '../../../../src/routes/ai-proxy/MappingRouter';

function buildDeps() {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    telemetry: {
      recordAISuggestionRequested: jest.fn().mockResolvedValue(undefined),
      recordAISuggestionGenerated: jest.fn().mockResolvedValue(undefined),
      recordAISuggestionAccepted: jest.fn().mockResolvedValue(undefined),
      recordEvent: jest.fn().mockResolvedValue(undefined),
      recordErrorOccurred: jest.fn().mockResolvedValue(undefined),
    } as any,
    costTracking: { getSessionCost: jest.fn().mockReturnValue({ totalCost: 0 }), getCostLimits: jest.fn() } as any,
    governanceService: { validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }), validateOutput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }) } as any,
    orchestrator: {
      executeAgent: jest.fn().mockResolvedValue({
        success: true,
        confidence: 0.9,
        reasoning: [],
        data: { mappings: [{ sourceField: 'a', targetField: 'b', confidence: 0.9 }] },
      }),
    } as any,
  };
}

const SUGGEST_BODY = {
  sourceSystem: 'salesforce',
  targetSystem: 'netsuite',
  sourceFields: [{ name: 'company_name', type: 'string' }],
  targetFields: [{ name: 'companyname', type: 'string' }],
};

async function makeApp(deps: ReturnType<typeof buildDeps>, identity?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  if (identity) {
    app.use((req, _res, next) => { (req as any).user = identity; next(); });
  }
  app.use('/', await createMappingRouter(deps));
  // Sentinel standing in for the aiMapping router mounted after MappingRouter
  // in aiProxy.ts — reached ONLY when MappingRouter calls next().
  app.post('/mapping/suggestions', (_req, res) => { res.json({ delegated: true }); });
  app.post('/mapping/transformation/suggest', (_req, res) => { res.json({ delegated: true }); });
  return app;
}

describe('MappingRouter anonymous zero-spend delegation (F2)', () => {
  it('anonymous POST /mapping/suggestions delegates via next() — orchestrator never invoked', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps);
    const res = await request(app).post('/mapping/suggestions').send(SUGGEST_BODY);
    expect(res.body.delegated).toBe(true);
    expect(deps.orchestrator.executeAgent).not.toHaveBeenCalled();
  });

  it('anonymous POST /mapping/transformation/suggest delegates likewise', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps);
    const res = await request(app).post('/mapping/transformation/suggest').send({
      sourceField: { name: 'a', type: 'string' },
      targetField: { name: 'b', type: 'string' },
    });
    expect(res.body.delegated).toBe(true);
    expect(deps.orchestrator.executeAgent).not.toHaveBeenCalled();
  });

  it('anonymous malformed suggestions preserve the 400 contract without telemetry persistence', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps);
    const res = await request(app).post('/mapping/suggestions').send({ ...SUGGEST_BODY, sourceFields: [] });
    expect(res.status).toBe(400);
    expect(deps.telemetry.recordErrorOccurred).not.toHaveBeenCalled();
    expect(deps.orchestrator.executeAgent).not.toHaveBeenCalled();
  });

  it('anonymous transformation delegation requires string field types', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps);
    const res = await request(app).post('/mapping/transformation/suggest').send({
      sourceField: { name: 'a' },
      targetField: { name: 'b' },
    });
    expect(res.status).toBe(400);
    expect(deps.orchestrator.executeAgent).not.toHaveBeenCalled();
  });

  it('authenticated POST /mapping/suggestions invokes the agent (D1 attribution direction)', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps, { id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    const res = await request(app).post('/mapping/suggestions').send(SUGGEST_BODY);
    expect(res.body.delegated).toBeUndefined();
    expect(deps.orchestrator.executeAgent).toHaveBeenCalled();
  });

  it('anonymous POST /suggestions/:id/accept is a no-op fixture — telemetry never persisted', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps);
    const res = await request(app).post('/suggestions/s-1/accept').send({});
    expect(res.body).toEqual({ success: true, demoFixture: true, recorded: false });
    expect(deps.telemetry.recordAISuggestionAccepted).not.toHaveBeenCalled();
  });

  it('authenticated POST /suggestions/:id/accept still records', async () => {
    const deps = buildDeps();
    const app = await makeApp(deps, { id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    await request(app).post('/suggestions/s-1/accept').send({});
    expect(deps.telemetry.recordAISuggestionAccepted).toHaveBeenCalled();
  });
});
