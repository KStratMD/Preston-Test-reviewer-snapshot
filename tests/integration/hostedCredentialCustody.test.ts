import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { ConfigurationService } from '../../src/services/ConfigurationService';
import { createConfigurationRouter } from '../../src/routes/configuration';
import { globalErrorHandler } from '../../src/middleware/errorBoundary';
import { Logger } from '../../src/utils/Logger';
import {
  DefaultConnectorCredentialResolver,
  type SecureCredentialManagerProvider,
} from '../../src/services/integration/ConnectorCredentialResolver';
import type { TenantSystemCredentialRegistry } from '../../src/services/integration/TenantSystemCredentialRegistry';
import type { SecureCredentialManager } from '../../src/services/SecureCredentialManager';
import type { IntegrationConfig } from '../../src/types';

function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  req.user = {
    id: 'operator-1',
    username: 'operator-1',
    tenantId: 'tenant-a',
    roles: ['admin'],
    permissions: [],
  };
  next();
}

function safeConfiguration(): Omit<IntegrationConfig, 'tenantId'> {
  return {
    id: 'api-hosted-safe',
    name: 'API hosted safe configuration',
    sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    targetSystem: { type: 'NetSuite', credentialSource: 'environment' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
  };
}

describe('hosted credential custody API and resolver integration', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let configDirectory: string;
  let service: ConfigurationService;
  let app: express.Express;

  beforeEach(async () => {
    process.env.NODE_ENV = 'production';
    configDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'preston-a3-'));
    service = new ConfigurationService(new Logger('hosted-custody-integration'), configDirectory);
    app = express();
    app.use(express.json());
    app.use('/api/configurations', fakeAuth, createConfigurationRouter(service));
    app.use(globalErrorHandler());
  });

  afterEach(async () => {
    await fsp.rm(configDirectory, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('writes a safe reference through the API, reloads it, and resolves only through A2 custody', async () => {
    const response = await request(app)
      .post('/api/configurations')
      .send(safeConfiguration());

    expect(response.status).toBe(201);
    const persistedPath = path.join(configDirectory, 'api-hosted-safe.json');
    const persistedText = await fsp.readFile(persistedPath, 'utf8');
    expect(persistedText).not.toContain('authentication');
    expect(persistedText).not.toContain('credentials');

    const reloaded = new ConfigurationService(new Logger('hosted-custody-reload'), configDirectory);
    await reloaded.loadConfigurations();
    const stored = reloaded.getConfigurationForTenant('tenant-a', 'api-hosted-safe');
    expect(stored?.sourceSystem).toEqual({ type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' });

    const fakeAuthConfig = { type: 'oauth2' as const, credentials: { clientId: 'resolver-only-secret' } };
    const secureManager = {
      getCredentials: jest.fn().mockResolvedValue(fakeAuthConfig),
    } as unknown as jest.Mocked<Pick<SecureCredentialManager, 'getCredentials'>>;
    const provider: SecureCredentialManagerProvider = async () => secureManager as unknown as SecureCredentialManager;
    const registry = {
      assertSystemOwnedByTenant: jest.fn().mockResolvedValue(undefined),
    } as unknown as TenantSystemCredentialRegistry;
    const resolver = new DefaultConnectorCredentialResolver(provider, registry);

    const resolved = await resolver.resolve(stored as IntegrationConfig, 'source');

    expect(resolved).toBe(fakeAuthConfig);
    expect(secureManager.getCredentials).toHaveBeenCalledWith('Salesforce', 'sf-prod');
    expect(registry.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'Salesforce', 'sf-prod');
  });

  it('rejects a legacy/inline payload before creating a file or invoking the resolver path', async () => {
    const sentinel = 'hosted-inline-integration-sentinel';
    const response = await request(app)
      .post('/api/configurations')
      .send({
        ...safeConfiguration(),
        id: 'api-hosted-invalid',
        sourceSystem: { type: 'Salesforce', credentialSource: 'inline' },
        sourceAuthentication: { type: 'api_key', credentials: { apiKey: sentinel } },
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    await expect(fsp.access(path.join(configDirectory, 'api-hosted-invalid.json'))).rejects.toThrow();
    expect(await fsp.readdir(configDirectory)).toEqual([]);
  });
});
