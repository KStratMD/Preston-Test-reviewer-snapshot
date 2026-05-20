import type { AuthService } from '../../services/AuthService';
import type { Logger } from '../../utils/Logger';
import type { TransformationEngine } from '../../services/TransformationEngine';
import type { ConfigurationService } from '../../services/ConfigurationService';
import type {
  IntegrationConfig,
  DataRecord,
  AuthConfig,
  ConnectionStatus,
  SystemInfo,
  SyncResult,
  TransformationResult,
} from '../../types';
import type { IConnector } from '../../interfaces/IConnector';

/**
 * Creates a mock logger instance with all required methods
 */
export function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    withCorrelationId: jest.fn().mockReturnThis(),
    getCorrelationId: jest.fn().mockReturnValue(undefined),
  } as unknown as jest.Mocked<Logger>;
}

/**
 * Creates a mock AuthService instance
 */
export function createMockAuthService(): jest.Mocked<AuthService> {
  return {
    cleanup: jest.fn(),
    authenticateOAuth2: jest.fn().mockResolvedValue({
      accessToken: 'mock-token',
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + 3600000),
      issued: new Date(),
    }),
    refreshOAuth2Token: jest.fn().mockResolvedValue({
      accessToken: 'refreshed-token',
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + 3600000),
      issued: new Date(),
    }),
    validateBasicAuth: jest.fn().mockResolvedValue(true),
    validateApiKey: jest.fn().mockReturnValue(true),
    hashPassword: jest.fn().mockResolvedValue('hashed-password'),
    generateJWT: jest.fn().mockReturnValue('mock-jwt-token'),
    verifyJWT: jest.fn().mockReturnValue({ sub: 'user-id' }),
    destroy: jest.fn(),
    getTokenCacheStats: jest.fn().mockReturnValue({ size: 0, hits: 0, misses: 0 }),
  } as unknown as jest.Mocked<AuthService>;
}

/**
 * Creates a mock TransformationEngine instance
 */
export function createMockTransformationEngine(): jest.Mocked<TransformationEngine> {
  return {
    transformRecord: jest.fn().mockImplementation(async (sourceRecord, _mappings, _rules) => {
      return Promise.resolve(sourceRecord.fields || { name: 'Mock Record' });
    }),
    transform: jest.fn().mockImplementation(async (context) => {
      return Promise.resolve({
        success: true,
        transformedData: {
          id: context.sourceData.id || 'mock-id',
          externalId: context.sourceData.externalId || `ext-${context.sourceData.id || 'mock'}`,
          fields: context.sourceData.fields || { name: 'Mock Record' },
          metadata: {
            source: 'transformed',
            lastModified: new Date(),
            version: '1.0',
          },
        },
        errors: [],
        warnings: [],
      } as TransformationResult);
    }),
  } as unknown as jest.Mocked<TransformationEngine>;
}

/**
 * Creates a mock ConfigurationService instance
 */
export function createMockConfigurationService(configs: IntegrationConfig[] = []): jest.Mocked<ConfigurationService> {
  return {
    loadConfigurations: jest.fn().mockResolvedValue(undefined),
    getConfiguration: jest.fn().mockImplementation((id: string) =>
      configs.find(c => c.id === id) || undefined,
    ),
    getAllConfigurations: jest.fn().mockReturnValue(configs),
    saveConfiguration: jest.fn().mockResolvedValue(undefined),
    deleteConfiguration: jest.fn().mockResolvedValue(true),
    validateConfiguration: jest.fn().mockReturnValue({
      isValid: true,
      errors: [],
      warnings: [],
    }),
    createSampleConfiguration: jest.fn().mockReturnValue(configs[0] || createMockIntegrationConfig()),
    exportConfiguration: jest.fn().mockResolvedValue('{"id":"test"}'),
    importConfiguration: jest.fn().mockResolvedValue(configs[0] || createMockIntegrationConfig()),
    getConfigurationStatistics: jest.fn().mockReturnValue({ total: configs.length, active: configs.length }),
  } as unknown as jest.Mocked<ConfigurationService>;
}

/**
 * Creates a valid integration configuration for testing
 */
export function createMockIntegrationConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'test-integration',
    name: 'Test Integration',
    description: 'Test integration configuration',
    sourceSystem: 'TestSource',
    targetSystem: 'TestTarget',
    sourceEntity: 'source_entity',
    targetEntity: 'target_entity',
    syncDirection: 'source_to_target',
    syncMode: 'manual',
    isActive: true,
    fieldMappings: [
      {
        sourceField: 'name',
        targetField: 'displayName',
        transformationType: 'direct',
        isRequired: true,
      },
    ],
    transformationRules: [],
    sourceAuthentication: {
      type: 'oauth2',
      credentials: {
        clientId: 'source-client-id',
        clientSecret: 'source-client-secret',
      },
    },
    targetAuthentication: {
      type: 'oauth2',
      credentials: {
        clientId: 'target-client-id',
        clientSecret: 'target-client-secret',
      },
    },
    batchSize: 100,
    ...overrides,
  };
}

/**
 * Creates a mock data record for testing
 */
export function createMockDataRecord(overrides: Partial<DataRecord> = {}): DataRecord {
  return {
    id: 'mock-record-1',
    externalId: 'ext-mock-record-1',
    fields: {
      name: 'Mock Record',
      email: 'mock@example.com',
      status: 'active',
    },
    metadata: {
      source: 'test',
      lastModified: new Date(),
      version: '1.0',
    },
    ...overrides,
  };
}

/**
 * Creates a mock connector instance
 */
export function createMockConnector(
  systemType: string,
  systemId: string,
  overrides: Partial<IConnector> = {},
): jest.Mocked<IConnector> {
  const mockData = createMockDataRecord();

  return {
    systemType,
    systemId,
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue({
      systemType,
      systemId,
      isConnected: true,
      lastTestTime: new Date(),
    } as ConnectionStatus),
    getSystemInfo: jest.fn().mockResolvedValue({
      name: systemType,
      type: systemType,
      version: '1.0',
      capabilities: ['read', 'write'],
      rateLimits: {
        requestsPerMinute: 100,
        requestsPerHour: 1000,
        requestsPerDay: 10000,
      },
      endpoints: {
        baseUrl: `https://${systemType.toLowerCase()}.example.com`,
        authUrl: `https://${systemType.toLowerCase()}.example.com/auth`,
        webhookUrl: `https://${systemType.toLowerCase()}.example.com/webhook`,
      },
    } as SystemInfo),
    list: jest.fn().mockResolvedValue([mockData]),
    read: jest.fn().mockResolvedValue(mockData),
    create: jest.fn().mockResolvedValue(mockData),
    update: jest.fn().mockResolvedValue(mockData),
    delete: jest.fn().mockResolvedValue(true),
    search: jest.fn().mockResolvedValue([mockData]),
    bulkCreate: jest.fn().mockResolvedValue({
      integrationId: 'test',
      syncId: 'bulk-create-1',
      status: 'success',
      success: true,
      recordsProcessed: 1,
      recordsSuccessful: 1,
      recordsFailed: 0,
      errors: [],
      startTime: new Date(),
      endTime: new Date(),
    } as SyncResult),
    bulkUpdate: jest.fn().mockResolvedValue({
      integrationId: 'test',
      syncId: 'bulk-update-1',
      status: 'success',
      success: true,
      recordsProcessed: 1,
      recordsSuccessful: 1,
      recordsFailed: 0,
      errors: [],
      startTime: new Date(),
      endTime: new Date(),
    } as SyncResult),
    bulkDelete: jest.fn().mockResolvedValue({
      integrationId: 'test',
      syncId: 'bulk-delete-1',
      status: 'success',
      success: true,
      recordsProcessed: 1,
      recordsSuccessful: 1,
      recordsFailed: 0,
      errors: [],
      startTime: new Date(),
      endTime: new Date(),
    } as SyncResult),
    setupWebhook: jest.fn().mockResolvedValue('webhook-id-123'),
    removeWebhook: jest.fn().mockResolvedValue(true),
    getChanges: jest.fn().mockResolvedValue([mockData]),
    validateSchema: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as jest.Mocked<IConnector>;
}

/**
 * Creates a mock OAuth2 authentication config
 */
export function createMockOAuth2Config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    type: 'oauth2',
    credentials: {
      clientId: 'mock-client-id',
      clientSecret: 'mock-client-secret',
      tenantId: 'mock-tenant-id',
      resourceUrl: 'https://mock.example.com',
    },
    ...overrides,
  };
}

/**
 * Creates a mock OAuth1 authentication config (for NetSuite)
 */
export function createMockOAuth1Config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    type: 'oauth1',
    credentials: {
      consumerKey: 'mock-consumer-key',
      consumerSecret: 'mock-consumer-secret',
      tokenId: 'mock-token-id',
      tokenSecret: 'mock-token-secret',
      accountId: 'mock-account-id',
    },
    ...overrides,
  };
}

/**
 * Creates a mock API key authentication config
 */
export function createMockApiKeyConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    type: 'api_key',
    credentials: {
      apiKey: 'mock-api-key',
      username: 'mock-username',
    },
    ...overrides,
  };
}

/**
 * Waits for a specified number of milliseconds (useful for async testing)
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates mock axios instance for HTTP client testing
 */
export function createMockAxiosInstance() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    request: jest.fn(),
    defaults: {
      baseURL: '',
      headers: { common: {} },
    },
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
}

/**
 * Creates a typed mock for jest.Mocked
 */
export function createTypedMock<T>(): jest.Mocked<T> {
  return {} as jest.Mocked<T>;
}

// Add a simple test to satisfy Jest's requirement
describe('Test Helpers Utilities', () => {
  test('should export utility functions', () => {
    expect(typeof createMockLogger).toBe('function');
    expect(typeof createMockAuthService).toBe('function');
    expect(typeof createMockTransformationEngine).toBe('function');
    expect(typeof createMockConfigurationService).toBe('function');
    expect(typeof createMockIntegrationConfig).toBe('function');
    expect(typeof createMockDataRecord).toBe('function');
    expect(typeof createMockConnector).toBe('function');
  });
});
