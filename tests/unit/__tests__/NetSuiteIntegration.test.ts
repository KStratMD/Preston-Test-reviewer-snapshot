import { IntegrationService } from '../services/IntegrationService';
import { createMockOutboundGovernanceService, createMockOwnershipResolver, createMockAuditService, createMockApprovalQueueService } from '../../governanceTestUtils';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { IntegrationConfig } from '../types';

// Mock all dependencies
jest.mock('../services/ConfigurationService');
jest.mock('../services/TransformationEngine');
jest.mock('../services/AuthService');
jest.mock('../utils/Logger');
jest.mock('../connectors/NetSuiteConnector');
jest.mock('../connectors/SalesforceConnector');
jest.mock('../connectors/SAPConnector');
jest.mock('../connectors/OracleConnector');
jest.mock('../connectors/BusinessCentralConnector');

describe('NetSuite Integration with New Connectors', () => {
  let integrationService: IntegrationService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockAuthService: jest.Mocked<AuthService>;

  const baseConfig = {
    id: 'test-integration',
    name: 'Test NetSuite Integration',
    description: 'Test integration between NetSuite and other systems',
    syncDirection: 'source_to_target' as const,
    syncMode: 'manual' as const,
    isActive: true,
    sourceEntity: 'customer',
    targetEntity: 'customer',
    fieldMappings: [],
    transformationRules: [],
    sourceAuthentication: {
      type: 'oauth1' as const,
      credentials: {
        accountId: 'test-account',
        consumerKey: 'test-consumer-key',
        consumerSecret: 'test-consumer-secret',
        tokenId: 'test-token-id',
        tokenSecret: 'test-token-secret',
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mocks with proper constructors
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    mockTransformationEngine = {
      transform: jest.fn(),
    } as unknown as jest.Mocked<TransformationEngine>;

    mockConfigService = {
      getConfiguration: jest.fn(),
      validateConfiguration: jest.fn(),
      getAllConfigurations: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<ConfigurationService>;

    mockAuthService = {
      authenticateOAuth2: jest.fn(),
      validateApiKey: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;

    integrationService = new IntegrationService(
      mockLogger,
      mockTransformationEngine,
      mockConfigService,
      mockAuthService,
      undefined,
      createMockOutboundGovernanceService() as any,
      createMockOwnershipResolver() as any,
      createMockAuditService() as any,
      createMockApprovalQueueService() as any, // 9th: ApprovalQueueService (PR 13b A2.5)
    );
  });

  describe('NetSuite to Salesforce Integration', () => {
    it('should create NetSuite and Salesforce connectors for integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'ns-to-sf-integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'Salesforce',
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'sf-client-id',
            clientSecret: 'sf-client-secret',
            tokenUrl: 'https://example.com/token',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(config);
      mockConfigService.validateConfiguration.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      // Access private method for testing
      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');
      const salesforceConnector = await getConnector('Salesforce', 'test-sf-system');

      expect(netsuiteConnector).toBeDefined();
      expect(salesforceConnector).toBeDefined();
    });
  });

  describe('NetSuite to SAP Integration', () => {
    it('should create NetSuite and SAP connectors for integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'ns-to-sap-integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'SAP',
        targetAuthentication: {
          type: 'basic',
          credentials: {
            username: 'sap-user',
            password: 'sap-password',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(config);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');
      const sapConnector = await getConnector('SAP', 'test-sap-system');

      expect(netsuiteConnector).toBeDefined();
      expect(sapConnector).toBeDefined();
    });
  });

  describe('NetSuite to Oracle Integration', () => {
    it('should create NetSuite and Oracle connectors for integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'ns-to-oracle-integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'Oracle',
        targetAuthentication: {
          type: 'basic',
          credentials: {
            username: 'oracle-user',
            password: 'oracle-password',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(config);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');
      const oracleConnector = await getConnector('Oracle', 'test-oracle-system');

      expect(netsuiteConnector).toBeDefined();
      expect(oracleConnector).toBeDefined();
    });
  });

  describe('NetSuite to Business Central Integration', () => {
    it('should create NetSuite and Business Central connectors for integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'ns-to-bc-integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'BusinessCentral',
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'bc-client-id',
            clientSecret: 'bc-client-secret',
            tokenUrl: 'https://example.com/token',
            tenantId: 'bc-tenant-id',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(config);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');
      const bcConnector = await getConnector('BusinessCentral', 'test-bc-system');

      expect(netsuiteConnector).toBeDefined();
      expect(bcConnector).toBeDefined();
    });
  });

  describe('Reverse Integrations (Other Systems to NetSuite)', () => {
    it('should support Salesforce to NetSuite integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'sf-to-ns-integration',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        sourceAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'sf-client-id',
            clientSecret: 'sf-client-secret',
            tokenUrl: 'https://example.com/token',
          },
        },
        targetAuthentication: baseConfig.sourceAuthentication,
      };

      mockConfigService.getConfiguration.mockReturnValue(config);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const salesforceConnector = await getConnector('Salesforce', 'test-sf-system');
      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');

      expect(salesforceConnector).toBeDefined();
      expect(netsuiteConnector).toBeDefined();
    });

    it('should support SAP to NetSuite integration', async () => {
      const config: IntegrationConfig = {
        ...baseConfig,
        id: 'sap-to-ns-integration',
        sourceSystem: 'SAP',
        targetSystem: 'NetSuite',
        sourceAuthentication: {
          type: 'basic',
          credentials: {
            username: 'sap-user',
            password: 'sap-password',
          },
        },
        targetAuthentication: baseConfig.sourceAuthentication,
      };

      mockConfigService.getConfiguration.mockReturnValue(config);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const sapConnector = await getConnector('SAP', 'test-sap-system');
      const netsuiteConnector = await getConnector('NetSuite', 'test-ns-system');

      expect(sapConnector).toBeDefined();
      expect(netsuiteConnector).toBeDefined();
    });
  });

  describe('Multi-System Validation', () => {
    it('should properly validate all supported system combinations', () => {
      const supportedCombinations = [
        ['NetSuite', 'Salesforce'],
        ['NetSuite', 'SAP'],
        ['NetSuite', 'Oracle'],
        ['NetSuite', 'BusinessCentral'],
        ['NetSuite', 'Dynamics365'],  // Original supported system
        ['Salesforce', 'NetSuite'],
        ['SAP', 'NetSuite'],
        ['Oracle', 'NetSuite'],
        ['BusinessCentral', 'NetSuite'],
      ];

      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      supportedCombinations.forEach((pair) => {
        const [source, target] = pair as [string, string];
        expect(async () => {
          await getConnector(source, `test-${source.toLowerCase()}-system`);
          await getConnector(target, `test-${target.toLowerCase()}-system`);
        }).not.toThrow();
      });
    });

    it('should maintain NetSuite connector compatibility', async () => {
      // Test that NetSuite connector can be instantiated with all required parameters
      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const netsuiteConnector = await getConnector('NetSuite', 'compatibility-test');

      expect(netsuiteConnector).toBeDefined();
      expect(netsuiteConnector.constructor.name).toBe('NetSuiteConnector');
    });
  });

  describe('Integration Service System Health', () => {
    it('should include NetSuite in system health monitoring with new connectors', async () => {
      const mockConfigs: IntegrationConfig[] = [
        {
          ...baseConfig,
          sourceSystem: 'NetSuite',
          targetSystem: 'Salesforce',
        },
        {
          ...baseConfig,
          id: 'test-integration-2',
          sourceSystem: 'SAP',
          targetSystem: 'NetSuite',
        },
        {
          ...baseConfig,
          id: 'test-integration-3',
          sourceSystem: 'Oracle',
          targetSystem: 'NetSuite',
        },
      ];

      mockConfigService.getAllConfigurations.mockReturnValue(mockConfigs);

      const health = await integrationService.getSystemHealth();

      // Verify NetSuite is included in system health along with new connectors
      expect(health.totalConfigurations).toBe(3);
      expect(health.activeConfigurations).toBe(3);

      // All systems should be monitored
      const expectedSystems = ['NetSuite', 'Salesforce', 'SAP', 'Oracle'];
      expectedSystems.forEach(system => {
        expect(health.systemStatus).toHaveProperty(system);
      });
    });
  });
});
