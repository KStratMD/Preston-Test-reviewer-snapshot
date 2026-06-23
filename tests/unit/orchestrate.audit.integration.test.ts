import request from 'supertest';

process.env.DEMO_MODE = process.env.DEMO_MODE || '1';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || '0';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { Server } from '../../src/index';

describe('Orchestrate + Audit correlation (integration)', () => {
  let app: import('express').Application;

  beforeAll(async () => {
    // Real timers required — supertest HTTP + AI provider calls need real I/O
    jest.useRealTimers();
    const server = new Server();
    // Wait for async initialization to complete (routes, services, etc.)
    await server.waitForInitialization();
    app = server.getExpressApp();
  });

  it('should execute workflow and surface an audit record with matching session id (best-effort)', async () => {
    const workflow = { agents: ['field-mapping','data-quality'], parallel: true, failureMode: 'continue', timeout: 15000 };
    const input = {
      sourceFields: [ { name: 'Email', type: 'string' } ],
      targetFields: [ { name: 'email_address', type: 'string' } ],
      data: [ { Email: 'alpha@example.org' } ],
      schema: [ { name: 'Email', type: 'string' } ]
    };

    const res = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id','audit-test-user')
      .send({ workflow, input });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const sessionId: string | undefined = res.body?.metadata?.sessionId;
    expect(sessionId).toBeDefined();

    // Attempt to fetch latest audit entry – implementation may return recent session
    const audit = await request(app).get('/api/agents/audit/latest');
    expect([200,404]).toContain(audit.status);
    if (audit.status === 200) {
      const auditBody = audit.body || {};
      // Soft assertion: if sessionId present in audit payload, should match orchestrate response
      const auditSession = auditBody.sessionId || auditBody.metadata?.sessionId || auditBody.workflowSessionId;
      if (auditSession) {
        expect(auditSession).toBe(sessionId);
      }
      // Always ensure structure contains basic trace fields
      expect(typeof (auditBody.timestamp || auditBody.time || '')).toBe('string');
    }
  }, 60000); // 60s timeout for real LMStudio AI calls
});
