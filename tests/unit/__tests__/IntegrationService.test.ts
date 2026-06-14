// IntegrationService Unit Tests
import { IntegrationService } from '../services/IntegrationService';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { ObservabilityService } from '../observability';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../governanceTestUtils';

describe('IntegrationService', () => {
  let integrationService: IntegrationService;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;
  let mockObservabilityService: jest.Mocked<ObservabilityService>;

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
      validateConfiguration: jest.fn(),
      getConfiguration: jest.fn(),
      getAllConfigurations: jest.fn().mockReturnValue([]),
      loadConfigurations: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConfigurationService>;

    mockTransformationEngine = {
      transform: jest.fn(),
      validateRules: jest.fn(),
    } as unknown as jest.Mocked<TransformationEngine>;

    mockAuthService = {
      authenticateOAuth2: jest.fn(),
      validateApiKey: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;

    mockObservabilityService = {
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
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
      mockObservabilityService,
      createMockOutboundGovernanceService(),
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any, // 9th: ApprovalQueueService (PR 13b A2.5)
    );
  });

  describe('Integration Execution', () => {
    it('should initialize without errors', async () => {
      await expect(integrationService.initialize()).resolves.not.toThrow();
      expect(mockLogger.info).toHaveBeenCalledWith('Initializing Integration Service');
    });

    it('should get system health', async () => {
      const health = await integrationService.getSystemHealth();

      expect(health).toBeDefined();
      expect(health.totalConfigurations).toBe(0);
      expect(health.activeConfigurations).toBe(0);
      expect(health.systemStatus).toBeDefined();
    });

    it('should handle missing configuration', () => {
      mockConfigService.getConfiguration.mockReturnValue(undefined);

      // getIntegrationStatus creates a new status if it doesn't exist
      const status = integrationService.getIntegrationStatus('nonexistent-config');
      expect(status).toBeDefined();
      expect(status.configId).toBe('nonexistent-config');
      expect(status.isRunning).toBe(false);
    });

    it('should validate service methods are accessible', () => {
      expect(typeof integrationService.initialize).toBe('function');
      expect(typeof integrationService.getSystemHealth).toBe('function');
      expect(typeof integrationService.getIntegrationStatus).toBe('function');
    });
  });

  describe('Service Configuration', () => {
    it('should have proper dependency injection', () => {
      expect(integrationService.configService).toBeDefined();
      expect(integrationService.configService).toBe(mockConfigService);
    });

    it('should handle service lifecycle correctly', async () => {
      await integrationService.initialize();
      const health = await integrationService.getSystemHealth();
      expect(health).toBeDefined();
    });
  });
});
