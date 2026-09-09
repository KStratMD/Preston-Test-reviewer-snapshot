import { SuiteCentralConnectorFactory } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralConnectorFactory';
import { SuiteCentralConnectorProd } from '../../../../src/connectors/SuiteCentralConnectorProd';
import { SuiteCentralNotFoundError } from '../../../../src/services/suitecentral/controlPlane/errors';
import type { Logger } from '../../../../src/utils/Logger';
import type { SuiteCentralControlPlaneContext, CredentialMetadataRow, EnvironmentView } from '../../../../src/services/suitecentral/controlPlane/domain';
import type { ValidatedSuiteCentralDestination } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralOutboundPolicy';

const SECRET = 'super-secret-value';

const context: SuiteCentralControlPlaneContext = {
  actorUserId: 'user-1',
  targetTenantId: 'tenant-a',
  accessMode: 'tenant_admin',
  correlationId: 'corr-1',
};

const baseEnvironment: EnvironmentView = {
  id: 'env-1',
  tenantId: 'tenant-a',
  name: 'prod',
  baseUrl: 'https://api.suitecentral.example',
  environmentTier: 'production',
  apiVersion: 'v1',
  timeoutMs: 30000,
  retryAttempts: 3,
  rateLimitConfig: null,
  securityConfig: null,
  featureConfig: null,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: '',
  updatedAt: '',
};

const baseCredential: CredentialMetadataRow = {
  id: 'cred-1',
  tenantId: 'tenant-a',
  environmentId: 'env-1',
  name: 'primary',
  clientId: 'client-abc',
  secretRef: 'suitecentral-deadbeef',
  companyId: null,
  scopes: [],
  isActive: true,
  rotatedAt: null,
  lastUsedAt: null,
  version: 1,
};

const destination: ValidatedSuiteCentralDestination = {
  canonicalUrl: 'https://api.suitecentral.example',
  hostname: 'api.suitecentral.example',
  port: 443,
  addresses: [{ address: '93.184.216.34', family: 4 }],
};

describe('SuiteCentralConnectorFactory', () => {
  let events: string[];
  let repository: {
    findEnvironment: jest.Mock;
    findCredentialMetadata: jest.Mock;
  };
  let outboundPolicy: { validateBaseUrl: jest.Mock };
  let secretStore: { resolve: jest.Mock };
  let transport: { create: jest.Mock };
  let logger: Logger;
  let factory: SuiteCentralConnectorFactory;

  beforeEach(() => {
    events = [];
    repository = {
      findEnvironment: jest.fn(async () => {
        events.push('load-environment');
        return { ...baseEnvironment };
      }),
      findCredentialMetadata: jest.fn(async () => {
        events.push('load-credential');
        return { ...baseCredential };
      }),
    };
    outboundPolicy = {
      validateBaseUrl: jest.fn(async () => {
        events.push('validate-destination');
        return destination;
      }),
    };
    secretStore = {
      resolve: jest.fn(async () => {
        events.push('resolve-secret');
        return SECRET;
      }),
    };
    transport = {
      create: jest.fn(() => {
        events.push('construct');
        return { request: jest.fn() };
      }),
    };
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    factory = new SuiteCentralConnectorFactory(repository, outboundPolicy, secretStore, transport, logger);
  });

  it('checks ownership and destination BEFORE secret resolution, then constructs', async () => {
    const connector = await factory.create(context, 'env-1', 'cred-1');

    expect(events).toEqual([
      'load-environment',
      'load-credential',
      'validate-destination',
      'resolve-secret',
      'construct',
    ]);
    expect(connector).toBeInstanceOf(SuiteCentralConnectorProd);
    // Both find calls are tenant-scoped with the JWT tenant, never a body value.
    expect(repository.findEnvironment).toHaveBeenCalledWith('tenant-a', 'env-1');
    expect(repository.findCredentialMetadata).toHaveBeenCalledWith('tenant-a', 'cred-1');
    expect(secretStore.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      profileId: 'cred-1',
      storedRef: 'suitecentral-deadbeef',
    });
  });

  it('returns a FRESH connector instance on every call (never cached)', async () => {
    const first = await factory.create(context, 'env-1', 'cred-1');
    const second = await factory.create(context, 'env-1', 'cred-1');
    expect(first).not.toBe(second);
    expect(transport.create).toHaveBeenCalledTimes(2);
  });

  it('never leaks the resolved secret into logs', async () => {
    await factory.create(context, 'env-1', 'cred-1');
    const infoMock = logger.info as jest.Mock;
    const debugMock = logger.debug as jest.Mock;
    const allLogArgs = JSON.stringify([
      ...infoMock.mock.calls,
      ...debugMock.mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
    ]);
    expect(allLogArgs).not.toContain(SECRET);
  });

  it('throws 404 without resolving a secret when the environment is not found', async () => {
    repository.findEnvironment.mockResolvedValueOnce(undefined);
    await expect(factory.create(context, 'missing-env', 'cred-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
    expect(outboundPolicy.validateBaseUrl).not.toHaveBeenCalled();
    expect(secretStore.resolve).not.toHaveBeenCalled();
  });

  it('throws 404 without resolving a secret when the credential belongs to another environment', async () => {
    repository.findCredentialMetadata.mockResolvedValueOnce({ ...baseCredential, environmentId: 'other-env' });
    await expect(factory.create(context, 'env-1', 'cred-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
    expect(secretStore.resolve).not.toHaveBeenCalled();
  });

  it('throws 404 without resolving a secret when the credential is inactive', async () => {
    repository.findCredentialMetadata.mockResolvedValueOnce({ ...baseCredential, isActive: false });
    await expect(factory.create(context, 'env-1', 'cred-1')).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
    expect(secretStore.resolve).not.toHaveBeenCalled();
  });

  it('validates the destination BEFORE resolving the secret (rejection short-circuits)', async () => {
    outboundPolicy.validateBaseUrl.mockRejectedValueOnce(new Error('destination_rejected'));
    await expect(factory.create(context, 'env-1', 'cred-1')).rejects.toThrow('destination_rejected');
    expect(secretStore.resolve).not.toHaveBeenCalled();
  });
});
