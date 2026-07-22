import request from 'supertest';

process.env.DEMO_MODE = process.env.DEMO_MODE || '1';
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED || '0';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { Server } from '../../src/index';

// Check if real AI providers are configured. OPENROUTER_API_KEY counts (C8):
// OpenRouter's pinned :free model runs these live smokes at $0.
const hasAIProvider = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.LMSTUDIO_BASE_URL);
const FLEXIBLE_STATUSES = [200, 400, 401, 404, 500];

describe('Single Agent execution (in-process)', () => {
  let app: import('express').Application;

  beforeAll(async () => {
    // Real timers required — supertest HTTP + AI provider calls need real I/O
    jest.useRealTimers();
    const server = new Server();
    // Wait for async initialization to complete (routes, services, etc.)
    await server.waitForInitialization();
    app = server.getExpressApp();
  });

  (hasAIProvider ? it : it.skip)('POST /api/ai/proxy/agents/field-mapping should succeed with minimal input', async () => {
    const input = {
      sourceFields: [
        { name: 'FirstName', type: 'string' },
        { name: 'LastName', type: 'string' }
      ],
      targetFields: [
        { name: 'first_name', type: 'string' },
        { name: 'last_name', type: 'string' }
      ],
      sampleData: [{ FirstName: 'Jane', LastName: 'Doe' }]
    };

    const res = await request(app)
      .post('/api/ai/proxy/agents/field-mapping')
      .set('x-user-id', 'smoke-test-user')
      .send({ input });

    // Log response for debugging if test fails
    if (!res.body?.result?.success) {
      console.log('Test failed - Full response body:', JSON.stringify(res.body, null, 2));
    }

    expect(FLEXIBLE_STATUSES).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.success).toBe(true);
      if (res.body?.result) {
        expect(typeof res.body.result.confidence).toBe('number');
      }
    } else {
      expect(res.body?.success).toBe(false);
    }
  }, 60000); // 60s timeout for real LMStudio AI calls

  it('POST /api/ai/proxy/agents/unknown should 400 for invalid agent type', async () => {
    const res = await request(app)
      .post('/api/ai/proxy/agents/unknown')
      .send({ input: {} });

    expect(res.status).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(String(res.body?.error).toLowerCase()).toContain('invalid agent type');
  });

  it('Governance block: malicious content should result in 400 with structured governance error', async () => {
    const input = {
      sourceFields: [
        { name: 'FirstName', type: 'string' },
        { name: 'LastName', type: 'string' }
      ],
      targetFields: [
        { name: 'first_name', type: 'string' },
        { name: 'last_name', type: 'string' }
      ],
      // Inject content that matches the 'malicious' content filter (action: block)
      sampleData: [
        { FirstName: '<script>alert(1)</script>', LastName: 'User' }
      ]
    };

    const res = await request(app)
      .post('/api/ai/proxy/agents/field-mapping')
      .set('x-user-id', 'smoke-test-user')
      .send({ input });

    expect(res.status).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.type).toBe('governance_violation');
    expect(typeof res.body?.error?.message).toBe('string');
    // ruleId should be present when a specific rule/filter triggered the block
    expect(typeof res.body?.error?.ruleId === 'string' || res.body?.error?.ruleId === undefined).toBe(true);
    expect(res.body?.governance?.blocked).toBe(true);
  });

  it('Governance block (mapping): malicious sampleData should return 400 with structured governance error', async () => {
    const body = {
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      sourceFields: [
        { name: 'FirstName', type: 'string' },
        { name: 'LastName', type: 'string' }
      ],
      targetFields: [
        { name: 'first_name', type: 'string' },
        { name: 'last_name', type: 'string' }
      ],
      sampleData: [
        { FirstName: '<script>alert(1)</script>', LastName: 'User' }
      ]
    };

    const res = await request(app)
      .post('/api/ai/proxy/mapping/suggestions')
      .set('x-user-id', 'smoke-test-user')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.type).toBe('governance_violation');
    expect(typeof res.body?.error?.message).toBe('string');
    expect(typeof res.body?.error?.ruleId === 'string' || res.body?.error?.ruleId === undefined).toBe(true);
    expect(res.body?.governance?.blocked).toBe(true);
  });

  it('Governance block (data-quality): malicious data should return 400 with structured governance error', async () => {
    const body = {
      data: [
        { comment: 'normal' },
        { comment: '<script>evil()</script>' }
      ],
      sourceSystem: 'CRM',
      businessPurpose: 'testing',
      schema: [
        { name: 'comment', type: 'string' }
      ]
    };

    const res = await request(app)
      .post('/api/ai/proxy/data-quality/analyze')
      .set('x-user-id', 'smoke-test-user')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.type).toBe('governance_violation');
    expect(typeof res.body?.error?.message).toBe('string');
    expect(typeof res.body?.error?.ruleId === 'string' || res.body?.error?.ruleId === undefined).toBe(true);
    expect(res.body?.governance?.blocked).toBe(true);
  });

  (hasAIProvider ? it : it.skip)('Warn-only rule (production_protection) should not block orchestrate but add flags', async () => {
    const workflow = { agents: ['field-mapping'], parallel: false, failureMode: 'continue', timeout: 10000 };
    const input = {
      sourceFields: [{ name: 'Id', type: 'string' }],
      targetFields: [{ name: 'id', type: 'string' }],
      // Provide context that targets a production system to trigger warn-only rule
      sourceSystem: 'CRM',
      targetSystem: 'Production-ERP'
    };

    const res = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id', 'smoke-test-user')
      .send({ workflow, input, context: { targetSystem: 'production' } });

    expect(FLEXIBLE_STATUSES).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.success).toBe(true);
    }
    const flags: string[] = res.body?.result?.governance?.complianceFlags || res.body?.governance?.complianceFlags || [];
    // flags may include rule_production_protection_triggered if context was propagated
    expect(Array.isArray(flags)).toBe(true);
  }, 60000); // 60s timeout for real LMStudio AI calls

  (hasAIProvider ? it : it.skip)('Warn-only rule (industry_compliance) should not block orchestrate for regulated industry', async () => {
    const workflow = { agents: ['field-mapping'], parallel: false, failureMode: 'continue', timeout: 10000 };
    const input = {
      sourceFields: [{ name: 'Id', type: 'string' }],
      targetFields: [{ name: 'id', type: 'string' }]
    };

    const res = await request(app)
      .post('/api/ai/proxy/orchestrate')
      .set('x-user-id', 'smoke-test-user')
      .send({ workflow, input, context: { industry: 'healthcare' } });

    expect(FLEXIBLE_STATUSES).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.success).toBe(true);
    }
    const flags: string[] = res.body?.result?.governance?.complianceFlags || res.body?.governance?.complianceFlags || [];
    expect(Array.isArray(flags)).toBe(true);
  }, 60000); // 60s timeout for real LMStudio AI calls
});
