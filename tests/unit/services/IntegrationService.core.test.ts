import { IntegrationService } from '../../../src/services/IntegrationService';
import type { SyncResult } from '../../../src/types';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService } from '../../governanceTestUtils';

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

const createIntegrationService = () => {
  const logger = createLogger();
  const transformationEngine = { transform: jest.fn() };
  const configService = {
    loadConfigurations: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
  };
  const authService = { authenticate: jest.fn() };

  const service = new IntegrationService(
    logger as any,
    transformationEngine as any,
    configService as any,
    authService as any,
    undefined,
    createMockOutboundGovernanceService() as any,
    createMockOwnershipResolver() as any,
    createMockAuditService() as any,
    { enqueue: jest.fn().mockResolvedValue('noop-queue-id') } as any,
  );

  (service as any).maxConcurrentIntegrations = 3;

  return { service, logger };
};

describe('IntegrationService core behaviors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes integration status lazily', () => {
    const { service } = createIntegrationService();

    const status = service.getIntegrationStatus('config-1');
    expect(status).toEqual({
      configId: 'config-1',
      isRunning: false,
      errorCount: 0,
      successCount: 0
    });

    const secondCall = service.getIntegrationStatus('config-1');
    expect(secondCall).toBe(status);
  });

  it('records sync results and updates counters', () => {
    const { service } = createIntegrationService();

    const result: SyncResult = {
      integrationId: 'config-1',
      syncId: 'sync-123',
      status: 'success',
      success: true,
      recordsProcessed: 5,
      recordsSuccessful: 5,
      recordsFailed: 0,
      errors: [],
      startTime: new Date('2024-01-01T00:00:00Z'),
      endTime: new Date('2024-01-01T00:01:00Z')
    };

    service.recordSyncResult('config-1', result);

    const status = service.getIntegrationStatus('config-1');
    expect(status.lastSync).toEqual(result.endTime);
    expect(status.lastSyncResult).toEqual(result);
    expect(status.successCount).toBe(1);
    expect(status.errorCount).toBe(0);
    expect(status.isRunning).toBe(false);
  });

  it('stops integrations and updates running set', async () => {
    const { service } = createIntegrationService();
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-2');
    (service as any).updateIntegrationStatus('config-2', { isRunning: true });

    const stopped = await service.stopIntegration('config-2');
    expect(stopped).toBe(true);
    expect(running.has('config-2')).toBe(false);
    expect(service.getIntegrationStatus('config-2').isRunning).toBe(false);

    const noOp = await service.stopIntegration('config-3');
    expect(noOp).toBe(false);
  });

  it('calculates rate limit availability', () => {
    const { service } = createIntegrationService();
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-a');
    running.add('config-b');

    const status = service.getRateLimitStatus();
    expect(status).toEqual({
      currentRunning: 2,
      maxConcurrent: 3,
      available: 1,
      isAtLimit: false
    });
  });

  it('exports and imports integration state snapshots', async () => {
    const { service } = createIntegrationService();
    const statusMap = (service as any).integrationStatus as Map<string, any>;
    statusMap.set('config-9', {
      configId: 'config-9',
      isRunning: true,
      errorCount: 2,
      successCount: 3
    });
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-9');

    const exported = await service.exportStates();
    expect(exported.integrationStates).toHaveLength(1);
    expect(exported.runningIntegrations).toContain('config-9');
    expect(exported.connectorCount).toBe(0);

    const { service: restored } = createIntegrationService();
    await restored.importStates(exported);

    const restoredStatus = restored.getIntegrationStatus('config-9');
    expect(restoredStatus.isRunning).toBe(true);
    expect(restoredStatus.errorCount).toBe(2);
    expect(restoredStatus.successCount).toBe(3);
    const restoredRunning = (restored as any).runningIntegrations as Set<string>;
    expect(restoredRunning.has('config-9')).toBe(true);
  });

  it('derives platform health status from system health snapshot', async () => {
    const { service } = createIntegrationService();

    const healthSpy = jest
      .spyOn(service, 'getSystemHealth')
      .mockResolvedValue({
        totalConfigurations: 4,
        activeConfigurations: 3,
        runningIntegrations: 1,
        rateLimitStatus: {
          currentRunning: 1,
          maxConcurrent: 3,
          available: 2,
          isAtLimit: false
        },
        systemStatus: {
          NetSuite: true,
          Salesforce: true,
          Dynamics365: false,
          SAP: false
        }
      });

    const health = await service.getHealthStatus();

    expect(health.status).toBe('degraded');
    expect(health.message).toContain('2/4');
    expect(health.metrics).toEqual(
      expect.objectContaining({
        healthySystemsCount: 2,
        totalSystemsCount: 4,
        runningIntegrations: 1
      })
    );
    healthSpy.mockRestore();
  });

  describe('tenant-scoped configuration resolution', () => {
    it('request-path variant (ForTenant) resolves via getConfigurationForTenant, never the deprecated lookup', async () => {
      const { service } = createIntegrationService();
      const cfgSvc = (service as any).configService;
      cfgSvc.getConfigurationForTenant.mockReturnValue(undefined);

      // config not found → method throws; we only assert the lookup path here.
      await expect(service.testIntegrationForTenant('tenant-x', 'config-1')).rejects.toThrow();

      expect(cfgSvc.getConfigurationForTenant).toHaveBeenCalledWith('tenant-x', 'config-1');
      expect(cfgSvc.getConfiguration).not.toHaveBeenCalled();
    });

    it('background variant (no tenant) uses the deliberate tenant-agnostic escape hatch', async () => {
      const { service } = createIntegrationService();
      const cfgSvc = (service as any).configService;
      cfgSvc.getConfiguration.mockReturnValue(undefined);

      await expect(service.testIntegration('config-1')).rejects.toThrow();

      expect(cfgSvc.getConfiguration).toHaveBeenCalledWith('config-1');
      expect(cfgSvc.getConfigurationForTenant).not.toHaveBeenCalled();
    });
  });
});

