import './setupEnv'; // Must be first to configure environment
import request from 'supertest';
import type { Response } from 'supertest';
import type { Application as ExpressApp } from 'express';
import jwt from 'jsonwebtoken';
import type { FieldMapping, TransformationRule } from '../../src/types';
import { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';

// /api/configurations and /api/integrations sit behind authMiddleware (PR 13c-4)
// and their handlers narrow on req.user.tenantId, so every request needs a
// Bearer JWT carrying a tenant claim (authMiddleware reads the tenant from
// the `tenantId`/`tid`/`tenant_id` claims, in that order).
const AUTH = `Bearer ${jwt.sign(
  { sub: 'api-integration-test-user', tenant_id: 'api-integration-test-tenant' },
  STRONG_TEST_JWT_SECRET,
  { expiresIn: '2h' },
)}`;
// Increase global timeout for integration tests (5 minutes)
jest.setTimeout(300000);

describe('API Integration Tests', () => {
  let expressApp: ExpressApp;
  let appInstance: App;

  beforeAll(async () => {
    // use the bare Express app (no connectors) for fast HTTP-layer testing
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    expressApp = testApp.expressApp;
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(expressApp)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });
  });

  describe('API Documentation', () => {
    it('should serve Swagger documentation', async () => {
      const response = await request(expressApp)
        .get('/api-docs/')
        .expect(200);

      expect(response.type).toBe('text/html');
      expect(response.text).toContain('swagger-ui');
    });

    it('should serve OpenAPI spec', async () => {
      const response = await request(expressApp)
        .get('/api-docs.json')
        .expect(200);

      expect(response.body).toHaveProperty('openapi');
      expect(response.body).toHaveProperty('info');
      expect(response.body).toHaveProperty('paths');
    });
  });

  describe('Configuration API', () => {
    it('should get all configurations', async () => {
      const response = await request(expressApp)
        .get('/api/configurations')
        .set('Authorization', AUTH)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should handle configuration validation', async () => {
      const testConfig = {
        id: 'test-integration',
        name: 'Test Integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'customer',
        targetEntity: 'account',
        syncDirection: 'source_to_target',
        syncMode: 'batch',
        isActive: true,
        sourceAuthentication: {
          type: 'api_key',
          credentials: {
            apiKey: 'test-key'
          }
        },
        targetAuthentication: {
          type: 'api_key',
          credentials: {
            apiKey: 'test-key'
          }
        },
        fieldMappings: [] as FieldMapping[],
        transformationRules: [] as TransformationRule[]
      };

      const response = await request(expressApp)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(testConfig)
        .expect(201);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('successfully');
    });

    it('should handle invalid configuration', async () => {
      const invalidConfig = {
        id: 'invalid-config',
        // Missing required fields
      };

      await request(expressApp)
        .post('/api/configurations')
        .set('Authorization', AUTH)
        .send(invalidConfig)
        .expect(400);
    });
  });

  describe('Integration API', () => {
    it('should get integration statuses', async () => {
      const response = await request(expressApp)
        .get('/api/integrations/status')
        .set('Authorization', AUTH)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should handle integration test for non-existent config', async () => {
      await request(expressApp)
        .post('/api/integrations/non-existent/test')
        .set('Authorization', AUTH)
        .expect(404);
    });

    it('should require recordId for sync-record endpoint', async () => {
      await request(expressApp)
        .post('/api/integrations/test-integration/sync-record')
        .set('Authorization', AUTH)
        .send({}) // Missing recordId
        .expect(400);
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown routes', async () => {
      await request(expressApp)
        .get('/api/unknown-endpoint')
        .expect(404);
    });

    it('should return JSON error responses', async () => {
      const response = await request(expressApp)
        .get('/api/unknown-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path');
    });
  });

  describe('Security Headers', () => {
    it('should include security headers', async () => {
      const response = await request(expressApp)
        .get('/health')
        .expect(200);

      expect(response.headers).toHaveProperty('x-frame-options');
      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limits to API endpoints', async () => {
      // Make multiple rapid requests to test rate limiting
      const requests = Array(20).fill(null).map(() =>
        request(expressApp).get('/api/configurations').set('Authorization', AUTH)
      );

      const responses = await Promise.all(requests);
      
      // At least some requests should succeed
      const successfulRequests = responses.filter((r: Response) => r.status === 200);
      expect(successfulRequests.length).toBeGreaterThan(0);
      
      // Check if rate limiting headers are present
      const firstResponse = responses[0];
      expect(firstResponse.headers).toHaveProperty('x-ratelimit-limit');
    });
  });
});