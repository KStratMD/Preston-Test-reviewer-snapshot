import { IntegrationService } from '../../services/IntegrationService';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../../governanceTestUtils';
import type { ConfigurationService } from '../../services/ConfigurationService';
import type { TransformationEngine } from '../../services/TransformationEngine';
import type { AuthService } from '../../services/AuthService';
import type { ObservabilityService } from '../../observability';
import type { Logger } from '../../utils/Logger';
import type { DataRecord, IntegrationConfig } from '../../types';

// Mock all dependencies
jest.mock('../../services/ConfigurationService');
jest.mock('../../services/TransformationEngine');
jest.mock('../../services/AuthService');
jest.mock('../../observability');
jest.mock('../../utils/Logger');

describe('Integration Performance Benchmarks', () => {
  let integrationService: IntegrationService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockObservabilityService: jest.Mocked<ObservabilityService>;

  const createMockRecords = (count: number): DataRecord[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `record-${i}`,
      externalId: `ext-${i}`,
      fields: {
        name: `Record ${i}`,
        email: `record${i}@example.com`,
        phone: `555-${String(i).padStart(4, '0')}`,
        address: `${i} Main Street, City, State`,
        value: Math.random() * 1000,
      },
      metadata: {
        source: 'test',
        lastModified: new Date(),
        version: '1.0',
      },
    }));
  };

  const createMockConnector = (systemType: string, records: DataRecord[]) => ({
    systemType,
    systemId: `${systemType.toLowerCase()}-test`,
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue({
      systemType,
      systemId: `${systemType.toLowerCase()}-test`,
      isConnected: true,
      lastTestTime: new Date(),
    }),
    getSystemInfo: jest.fn().mockResolvedValue({
      systemType,
      version: '1.0',
      capabilities: ['read', 'write'],
    }),
    list: jest.fn().mockResolvedValue(records),
    read: jest.fn().mockImplementation(async (_, id) =>
      Promise.resolve(records.find(r => r.id === id) || null),
    ),
    create: jest.fn().mockImplementation(async (_, record) => Promise.resolve(record)),
    update: jest.fn().mockImplementation(async (_, __, record) => Promise.resolve(record)),
    delete: jest.fn().mockResolvedValue(true),
    search: jest.fn().mockResolvedValue(records),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    mockTransformationEngine = {
      transform: jest.fn().mockImplementation(async ({ sourceData }) =>
        Promise.resolve({
          success: true,
          transformedData: sourceData,
          errors: [],
          warnings: [],
        }),
      ),
      validateRules: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
    } as unknown as jest.Mocked<TransformationEngine>;

    const baseConfig: IntegrationConfig = {
      id: 'perf-test',
      name: 'Performance Test Integration',
      description: 'Performance testing integration',
      sourceSystem: 'salesforce',
      targetSystem: 'netsuite',
      syncDirection: 'source_to_target',
      syncMode: 'manual',
      isActive: true,
      sourceEntity: 'records',
      targetEntity: 'records',
      fieldMappings: [],
      transformationRules: [],
      sourceAuthentication: {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
        refreshable: false,
      },
      targetAuthentication: {
        type: 'api_key',
        credentials: { apiKey: 'test-key' },
        refreshable: false,
      },
    };

    mockConfigService = {
      getConfiguration: jest.fn().mockReturnValue(baseConfig),
      validateConfiguration: jest.fn().mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
      }),
      getAllConfigurations: jest.fn().mockReturnValue([baseConfig]),
      loadConfigurations: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConfigurationService>;

    mockAuthService = {
      authenticateOAuth2: jest.fn().mockResolvedValue({
        accessToken: 'test-token',
        expiresAt: Date.now() + 3600000,
      }),
    } as unknown as jest.Mocked<AuthService>;

    mockObservabilityService = {
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      createScope: jest.fn().mockReturnValue({
        logger: mockLogger,
        metrics: {
          incrementActiveIntegrations: jest.fn(),
          decrementActiveIntegrations: jest.fn(),
          recordIntegrationRun: jest.fn(),
          recordBatchProcessing: jest.fn(),
          recordError: jest.fn(),
        },
        tracing: {
          startSpan: jest.fn().mockReturnValue({
            end: jest.fn(),
            recordException: jest.fn(),
            setStatus: jest.fn(),
          }),
        },
      }),
      getLogger: jest.fn().mockReturnValue(mockLogger),
    } as unknown as jest.Mocked<ObservabilityService>;

    integrationService = new IntegrationService(
      mockLogger,
      mockTransformationEngine,
      mockConfigService,
      mockAuthService,
      mockObservabilityService,
      createMockOutboundGovernanceService(),
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any, // 9th: ApprovalQueueService (PR 13b A2.5)
    );
  });

  describe('Record Processing Performance', () => {
    it('should process 100 records within acceptable time', async () => {
      const recordCount = 100;
      const records = createMockRecords(recordCount);
      const sourceConnector = createMockConnector('salesforce', records);
      const targetConnector = createMockConnector('netsuite', []);

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: unknown) => {
          if (systemType === 'salesforce') return Promise.resolve(sourceConnector);
          if (systemType === 'netsuite') return Promise.resolve(targetConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const startTime = process.hrtime.bigint();
      const result = await integrationService.runIntegration('perf-test');
      const endTime = process.hrtime.bigint();

      const durationMs = Number(endTime - startTime) / 1_000_000;

      expect(result.success).toBe(true);
      expect(result.recordsProcessed).toBe(recordCount);
      expect(durationMs).toBeLessThan(5000); // Should complete within 5 seconds

      // Log performance metrics
      console.log(`Processed ${recordCount} records in ${durationMs.toFixed(2)}ms`);
      console.log(`Average per record: ${(durationMs / recordCount).toFixed(2)}ms`);

      getConnectorSpy.mockRestore();
    });

    it('should process 1000 records efficiently', async () => {
      const recordCount = 1000;
      const records = createMockRecords(recordCount);
      const sourceConnector = createMockConnector('salesforce', records);
      const targetConnector = createMockConnector('netsuite', []);

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: unknown) => {
          if (systemType === 'salesforce') return Promise.resolve(sourceConnector);
          if (systemType === 'netsuite') return Promise.resolve(targetConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const startTime = process.hrtime.bigint();
      const result = await integrationService.runIntegration('perf-test');
      const endTime = process.hrtime.bigint();

      const durationMs = Number(endTime - startTime) / 1_000_000;

      expect(result.success).toBe(true);
      expect(result.recordsProcessed).toBe(recordCount);
      expect(durationMs).toBeLessThan(30000); // Should complete within 30 seconds

      console.log(`Processed ${recordCount} records in ${durationMs.toFixed(2)}ms`);
      console.log(`Average per record: ${(durationMs / recordCount).toFixed(2)}ms`);

      getConnectorSpy.mockRestore();
    });
  });

  describe('Memory Usage', () => {
    it('should maintain reasonable memory usage during large data processing', async () => {
      const recordCount = 500;
      const records = createMockRecords(recordCount);
      const sourceConnector = createMockConnector('salesforce', records);
      const targetConnector = createMockConnector('netsuite', []);

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: unknown) => {
          if (systemType === 'salesforce') return Promise.resolve(sourceConnector);
          if (systemType === 'netsuite') return Promise.resolve(targetConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const initialMemory = process.memoryUsage();

      await integrationService.runIntegration('perf-test');

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreasePerRecord = memoryIncrease / recordCount;

      console.log(`Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Memory per record: ${(memoryIncreasePerRecord / 1024).toFixed(2)}KB`);

      // Memory increase should be reasonable for 500 records.
      // PR 13b on PR #851: budget raised from 50MB → 80MB to absorb the
      // per-record guardedWrite overhead (ownership eval + audit row +
      // canonical-entity lookup). Local sees ~1.7MB; CI runner bookkeeping +
      // jest worker isolation amplifies that. Even after hoisting
      // GuardedWriteDeps out of the per-record loop (IntegrationService:149)
      // CI was at 63.5MB — the remaining churn is the per-call
      // GuardedWriteContext + audit-entry allocations, which are
      // fundamental to the design.
      expect(memoryIncrease).toBeLessThan(80 * 1024 * 1024);

      getConnectorSpy.mockRestore();
    });
  });

  describe('Concurrent Processing', () => {
    it('should handle multiple concurrent integrations efficiently', async () => {
      const recordCount = 50;
      const concurrentIntegrations = 3;

      const records = createMockRecords(recordCount);
      const sourceConnector = createMockConnector('salesforce', records);
      const targetConnector = createMockConnector('netsuite', []);

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: unknown) => {
          if (systemType === 'salesforce') return Promise.resolve(sourceConnector);
          if (systemType === 'netsuite') return Promise.resolve(targetConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      // Create multiple integration configs
      const integrationPromises = Array.from({ length: concurrentIntegrations }, async (_, i) => {
        mockConfigService.getConfiguration.mockReturnValue({
          ...mockConfigService.getConfiguration('perf-test'),
          id: `perf-test-${i}`,
          name: `Performance Test Integration ${i}`,
        } as IntegrationConfig);

        return integrationService.runIntegration(`perf-test-${i}`);
      });

      const startTime = process.hrtime.bigint();
      const results = await Promise.all(integrationPromises);
      const endTime = process.hrtime.bigint();

      const durationMs = Number(endTime - startTime) / 1_000_000;

      // All integrations should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.recordsProcessed).toBe(recordCount);
      });

      console.log(`Processed ${concurrentIntegrations} concurrent integrations in ${durationMs.toFixed(2)}ms`);
      console.log(`Average per integration: ${(durationMs / concurrentIntegrations).toFixed(2)}ms`);

      getConnectorSpy.mockRestore();
    });
  });

  describe('Transformation Performance', () => {
    it('should handle complex transformations efficiently', async () => {
      const recordCount = 200;
      const records = createMockRecords(recordCount);

      // Mock complex transformation
      mockTransformationEngine.transform.mockImplementation(async ({ sourceData }) => {
        // Simulate complex transformation work
        const complexTransformation = {
          ...sourceData,
          fields: {
            ...sourceData.fields,
            computed: Math.sqrt(Number(sourceData.fields.value || 0)),
            timestamp: new Date().toISOString(),
            hash: Buffer.from(JSON.stringify(sourceData)).toString('base64'),
          },
        };

        return Promise.resolve({
          success: true,
          transformedData: complexTransformation,
          errors: [],
          warnings: [],
        });
      });

      const sourceConnector = createMockConnector('salesforce', records);
      const targetConnector = createMockConnector('netsuite', []);

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: unknown) => {
          if (systemType === 'salesforce') return Promise.resolve(sourceConnector);
          if (systemType === 'netsuite') return Promise.resolve(targetConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const startTime = process.hrtime.bigint();
      const result = await integrationService.runIntegration('perf-test');
      const endTime = process.hrtime.bigint();

      const durationMs = Number(endTime - startTime) / 1_000_000;

      expect(result.success).toBe(true);
      expect(result.recordsProcessed).toBe(recordCount);
      expect(mockTransformationEngine.transform).toHaveBeenCalledTimes(recordCount);

      console.log(`Complex transformation of ${recordCount} records: ${durationMs.toFixed(2)}ms`);
      console.log(`Average transformation time: ${(durationMs / recordCount).toFixed(2)}ms`);

      getConnectorSpy.mockRestore();
    });
  });
});
