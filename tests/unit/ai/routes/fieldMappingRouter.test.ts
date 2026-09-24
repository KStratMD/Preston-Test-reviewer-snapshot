/**
 * FieldMappingRouter Unit Tests
 *
 * Covers Zod request-body validation for the routes refactored under
 * as_any tranche 14 (PR after #668). Each endpoint should:
 *   - return 400 with `{ success: false, error: 'Validation failed', issues }` on bad input
 *   - return 200 on a minimally valid payload
 */

import request from 'supertest';
import express, { Application, Request, Response, NextFunction } from 'express';
import { createLegacyFieldMappingRouter } from '../../../../src/routes/ai-proxy/LegacyCompatibilityRouter';

// Pass-through auth so we can exercise validation directly.
const passThroughAuth = (_req: Request, _res: Response, next: NextFunction) => next();

describe('FieldMappingRouter validation', () => {
  let app: Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/field-mapping', createLegacyFieldMappingRouter(passThroughAuth));
  });

  describe('POST /field-mapping/generate', () => {
    it('returns 400 with structured error when sourceSchema is missing', async () => {
      const res = await request(app).post('/field-mapping/generate').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    it('returns 200 with mappings on a valid payload', async () => {
      const res = await request(app)
        .post('/field-mapping/generate')
        .send({ sourceSchema: ['customer_name', 'email'] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.mappings)).toBe(true);
      expect(res.body.mappings.length).toBeGreaterThan(0);
    });
  });

  describe('POST /field-mapping/validate', () => {
    it('returns 400 when mappings is not an array (previously crashed with 500)', async () => {
      const res = await request(app)
        .post('/field-mapping/validate')
        .send({ mappings: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 200 and computes overallScore for valid mappings', async () => {
      const res = await request(app)
        .post('/field-mapping/validate')
        .send({
          mappings: [
            { id: 1, sourceField: 'a', targetField: 'A', transformation: 'value.trim()' },
            { id: 2, sourceField: 'b', targetField: 'B' }
          ]
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.validationResults).toHaveLength(2);
      expect(typeof res.body.overallScore).toBe('number');
    });
  });

  describe('POST /field-mapping/advanced-analysis', () => {
    it('returns 400 when mappings is missing', async () => {
      const res = await request(app)
        .post('/field-mapping/advanced-analysis')
        .send({ sourceSystem: 'Salesforce' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('handles a mapping without sourceField without throwing', async () => {
      // Pre-tranche-14, `(mapping as any).sourceField.includes(...)` would
      // throw on a mapping that lacked sourceField. The MappingItem narrowing
      // + typeof guard now handles this safely.
      const res = await request(app)
        .post('/field-mapping/advanced-analysis')
        .send({
          mappings: [
            { confidence: 0.5 },
            { sourceField: 'email_address', confidence: 0.9 }
          ]
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.analysis).toBeDefined();
    });
  });
});
