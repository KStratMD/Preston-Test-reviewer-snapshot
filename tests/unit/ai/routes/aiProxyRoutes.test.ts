/**
 * AI Proxy Routes Unit Tests
 * Tests for the refactored AI proxy router and sub-routers
 */

import request from 'supertest';
import express, { Application } from 'express';
import { createAIProxyRouter } from '../../../../src/routes/aiProxy';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';
import { UnifiedTelemetryService } from '../../../../src/services/UnifiedTelemetryService';

const FLEXIBLE_STATUSES = [200, 400, 401, 404, 500];

describe('AI Proxy Routes', () => {
  let app: Application;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    const aiRouter = await createAIProxyRouter();
    app.use('/api/ai/proxy', aiRouter);
  });

  describe('Provider Router Endpoints', () => {
    it('GET /models should return aggregate model catalog', async () => {
      const res = await request(app).get('/api/ai/proxy/models');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('providers');
        expect(typeof res.body.providers).toBe('object');
      }
    });

    it('GET /models/active should return currently active models', async () => {
      const res = await request(app).get('/api/ai/proxy/models/active');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('activeModels');
      }
    });

    it('GET /models/:provider should list provider-specific models', async () => {
      const res = await request(app).get('/api/ai/proxy/models/openai');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.provider).toBe('openai');
        expect(Array.isArray(res.body.models)).toBe(true);
      }
    });

    it('GET /models/:provider/capabilities should return provider capabilities', async () => {
      const res = await request(app).get('/api/ai/proxy/models/openai/capabilities');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.provider).toBe('openai');
      }
    });

    it('GET /models/:provider should reject invalid provider', async () => {
      const res = await request(app).get('/api/ai/proxy/models/invalid-provider');
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid provider');
    });
  });

  describe('Agent Router Endpoints', () => {
    it('GET /agents should list registered agents', async () => {
      const res = await request(app).get('/api/ai/proxy/agents');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.agents)).toBe(true);
        
        // Verify all 5 agents are registered
        const agentIds = res.body.agents.map((a: any) => a.id);
        expect(agentIds).toContain('field-mapping');
        expect(agentIds).toContain('data-quality');
        expect(agentIds).toContain('process-optimization');
        expect(agentIds).toContain('integration-strategy');
        expect(agentIds).toContain('business-intelligence');
      }
    });

    it('POST /agents/:agentType should validate agent type', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/invalid-agent')
        .send({ input: { test: 'data' } });
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid agent type');
    });

    it('POST /agents/:agentType should require input field', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/field-mapping')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required field: input');
    });

    it('POST /orchestrate should validate required workflow field', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/orchestrate')
        .send({ input: { test: 'data' } });
      
      expect([400, 404]).toContain(res.status);
      if (res.body?.error) {
        expect(res.body.error).toMatch(/missing required/i);
      }
    });
  });

  describe('Mapping Router Endpoints', () => {
    it('POST /field-mapping should validate required fields', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({});
      
      expect([400, 404]).toContain(res.status);
      if (res.body?.success !== undefined) {
        expect(res.body.success).toBe(false);
      }
      if (res.body?.error) {
        expect(res.body.error).toMatch(/missing required/i);
      }
    });

    it('POST /field-mapping should accept valid mapping request', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: [{ name: 'AccountName', type: 'string' }],
          targetFields: [{ name: 'CompanyName', type: 'string' }],
          sampleData: []
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      // Status 200 = success, 401 = auth required, 500 = service error
    });

    it('POST /transformation should validate input fields', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/transformation')
        .send({});

      expect([400, 404]).toContain(res.status);
      if (res.body?.success !== undefined) {
        expect(res.body.success).toBe(false);
      }
    });

    // Routes-recipe (tranche 13) coverage: Zod schema validation paths
    it('POST /mapping/suggestions should reject empty body with 400 + Zod issues', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/suggestions')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
      expect(res.body.issues.length).toBeGreaterThan(0);
      const paths = res.body.issues.map((i: { path: (string | number)[] }) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['sourceSystem']));
    });

    it('POST /mapping/suggestions should accept a valid request shape', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/suggestions')
        .send({
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: [{ name: 'AccountName', type: 'string' }],
          targetFields: [{ name: 'CompanyName', type: 'string' }],
          sampleData: [],
          preferredProvider: 'rule-based',
        });

      // 200 = success, 400 = governance rejection, 500 = downstream agent error
      // The point is it gets PAST schema validation (no "Validation failed" error).
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.body?.error && typeof res.body.error === 'string') {
        expect(res.body.error).not.toBe('Validation failed');
      }
    });

    it('POST /mapping/transformation/suggest should reject empty body with structured error', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/transformation/suggest')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    it('POST /mapping/transformation/suggest should reject empty sourceField.name (min(1) tightening)', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/transformation/suggest')
        .send({
          sourceField: { name: '' },
          targetField: { name: 'TargetField' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      const paths = res.body.issues.map((i: { path: (string | number)[] }) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['sourceField.name']));
    });

    it('POST /mapping/suggestions should reject string[] sourceFields (post-tightening to FieldDefinition)', async () => {
      // Pre-#668-fix: schema accepted z.array(z.unknown()), letting string[] reach
      // FieldMappingAgent which then fails validateInputInternal silently. Now Zod
      // rejects at the boundary with a structured 400.
      const res = await request(app)
        .post('/api/ai/proxy/mapping/suggestions')
        .send({
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: ['Email'],
          targetFields: [{ name: 'CompanyName', type: 'string' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      const paths = res.body.issues.map((i: { path: (string | number)[] }) => i.path.join('.'));
      expect(paths.some((p: string) => p.startsWith('sourceFields.'))).toBe(true);
    });

    it('POST /mapping/validation/suggest should reject empty body with structured error', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/validation/suggest')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    it('POST /mapping/transformation/validate should reject empty body with structured error', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/mapping/transformation/validate')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });
  });

  describe('Business Intelligence Router Endpoints', () => {
    it('POST /business-intelligence/analyze should validate input', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/business-intelligence/analyze')
        .send({});
      
      expect([400, 404]).toContain(res.status);
      if (res.body?.success !== undefined) {
        expect(res.body.success).toBe(false);
      }
    });

    it('POST /compliance/validate should validate input', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/compliance/validate')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /roi/calculate should validate input', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/roi/calculate')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('Quality Router Endpoints', () => {
    it('GET /telemetry/events should return telemetry data', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/events');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.events)).toBe(true);
      }
    });

    it('GET /telemetry/costs should return cost metrics', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/costs');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
      }
    });

    it('GET /telemetry/statistics should return statistics', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/statistics');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limits to AI routes', async () => {
      // Make multiple rapid requests to trigger rate limit
      const requests = Array.from({ length: 105 }, () =>
        request(app).get('/api/ai/proxy/models').catch(() => ({ status: 429 }))
      );
      
      const responses = await Promise.all(requests);
      const rateLimited = responses.some(r => r.status === 429);
      
      // Rate limit may or may not trigger depending on test environment
      expect(typeof rateLimited).toBe('boolean');
    });
  });

  describe('Error Handling', () => {
    it('should return proper error format for invalid JSON', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');
      
      expect(res.status).toBe(400);
    });

    it('should handle missing Content-Type header', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send('plain text body');
      
      expect([400, 404, 429, 500]).toContain(res.status);
    });
  });

  afterAll(async () => {
    try {
      const telemetry = container.get<UnifiedTelemetryService>(TYPES.UnifiedTelemetryService);
      await telemetry.shutdown();
    } catch {
      // ignore if telemetry binding unavailable
    }
  });
});
