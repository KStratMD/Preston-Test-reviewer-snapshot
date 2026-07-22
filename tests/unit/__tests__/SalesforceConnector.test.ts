import { SalesforceConnector } from '../connectors/SalesforceConnector';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { AuthConfig, DataRecord } from '../types';
import axios from 'axios';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  defaults: {
    baseURL: '',
    headers: { common: {} },
  },
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
  request: jest.fn().mockResolvedValue({ data: {} }), // Add this line
} as any;

// Mock dependencies
// Replace AuthService and Logger mocks with minimal stubs

describe('SalesforceConnector', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let salesforceConnector: SalesforceConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;

  const mockAuthConfig: AuthConfig = {
    type: 'oauth2',
    credentials: {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      username: 'test@example.com',
      password: 'testpassword',
      securityToken: 'token123',
      loginUrl: 'https://test.salesforce.com',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup axios mock
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Minimal mocks for AuthService and Logger
    mockAuthService = ({ authenticateOAuth2: jest.fn() } as unknown) as jest.Mocked<AuthService>;
    mockLogger = ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      withCorrelationId: jest.fn(),
      getCorrelationId: jest.fn(),
    } as unknown) as jest.Mocked<Logger>;

    salesforceConnector = new SalesforceConnector('test-system', mockLogger, mockAuthService, createMockOutboundGovernanceService());

    // Mock the httpClient property
    (salesforceConnector as any).httpClient = mockAxiosInstance;
  });

  describe('initialize', () => {
    it('should initialize with OAuth2 config', async () => {
      await salesforceConnector.initialize(mockAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Salesforce connector initialized',
        expect.objectContaining({
          instanceUrl: expect.any(String),
          apiVersion: 'v59.0',
        }),
      );
    });

    it('should throw error for non-OAuth2 config', async () => {
      const invalidConfig: AuthConfig = {
        type: 'basic',
        credentials: { username: 'test', password: 'test' },
      };

      await expect(salesforceConnector.initialize(invalidConfig))
        .rejects
        .toThrow('Salesforce connector requires OAuth2 authentication');
    });
  });

  describe('authenticate', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
    });

    it('should authenticate successfully', async () => {
      const mockTokenInfo = {
        accessToken: 'mock_access_token',
        tokenType: 'Bearer',
        expiresAt: new Date(Date.now() + 3600000),
        scope: 'api',
        instanceUrl: 'https://test.salesforce.com',
        issued: new Date(),
      };

      mockAuthService.authenticateOAuth2.mockResolvedValue(mockTokenInfo);

      const result = await salesforceConnector.authenticate();

      expect(result).toBe(true);
      expect(mockAuthService.authenticateOAuth2).toHaveBeenCalledWith({
        type: 'oauth2',
        credentials: {
          client_id: 'test_client_id',
          client_secret: 'test_client_secret',
          token_url: 'https://test.salesforce.com/services/oauth2/token',
          grant_type: 'password',
          username: 'test@example.com',
          password: 'testpasswordtoken123',
          scope: 'api',
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Salesforce authentication successful',
        expect.any(Object),
      );
    });

    it('should handle authentication failure', async () => {
      mockAuthService.authenticateOAuth2.mockRejectedValue(new Error('Auth failed'));

      await expect(salesforceConnector.authenticate())
        .rejects
        .toThrow('Auth failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Salesforce authentication failed',
        expect.any(Error),
      );
    });
  });

  describe('getSystemInfo', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('should return system information', async () => {
      const mockOrgData = {
        records: [{
          Name: 'Test Org',
          OrganizationType: 'Production',
          Edition: 'Enterprise',
          InstanceName: 'CS1',
        }],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockOrgData });

      const systemInfo = await salesforceConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'Test Org',
        type: 'Salesforce',
        version: 'v59.0',
        capabilities: expect.arrayContaining([
          'accounts',
          'contacts',
          'leads',
          'opportunities',
          'soql_queries',
          'bulk_operations',
        ]),
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 100000,
          requestsPerDay: 1000000,
        },
        endpoints: expect.objectContaining({
          baseUrl: expect.any(String),
          authUrl: expect.any(String),
          webhookUrl: expect.any(String),
        }),
      });
    });
  });

  describe('CRUD operations', () => {
    const mockRecord: DataRecord = {
      id: 'test-id',
      externalId: 'test-external-id',
      fields: {
        name: 'Test Account',
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
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    describe('create', () => {
      it('should create a record successfully', async () => {
        const mockCreateResponse = {
          id: 'new-record-id',
          success: true,
          errors: [],
        };

        const mockReadResponse = {
          Id: 'new-record-id',
          Name: 'Test Account',
          Email: 'test@example.com',
          Phone: '123-456-7890',
          CreatedDate: new Date().toISOString(),
          LastModifiedDate: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValueOnce({ data: mockCreateResponse });
        mockAxiosInstance.request.mockResolvedValueOnce({ data: mockReadResponse });

        const result = await salesforceConnector.create('account', mockRecord);

        expect(result).toEqual({
          id: 'new-record-id',
          externalId: 'new-record-id',
          fields: {
            name: 'Test Account',
            email: 'test@example.com',
            phone: '123-456-7890',
          },
          metadata: expect.objectContaining({
            source: 'Salesforce',
          }),
        });
      });

      it('should handle create failure', async () => {
        const mockCreateResponse = {
          id: null,
          success: false,
          errors: ['Required field missing'],
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockCreateResponse });

        await expect(salesforceConnector.create('account', mockRecord))
          .rejects
          .toThrow('Salesforce create failed: Required field missing');
      });
    });

    describe('read', () => {
      it('should read a record successfully', async () => {
        const mockResponse = {
          Id: 'test-id',
          Name: 'Test Account',
          Email: 'test@example.com',
          Phone: '123-456-7890',
          CreatedDate: new Date().toISOString(),
          LastModifiedDate: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await salesforceConnector.read('account', 'test-id');

        expect(result).toEqual({
          id: 'test-id',
          externalId: 'test-id',
          fields: {
            name: 'Test Account',
            email: 'test@example.com',
            phone: '123-456-7890',
          },
          metadata: expect.objectContaining({
            source: 'Salesforce',
          }),
        });
      });

      it('should return null for non-existent record', async () => {
        const error = new Error('Record not found');
        error.message = 'Request failed with status code 404';
        mockAxiosInstance.request.mockRejectedValue(error);

        const result = await salesforceConnector.read('account', 'non-existent');

        expect(result).toBeNull();
      });
    });

    describe('update', () => {
      it('should update a record successfully', async () => {
        const mockReadResponse = {
          Id: 'test-id',
          Name: 'Updated Account',
          Email: 'updated@example.com',
          Phone: '123-456-7890',
          CreatedDate: new Date().toISOString(),
          LastModifiedDate: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: {} });
        mockAxiosInstance.request.mockResolvedValue({ data: mockReadResponse });

        const updateData = {
          fields: { name: 'Updated Account', email: 'updated@example.com' },
        };

        const result = await salesforceConnector.update('account', 'test-id', updateData);

        expect(result).toEqual({
          id: 'test-id',
          externalId: 'test-id',
          fields: {
            name: 'Updated Account',
            email: 'updated@example.com',
            phone: '123-456-7890',
          },
          metadata: expect.objectContaining({
            source: 'Salesforce',
          }),
        });
      });
    });

    describe('delete', () => {
      it('should delete a record successfully', async () => {
        mockAxiosInstance.request.mockResolvedValue({ status: 204 });

        const result = await salesforceConnector.delete('account', 'test-id');

        expect(result).toBe(true);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'DELETE',
            url: '/sobjects/Account/test-id',
          }),
        );
      });
    });

    describe('list', () => {
      it('should list records successfully', async () => {
        const mockResponse = {
          totalSize: 2,
          done: true,
          records: [
            {
              Id: 'id1',
              Name: 'Account 1',
              Email: 'account1@example.com',
              CreatedDate: new Date().toISOString(),
              LastModifiedDate: new Date().toISOString(),
            },
            {
              Id: 'id2',
              Name: 'Account 2',
              Email: 'account2@example.com',
              CreatedDate: new Date().toISOString(),
              LastModifiedDate: new Date().toISOString(),
            },
          ],
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await salesforceConnector.list('account', { limit: 10 });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'id1',
          externalId: 'id1',
          fields: {
            name: 'Account 1',
            email: 'account1@example.com',
          },
          metadata: expect.objectContaining({
            source: 'Salesforce',
          }),
        });
      });
    });

    describe('search', () => {
      it('should search records successfully', async () => {
        const mockResponse = {
          records: [
            {
              Id: 'search-id',
              Name: 'Search Result',
              Email: 'search@example.com',
              CreatedDate: new Date().toISOString(),
              LastModifiedDate: new Date().toISOString(),
            },
          ],
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

        const result = await salesforceConnector.search('account', {
          filters: { Name: { operator: 'contains', value: 'Search' } },
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: 'search-id',
          externalId: 'search-id',
          fields: {
            name: 'Search Result',
            email: 'search@example.com',
          },
          metadata: expect.objectContaining({
            source: 'Salesforce',
          }),
        });
      });
    });
  });

  describe('getChanges', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('should get changed records since date', async () => {
      const mockResponse = {
        records: [
          {
            Id: 'changed-id',
            Name: 'Changed Account',
            Email: 'changed@example.com',
            CreatedDate: new Date().toISOString(),
            LastModifiedDate: new Date().toISOString(),
          },
        ],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await salesforceConnector.getChanges('account', new Date(Date.now() - 86400000));

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'changed-id',
        externalId: 'changed-id',
        fields: {
          name: 'Changed Account',
          email: 'changed@example.com',
        },
        metadata: expect.objectContaining({
          source: 'Salesforce',
        }),
      });
    });
  });

  describe('webhook operations', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('should setup webhook successfully', async () => {
      const mockResponse = {
        id: 'webhook-id',
        success: true,
        errors: [],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await salesforceConnector.setupWebhook(
        'https://example.com/webhook',
        ['Account.create', 'Account.update'],
      );

      expect(result).toBe('webhook-id');
    });

    it('should remove webhook successfully', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {} });

      const result = await salesforceConnector.removeWebhook('webhook-id');

      expect(result).toBe(true);
    });
  });

  describe('getChanges', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('should get changed records since date', async () => {
      const mockResponse = {
        totalSize: 1,
        done: true,
        records: [
          {
            Id: 'changed-id',
            Name: 'Changed Account',
            Email: 'changed@example.com',
            CreatedDate: new Date().toISOString(),
            LastModifiedDate: new Date().toISOString(),
          },
        ],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const result = await salesforceConnector.getChanges('account', since);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'changed-id',
        externalId: 'changed-id',
        fields: expect.objectContaining({
          name: 'Changed Account',
        }),
        metadata: expect.objectContaining({
          source: 'Salesforce',
        }),
      });
    });
  });
});
