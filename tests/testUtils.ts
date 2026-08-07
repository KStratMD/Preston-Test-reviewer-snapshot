import { afterAll, afterEach, beforeAll, beforeEach } from '@jest/globals';
import { IntegrationHub } from '../src';

export const setupTestServer = () => {
  let app: IntegrationHub;

  beforeAll(async () => {
    app = new IntegrationHub();
    await app.start();
  });

  afterAll(async () => {
    if (app) {
      await app.shutdown();
    }
  });

  return () => app;
};

export const setupTestServerEach = () => {
  let app: IntegrationHub;

  beforeEach(async () => {
    app = new IntegrationHub();
    await app.start();
  });

  afterEach(async () => {
    if (app) {
      await app.shutdown();
    }
  });

  return () => app;
};
