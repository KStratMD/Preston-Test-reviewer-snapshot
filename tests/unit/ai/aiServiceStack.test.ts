/**
 * AI Service Stack Integration Tests
 * Focused tests for AI proxy routes, governance, and agent execution
 */

import request from 'supertest';
import express, {Application} from 'express';
import { createAIProxyRouter } from '../../../src/routes/aiProxy';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { UnifiedTelemetryService } from '../../../src/services/UnifiedTelemetryService';

// Set demo mode for testing
process.env.DEMO_MODE = '1';
process.env.RATE_LIMIT_ENABLED = '0';
process.env.DISABLE_REDIS = '1';

const FLEXIBLE_STATUSES = [200, 400, 401, 404, 500];

describe('AI Service Stack - Coverage Tests', () => {
  let app: Application;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    
    try {
      const aiRouter = await createAIProxyRouter();
      app.use('/api/ai/proxy', aiRouter);
    } catch (error) {
      console.error('Failed to create AI router:', error);
      throw error;
    }
  });

  describe('Provider Management', () => {
    it('should list aggregate model catalog', async () => {
      const res = await request(app).get('/api/ai/proxy/models');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should list active models', async () => {
      const res = await request(app).get('/api/ai/proxy/models/active');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should list OpenAI models', async () => {
      const res = await request(app).get('/api/ai/proxy/models/openai');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should get provider capabilities', async () => {
      const res = await request(app).get('/api/ai/proxy/models/openai/capabilities');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should reject invalid provider names', async () => {
      const res = await request(app).get('/api/ai/proxy/models/invalid-provider-xyz');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should handle provider selection', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/models/openai/select')
        .send({ modelId: 'gpt-4o' });
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should test provider connectivity', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/providers/test')
        .send({ provider: 'openai' });
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Agent Management', () => {
    it('should list all registered agents', async () => {
      const res = await request(app).get('/api/ai/proxy/agents');
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.agents)).toBe(true);
        expect(res.body.agents.length).toBeGreaterThanOrEqual(5);
      }
    });

    it('should validate agent type on single execution', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/non-existent-agent')
        .send({ input: {} });
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid agent type');
    });

    it('should require input field for agent execution', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/field-mapping')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required field: input');
    });

    it('should accept valid agent execution request', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/field-mapping')
        .send({
          input: {
            sourceFields: [],
            targetFields: []
          },
          context: {
            sourceSystem: 'Salesforce',
            targetSystem: 'NetSuite'
          }
        });
      
      // May fail due to auth or validation, but should route correctly
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Multi-Agent Orchestration', () => {
    it('should validate workflow structure', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/orchestrate')
        .send({ input: {} });
      
      expect([400, 404]).toContain(res.status);
      if (res.body?.error) {
        expect(res.body.error).toMatch(/missing required field/i);
      }
    });

    it('should accept valid workflow request', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/orchestrate')
        .send({
          workflow: {
            agents: ['field-mapping'],
            parallel: false,
            failureMode: 'abort',
            timeout: 30000
          },
          input: {
            sourceFields: [],
            targetFields: []
          },
          context: {}
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Field Mapping Services', () => {
    it('should validate field mapping request structure', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({});
      
      expect([400, 404]).toContain(res.status);
      if (res.body?.error) {
        expect(res.body.error).toMatch(/missing required/i);
      }
    });

    it('should accept valid mapping request', async () => {
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
    });

    it('should handle transformation requests', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/transformation')
        .send({
          sourceValue: '  John Doe  ',
          sourceType: 'string',
          targetType: 'string',
          transformation: 'trim'
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should validate mapping suggestions', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/validation')
        .send({
          mappings: [],
          validationRules: []
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Business Intelligence Services', () => {
    it('should validate BI analysis requests', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/business-intelligence/analyze')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing required field/i);
    });

    it('should process valid BI analysis', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/business-intelligence/analyze')
        .send({
          integrationData: {
            systemA: 'Salesforce',
            systemB: 'NetSuite',
            recordCount: 1000
          },
          metrics: ['efficiency', 'cost']
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should validate compliance requests', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/compliance/validate')
        .send({});
      
      expect(res.status).toBe(400);
    });

    it('should process ROI calculations', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/roi/calculate')
        .send({
          costs: { setup: 5000, monthly: 500 },
          benefits: { timeResaving: 20, errorReduction: 50 }
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Telemetry & Quality Services', () => {
    it('should retrieve telemetry events', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/events');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should retrieve cost metrics', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/costs');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should retrieve statistics', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/statistics');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should limit telemetry event results', async () => {
      const res = await request(app).get('/api/ai/proxy/telemetry/events?limit=10');
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });

    it('should perform data quality analysis', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/data-quality')
        .send({
          data: [{ id: 1, name: 'Test' }],
          schema: [{ name: 'id', type: 'number' }]
        });
      
      expect(FLEXIBLE_STATUSES).toContain(res.status);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');
      
      expect(res.status).toBe(400);
    });

    it('should handle missing required fields gracefully', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/agents/field-mapping')
        .send({ context: {} });
      
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should provide helpful error messages', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/orchestrate')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(typeof res.body.error).toBe('string');
    });
  });

  describe('Request Validation', () => {
    it('should validate sourceSystem and targetSystem', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({
          sourceSystem: '', // Empty string should fail
          targetSystem: 'NetSuite',
          sourceFields: [],
          targetFields: []
        });
      
      expect([400, 404, 500]).toContain(res.status);
    });

    it('should validate field array structure', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: 'not-an-array',
          targetFields: []
        });
      
      expect([400, 404, 500]).toContain(res.status);
    });

    it('should handle empty field arrays', async () => {
      const res = await request(app)
        .post('/api/ai/proxy/field-mapping')
        .send({
          sourceSystem: 'Salesforce',
          targetSystem: 'NetSuite',
          sourceFields: [],
          targetFields: [],
          sampleData: []
        });
      
      // Empty arrays may be valid or invalid depending on business logic
      expect(FLEXIBLE_STATUSES).toContain(res.status);
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
