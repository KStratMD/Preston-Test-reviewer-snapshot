import { SAPConnector } from '../connectors/SAPConnector';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { AuthConfig, DataRecord } from '../types';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
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
} as any;

// Mock dependencies
jest.mock('../services/AuthService');
jest.mock('../utils/Logger');
// Removed unused mocked class constants for AuthService and Logger

describe('SAPConnector', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let sapConnector: SAPConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DEMO_MODE: process.env.DEMO_MODE,
  };

  const mockBasicAuthConfig: AuthConfig = {
    type: 'basic',
    credentials: {
      username: 'sap_user',
      password: 'sap_password',
      client: '100',
      systemId: 'DEV',
      host: 'sap-dev.company.com',
      port: 8000,
      protocol: 'https',
    },
  };

  const mockApiKeyAuthConfig: AuthConfig = {
    type: 'api_key',
    credentials: {
      username: 'sap_user',
      password: 'sap_password',
      client: '100',
      systemId: 'DEV',
      host: 'sap-cloud.company.com',
      port: 443,
      protocol: 'https',
      apiKey: 'test_api_key',
    },
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = '0';
    jest.clearAllMocks();

    // Setup axios mock
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Stub AuthService and Logger to avoid constructor requirements
    mockAuthService = ({
      authenticateOAuth2: jest.fn(),
      validateApiKey: jest.fn(),
    } as unknown) as jest.Mocked<AuthService>;
    mockLogger = ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown) as jest.Mocked<Logger>;

    sapConnector = new SAPConnector('test-system', mockLogger, mockAuthService);

    // Mock the httpClient property
    (sapConnector as any).httpClient = mockAxiosInstance;
  });

  afterAll(() => {
    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    if (originalEnv.DEMO_MODE === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalEnv.DEMO_MODE;
    }
  });

  describe('initialize', () => {
    it('should initialize with Basic auth config', async () => {
      await sapConnector.initialize(mockBasicAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'SAP connector initialized',
        expect.objectContaining({
          host: 'sap-dev.company.com',
          client: '100',
          systemId: 'DEV',
          odataVersion: 'v2',
        }),
      );
    });

    it('should initialize with API Key auth config', async () => {
      await sapConnector.initialize(mockApiKeyAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'SAP connector initialized',
        expect.objectContaining({
          host: 'sap-cloud.company.com',
          client: '100',
          systemId: 'DEV',
        }),
      );
    });

    it('should throw error for unsupported auth type', async () => {
      const invalidConfig: AuthConfig = {
        type: 'oauth2',
        credentials: { clientId: 'test', clientSecret: 'test' },
      };

      await expect(sapConnector.initialize(invalidConfig))
        .rejects
        .toThrow('SAP connector requires Basic or API Key authentication');
    });
  });

  describe('authenticate', () => {
    describe('Basic authentication', () => {
      beforeEach(async () => {
        await sapConnector.initialize(mockBasicAuthConfig);
      });

      it('should authenticate successfully with Basic auth', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: '<metadata>test</metadata>' });

        const result = await sapConnector.authenticate();

        expect(result).toBe(true);
        expect(mockAxiosInstance.defaults.headers.common['Authorization'])
          .toBe(`Basic ${Buffer.from('sap_user:sap_password').toString('base64')}`);
        expect(mockLogger.info).toHaveBeenCalledWith('SAP authentication successful');
      });

      it('should handle authentication failure', async () => {
        mockAxiosInstance.request.mockRejectedValue(new Error('Auth failed'));

        await expect(sapConnector.authenticate())
          .rejects
          .toThrow('Auth failed');

        expect(mockLogger.error).toHaveBeenCalledWith(
          'SAP authentication failed',
          expect.any(Error),
        );
      });
    });

    describe('API Key authentication', () => {
      beforeEach(async () => {
        await sapConnector.initialize(mockApiKeyAuthConfig);
      });

      it('should authenticate successfully with API Key', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: '<metadata>test</metadata>' });

        const result = await sapConnector.authenticate();

        expect(result).toBe(true);
        expect(mockAxiosInstance.defaults.headers.common['Authorization'])
          .toBe('ApiKey test_api_key');
        expect(mockLogger.info).toHaveBeenCalledWith('SAP authentication successful');
      });
    });
  });

  describe('getSystemInfo', () => {
    beforeEach(async () => {
      await sapConnector.initialize(mockBasicAuthConfig);
      (sapConnector as any).isAuthenticated = true;
    });

    it('should return system information', async () => {
      const mockSystemInfo = {
        d: {
          results: [{
            SystemId: 'DEV',
            Client: '100',
            Release: '752',
            Version: '7.52',
          }],
        },
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockSystemInfo });

      const systemInfo = await sapConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'SAP DEV',
        type: 'SAP',
        version: '752',
        capabilities: expect.arrayContaining([
          'master_data',
          'business_partners',
          'materials',
          'purchase_orders',
          'sales_orders',
          'odata_queries',
          'bapi_calls',
        ]),
        rateLimits: {
          requestsPerMinute: 300,
          requestsPerHour: 10000,
          requestsPerDay: 100000,
        },
        endpoints: expect.objectContaining({
          baseUrl: expect.any(String),
          authUrl: expect.any(String),
          webhookUrl: expect.any(String),
        }),
      });
    });

    it('should return default system info on error', async () => {
      mockAxiosInstance.request.mockRejectedValue(new Error('System info not available'));

      const systemInfo = await sapConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'SAP DEV',
        type: 'SAP',
        version: 'Unknown',
        capabilities: expect.arrayContaining([
          'master_data',
          'business_partners',
          'materials',
          'odata_queries',
        ]),
        rateLimits: {
          requestsPerMinute: 300,
          requestsPerHour: 10000,
          requestsPerDay: 100000,
        },
        endpoints: expect.objectContaining({
          baseUrl: expect.any(String),
        }),
      });
    });
  });

  describe('CRUD operations', () => {
    const mockRecord: DataRecord = {
      id: 'BP001',
      externalId: 'BP001',
      fields: {
        name: 'Test Business Partner',
        email: 'test@example.com',
        phone: '123-456-7890',
      },
      metadata: {
        source: 'test',
        lastModified: new Date(),
        version: '1.0',
      },
    };

    beforeEach(async () => {
      await sapConnector.initialize(mockBasicAuthConfig);
      (sapConnector as any).isAuthenticated = true;
    });

    describe('create', () => {
      it('should create a business partner successfully', async () => {
        const mockResponse = {
          __metadata: {
            uri: 'https://sap-dev.company.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner(\'BP001\')',
            type: 'API_BUSINESS_PARTNER.A_BusinessPartnerType',
          },
          BusinessPartner: 'BP001',
          BusinessPartnerFullName: 'Test Business Partner',
          EmailAddress: 'test@example.com',
          PhoneNumber: '123-456-7890',
          CreatedOn: new Date().toISOString(),
          ChangedOn: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await sapConnector.create('business_partner', mockRecord);

        expect(result).toEqual({
          id: 'BP001',
          externalId: 'BP001',
          fields: expect.objectContaining({
            name: 'Test Business Partner',
            email: 'test@example.com',
            phone: '123-456-7890',
          }),
          metadata: expect.objectContaining({
            source: 'SAP',
          }),
        });
      });
    });

    describe('read', () => {
      it('should read a business partner successfully', async () => {
        const mockResponse = {
          __metadata: {
            uri: 'https://sap-dev.company.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner(\'BP001\')',
            type: 'API_BUSINESS_PARTNER.A_BusinessPartnerType',
          },
          BusinessPartner: 'BP001',
          BusinessPartnerFullName: 'Test Business Partner',
          EmailAddress: 'test@example.com',
          PhoneNumber: '123-456-7890',
          CreatedOn: new Date().toISOString(),
          ChangedOn: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await sapConnector.read('business_partner', 'BP001');

        expect(result).toEqual({
          id: 'BP001',
          externalId: 'BP001',
          fields: expect.objectContaining({
            name: 'Test Business Partner',
            email: 'test@example.com',
            phone: '123-456-7890',
          }),
          metadata: expect.objectContaining({
            source: 'SAP',
          }),
        });
      });

      it('should return null for non-existent record', async () => {
        const error = new Error('Record not found');
        error.message = 'Request failed with status code 404';
        mockAxiosInstance.request.mockRejectedValue(error);

        const result = await sapConnector.read('business_partner', 'NON_EXISTENT');

        expect(result).toBeNull();
      });
    });

    describe('update', () => {
      it('should update a business partner successfully', async () => {
        const mockResponse = {
          __metadata: {
            uri: 'https://sap-dev.company.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner(\'BP001\')',
            type: 'API_BUSINESS_PARTNER.A_BusinessPartnerType',
          },
          BusinessPartner: 'BP001',
          BusinessPartnerFullName: 'Updated Business Partner',
          EmailAddress: 'updated@example.com',
          PhoneNumber: '123-456-7890',
          ChangedOn: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const updateData = {
          fields: { name: 'Updated Business Partner', email: 'updated@example.com' },
        };

        const result = await sapConnector.update('business_partner', 'BP001', updateData);

        expect(result).toEqual({
          id: 'BP001',
          externalId: 'BP001',
          fields: expect.objectContaining({
            name: 'Updated Business Partner',
            email: 'updated@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'SAP',
          }),
        });
      });
    });

    describe('delete', () => {
      it('should delete a business partner successfully', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: {} });

        const result = await sapConnector.delete('business_partner', 'BP001');

        expect(result).toBe(true);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'DELETE',
            url: '/API_BUSINESS_PARTNER/A_BusinessPartner(\'BP001\')',
            headers: { 'If-Match': '*' },
          }),
        );
      });
    });

    describe('list', () => {
      it('should list business partners successfully', async () => {
        const mockResponse = {
          d: {
            results: [
              {
                __metadata: { uri: 'test-uri-1', type: 'test-type' },
                BusinessPartner: 'BP001',
                BusinessPartnerFullName: 'Business Partner 1',
                EmailAddress: 'bp1@example.com',
                ChangedOn: new Date().toISOString(),
              },
              {
                __metadata: { uri: 'test-uri-2', type: 'test-type' },
                BusinessPartner: 'BP002',
                BusinessPartnerFullName: 'Business Partner 2',
                EmailAddress: 'bp2@example.com',
                ChangedOn: new Date().toISOString(),
              },
            ],
          },
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await sapConnector.list('business_partner', { limit: 10 });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'BP001',
          externalId: 'BP001',
          fields: expect.objectContaining({
            name: 'Business Partner 1',
            email: 'bp1@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'SAP',
          }),
        });
      });
    });

    describe('search', () => {
      it('should search business partners successfully', async () => {
        const mockResponse = {
          d: {
            results: [
              {
                __metadata: { uri: 'test-uri', type: 'test-type' },
                BusinessPartner: 'BP001',
                BusinessPartnerFullName: 'Search Result',
                EmailAddress: 'search@example.com',
                ChangedOn: new Date().toISOString(),
              },
            ],
          },
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await sapConnector.search('business_partner', {
          filters: { BusinessPartnerFullName: { operator: 'contains', value: 'Search' } },
          operator: 'AND',
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: 'BP001',
          externalId: 'BP001',
          fields: expect.objectContaining({
            name: 'Search Result',
          }),
          metadata: expect.objectContaining({
            source: 'SAP',
          }),
        });
      });
    });
  });

  describe('OData filter building', () => {
    beforeEach(async () => {
      await sapConnector.initialize(mockBasicAuthConfig);
    });

    it('should build simple equality filter', () => {
      const filters = { BusinessPartner: 'BP001' };
      const result = (sapConnector as any).buildODataFilter(filters);

      expect(result).toBe('BusinessPartner eq \'BP001\'');
    });

    it('should build complex filters with operators', () => {
      const filters = {
        BusinessPartner: { operator: 'contains', value: 'BP' },
        CreatedOn: { operator: 'greater_than', value: new Date('2023-01-01') },
      };
      const result = (sapConnector as any).buildODataFilter(filters);

      expect(result).toContain('substringof(\'BP\', BusinessPartner)');
      expect(result).toContain('CreatedOn gt datetime');
      expect(result).toContain(' and ');
    });

    it('should handle OR operator', () => {
      const filters = {
        BusinessPartner: 'BP001',
        BusinessPartnerFullName: 'Test',
      };
      const result = (sapConnector as any).buildODataFilter(filters, 'OR');

      expect(result).toContain(' or ');
    });
  });

  describe('webhook operations', () => {
    beforeEach(async () => {
      await sapConnector.initialize(mockBasicAuthConfig);
      (sapConnector as any).isAuthenticated = true;
    });

    it('should setup webhook successfully', async () => {
      const mockResponse = {
        Id: 'webhook-123',
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await sapConnector.setupWebhook(
        'https://example.com/webhook',
        ['BusinessPartner.create', 'BusinessPartner.update'],
      );

      expect(result).toBe('webhook-123');
    });

    it('should remove webhook successfully', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {} });

      const result = await sapConnector.removeWebhook('webhook-123');

      expect(result).toBe(true);
    });
  });

  describe('getChanges', () => {
    beforeEach(async () => {
      await sapConnector.initialize(mockBasicAuthConfig);
      (sapConnector as any).isAuthenticated = true;
    });

    it('should get changed records since date', async () => {
      const mockResponse = {
        d: {
          results: [
            {
              __metadata: { uri: 'test-uri', type: 'test-type' },
              BusinessPartner: 'BP001',
              BusinessPartnerFullName: 'Changed Business Partner',
              EmailAddress: 'changed@example.com',
              ChangedOn: new Date().toISOString(),
            },
          ],
        },
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const result = await sapConnector.getChanges('business_partner', since);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'BP001',
        externalId: 'BP001',
        fields: expect.objectContaining({
          name: 'Changed Business Partner',
        }),
        metadata: expect.objectContaining({
          source: 'SAP',
        }),
      });
    });
  });
});
