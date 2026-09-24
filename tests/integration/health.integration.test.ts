/**
 * Integration tests for Health API
 * Author: Eric Stratford
 * Module 3.2 - Learning Integration Testing
 */

import './setupEnv'; // Must be first to configure environment
import request from 'supertest';
import type { Application as ExpressApp } from 'express';
import { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';

describe('Health API', () => {
  let appInstance: App;
  let expressApp: ExpressApp;

  beforeAll(async () => {
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    expressApp = testApp.expressApp;
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  test('GET /health returns 200 status code', async () => {
    const response = await request(expressApp)
      .get('/health')
      .expect(200);

    expect(response.body).toHaveProperty('status');
  });

  test('GET /health includes uptime', async () => {
    const response = await request(expressApp)
      .get('/health');

    expect(response.body).toHaveProperty('uptime');
    expect(typeof response.body.uptime).toBe('number');
  });

  test('GET /health includes timestamp', async () => {
    const response = await request(expressApp)
      .get('/health');

    expect(response.body).toHaveProperty('timestamp');
  });

});
