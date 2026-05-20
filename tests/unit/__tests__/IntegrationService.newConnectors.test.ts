// Tests for IntegrationService support of new connectors
import { IntegrationService } from '../services/IntegrationService';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';
import type { ObservabilityService } from '../observability';
import { TransformationEngine } from '../services/TransformationEngine';
import { ConfigurationService } from '../services/ConfigurationService';
import { AuthService } from '../services/AuthService';
import { Logger } from '../utils/Logger';
import type { IntegrationConfig } from '../types';
import { SalesforceConnector } from '../connectors/SalesforceConnector';
import { SAPConnector } from '../connectors/SAPConnector';
import { OracleConnector } from '../connectors/OracleConnector';
import { BusinessCentralConnector } from '../connectors/BusinessCentralConnector';

// Mock all dependencies
jest.mock('../services/TransformationEngine');
jest.mock('../services/ConfigurationService');
jest.mock('../services/AuthService');
jest.mock('../utils/Logger');
jest.mock('../connectors/SalesforceConnector');
jest.mock('../connectors/SAPConnector');
jest.mock('../connectors/OracleConnector');
jest.mock('../connectors/BusinessCentralConnector');

// Mocked classes - defined but used for mocking setup
const _MockedTransformationEngine = TransformationEngine as jest.MockedClass<typeof TransformationEngine>;
const _MockedConfigurationService = ConfigurationService as jest.MockedClass<typeof ConfigurationService>;
const _MockedAuthService = AuthService as jest.MockedClass<typeof AuthService>;
const _MockedLogger = Logger as jest.MockedClass<typeof Logger>;
const MockedSalesforceConnector = SalesforceConnector as jest.MockedClass<typeof SalesforceConnector>;
const MockedSAPConnector = SAPConnector as jest.MockedClass<typeof SAPConnector>;
const MockedOracleConnector = OracleConnector as jest.MockedClass<typeof OracleConnector>;
const MockedBusinessCentralConnector = BusinessCentralConnector as jest.MockedClass<typeof BusinessCentralConnector>;

// Mock configuration for testing
const mockSalesforceConfig: IntegrationConfig = {
  id: 'sf-to-sap-test',
  name: 'Salesforce to SAP Test Integration',
  description: 'Test integration between Salesforce and SAP',
  sourceSystem: 'Salesforce',
  targetSystem: 'SAP',
  sourceEntity: 'Account',
  targetEntity: 'business_partner',
  syncDirection: 'source_to_target',
  syncMode: 'manual',
  isActive: true,
  sourceAuthentication: {
    type: 'oauth2',
    credentials: {
      clientId: 'sf_client_id',
      clientSecret: 'sf_client_secret',
      tokenUrl: 'https://example.com/token',
    },
  },
  targetAuthentication: {
    type: 'basic',
    credentials: {
      username: 'sap_user',
      password: 'sap_password',
    },
  },
  fieldMappings: [],
  transformationRules: [],
};

describe('IntegrationService - New Connectors Support', () => {
  let integrationService: IntegrationService;
  let mockObservabilityService: jest.Mocked<ObservabilityService>;
  let mockLogger: jest.Mocked<Logger>;
  let mockTransformationEngine: jest.Mocked<TransformationEngine>;
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockAuthService: jest.Mocked<AuthService>;

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

    // Stub ObservabilityService for constructor
    mockObservabilityService = {} as jest.Mocked<ObservabilityService>;
    integrationService = new IntegrationService(
      mockLogger,
      mockTransformationEngine,
      mockConfigService,
      mockAuthService,
      mockObservabilityService,
      createMockOutboundGovernanceService(),
    );

    // Mock config service methods
    mockConfigService.getAllConfigurations.mockReturnValue([]);
  });

  describe('Connector Creation', () => {
    it('should create Salesforce connector', async () => {
      const _mockConnector = new MockedSalesforceConnector('test', mockLogger, mockAuthService);

      // Access private method for testing
      const getConnector = (integrationService as any).getConnector.bind(integrationService);
      const connector = await getConnector('Salesforce', 'test-system-id');

      expect(MockedSalesforceConnector).toHaveBeenCalledWith('test-system-id', mockLogger, mockAuthService, expect.anything());
      expect(connector).toBeInstanceOf(MockedSalesforceConnector);
    });

    it('should create SAP connector', async () => {
      const _mockConnector = new MockedSAPConnector('test', mockLogger, mockAuthService);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);
      const connector = await getConnector('SAP', 'test-system-id');

      expect(MockedSAPConnector).toHaveBeenCalledWith('test-system-id', mockLogger, mockAuthService);
      expect(connector).toBeInstanceOf(MockedSAPConnector);
    });

    it('should create Oracle connector', async () => {
      const _mockConnector = new MockedOracleConnector('test', mockLogger, mockAuthService);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);
      const connector = await getConnector('Oracle', 'test-system-id');

      expect(MockedOracleConnector).toHaveBeenCalledWith('test-system-id', mockLogger, mockAuthService);
      expect(connector).toBeInstanceOf(MockedOracleConnector);
    });

    it('should create Business Central connector', async () => {
      const _mockConnector = new MockedBusinessCentralConnector('test', mockLogger, mockAuthService);

      const getConnector = (integrationService as any).getConnector.bind(integrationService);
      const connector = await getConnector('BusinessCentral', 'test-system-id');

      expect(MockedBusinessCentralConnector).toHaveBeenCalledWith('test-system-id', mockLogger, mockAuthService, expect.anything());
      expect(connector).toBeInstanceOf(MockedBusinessCentralConnector);
    });

    it('should cache connectors correctly', async () => {
      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const connector1 = await getConnector('Salesforce', 'test-system-id');
      const connector2 = await getConnector('Salesforce', 'test-system-id');

      expect(MockedSalesforceConnector).toHaveBeenCalledTimes(1);
      expect(connector1).toBe(connector2);
    });

    it('should create different instances for different system IDs', async () => {
      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      const _connector1 = await getConnector('Salesforce', 'system-1');
      const _connector2 = await getConnector('Salesforce', 'system-2');

      expect(MockedSalesforceConnector).toHaveBeenCalledTimes(2);
      expect(MockedSalesforceConnector).toHaveBeenNthCalledWith(1, 'system-1', mockLogger, mockAuthService, expect.anything());
      expect(MockedSalesforceConnector).toHaveBeenNthCalledWith(2, 'system-2', mockLogger, mockAuthService, expect.anything());
    });

    it('should throw error for unsupported system type', async () => {
      const getConnector = (integrationService as any).getConnector.bind(integrationService);

      await expect(getConnector('UnsupportedSystem', 'test-system-id'))
        .rejects
        .toThrow('Unsupported system type: UnsupportedSystem');
    });
  });

  describe('Integration Scenarios', () => {
    beforeEach(() => {
      mockConfigService.getConfiguration.mockReturnValue(mockSalesforceConfig);
      (mockConfigService.validateConfiguration as jest.Mock).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });

    it('should test Salesforce to SAP integration', async () => {
      const mockSalesforceConnector = {
        systemType: 'Salesforce',
        systemId: 'salesforce-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({
          systemType: 'Salesforce',
          systemId: 'salesforce-test',
          isConnected: true,
          lastTestTime: new Date(),
        }),
        authenticate: jest.fn().mockResolvedValue(true),
        getSystemInfo: jest.fn().mockResolvedValue({
          name: 'Salesforce',
          type: 'Salesforce',
          version: '1.0',
          capabilities: ['read', 'write'],
        }),
        list: jest.fn().mockResolvedValue([{
          id: 'test-account',
          fields: { name: 'Test Account' },
        }]),
      };

      const mockSAPConnector = {
        systemType: 'SAP',
        systemId: 'sap-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({
          systemType: 'SAP',
          systemId: 'sap-test',
          isConnected: true,
          lastTestTime: new Date(),
        }),
        authenticate: jest.fn().mockResolvedValue(true),
        getSystemInfo: jest.fn().mockResolvedValue({
          name: 'SAP',
          type: 'SAP',
          version: '1.0',
          capabilities: ['read', 'write'],
        }),
      };

      const getConnectorSpy = jest.spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Salesforce') return Promise.resolve(mockSalesforceConnector);
          if (systemType === 'SAP') return Promise.resolve(mockSAPConnector);
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const result = await integrationService.testIntegration('sf-to-sap-test');

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(mockSalesforceConnector.initialize).toHaveBeenCalled();
      expect(mockSAPConnector.initialize).toHaveBeenCalled();

      getConnectorSpy.mockRestore();
    });

    it('should test Oracle to Business Central integration', async () => {
      const oracleToBC: IntegrationConfig = {
        ...mockSalesforceConfig,
        id: 'oracle-to-bc-test',
        name: 'Oracle to Business Central Test Integration',
        sourceSystem: 'Oracle',
        targetSystem: 'BusinessCentral',
        sourceEntity: 'CUSTOMERS',
        targetEntity: 'customers',
        sourceAuthentication: {
          type: 'basic',
          credentials: {
            username: 'oracle_user',
            password: 'oracle_password',
          },
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'bc_client_id',
            clientSecret: 'bc_client_secret',
            tokenUrl: 'https://example.com/token',
            tenantId: 'test-tenant-id',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(oracleToBC);

      const mockOracleConnector = {
        systemType: 'Oracle',
        systemId: 'oracle-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };
      const mockBCConnector = {
        systemType: 'BusinessCentral',
        systemId: 'bc-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Oracle') return mockOracleConnector;
          if (systemType === 'BusinessCentral') return mockBCConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      mockTransformationEngine.transform.mockResolvedValue({
        success: true,
        transformedData: {
          id: 'test-id',
          externalId: 'test-external-id',
          fields: { displayName: 'Test Customer' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        errors: [],
        warnings: [],
      });

      const result = await integrationService.testIntegration('oracle-to-bc-test');

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(mockOracleConnector.initialize).toHaveBeenCalled();
      expect(mockBCConnector.initialize).toHaveBeenCalled();

      getConnectorSpy.mockRestore();
    });

    it('should handle authentication failures gracefully', async () => {
      const mockSalesforceConnector = {
        systemType: 'Salesforce',
        systemId: 'sf-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({
          isConnected: false,
          errorMessage: 'Invalid credentials',
        }),
      };
      const mockSAPConnector = {
        systemType: 'SAP',
        systemId: 'sap-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Salesforce') return mockSalesforceConnector;
          if (systemType === 'SAP') return mockSAPConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const result = await integrationService.testIntegration('sf-to-sap-test');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Source system connection failed: Invalid credentials');

      getConnectorSpy.mockRestore();
    });

    it('should handle transformation failures', async () => {
      const mockSalesforceConnector = {
        systemType: 'Salesforce',
        systemId: 'sf-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
        list: jest.fn().mockResolvedValue([
          {
            id: 'test-id',
            externalId: 'test-external-id',
            fields: { Name: 'Test Account' },
            metadata: { source: 'Salesforce', lastModified: new Date(), version: '1.0' },
          },
        ]),
      };
      const mockSAPConnector = {
        systemType: 'SAP',
        systemId: 'sap-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Salesforce') return mockSalesforceConnector;
          if (systemType === 'SAP') return mockSAPConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      mockTransformationEngine.transform.mockResolvedValue({
        success: false,
        transformedData: {} as any,
        errors: [{ message: 'Required field missing', field: 'BusinessPartnerFullName', severity: 'error' }],
        warnings: [],
      });

      const result = await integrationService.testIntegration('sf-to-sap-test');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Transformation Error: Required field missing');

      getConnectorSpy.mockRestore();
    });
  });

  describe('System Health Monitoring', () => {
    it('should include new system types in health monitoring', async () => {
      const mockConfigs: IntegrationConfig[] = [
        {
          id: 'sf-integration',
          sourceSystem: 'Salesforce',
          targetSystem: 'SAP',
          isActive: true,
        } as IntegrationConfig,
        {
          id: 'oracle-integration',
          sourceSystem: 'Oracle',
          targetSystem: 'BusinessCentral',
          isActive: true,
        } as IntegrationConfig,
      ];

      mockConfigService.getAllConfigurations.mockReturnValue(mockConfigs);

      const health = await integrationService.getSystemHealth();

      expect(health.totalConfigurations).toBe(2);
      expect(health.activeConfigurations).toBe(2);
      expect(health.systemStatus).toHaveProperty('Salesforce');
      expect(health.systemStatus).toHaveProperty('SAP');
      expect(health.systemStatus).toHaveProperty('Oracle');
      expect(health.systemStatus).toHaveProperty('BusinessCentral');
    });
  });

  describe('Error Handling', () => {
    it('should handle connector initialization failures', async () => {
      const mockConfig: IntegrationConfig = {
        ...mockSalesforceConfig,
        sourceSystem: 'Salesforce',
        targetSystem: 'SAP',
      };

      mockConfigService.getConfiguration.mockReturnValue(mockConfig);

      const mockSalesforceConnector = {
        systemType: 'Salesforce',
        systemId: 'sf-test',
        initialize: jest.fn().mockRejectedValue(new Error('Initialization failed')),
      };
      const mockSAPConnector = {
        systemType: 'SAP',
        systemId: 'sap-test',
        initialize: jest.fn().mockResolvedValue(undefined),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Salesforce') return mockSalesforceConnector;
          if (systemType === 'SAP') return mockSAPConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      const initializeConnectorsForConfig = (integrationService as any)
        .initializeConnectorsForConfig
        .bind(integrationService);

      await initializeConnectorsForConfig(mockConfig);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialize connectors'),
        expect.any(Error),
      );

      getConnectorSpy.mockRestore();
    });

    it('should validate configuration before testing integration', async () => {
      mockConfigService.getConfiguration.mockReturnValue(null as any);

      await expect(integrationService.testIntegration('non-existent-config'))
        .rejects
        .toThrow('Configuration non-existent-config not found');
    });
  });

  describe('Multi-System Integration Patterns', () => {
    beforeEach(() => {
      (mockConfigService.validateConfiguration as jest.Mock).mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });
    });
    it('should support bidirectional sync between new systems', async () => {
      const bidirectionalConfig: IntegrationConfig = {
        ...mockSalesforceConfig,
        id: 'sap-bc-bidirectional',
        name: 'SAP to Business Central Bidirectional Sync',
        sourceSystem: 'SAP',
        targetSystem: 'BusinessCentral',
        syncDirection: 'bidirectional',
        sourceAuthentication: {
          type: 'basic',
          credentials: { username: 'sap_user', password: 'sap_password' },
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'bc_client_id',
            clientSecret: 'bc_client_secret',
            tokenUrl: 'https://example.com/token',
            tenantId: 'test-tenant-id',
          },
        },
      };

      mockConfigService.getConfiguration.mockReturnValue(bidirectionalConfig);

      const mockSAPConnector = {
        systemType: 'SAP',
        systemId: 'sap-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };
      const mockBCConnector = {
        systemType: 'BusinessCentral',
        systemId: 'bc-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'SAP') return mockSAPConnector;
          if (systemType === 'BusinessCentral') return mockBCConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      mockTransformationEngine.transform.mockResolvedValue({
        success: true,
        transformedData: {
          id: 'test-id',
          externalId: 'test-external-id',
          fields: { displayName: 'Test Entity' },
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        },
        errors: [],
        warnings: [],
      });

      const result = await integrationService.testIntegration('sap-bc-bidirectional');

      expect(mockSAPConnector.initialize).toHaveBeenCalled();
      expect(mockBCConnector.initialize).toHaveBeenCalled();
      expect(result.errors).toHaveLength(0);

      getConnectorSpy.mockRestore();
    });

    it('should handle complex transformation scenarios between different system types', async () => {
      const complexConfig: IntegrationConfig = {
        ...mockSalesforceConfig,
        id: 'complex-transformation',
        sourceSystem: 'Oracle',
        targetSystem: 'Salesforce',
        sourceAuthentication: {
          type: 'basic',
          credentials: { username: 'oracle_user', password: 'oracle_password' },
        },
        targetAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'sf_client_id',
            clientSecret: 'sf_client_secret',
            tokenUrl: 'https://example.com/token',
          },
        },
        fieldMappings: [
          {
            sourceField: 'CUSTOMER_NAME',
            targetField: 'Name',
            transformationType: 'direct',
            isRequired: true,
          },
          {
            sourceField: 'EMAIL_ADDRESS',
            targetField: 'Email',
            transformationType: 'direct',
            isRequired: true,
          },
        ],
        transformationRules: [
          {
            condition: 'CUSTOMER_TYPE = "PREMIUM"',
            action: 'set_field_value',
            targetField: 'Type',
            value: 'Premium Customer',
          },
        ] as any,
      };

      mockConfigService.getConfiguration.mockReturnValue(complexConfig);

      const mockOracleConnector = {
        systemType: 'Oracle',
        systemId: 'oracle-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
        list: jest.fn().mockResolvedValue([
          {
            id: 'CUST001',
            externalId: 'CUST001',
            fields: { CUSTOMER_NAME: 'Premium Corp', EMAIL_ADDRESS: 'premium@corp.com', CUSTOMER_TYPE: 'PREMIUM' },
            metadata: { source: 'Oracle', lastModified: new Date(), version: '1.0' },
          },
        ]),
      };
      const mockSalesforceConnector = {
        systemType: 'Salesforce',
        systemId: 'sf-test',
        initialize: jest.fn().mockResolvedValue(undefined),
        testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
      };

      const getConnectorSpy = jest
        .spyOn(integrationService as any, 'getConnector')
        .mockImplementation(async (systemType: any) => {
          if (systemType === 'Oracle') return mockOracleConnector;
          if (systemType === 'Salesforce') return mockSalesforceConnector;
          throw new Error(`Unknown system type: ${systemType}`);
        });

      mockTransformationEngine.transform.mockResolvedValue({
        success: true,
        transformedData: {
          id: 'CUST001',
          externalId: 'CUST001',
          fields: { Name: 'Premium Corp', Email: 'premium@corp.com', Type: 'Premium Customer' },
          metadata: { source: 'Oracle', lastModified: new Date(), version: '1.0' },
        },
        errors: [],
        warnings: [],
      });

      const result = await integrationService.testIntegration('complex-transformation');

      expect(result.errors).toHaveLength(0);
      expect(mockTransformationEngine.transform).toHaveBeenCalledWith({
        sourceData: expect.objectContaining({
          fields: expect.objectContaining({
            CUSTOMER_NAME: 'Premium Corp',
            EMAIL_ADDRESS: 'premium@corp.com',
            CUSTOMER_TYPE: 'PREMIUM',
          }),
        }),
        mappings: complexConfig.fieldMappings,
        rules: complexConfig.transformationRules,
      });

      getConnectorSpy.mockRestore();
    });
  });
});
