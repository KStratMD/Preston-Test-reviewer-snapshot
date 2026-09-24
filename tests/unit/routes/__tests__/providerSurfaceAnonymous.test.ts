/**
 * F2 zero-spend ruling (v4, Codex v3 finding 1): several
 * provider.testConnection() implementations issue REAL paid completions, so
 * the anonymous demo surface must never invoke them — GET /providers returns
 * unprobed registry metadata and POST /providers/:id/test returns a fixture.
 */
import express from 'express';
import request from 'supertest';
import { createProviderRouter } from '../../../../src/routes/ai-proxy/ProviderRouter';
import { createQualityRouter } from '../../../../src/routes/ai-proxy/QualityRouter';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

function buildRegistry() {
  const provider = {
    testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'connected' }),
    analyzeDataQuality: jest.fn(),
  };
  return {
    provider,
    registry: {
      listProviders: jest.fn().mockReturnValue([{ id: 'openai', name: 'OpenAI', configured: true }]),
      getProvider: jest.fn().mockReturnValue(provider),
      getAvailableProvider: jest.fn().mockReturnValue(provider),
    } as any,
  };
}

async function makeApps(identity?: Record<string, unknown>) {
  const { provider, registry } = buildRegistry();
  const modelCatalog = { aggregate: jest.fn().mockResolvedValue([]), listModels: jest.fn(), setActiveModel: jest.fn() } as any;
  const telemetry = { getStatistics: jest.fn().mockReturnValue({}) } as any;
  const governanceService = { validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [], riskLevel: 'low', complianceChecks: [] }) } as any;

  const app = express();
  app.use(express.json());
  if (identity) app.use((req, _res, next) => { (req as any).user = identity; next(); });
  app.use('/', await createProviderRouter({ logger, registry, modelCatalog }));
  app.use('/', await createQualityRouter({ logger, telemetry, registry, governanceService }));
  return { app, provider };
}

describe('anonymous provider surface is zero-spend (F2 v4)', () => {
  it('anonymous GET /providers returns unprobed metadata — testConnection never called', async () => {
    const { app, provider } = await makeApps();
    const res = await request(app).get('/providers');
    expect(res.status).toBe(200);
    expect(provider.testConnection).not.toHaveBeenCalled();
    expect(res.body.providers[0].probed).toBe(false);
  });

  it('authenticated GET /providers still live-probes', async () => {
    const { app, provider } = await makeApps({ id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    const res = await request(app).get('/providers');
    expect(res.status).toBe(200);
    expect(provider.testConnection).toHaveBeenCalled();
  });

  it('anonymous POST /providers/:id/test returns a fixture — provider never touched', async () => {
    const { app, provider } = await makeApps();
    const res = await request(app).post('/providers/openai/test').send({});
    expect(res.status).toBe(200);
    expect(provider.testConnection).not.toHaveBeenCalled();
    expect(res.body.demoFixture).toBe(true);
  });

  it('anonymous POST /providers/:id/test with an invented id keeps the 404 contract', async () => {
    const { app, provider } = await makeApps();
    const res = await request(app).post('/providers/not-a-provider/test').send({});
    expect(res.status).toBe(404);
    expect(provider.testConnection).not.toHaveBeenCalled();
  });

  it('authenticated POST /providers/:id/test still runs the live test', async () => {
    const { app, provider } = await makeApps({ id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    await request(app).post('/providers/openai/test').send({});
    expect(provider.testConnection).toHaveBeenCalled();
  });
});
