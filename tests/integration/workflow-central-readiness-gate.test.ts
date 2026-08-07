import express from 'express';
import request from 'supertest';
import { workflowCentralReadyGate } from '../../src/middleware/workflowCentralReady';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';

describe('workflowCentralReadyGate', () => {
  it('returns 503 when engine.hydrationReady === false', async () => {
    const fakeEngine = { hydrationReady: false } as any;
    const app = express();
    app.use(workflowCentralReadyGate(fakeEngine));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('service_unavailable');
  });

  it('passes through when engine.hydrationReady === true', async () => {
    const fakeEngine = { hydrationReady: true } as any;
    const app = express();
    app.use(workflowCentralReadyGate(fakeEngine));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('T-25 re-hydration window: 503s while a SECOND hydrate() is in flight', async () => {
    const repo: any = {
      listInstancesForHydration: jest.fn(() => new Promise<any[]>(resolve => { repo.__resolve = () => resolve([]); })),
    };
    const noopLogger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const engine = new WorkflowEngineService(noopLogger);
    engine.hydrationReady = true;
    const app = express();
    app.use(workflowCentralReadyGate(engine));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // Begin re-hydrate (does NOT await — Promise pending)
    const hydratePromise = engine.hydrate(repo);
    // engine.hydrate() must set hydrationReady=false BEFORE awaiting listInstancesForHydration
    expect(engine.hydrationReady).toBe(false);

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(503);

    repo.__resolve();
    await hydratePromise;

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
  });
});
