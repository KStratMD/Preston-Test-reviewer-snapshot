/**
 * IntegrationService Tests
 * Session 11 - Core service testing for B grade (50% coverage)
 */

import { IntegrationService } from '../../../../src/services/IntegrationService';
import type { Logger } from '../../../../src/utils/Logger';
import type { TransformationEngine } from '../../../../src/services/TransformationEngine';
import type { ConfigurationService } from '../../../../src/services/ConfigurationService';
import type { AuthService } from '../../../../src/services/AuthService';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../../governanceTestUtils';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createMockTransformationEngine(): jest.Mocked<TransformationEngine> {
  return {
    transform: jest.fn().mockResolvedValue({
      success: true,
      transformedData: { id: 'transformed', fields: {}, metadata: { source: 'test' } },
      errors: [],
    }),
  } as any;
}

function createMockConfigurationService(): jest.Mocked<ConfigurationService> {
  const mockConfigs = [
    {
      id: 'test-config-1',
      name: 'Test Integration',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      sourceEntity: 'Account',
      targetEntity: 'Customer',
      isActive: true,
      sourceAuthentication: {},
      targetAuthentication: {},
      fieldMappings: [],
      transformationRules: [],
    },
    {
      id: 'inactive-config',
      name: 'Inactive Integration',
      sourceSystem: 'SAP',
      targetSystem: 'Oracle',
      sourceEntity: 'Material',
      targetEntity: 'Item',
      isActive: false,
      sourceAuthentication: {},
      fieldMappings: [],
    },
  ];

  return {
    loadConfigurations: jest.fn().mockResolvedValue(undefined),
    getAllConfigurations: jest.fn().mockReturnValue(mockConfigs),
    getConfiguration: jest.fn((id: string) => mockConfigs.find(c => c.id === id) || null),
    validateConfiguration: jest.fn().mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    }),
  } as any;
}

function createMockAuthService(): jest.Mocked<AuthService> {
  return {} as any;
}

function createMockObservabilityService() {
  return {
    createScope: jest.fn().mockReturnValue({
      logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      },
      metrics: {
        incrementActiveIntegrations: jest.fn(),
        decrementActiveIntegrations: jest.fn(),
        recordIntegrationRun: jest.fn(),
      },
    }),
  };
}

function createMockConnector() {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true, errorMessage: '' }),
    list: jest.fn().mockResolvedValue([
      { id: 'rec1', fields: {}, metadata: { source: 'test' } },
      { id: 'rec2', fields: {}, metadata: { source: 'test' } },
    ]),
    read: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'created', fields: {}, metadata: { source: 'test' } }),
    update: jest.fn().mockResolvedValue({ id: 'updated', fields: {}, metadata: { source: 'test' } }),
  };
}

// Mock connectors
jest.mock('../../../../src/connectors/SalesforceConnector', () => ({
  SalesforceConnector: jest.fn().mockImplementation(() => createMockConnector()),
}));

jest.mock('../../../../src/connectors/NetSuiteConnector', () => ({
  NetSuiteConnector: jest.fn().mockImplementation(() => createMockConnector()),
}));

jest.mock('../../../../src/connectors/SAPConnector', () => ({
  SAPConnector: jest.fn().mockImplementation(() => createMockConnector()),
}));

jest.mock('../../../../src/connectors/OracleConnector', () => ({
  OracleConnector: jest.fn().mockImplementation(() => createMockConnector()),
}));

describe('IntegrationService', () => {
  let service: IntegrationService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockObservabilityService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = createMockLogger();
    mockTransformationEngine = createMockTransformationEngine();
    mockConfigService = createMockConfigurationService();
    mockAuthService = createMockAuthService();
    mockObservabilityService = createMockObservabilityService();

    service = new IntegrationService(
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

  describe('initialize', () => {
    it('should load configurations', async () => {
      await service.initialize();
      expect(mockConfigService.loadConfigurations).toHaveBeenCalled();
    });
  });

  describe('runIntegration', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should run integration successfully', async () => {
      const result = await service.runIntegration('test-config-1', {});
      expect(result.success).toBe(true);
      expect(result.recordsProcessed).toBe(2);
    });

    it('should reject if already running', async () => {
      const first = service.runIntegration('test-config-1', {});
      await expect(service.runIntegration('test-config-1', {})).rejects.toThrow('already running');
      await first;
    });

    it('should throw if config not found', async () => {
      await expect(service.runIntegration('non-existent', {})).rejects.toThrow('not found');
    });

    it('should throw if config not active', async () => {
      await expect(service.runIntegration('inactive-config', {})).rejects.toThrow('not active');
    });

    it('should update status', async () => {
      await service.runIntegration('test-config-1', {});
      const status = service.getIntegrationStatus('test-config-1');
      expect(status.successCount).toBe(1);
    });

    it('should support dry run', async () => {
      const result = await service.runIntegration('test-config-1', { dryRun: true });
      expect(result.success).toBe(true);
    });
  });

  describe('testIntegration', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should test integration successfully', async () => {
      const result = await service.testIntegration('test-config-1');
      expect(result.isValid).toBe(true);
    });

    it('should throw if config not found', async () => {
      await expect(service.testIntegration('non-existent')).rejects.toThrow();
    });
  });

  describe('syncSingleRecord', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should throw if config not found', async () => {
      await expect(service.syncSingleRecord('non-existent', 'rec1')).rejects.toThrow();
    });

    it('should return failure if record not found', async () => {
      const result = await service.syncSingleRecord('test-config-1', 'non-existent');
      expect(result.success).toBe(false);
    });
  });

  describe('getIntegrationStatus', () => {
    it('should return status', () => {
      const status = service.getIntegrationStatus('test');
      expect(status.configId).toBe('test');
      expect(status.isRunning).toBe(false);
    });
  });

  describe('getAllIntegrationStatuses', () => {
    it('should return all statuses', () => {
      service.getIntegrationStatus('test1');
      service.getIntegrationStatus('test2');
      const statuses = service.getAllIntegrationStatuses();
      expect(statuses.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('recordSyncResult', () => {
    it('should record successful result', () => {
      const result = {
        integrationId: 'test',
        syncId: 'sync1',
        status: 'success' as const,
        success: true,
        recordsProcessed: 10,
        recordsSuccessful: 10,
        recordsFailed: 0,
        errors: [],
        startTime: new Date(),
        endTime: new Date(),
      };
      service.recordSyncResult('test', result);
      const status = service.getIntegrationStatus('test');
      expect(status.successCount).toBe(1);
    });

    it('should record failed result', () => {
      const result = {
        integrationId: 'test',
        syncId: 'sync1',
        status: 'failed' as const,
        success: false,
        recordsProcessed: 10,
        recordsSuccessful: 0,
        recordsFailed: 10,
        errors: ['Error'],
        startTime: new Date(),
        endTime: new Date(),
      };
      service.recordSyncResult('test', result);
      const status = service.getIntegrationStatus('test');
      expect(status.errorCount).toBe(1);
    });
  });

  describe('stopIntegration', () => {
    it('should return false if not running', async () => {
      const stopped = await service.stopIntegration('test');
      expect(stopped).toBe(false);
    });
  });
});
