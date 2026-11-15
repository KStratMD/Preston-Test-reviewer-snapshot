import request from 'supertest';
import jwt from 'jsonwebtoken';

// Set demo-friendly env before importing app/server code
process.env.DEMO_MODE = process.env.DEMO_MODE || '1';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || '0';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

// F2: /api/ai/proxy requires auth outside the exact demo allowlist.
// fastMocks' AuthService stub ignores tokens (no subject → 401), so restore
// the real HS256 verification path for these smoke tests.
jest.unmock('../../src/services/AuthService');

import { Server } from '../../src/index';

describe('AI Proxy smoke tests (in-process app)', () => {
  let app: import('express').Application;
  let auth: Record<string, string>;

  beforeAll(async () => {
    const server = new Server();
    // Wait for async initialization to complete (routes, services, etc.)
    await server.waitForInitialization();
    app = server.getExpressApp();
    const token = jwt.sign(
      { id: 'smoke-user', username: 'smoke-user', tenantId: 'tenant-smoke', roles: ['user'] },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '10m' },
    );
    auth = { Authorization: `Bearer ${token}` };
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
    const res = await request(app).get('/api/ai/proxy/agents').set(auth);
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
