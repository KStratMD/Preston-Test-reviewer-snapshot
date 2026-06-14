import { IntegrationService } from '../services/IntegrationService';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../governanceTestUtils';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { ObservabilityService } from '../observability';
import type { IntegrationConfig, ConnectionStatus } from '../types';
import type { IConnector } from '../interfaces/IConnector';

describe('IntegrationService.getSystemHealth', () => {
  let integrationService: IntegrationService;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;
  let mockObservability: jest.Mocked<ObservabilityService>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    mockConfigService = {
      getAllConfigurations: jest.fn().mockReturnValue([]),
      loadConfigurations: jest.fn(),
      validateConfiguration: jest.fn(),
      getConfiguration: jest.fn(),
    } as unknown as jest.Mocked<ConfigurationService>;

    mockTransformationEngine = {
      transform: jest.fn(),
      validateRules: jest.fn(),
    } as unknown as jest.Mocked<TransformationEngine>;

    mockAuthService = {} as unknown as jest.Mocked<AuthService>;

    mockObservability = {
      initialize: jest.fn(),
      shutdown: jest.fn(),
      createScope: jest.fn().mockReturnValue({
        logger: mockLogger,
        tracing: { initialize: jest.fn(), shutdown: jest.fn() },
        metrics: {
          incrementActiveIntegrations: jest.fn(),
          decrementActiveIntegrations: jest.fn(),
          recordIntegrationRun: jest.fn(),
        },
      }),
    } as unknown as jest.Mocked<ObservabilityService>;

    integrationService = new IntegrationService(
      mockLogger,
      mockTransformationEngine,
      mockConfigService,
      mockAuthService,
      mockObservability,
      createMockOutboundGovernanceService(),
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any, // 9th: ApprovalQueueService (PR 13b A2.5)
    );
  });

  it('should report system status for success and failure', async () => {
    const configs: IntegrationConfig[] = [
      {
        id: '1',
        name: 'Test',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        sourceEntity: 'A',
        targetEntity: 'B',
        syncDirection: 'unidirectional',
        syncMode: 'manual',
        isActive: true,
        fieldMappings: [],
        transformationRules: [],
        sourceAuthentication: { type: 'basic', credentials: { username: 'u', password: 'p' } },
        targetAuthentication: { type: 'basic', credentials: { username: 'u', password: 'p' } },
      },
    ];
    mockConfigService.getAllConfigurations.mockReturnValue(configs);

    const connectorSuccess: jest.Mocked<IConnector> = {
      systemType: 'NetSuite',
      systemId: 'NetSuite_healthcheck',
      initialize: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue({
        systemType: 'NetSuite',
        systemId: '1',
        isConnected: true,
        lastTestTime: new Date(),
      } as ConnectionStatus),
    } as any;

    const connectorFail: jest.Mocked<IConnector> = {
      systemType: 'Salesforce',
      systemId: 'Salesforce_healthcheck',
      initialize: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue({
        systemType: 'Salesforce',
        systemId: '2',
        isConnected: false,
        lastTestTime: new Date(),
        errorMessage: 'bad',
      } as ConnectionStatus),
    } as any;

    jest
      .spyOn<any, any>(integrationService as any, 'getConnector')
      .mockImplementation(async (type: any) =>
        type === 'NetSuite' ? connectorSuccess : connectorFail,
      );

    const health = await integrationService.getSystemHealth();

    expect(health.systemStatus.NetSuite).toBe(true);
    expect(health.systemStatus.Salesforce).toBe(false);
    // Ensure initialize was called with some authentication config (avoid TS on local configs var)
    expect(connectorSuccess.initialize).toHaveBeenCalledWith(expect.objectContaining({ type: expect.any(String) }));
    expect(connectorFail.initialize).toHaveBeenCalledWith(expect.objectContaining({ type: expect.any(String) }));
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Health check failed for Salesforce'),
    );
  });

  it('should handle connector errors gracefully', async () => {
    const configs: IntegrationConfig[] = [
      {
        id: '1',
        name: 'Test',
        sourceSystem: 'NetSuite',
        targetSystem: 'NetSuite',
        sourceEntity: 'A',
        targetEntity: 'B',
        syncDirection: 'unidirectional',
        syncMode: 'manual',
        isActive: true,
        fieldMappings: [],
        transformationRules: [],
        sourceAuthentication: { type: 'basic', credentials: { username: 'u', password: 'p' } },
        targetAuthentication: { type: 'basic', credentials: { username: 'u', password: 'p' } },
      },
    ];
    mockConfigService.getAllConfigurations.mockReturnValue(configs);

    const error = new Error('connection failed');
    const connector: jest.Mocked<IConnector> = {
      systemType: 'NetSuite',
      systemId: 'NetSuite_healthcheck',
      initialize: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockRejectedValue(error),
    } as any;

    jest
      .spyOn<any, any>(integrationService as any, 'getConnector')
      .mockImplementation(async () => connector);

    const health = await integrationService.getSystemHealth();

    expect(health.systemStatus.NetSuite).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Health check error for NetSuite',
      error,
    );
  });
});
