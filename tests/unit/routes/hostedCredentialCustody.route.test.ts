import express from 'express';
import request from 'supertest';
import { createConfigurationRouter } from '../../../src/routes/configuration';
import { globalErrorHandler } from '../../../src/middleware/errorBoundary';
import { ValidationError } from '../../../src/errors/ConfigurationErrors';
import type { ConfigurationService } from '../../../src/services/ConfigurationService';
import { fakeAuthMiddleware } from './_helpers/routerTestAuth';
import { Logger } from '../../../src/utils/Logger';

function makeService(): jest.Mocked<Pick<ConfigurationService,
  'getConfigurationForTenant' | 'getAllConfigurations' | 'validateConfiguration' | 'saveConfiguration'>> {
  return {
    getConfigurationForTenant: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    validateConfiguration: jest.fn(),
    saveConfiguration: jest.fn(),
  } as unknown as jest.Mocked<Pick<ConfigurationService,
    'getConfigurationForTenant' | 'getAllConfigurations' | 'validateConfiguration' | 'saveConfiguration'>>;
}

describe('hosted credential custody route contract', () => {
  it('returns bounded 400 details without echoing a submitted credential in response or logs', async () => {
    const sentinel = 'hosted-route-secret-sentinel';
    const opaqueSentinel = 'hosted-route-opaque-sentinel';
    const service = makeService();
    service.saveConfiguration.mockRejectedValue(new ValidationError(
      'Hosted configurations must use reference-only credentials',
      ['sourceSystem.credentialSource: inline credentials are forbidden', 'sourceAuthentication: inline credentials are forbidden'],
    ));

    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/configurations', fakeAuthMiddleware(), createConfigurationRouter(service as unknown as ConfigurationService));
      app.use(globalErrorHandler());

      const response = await request(app)
        .post('/api/configurations')
        .send({
          name: 'Hosted configuration',
          sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'inline' },
          targetSystem: { type: 'NetSuite', systemId: 'ns-prod', credentialSource: 'environment' },
          sourceAuthentication: { type: 'api_key', credentials: { apiKey: sentinel } },
          sourceCredentials: { opaque: opaqueSentinel },
          fieldMappings: [],
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(expect.objectContaining({ error: 'Validation Error' }));
      expect(JSON.stringify(response.body)).not.toContain(sentinel);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(opaqueSentinel);
      expect(service.saveConfiguration).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});