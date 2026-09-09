/**
 * Comprehensive unit tests for IntegrationOrchestrator
 * Covers: initialize, runIntegration, testIntegration, syncSingleRecord,
 *         stopIntegration, getIntegrationStatus, getAllIntegrationStatuses,
 *         getRateLimitStatus, getSystemHealth, shutdown
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

jest.mock('../../../../src/config/env', () => ({
  env: {
    MAX_CONCURRENT_INTEGRATIONS: 5,
  },
}));

jest.mock('../../../../src/utils/loggerAdapter', () => ({
  adaptScopeLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { IntegrationOrchestrator } from '../../../../src/services/integration/IntegrationOrchestrator';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    id: 'config-1',
    name: 'Test Integration',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    isActive: true,
    fieldMappings: [],
    transformationRules: [],
    sourceAuthentication: { apiKey: 'src-key' },
    targetAuthentication: { apiKey: 'tgt-key' },
    ...overrides,
  };
}

const mockConfigService = {
  loadConfigurations: jest.fn().mockResolvedValue(undefined),
  getAllConfigurations: jest.fn().mockReturnValue([makeConfig()]),
  getConfiguration: jest.fn().mockReturnValue(makeConfig()),
  validateConfiguration: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
};

const mockConnectorManager = {
  initializeConnectorsForConfig: jest.fn().mockResolvedValue(undefined),
  testConnector: jest.fn().mockResolvedValue({ isConnected: true }),
  getConnectorStats: jest.fn().mockReturnValue({
    totalConnectors: 2,
    connectorsByType: { Salesforce: 1, NetSuite: 1 },
    activeConnections: 2,
  }),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

const mockStatusManager = {
  initializeStatus: jest.fn(),
  isRunning: jest.fn().mockReturnValue(false),
  getRunningIntegrations: jest.fn().mockReturnValue(new Set()),
  markAsRunning: jest.fn(),
  markAsCompleted: jest.fn(),
  markAsFailed: jest.fn(),
  updateStatus: jest.fn(),
  getStatus: jest.fn().mockReturnValue({ configId: 'config-1', isRunning: false }),
  getAllStatuses: jest.fn().mockReturnValue([{ configId: 'config-1', isRunning: false }]),
  getMetrics: jest.fn().mockReturnValue({
    totalIntegrations: 10,
    runningIntegrations: 0,
    successfulRuns: 8,
    failedRuns: 2,
    averageRunTime: 5000,
    totalRecordsProcessed: 1000,
    errorRate: 0.2,
    uptime: 99.5,
  }),
  clearAll: jest.fn(),
};

const mockExecutor = {
  executeSync: jest.fn().mockResolvedValue({
    status: 'success',
    success: true,
    recordsProcessed: 10,
    recordsSuccessful: 10,
    recordsFailed: 0,
    errors: [],
  }),
  testSync: jest.fn().mockResolvedValue({
    canConnect: true,
    sampleRecords: [{ id: 'r1' }],
    transformationPreview: [{ id: 'r1', transformed: true }],
    validationResults: [{ isValid: true }],
    errors: [],
  }),
  syncSingleRecord: jest.fn().mockResolvedValue({
    status: 'success',
    recordsProcessed: 1,
    recordsSuccessful: 1,
  }),
};

const mockObservability = {
  createScope: jest.fn().mockReturnValue({
    logger: mockLogger,
    metrics: {
      incrementActiveIntegrations: jest.fn(),
      decrementActiveIntegrations: jest.fn(),
      recordIntegrationRun: jest.fn(),
    },
  }),
};

describe('IntegrationOrchestrator', () => {
  let orchestrator: IntegrationOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    orchestrator = new IntegrationOrchestrator(
      mockLogger,
      mockConfigService as any,
      mockConnectorManager as any,
      mockStatusManager as any,
      mockExecutor as any,
      mockObservability as any,
    );
  });

  describe('initialize', () => {
    it('should load configurations', async () => {
      await orchestrator.initialize();
      expect(mockConfigService.loadConfigurations).toHaveBeenCalled();
    });

    it('should initialize connectors for active configs', async () => {
      await orchestrator.initialize();
      expect(mockConnectorManager.initializeConnectorsForConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'config-1' }),
      );
    });

    it('should initialize status for active configs', async () => {
      await orchestrator.initialize();
      expect(mockStatusManager.initializeStatus).toHaveBeenCalledWith('config-1');
    });

    it('should skip inactive configs', async () => {
      mockConfigService.getAllConfigurations.mockReturnValueOnce([
        makeConfig({ isActive: false }),
      ]);
      await orchestrator.initialize();
      expect(mockConnectorManager.initializeConnectorsForConfig).not.toHaveBeenCalled();
    });
  });

  describe('runIntegration', () => {
    it('should execute sync successfully', async () => {
      const result = await orchestrator.runIntegration('config-1');
      expect(result.status).toBe('success');
      expect(result.recordsProcessed).toBe(10);
    });

    it('should check if already running', async () => {
      mockStatusManager.isRunning.mockReturnValueOnce(true);
      await expect(orchestrator.runIntegration('config-1'))
        .rejects.toThrow('already running');
    });

    it('should enforce rate limiting', async () => {
      mockStatusManager.getRunningIntegrations.mockReturnValueOnce(new Set(['a', 'b', 'c', 'd', 'e']));
      await expect(orchestrator.runIntegration('config-1'))
        .rejects.toThrow('Maximum concurrent integrations');
    });

    it('should throw for missing config', async () => {
      mockConfigService.getConfiguration.mockReturnValueOnce(null);
      await expect(orchestrator.runIntegration('missing'))
        .rejects.toThrow('not found');
    });

    it('should throw for inactive config', async () => {
      mockConfigService.getConfiguration.mockReturnValueOnce(makeConfig({ isActive: false }));
      await expect(orchestrator.runIntegration('config-1'))
        .rejects.toThrow('not active');
    });

    it('should mark as running before execution', async () => {
      await orchestrator.runIntegration('config-1');
      expect(mockStatusManager.markAsRunning).toHaveBeenCalledWith('config-1');
    });

    it('should mark as completed after success', async () => {
      await orchestrator.runIntegration('config-1');
      expect(mockStatusManager.markAsCompleted).toHaveBeenCalledWith(
        'config-1',
        expect.objectContaining({ status: 'success' }),
        expect.any(Number),
      );
    });

    it('should record metrics on success', async () => {
      await orchestrator.runIntegration('config-1');
      const scope = mockObservability.createScope.mock.results[0].value;
      expect(scope.metrics.recordIntegrationRun).toHaveBeenCalled();
      expect(scope.metrics.incrementActiveIntegrations).toHaveBeenCalled();
      expect(scope.metrics.decrementActiveIntegrations).toHaveBeenCalled();
    });

    it('should handle execution failure', async () => {
      mockExecutor.executeSync.mockRejectedValueOnce(new Error('Sync failed'));
      await expect(orchestrator.runIntegration('config-1')).rejects.toThrow('Sync failed');
      expect(mockStatusManager.markAsFailed).toHaveBeenCalledWith(
        'config-1',
        'Sync failed',
        expect.any(Number),
      );
    });

    it('should support dry run option', async () => {
      await orchestrator.runIntegration('config-1', { dryRun: true });
      expect(mockExecutor.executeSync).toHaveBeenCalledWith(
        expect.any(Object),
        { dryRun: true },
      );
    });
  });

  describe('testIntegration', () => {
    it('should return valid test results', async () => {
      const result = await orchestrator.testIntegration('config-1');
      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should throw NotFoundError for missing config', async () => {
      mockConfigService.getConfiguration.mockReturnValueOnce(null);
      await expect(orchestrator.testIntegration('missing')).rejects.toThrow('not found');
    });

    it('should include validation errors', async () => {
      mockConfigService.validateConfiguration.mockResolvedValueOnce({
        isValid: false,
        errors: ['Invalid mapping'],
        warnings: [],
      });
      const result = await orchestrator.testIntegration('config-1');
      expect(result.errors).toContain('Invalid mapping');
    });

    it('should include validation warnings', async () => {
      mockConfigService.validateConfiguration.mockResolvedValueOnce({
        isValid: true,
        errors: [],
        warnings: ['Consider adding more mappings'],
      });
      const result = await orchestrator.testIntegration('config-1');
      expect(result.warnings).toContain('Consider adding more mappings');
    });

    it('should test connectivity', async () => {
      const result = await orchestrator.testIntegration('config-1');
      expect(result.connectivity.canConnect).toBe(true);
      expect(result.connectivity.sampleRecords).toBe(1);
    });

    it('should report connection failure', async () => {
      mockExecutor.testSync.mockResolvedValueOnce({
        canConnect: false,
        sampleRecords: [],
        transformationPreview: [],
        validationResults: [],
        errors: ['Source connection failed'],
      });
      const result = await orchestrator.testIntegration('config-1');
      expect(result.errors).toContain('Source connection failed');
    });

    it('should test source connector', async () => {
      await orchestrator.testIntegration('config-1');
      expect(mockConnectorManager.testConnector).toHaveBeenCalledWith(
        'Salesforce',
        expect.any(Object),
      );
    });

    it('should test target connector', async () => {
      await orchestrator.testIntegration('config-1');
      expect(mockConnectorManager.testConnector).toHaveBeenCalledWith(
        'NetSuite',
        expect.any(Object),
      );
    });

    it('should report source connector failure', async () => {
      mockConnectorManager.testConnector
        .mockResolvedValueOnce({ isConnected: false, errorMessage: 'Auth failed' })
        .mockResolvedValueOnce({ isConnected: true });
      const result = await orchestrator.testIntegration('config-1');
      expect(result.errors.some((e: string) => e.includes('Source system'))).toBe(true);
    });

    it('should report target connector failure', async () => {
      mockConnectorManager.testConnector
        .mockResolvedValueOnce({ isConnected: true })
        .mockResolvedValueOnce({ isConnected: false, errorMessage: 'Auth failed' });
      const result = await orchestrator.testIntegration('config-1');
      expect(result.errors.some((e: string) => e.includes('Target system'))).toBe(true);
    });

    it('should handle test execution error', async () => {
      mockConfigService.validateConfiguration.mockRejectedValueOnce(new Error('Validate crashed'));
      const result = await orchestrator.testIntegration('config-1');
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Validate crashed'))).toBe(true);
    });

    it('should handle object-type source/target system', async () => {
      mockConfigService.getConfiguration.mockReturnValueOnce(
        makeConfig({
          sourceSystem: { type: 'Salesforce' },
          targetSystem: { type: 'NetSuite' },
        }),
      );
      const result = await orchestrator.testIntegration('config-1');
      expect(result).toBeDefined();
    });
  });

  describe('syncSingleRecord', () => {
    it('should sync a single record', async () => {
      const result = await orchestrator.syncSingleRecord('config-1', 'rec-1');
      expect(result.status).toBe('success');
      expect(mockExecutor.syncSingleRecord).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'config-1' }),
        'rec-1',
      );
    });

    it('should throw for missing config', async () => {
      mockConfigService.getConfiguration.mockReturnValueOnce(null);
      await expect(orchestrator.syncSingleRecord('missing', 'rec-1'))
        .rejects.toThrow('not found');
    });
  });

  describe('stopIntegration', () => {
    it('should return false if not running', async () => {
      const result = await orchestrator.stopIntegration('config-1');
      expect(result).toBe(false);
    });

    it('should stop a running integration', async () => {
      mockStatusManager.isRunning.mockReturnValueOnce(true);
      const result = await orchestrator.stopIntegration('config-1');
      expect(result).toBe(true);
      expect(mockStatusManager.updateStatus).toHaveBeenCalledWith('config-1', { isRunning: false });
    });
  });

  describe('getIntegrationStatus', () => {
    it('should delegate to status manager', () => {
      const status = orchestrator.getIntegrationStatus('config-1');
      expect(status).toEqual({ configId: 'config-1', isRunning: false });
    });
  });

  describe('getAllIntegrationStatuses', () => {
    it('should delegate to status manager', () => {
      const statuses = orchestrator.getAllIntegrationStatuses();
      expect(statuses.length).toBe(1);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return rate limit info', () => {
      const status = orchestrator.getRateLimitStatus();
      expect(status.maxConcurrent).toBe(5);
      expect(status.currentRunning).toBe(0);
      expect(status.available).toBe(5);
      expect(status.isAtLimit).toBe(false);
    });

    it('should detect at-limit state', () => {
      mockStatusManager.getRunningIntegrations.mockReturnValueOnce(new Set(['a', 'b', 'c', 'd', 'e']));
      const status = orchestrator.getRateLimitStatus();
      expect(status.isAtLimit).toBe(true);
      expect(status.available).toBe(0);
    });
  });

  describe('getSystemHealth', () => {
    it('should return comprehensive health', async () => {
      const health = await orchestrator.getSystemHealth();
      expect(health.totalConfigurations).toBe(1);
      expect(health.activeConfigurations).toBe(1);
      expect(health.connectorStats.totalConnectors).toBe(2);
      expect(health.integrationMetrics.totalIntegrations).toBe(10);
    });

    it('should test system connectivity', async () => {
      const health = await orchestrator.getSystemHealth();
      expect(health.systemStatus).toBeDefined();
    });

    it('should handle connector test failure', async () => {
      mockConnectorManager.testConnector.mockRejectedValueOnce(new Error('Test error'));
      const health = await orchestrator.getSystemHealth();
      // Should mark system as false on error
      expect(Object.values(health.systemStatus).some(v => v === false)).toBe(true);
    });

    it('should skip systems without auth config', async () => {
      mockConfigService.getAllConfigurations.mockReturnValueOnce([
        makeConfig({ sourceAuthentication: undefined, targetAuthentication: undefined, authentication: undefined }),
      ]);
      const health = await orchestrator.getSystemHealth();
      expect(Object.values(health.systemStatus).some(v => v === false)).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should stop running integrations', async () => {
      mockStatusManager.getRunningIntegrations.mockReturnValueOnce(new Set(['config-1']));
      mockStatusManager.isRunning.mockReturnValueOnce(true);
      await orchestrator.shutdown();
      expect(mockStatusManager.updateStatus).toHaveBeenCalled();
    });

    it('should shutdown connector manager', async () => {
      await orchestrator.shutdown();
      expect(mockConnectorManager.shutdown).toHaveBeenCalled();
    });

    it('should clear status', async () => {
      await orchestrator.shutdown();
      expect(mockStatusManager.clearAll).toHaveBeenCalled();
    });
  });
});
