import { OracleConnector } from '../connectors/OracleConnector';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { AuthConfig, DataRecord } from '../types';
import axios from 'axios';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockAxiosInstance = {
  request: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  defaults: {
    baseURL: '',
    headers: { common: {} },
  },
} as any;

// Mock dependencies

describe('OracleConnector', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let oracleConnector: OracleConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;

  const mockBasicAuthConfig: AuthConfig = {
    type: 'basic',
    credentials: {
      username: 'hr_user',
      password: 'hr_password',
      host: 'oracle-db.company.com',
      port: 8080,
      protocol: 'https',
      serviceName: 'XEPDB1',
    },
  };

  const mockApiKeyAuthConfig: AuthConfig = {
    type: 'api_key',
    credentials: {
      username: 'cloud_user',
      password: 'cloud_password',
      host: 'oracle-cloud.company.com',
      port: 443,
      protocol: 'https',
      apiKey: 'prod_api_key_12345',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup axios mock
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Minimal AuthService and Logger stubs
    mockAuthService = ({} as unknown) as jest.Mocked<AuthService>;
    mockLogger = ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      withCorrelationId: jest.fn(),
      getCorrelationId: jest.fn(),
    } as unknown) as jest.Mocked<Logger>;

    oracleConnector = new OracleConnector('test-system', mockLogger, mockAuthService, createMockOutboundGovernanceService());

    // Mock the httpClient property
    (oracleConnector as any).httpClient = mockAxiosInstance;
  });

  describe('constructor', () => {
    it('should throw when OutboundGovernanceService is missing', () => {
      expect(() => new OracleConnector(
        'test-system',
        mockLogger,
        mockAuthService,
        undefined as unknown as ReturnType<typeof createMockOutboundGovernanceService>,
      )).toThrow('OutboundGovernanceService is required for gated (production/beta) connector outbound protection');
    });
  });

  describe('initialize', () => {
    it('should initialize with Basic auth config', async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Oracle connector initialized',
        expect.objectContaining({
          host: 'oracle-db.company.com',
          port: 8080,
          serviceName: 'XEPDB1',
          schema: 'HR',
        }),
      );
    });

    it('should initialize with API Key auth config', async () => {
      await oracleConnector.initialize(mockApiKeyAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Oracle connector initialized',
        expect.objectContaining({
          host: 'oracle-cloud.company.com',
          port: 443,
        }),
      );
    });

    it('should throw error for unsupported auth type', async () => {
      const invalidConfig: AuthConfig = {
        type: 'oauth2',
        credentials: { clientId: 'test', clientSecret: 'test' },
      };

      await expect(oracleConnector.initialize(invalidConfig))
        .rejects
        .toThrow('Oracle connector requires Basic or API Key authentication');
    });
  });

  describe('authenticate', () => {
    describe('Basic authentication', () => {
      beforeEach(async () => {
        await oracleConnector.initialize(mockBasicAuthConfig);
      });

      it('should authenticate successfully with Basic auth', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: { items: [] } });

        const result = await oracleConnector.authenticate();

        expect(result).toBe(true);
        expect(mockAxiosInstance.defaults.headers.common['Authorization'])
          .toBe(`Basic ${Buffer.from('hr_user:hr_password').toString('base64')}`);
        expect(mockLogger.info).toHaveBeenCalledWith('Oracle authentication successful');
      });

      it('should handle authentication failure', async () => {
        mockAxiosInstance.request.mockRejectedValue(new Error('Auth failed'));

        await expect(oracleConnector.authenticate())
          .rejects
          .toThrow('Auth failed');

        expect(mockLogger.error).toHaveBeenCalledWith(
          'Oracle authentication failed',
          expect.any(Error),
        );
      });
    });

    describe('API Key authentication', () => {
      beforeEach(async () => {
        await oracleConnector.initialize(mockApiKeyAuthConfig);
      });

      it('should authenticate successfully with API Key', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: { items: [] } });

        const result = await oracleConnector.authenticate();

        expect(result).toBe(true);
        expect(mockAxiosInstance.defaults.headers.common['Authorization'])
          .toBe('Bearer prod_api_key_12345');
        expect(mockLogger.info).toHaveBeenCalledWith('Oracle authentication successful');
      });
    });
  });

  describe('getSystemInfo', () => {
    beforeEach(async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);
      (oracleConnector as any).isAuthenticated = true;
    });

    it('should return system information', async () => {
      const mockVersionInfo = {
        version_full: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0',
        version: '19.0.0.0.0',
        banner: 'Oracle Database 19c Enterprise Edition',
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockVersionInfo });

      const systemInfo = await oracleConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'Oracle Database',
        type: 'Oracle',
        version: '19.0.0.0.0',
        capabilities: expect.arrayContaining([
          'tables',
          'views',
          'procedures',
          'functions',
          'sql_queries',
          'plsql_execution',
          'json_support',
          'spatial_data',
        ]),
        rateLimits: {
          requestsPerMinute: 500,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
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

      const systemInfo = await oracleConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'Oracle Database',
        type: 'Oracle',
        version: 'Unknown',
        capabilities: expect.arrayContaining([
          'tables',
          'views',
          'sql_queries',
          'json_support',
        ]),
        rateLimits: {
          requestsPerMinute: 500,
          requestsPerHour: 20000,
          requestsPerDay: 200000,
        },
        endpoints: expect.objectContaining({
          baseUrl: expect.any(String),
        }),
      });
    });
  });

  describe('CRUD operations', () => {
    const mockRecord: DataRecord = {
      id: 'CUST001',
      externalId: 'CUST001',
      fields: {
        name: 'Test Customer',
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
      await oracleConnector.initialize(mockBasicAuthConfig);
      (oracleConnector as any).isAuthenticated = true;
    });

    describe('create', () => {
      it('should create a customer successfully', async () => {
        const mockResponse = {
          CUSTOMER_ID: 'CUST001',
          NAME: 'Test Customer',
          EMAIL: 'test@example.com',
          PHONE: '123-456-7890',
          CREATED_DATE: new Date().toISOString(),
          LAST_UPDATED: new Date().toISOString(),
          ROWID: 'AAAE1iAABAAAL8nAAA',
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await oracleConnector.create('customer', mockRecord);

        expect(result).toEqual({
          id: 'CUST001',
          externalId: 'CUST001',
          fields: expect.objectContaining({
            name: 'Test Customer',
            email: 'test@example.com',
            phone: '123-456-7890',
          }),
          metadata: expect.objectContaining({
            source: 'Oracle',
          }),
        });
      });
    });

    describe('read', () => {
      it('should read a customer successfully', async () => {
        const mockResponse = {
          CUSTOMER_ID: 'CUST001',
          NAME: 'Test Customer',
          EMAIL: 'test@example.com',
          PHONE: '123-456-7890',
          CREATED_DATE: new Date().toISOString(),
          LAST_UPDATED: new Date().toISOString(),
          ROWID: 'AAAE1iAABAAAL8nAAA',
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await oracleConnector.read('customer', 'CUST001');

        expect(result).toEqual({
          id: 'CUST001',
          externalId: 'CUST001',
          fields: expect.objectContaining({
            name: 'Test Customer',
            email: 'test@example.com',
            phone: '123-456-7890',
          }),
          metadata: expect.objectContaining({
            source: 'Oracle',
          }),
        });
      });

      it('should return null for non-existent record', async () => {
        const error = new Error('Record not found');
        error.message = 'Request failed with status code 404';
        mockAxiosInstance.request.mockRejectedValue(error);

        const result = await oracleConnector.read('customer', 'NON_EXISTENT');

        expect(result).toBeNull();
      });
    });

    describe('update', () => {
      it('should update a customer successfully', async () => {
        const mockResponse = {
          CUSTOMER_ID: 'CUST001',
          NAME: 'Updated Customer',
          EMAIL: 'updated@example.com',
          PHONE: '123-456-7890',
          LAST_UPDATED: new Date().toISOString(),
          ROWID: 'AAAE1iAABAAAL8nAAA',
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const updateData = {
          fields: { name: 'Updated Customer', email: 'updated@example.com' },
        };

        const result = await oracleConnector.update('customer', 'CUST001', updateData);

        expect(result).toEqual({
          id: 'CUST001',
          externalId: 'CUST001',
          fields: expect.objectContaining({
            name: 'Updated Customer',
            email: 'updated@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'Oracle',
          }),
        });
      });
    });

    describe('delete', () => {
      it('should delete a customer successfully', async () => {
        mockAxiosInstance.request.mockResolvedValue({ data: {} });

        const result = await oracleConnector.delete('customer', 'CUST001');

        expect(result).toBe(true);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/CUSTOMERS/CUST001' }));
      });
    });

    describe('list', () => {
      it('should list customers successfully', async () => {
        const mockResponse = {
          items: [
            {
              CUSTOMER_ID: 'CUST001',
              NAME: 'Customer 1',
              EMAIL: 'customer1@example.com',
              LAST_UPDATED: new Date().toISOString(),
              ROWID: 'AAAE1iAABAAAL8nAAA',
            },
            {
              CUSTOMER_ID: 'CUST002',
              NAME: 'Customer 2',
              EMAIL: 'customer2@example.com',
              LAST_UPDATED: new Date().toISOString(),
              ROWID: 'AAAE1iAABAAAL8nAAB',
            },
          ],
          hasMore: false,
          limit: 10,
          offset: 0,
          count: 2,
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await oracleConnector.list('customer', { limit: 10 });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'CUST001',
          externalId: 'CUST001',
          fields: expect.objectContaining({
            name: 'Customer 1',
            email: 'customer1@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'Oracle',
          }),
        });
      });
    });

    describe('search', () => {
      it('should search customers successfully', async () => {
        const mockResponse = {
          items: [
            {
              CUSTOMER_ID: 'CUST001',
              NAME: 'Search Result',
              EMAIL: 'search@example.com',
              LAST_UPDATED: new Date().toISOString(),
              ROWID: 'AAAE1iAABAAAL8nAAA',
            },
          ],
          hasMore: false,
          limit: 100,
          offset: 0,
          count: 1,
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await oracleConnector.search('customer', {
          filters: { NAME: { operator: 'contains', value: 'Search' } },
          operator: 'AND',
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: 'CUST001',
          externalId: 'CUST001',
          fields: expect.objectContaining({
            name: 'Search Result',
          }),
          metadata: expect.objectContaining({
            source: 'Oracle',
          }),
        });
      });
    });
  });

  describe('Oracle-specific query building', () => {
    beforeEach(async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);
    });

    it('should build simple equality filter', () => {
      const filters = { CUSTOMER_ID: 'CUST001' };
      const result = (oracleConnector as any).buildWhereClause(filters);

      expect(result).toBe('"CUSTOMER_ID" = \'CUST001\'');
    });

    it('should build complex filters with operators', () => {
      const filters = {
        NAME: { operator: 'contains', value: 'Test' },
        CREATED_DATE: { operator: 'greater_than', value: new Date('2023-01-01') },
      };
      const result = (oracleConnector as any).buildWhereClause(filters);

      expect(result).toContain('UPPER("NAME") LIKE UPPER(\'%Test%\')');
      expect(result).toContain('"CREATED_DATE" > TO_TIMESTAMP');
      expect(result).toContain(' AND ');
    });

    it('should handle OR operator', () => {
      const filters = {
        CUSTOMER_ID: 'CUST001',
        NAME: 'Test Customer',
      };
      const result = (oracleConnector as any).buildWhereClause(filters, 'OR');

      expect(result).toContain(' OR ');
    });

    it('should handle IN clause', () => {
      const filters = {
        STATUS: { operator: 'in', value: ['ACTIVE', 'PENDING', 'INACTIVE'] },
      };
      const result = (oracleConnector as any).buildWhereClause(filters);

      expect(result).toContain('"STATUS" IN (\'ACTIVE\', \'PENDING\', \'INACTIVE\')');
    });
  });

  describe('Oracle data formatting', () => {
    beforeEach(async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);
    });

    it('should format Oracle values correctly', () => {
      const formatValue = (oracleConnector as any).formatOracleValue.bind(oracleConnector);

      expect(formatValue('test string')).toBe('\'test string\'');
      expect(formatValue(123)).toBe('123');
      expect(formatValue(true)).toBe('1');
      expect(formatValue(false)).toBe('0');
      expect(formatValue(null)).toBe('NULL');
      expect(formatValue(new Date('2023-01-01T12:00:00Z')))
        .toBe('TO_TIMESTAMP(\'2023-01-01T12:00:00.000Z\', \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\')');
    });

    it('should format data for Oracle correctly', () => {
      const mockData = {
        fields: {
          name: 'Test Customer',
          email: 'test@example.com',
          phone: '123-456-7890',
        },
      };

      const result = (oracleConnector as any).formatDataForOracle(mockData);

      expect(result).toEqual({
        NAME: 'Test Customer',
        EMAIL: 'test@example.com',
        PHONE: '123-456-7890',
      });
    });
  });

  describe('webhook operations', () => {
    beforeEach(async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);
      (oracleConnector as any).isAuthenticated = true;
    });

    it('should setup webhook successfully', async () => {
      const mockResponse = {
        id: 'webhook-123',
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await oracleConnector.setupWebhook(
        'https://example.com/webhook',
        ['CUSTOMERS.insert', 'CUSTOMERS.update'],
      );

      expect(result).toBe('webhook-123');
    });

    it('should remove webhook successfully', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {} });

      const result = await oracleConnector.removeWebhook('webhook-123');

      expect(result).toBe(true);
    });
  });

  describe('getChanges', () => {
    beforeEach(async () => {
      await oracleConnector.initialize(mockBasicAuthConfig);
      (oracleConnector as any).isAuthenticated = true;
    });

    it('should get changed records since date', async () => {
      const mockResponse = {
        items: [
          {
            CUSTOMER_ID: 'CUST001',
            NAME: 'Changed Customer',
            EMAIL: 'changed@example.com',
            LAST_UPDATED: new Date().toISOString(),
            ROWID: 'AAAE1iAABAAAL8nAAA',
          },
        ],
        hasMore: false,
        limit: 1000,
        offset: 0,
        count: 1,
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const result = await oracleConnector.getChanges('customer', since);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'CUST001',
        externalId: 'CUST001',
        fields: expect.objectContaining({
          name: 'Changed Customer',
        }),
        metadata: expect.objectContaining({
          source: 'Oracle',
        }),
      });
    });
  });
});
