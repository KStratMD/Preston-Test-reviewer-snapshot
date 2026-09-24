import 'reflect-metadata';
import type { Shutdownable } from './globals';
import type { IntegrationService } from '../src/services/IntegrationService';

export default async () => {
  // Ensure test environment variables are set before importing application modules
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'a-very-secure-secret-for-testing-purposes-only-12345';

  const { App } = await import('../src/app');
  const { container } = await import('../src/inversify/inversify.config');
  const { TYPES } = await import('../src/inversify/types');

  const app = new App();

  // Initialize services required for tests
  const integrationService = container.get<IntegrationService>(TYPES.IntegrationService);
  await integrationService.initialize();

  // global.__APP__ = app.getExpressApp(); // Commented out to avoid compilation issues
  global.__APP_INSTANCE__ = app as Shutdownable;
};
