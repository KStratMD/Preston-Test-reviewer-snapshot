import request from 'supertest';

// Set demo-friendly env before importing app/server code
process.env.DEMO_MODE = process.env.DEMO_MODE || '1';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || '0';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { Server } from '../../src/index';

describe('AI Proxy smoke tests (in-process app)', () => {
  let app: import('express').Application;

  beforeAll(async () => {
    const server = new Server();
    // Wait for async initialization to complete (routes, services, etc.)
    await server.waitForInitialization();
    app = server.getExpressApp();
  });

  it('GET /health should respond with 200 and status payload', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // Status may be 'ok' or 'healthy' depending on router path; accept either
    const statusVal = (res.body.status || res.body.data?.status || '').toString().toLowerCase();
    expect(['ok', 'healthy'].includes(statusVal)).toBe(true);
  });

  it('GET /api/ai/proxy/agents should list registered agents', async () => {
    const res = await request(app).get('/api/ai/proxy/agents');
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(Array.isArray(res.body?.agents)).toBe(true);
    // Expect at least the four agents described in docs
    const agentIds = (res.body.agents as any[]).map(a => a.id);
    for (const id of ['field-mapping', 'data-quality', 'process-optimization', 'integration-strategy']) {
      expect(agentIds).toContain(id);
    }
  });
});
