import './setupEnv'; // Must be first to configure environment
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import request from 'supertest';
import type { Application as ExpressApp } from 'express';
import { App } from '../../src/app';
import { createTestToken } from '../../src/middleware/auth';

describe('Production environment gating', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalJwt = process.env.JWT_SECRET;
  let expressApp: ExpressApp;

  const resetEnv = () => {
    delete process.env.ENABLE_METRICS;
    delete process.env.ENABLE_DASHBOARD;
    if (originalJwt) {
      process.env.JWT_SECRET = originalJwt;
    } else {
      delete process.env.JWT_SECRET;
    }
    process.env.NODE_ENV = originalEnv;
  };

  beforeEach(() => {
    process.env.JWT_SECRET = STRONG_TEST_JWT_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.ENABLE_METRICS;
    delete process.env.ENABLE_DASHBOARD;
    const appInstance = new App();
    expressApp = appInstance.getExpressApp();
    // Attach instance for cleanup on the response locals via closure
    (expressApp as any).__appInstance = appInstance;
  });

  afterEach(async () => {
    const instance = (expressApp as any)?.__appInstance as App | undefined;
    if (instance && typeof instance.shutdown === 'function') {
      await instance.shutdown();
    }
  });

  afterAll(() => {
    resetEnv();
  });

  it('disables sample routes in production', async () => {
    await request(expressApp).get('/test-integration').expect(404);
    await request(expressApp).get('/api/sample-data').expect(404);
    await request(expressApp).get('/api/sample-configurations').expect(404);
    await request(expressApp).post('/api/sample-configurations/load').expect(404);
  });

  it('requires auth for metrics when enabled', async () => {
    process.env.ENABLE_METRICS = 'true';
    const flaggedAppInstance = new App();
    const flaggedApp = flaggedAppInstance.getExpressApp();
    await request(flaggedApp).get('/metrics').expect(401);
    const token = createTestToken({ id: '1', username: 'test' });
    await request(flaggedApp).get('/metrics').set('Authorization', `Bearer ${token}`).expect(200);
    await flaggedAppInstance.shutdown();
  });

  it('requires auth for dashboard when enabled', async () => {
    process.env.ENABLE_DASHBOARD = 'true';
    const flaggedAppInstance = new App();
    const flaggedApp = flaggedAppInstance.getExpressApp();
    await request(flaggedApp).get('/api/dashboard').expect(401);
    const token = createTestToken({ id: '1', username: 'test' });
    await request(flaggedApp).get('/api/dashboard').set('Authorization', `Bearer ${token}`).expect(200);
    await flaggedAppInstance.shutdown();
  });
});
