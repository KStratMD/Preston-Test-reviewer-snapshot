import request from 'supertest';

// Demo-friendly env
process.env.DEMO_MODE = process.env.DEMO_MODE || '1';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || '0';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { Server } from '../../src/index';

// Check if real AI providers are configured. OPENROUTER_API_KEY counts (C8):
// OpenRouter's pinned :free model runs these live smokes at $0.
const hasAIProvider = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.LMSTUDIO_BASE_URL);

describe('Multi-Agent Orchestrator smoke test (in-process)', () => {
  let app: import('express').Application;

  beforeAll(async () => {
    // Real timers required — supertest HTTP + AI provider calls need real I/O
    jest.useRealTimers();
    const server = new Server();
    // Wait for async initialization to complete (routes, services, etc.)
    await server.waitForInitialization();
    app = server.getExpressApp();
  });

  (hasAIProvider ? it : it.skip)('POST /api/ai/proxy/orchestrate should execute a simple sequential workflow', async () => {
    const workflow = {
      agents: ['field-mapping', 'data-quality'],
      parallel: false,
      failureMode: 'continue',
      timeout: 10000
    };

    const input = {
      // FieldMappingAgent input
      sourceFields: [
        { name: 'FirstName', type: 'string', required: false },
        { name: 'LastName', type: 'string', required: false },
        { name: 'Email', type: 'string', required: false }
      ],
      targetFields: [
        { name: 'first_name', type: 'string', required: false },
        { name: 'last_name', type: 'string', required: false },
        { name: 'email_address', type: 'string', required: false }
      ],

      // DataQualityAgent input
      data: [
        { FirstName: 'Alice', LastName: 'Anderson', Email: 'alice@example.org' },
        { FirstName: 'Bob', LastName: 'Baker', Email: 'bob@example.org' }
      ],
      schema: [
        { name: 'FirstName', type: 'string', required: false },
        { name: 'LastName', type: 'string', required: false },
        { name: 'Email', type: 'string', required: false }
      ],

      // Execution context hints (non-prod, non-sensitive)
      industry: 'manufacturing',
      businessProcess: 'lead_import',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite'
    };

    const res = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id', 'smoke-test-user')
      .send({ workflow, input });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.metadata?.sessionId).toBeDefined();
    // Result object basic shape checks
    expect(res.body?.result).toBeDefined();
    expect(typeof res.body.result?.overallConfidence).toBe('number');
    expect(typeof res.body.result?.totalExecutionTime).toBe('number');
    // Ensure results are serialized as a plain object (not a Map)
    const resultsObj = res.body.result?.results;
    expect(resultsObj && typeof resultsObj).toBe('object');
    if (resultsObj) {
      expect(typeof resultsObj.forEach).toBe('undefined');
    }
  }, 60000); // 60s timeout for real LMStudio AI calls

  (hasAIProvider ? it : it.skip)('POST orchestrate then fetch status and trace (may be ephemeral)', async () => {
    const workflow = {
      agents: ['field-mapping'],
      parallel: false,
      failureMode: 'continue',
      timeout: 10000
    };

    const input = {
      sourceFields: [{ name: 'Email', type: 'string' }],
      targetFields: [{ name: 'email_address', type: 'string' }],
      data: [{ Email: 'user@example.org' }],
      schema: [{ name: 'Email', type: 'string' }]
    };

    const post = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id', 'smoke-test-user')
      .send({ workflow, input });

    expect(post.status).toBe(200);
    const sessionId = post.body?.metadata?.sessionId;
    expect(sessionId).toBeDefined();

    // Even if the orchestrator session is cleaned up quickly, endpoints should not 500
    const statusRes = await request(app).get(`/api/ai/proxy/orchestrate/${encodeURIComponent(sessionId)}/status`);
    expect([200, 404]).toContain(statusRes.status);

    const traceRes = await request(app).get(`/api/ai/proxy/orchestrate/${encodeURIComponent(sessionId)}/trace`);
    expect([200, 404]).toContain(traceRes.status);
  }, 60000); // 60s timeout for real LMStudio AI calls

  it('Governance block: oversized input should result in 400 with structured governance error', async () => {
    const workflow = {
      agents: ['field-mapping'],
      parallel: false,
      failureMode: 'abort',
      timeout: 10000
    };

    // Create a large payload (>1MB) to trigger data_size_limit rule
    const bigString = 'x'.repeat(1_200_000);
    const input = { text: bigString } as any;

    const res = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id', 'smoke-test-user')
      .send({ workflow, input });

  expect(res.status).toBe(400);
  expect(res.body?.success).toBe(false);
  // Structured governance error shape
  expect(res.body?.error?.type).toBe('governance_violation');
  expect(typeof res.body?.error?.message).toBe('string');
  // ruleId should be present when a specific rule triggered the block
  expect(typeof res.body?.error?.ruleId === 'string' || res.body?.error?.ruleId === undefined).toBe(true);
  expect(res.body?.governance?.blocked).toBe(true);
  });
});
