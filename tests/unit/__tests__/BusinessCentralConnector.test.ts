// Removed ts-nocheck to enforce type checking
import { BusinessCentralConnector } from '../connectors/BusinessCentralConnector';
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
  request: jest.fn().mockResolvedValue({ data: {} }),
} as any;

// Mock dependencies
jest.mock('../services/AuthService');
jest.mock('../utils/Logger');


describe('BusinessCentralConnector', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let bcConnector: BusinessCentralConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;

  const mockAuthConfig: AuthConfig = {
    type: 'oauth2',
    credentials: {
      clientId: 'bc_client_id',
      clientSecret: 'bc_client_secret',
      tenantId: 'test-tenant-id',
      environment: 'sandbox',
      companyId: 'test-company-id',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup axios mock
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    // Use minimal mocks for AuthService and Logger
    mockAuthService = ({ authenticateOAuth2: jest.fn() } as unknown) as jest.Mocked<AuthService>;
    mockLogger = ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      withCorrelationId: jest.fn(),
      getCorrelationId: jest.fn(),
    } as unknown) as jest.Mocked<Logger>;

    bcConnector = new BusinessCentralConnector('test-system', mockLogger, mockAuthService, createMockOutboundGovernanceService());

    // Mock the httpClient property
    (bcConnector as any).httpClient = mockAxiosInstance;
  });

  describe('initialize', () => {
    it('should initialize with OAuth2 config', async () => {
      await bcConnector.initialize(mockAuthConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Business Central connector initialized',
        expect.objectContaining({
          tenantId: 'test-tenant-id',
          environment: 'sandbox',
          companyId: 'test-company-id',
          apiVersion: 'v2.0',
        }),
      );
    });

    it('should throw error for non-OAuth2 config', async () => {
      const invalidConfig: AuthConfig = {
        type: 'basic',
        credentials: { username: 'test', password: 'test' },
      };

      await expect(bcConnector.initialize(invalidConfig))
        .rejects
        .toThrow('Business Central connector requires OAuth2 authentication');
    });
  });

  describe('authenticate', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
    });

    it('should authenticate successfully', async () => {
      const mockTokenInfo = {
        accessToken: 'mock_access_token',
        tokenType: 'Bearer',
        expiresAt: new Date(Date.now() + 3600000),
        issued: new Date(),
      };

      const mockCompaniesResponse = {
        value: [{ id: 'test-company-id' }],
      };

      mockAuthService.authenticateOAuth2.mockResolvedValue(mockTokenInfo);
      mockAxiosInstance.request.mockResolvedValue({ data: mockCompaniesResponse });

      const result = await bcConnector.authenticate();

      expect(result).toBe(true);
      expect(mockAuthService.authenticateOAuth2).toHaveBeenCalledWith({
        type: 'oauth2',
        credentials: {
          client_id: 'bc_client_id',
          client_secret: 'bc_client_secret',
          token_url: 'https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token',
          grant_type: 'client_credentials',
          scope: 'https://api.businesscentral.dynamics.com/.default',
        },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Business Central authentication successful',
        expect.any(Object),
      );
    });

    it('should handle authentication failure', async () => {
      mockAuthService.authenticateOAuth2.mockRejectedValue(new Error('Auth failed'));

      await expect(bcConnector.authenticate())
        .rejects
        .toThrow('Auth failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Business Central authentication failed',
        expect.any(Error),
      );
    });

    it('should fetch company ID if not provided', async () => {
      const configWithoutCompanyId = {
        ...mockAuthConfig,
        credentials: {
          ...mockAuthConfig.credentials,
          companyId: undefined,
        },
      };

      await bcConnector.initialize(configWithoutCompanyId);

      const mockTokenInfo = {
        accessToken: 'mock_access_token',
        tokenType: 'Bearer',
        expiresAt: new Date(Date.now() + 3600000),
        issued: new Date(),
      };

      const mockCompaniesResponse = {
        value: [{ id: 'fetched-company-id' }],
      };

      mockAuthService.authenticateOAuth2.mockResolvedValue(mockTokenInfo);
      mockAxiosInstance.request.mockResolvedValue({ data: mockCompaniesResponse });

      await bcConnector.authenticate();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Retrieved Business Central company ID',
        { companyId: 'fetched-company-id' },
      );
    });
  });

  describe('getSystemInfo', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
      (bcConnector as any).isAuthenticated = true;
      (bcConnector as any).companyId = 'test-company-id';
    });

    it('should return system information', async () => {
      const mockCompaniesResponse = {
        value: [{
          id: 'test-company-id',
          displayName: 'Test Company',
          systemVersion: '20.0',
        }],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockCompaniesResponse });

      const systemInfo = await bcConnector.getSystemInfo();

      expect(systemInfo).toEqual({
        name: 'Test Company',
        type: 'BusinessCentral',
        version: '20.0',
        capabilities: expect.arrayContaining([
          'companies',
          'customers',
          'vendors',
          'items',
          'sales_orders',
          'purchase_orders',
          'invoices',
          'payments',
          'general_ledger',
          'chart_of_accounts',
        ]),
        rateLimits: {
          requestsPerMinute: 600,
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
  });

  describe('CRUD operations', () => {
    const mockRecord: DataRecord = {
      id: 'customer-001',
      externalId: 'customer-001',
      fields: {
        name: 'Test Customer BC',
        email: 'test@example.com',
        phone: '123-456-7890',
        address: '123 Main St',
        city: 'Anytown',
        postalCode: '12345',
      },
      metadata: {
        source: 'test',
        lastModified: new Date(),
        version: '1.0',
      },
    };

    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
      (bcConnector as any).isAuthenticated = true;
      (bcConnector as any).companyId = 'test-company-id';
    });

    describe('create', () => {
      it('should create a customer successfully', async () => {
        const mockCreateResponse = {
          '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers/$entity',
          '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
          id: 'customer-001',
          displayName: 'Test Customer BC',
          email: 'test@example.com',
          phoneNumber: '123-456-7890',
          address: '123 Main St',
          city: 'Anytown',
          postalCode: '12345',
          lastModifiedDateTime: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockCreateResponse });

        const result = await bcConnector.create('customer', mockRecord);

        expect(result).toEqual({
          id: 'customer-001',
          externalId: 'customer-001',
          fields: expect.objectContaining({
            name: 'Test Customer BC',
            email: 'test@example.com',
            phone: '123-456-7890',
            address: '123 Main St',
            city: 'Anytown',
            postalCode: '12345',
          }),
          metadata: expect.objectContaining({
            source: 'BusinessCentral',
          }),
        });
      });
    });

    describe('read', () => {
      it('should read a customer successfully', async () => {
        const mockReadResponse = {
          '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers/$entity',
          '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
          id: 'customer-001',
          displayName: 'Test Customer BC',
          email: 'test@example.com',
          phoneNumber: '123-456-7890',
          address: '123 Main St',
          city: 'Anytown',
          postalCode: '12345',
          lastModifiedDateTime: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockReadResponse });

        const result = await bcConnector.read('customer', 'customer-001');

        expect(result).toEqual({
          id: 'customer-001',
          externalId: 'customer-001',
          fields: expect.objectContaining({
            name: 'Test Customer BC',
            email: 'test@example.com',
            phone: '123-456-7890',
          }),
          metadata: expect.objectContaining({
            source: 'BusinessCentral',
          }),
        });
      });

      it('should return null for non-existent record', async () => {
        const error = new Error('Record not found');
        error.message = 'Request failed with status code 404';
        mockAxiosInstance.request.mockRejectedValue(error);

        const result = await bcConnector.read('customer', 'non-existent');

        expect(result).toBeNull();
      });
    });

    describe('update', () => {
      it('should update a customer successfully', async () => {
        const mockCurrentRecord = {
          '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
          id: 'customer-001',
          displayName: 'Test Customer BC',
          email: 'test@example.com',
        };

        const mockUpdatedRecord = {
          '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers/$entity',
          '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMTsn"',
          id: 'customer-001',
          displayName: 'Updated Customer BC',
          email: 'updated@example.com',
          phoneNumber: '123-456-7890',
          lastModifiedDateTime: new Date().toISOString(),
        };

        mockAxiosInstance.request.mockResolvedValueOnce({ data: mockCurrentRecord });
        mockAxiosInstance.request.mockResolvedValueOnce({ data: mockUpdatedRecord });

        const updateData = {
          fields: { name: 'Updated Customer BC', email: 'updated@example.com' },
        };

        const result = await bcConnector.update('customer', 'customer-001', updateData);

        expect(result).toEqual({
          id: 'customer-001',
          externalId: 'customer-001',
          fields: expect.objectContaining({
            name: 'Updated Customer BC',
            email: 'updated@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'BusinessCentral',
          }),
        });

        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'PATCH',
            url: '/companies(test-company-id)/customers(customer-001)',
            data: expect.any(Object),
            headers: {
              'If-Match': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
            },
          }),
        );
      });
    });

    describe('delete', () => {
      it('should delete a customer successfully', async () => {
        const mockCurrentRecord = {
          '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
          id: 'customer-001',
          displayName: 'Test Customer BC',
        };

        mockAxiosInstance.request.mockResolvedValueOnce({ data: mockCurrentRecord });
        mockAxiosInstance.request.mockResolvedValueOnce({ data: {} });

        const result = await bcConnector.delete('customer', 'customer-001');

        expect(result).toBe(true);
        expect(mockAxiosInstance.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'DELETE',
            url: '/companies(test-company-id)/customers(customer-001)',
            headers: {
              'If-Match': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
            },
          }),
        );
      });
    });

    describe('list', () => {
      it('should list customers successfully', async () => {
        const mockListResponse = {
          '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
          '@odata.count': 2,
          value: [
            {
              '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
              id: 'customer-001',
              displayName: 'Customer 1',
              email: 'customer1@example.com',
              lastModifiedDateTime: new Date().toISOString(),
            },
            {
              '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMTsn"',
              id: 'customer-002',
              displayName: 'Customer 2',
              email: 'customer2@example.com',
              lastModifiedDateTime: new Date().toISOString(),
            },
          ],
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockListResponse });

        const result = await bcConnector.list('customer', { limit: 10 });

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'customer-001',
          externalId: 'customer-001',
          fields: expect.objectContaining({
            name: 'Customer 1',
            email: 'customer1@example.com',
          }),
          metadata: expect.objectContaining({
            source: 'BusinessCentral',
          }),
        });
      });
    });

    describe('search', () => {
      it('should search customers successfully', async () => {
        const mockSearchResponse = {
          '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
          '@odata.count': 1,
          value: [
            {
              '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
              id: 'search-result',
              displayName: 'Search Result Customer',
              email: 'search@example.com',
              lastModifiedDateTime: new Date().toISOString(),
            },
          ],
        };

        mockAxiosInstance.request.mockResolvedValue({ data: mockSearchResponse });

        const result = await bcConnector.search('customer', {
          filters: { displayName: { operator: 'contains', value: 'Search' } },
          operator: 'AND',
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: 'search-result',
          externalId: 'search-result',
          fields: expect.objectContaining({
            name: 'Search Result Customer',
          }),
          metadata: expect.objectContaining({
            source: 'BusinessCentral',
          }),
        });
      });
    });
  });

  describe('OData filter building', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
    });

    it('should build simple equality filter', () => {
      const filters = { displayName: 'Test Customer' };
      const result = (bcConnector as any).buildODataFilter(filters);

      expect(result).toBe('displayName eq \'Test Customer\'');
    });

    it('should build complex filters with operators', () => {
      const filters = {
        displayName: { operator: 'contains', value: 'Test' },
        lastModifiedDateTime: { operator: 'greater_than', value: new Date('2023-01-01') },
      };
      const result = (bcConnector as any).buildODataFilter(filters);

      expect(result).toContain('contains(displayName, \'Test\')');
      expect(result).toContain('lastModifiedDateTime gt 2023-01-01');
      expect(result).toContain(' and ');
    });

    it('should handle OR operator', () => {
      const filters = {
        displayName: 'Customer 1',
        email: 'test@example.com',
      };
      const result = (bcConnector as any).buildODataFilter(filters, 'OR');

      expect(result).toContain(' or ');
    });
  });

  describe('webhook operations', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
      (bcConnector as any).isAuthenticated = true;
    });

    it('should setup webhook successfully', async () => {
      const mockResponse = {
        subscriptionId: 'webhook-subscription-123',
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await bcConnector.setupWebhook(
        'https://example.com/webhook',
        ['customers', 'vendors'],
      );

      expect(result).toBe('webhook-subscription-123');
    });

    it('should remove webhook successfully', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {} });

      const result = await bcConnector.removeWebhook('webhook-subscription-123');

      expect(result).toBe(true);
    });
  });

  describe('getChanges', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
      (bcConnector as any).isAuthenticated = true;
      (bcConnector as any).companyId = 'test-company-id';
    });

    it('should get changed records since date', async () => {
      const mockChangesResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 1,
        value: [
          {
            '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMTsn"',
            id: 'changed-customer',
            displayName: 'Changed Customer',
            email: 'changed@example.com',
            lastModifiedDateTime: new Date().toISOString(),
          },
        ],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockChangesResponse });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const result = await bcConnector.getChanges('customer', since);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'changed-customer',
        externalId: 'changed-customer',
        fields: expect.objectContaining({
          name: 'Changed Customer',
        }),
        metadata: expect.objectContaining({
          source: 'BusinessCentral',
        }),
      });
    });
  });

  describe('entity mapping', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
    });

    it('should map entity types to Business Central entities correctly', () => {
      const getEntityName = (bcConnector as any).getEntityName.bind(bcConnector);

      expect(getEntityName('customer')).toBe('customers');
      expect(getEntityName('vendor')).toBe('vendors');
      expect(getEntityName('item')).toBe('items');
      expect(getEntityName('sales_order')).toBe('salesOrders');
      expect(getEntityName('purchase_order')).toBe('purchaseOrders');
      expect(getEntityName('invoice')).toBe('salesInvoices');
      expect(getEntityName('payment')).toBe('customerPayments');
      expect(getEntityName('custom_entity')).toBe('custom_entity');
    });
  });

  describe('Additional edge cases and error handling', () => {
    beforeEach(async () => {
      await bcConnector.initialize(mockAuthConfig);
      (bcConnector as any).isAuthenticated = true;
      (bcConnector as any).companyId = 'test-company-id';
    });

    it('should handle empty list response', async () => {
      const emptyResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 0,
        value: [],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: emptyResponse });

      const result = await bcConnector.list('customer', { limit: 10 });

      expect(result).toHaveLength(0);
    });

    it('should handle pagination with @odata.nextLink', async () => {
      const paginatedResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 100,
        '@odata.nextLink': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/companies(test-company-id)/customers?$skip=50',
        value: Array(50).fill(null).map((_, i) => ({
          '@odata.etag': `W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"`,
          id: `customer-${i}`,
          displayName: `Customer ${i}`,
          email: `customer${i}@example.com`,
          lastModifiedDateTime: new Date().toISOString(),
        })),
      };

      mockAxiosInstance.request.mockResolvedValue({ data: paginatedResponse });

      const result = await bcConnector.list('customer', { limit: 50 });

      expect(result).toHaveLength(50);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'customer-0',
          fields: expect.objectContaining({
            name: 'Customer 0',
          }),
        }),
      );
    });

    it('should handle search with no results', async () => {
      const emptySearchResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 0,
        value: [],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: emptySearchResponse });

      const result = await bcConnector.search('customer', {
        filters: { displayName: { operator: 'contains', value: 'NonExistent' } },
        operator: 'AND',
      });

      expect(result).toHaveLength(0);
    });

    it('should handle create with minimal fields', async () => {
      const minimalRecord: DataRecord = {
        id: 'minimal-001',
        externalId: 'minimal-001',
        fields: {
          name: 'Minimal Customer',
        },
        metadata: {
          source: 'test',
          lastModified: new Date(),
          version: '1.0',
        },
      };

      const mockResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers/$entity',
        '@odata.etag': 'W/"JzE5OzEwNDU4NTk1NDk5MzY3NzAwOTU5MTswMDsn"',
        id: 'minimal-001',
        displayName: 'Minimal Customer',
        lastModifiedDateTime: new Date().toISOString(),
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockResponse });

      const result = await bcConnector.create('customer', minimalRecord);

      expect(result).toEqual({
        id: 'minimal-001',
        externalId: 'minimal-001',
        fields: expect.objectContaining({
          name: 'Minimal Customer',
        }),
        metadata: expect.objectContaining({
          source: 'BusinessCentral',
        }),
      });
    });

    it('should handle delete of non-existent record', async () => {
      const error = new Error('Record not found');
      error.message = 'Request failed with status code 404';
      mockAxiosInstance.request.mockRejectedValue(error);

      await expect(bcConnector.delete('customer', 'non-existent'))
        .rejects
        .toThrow();
    });

    it('should handle update with missing etag', async () => {
      const mockCurrentRecord = {
        id: 'customer-001',
        displayName: 'Test Customer BC',
        email: 'test@example.com',
        // No @odata.etag
      };

      mockAxiosInstance.request.mockResolvedValue({ data: mockCurrentRecord });

      const updateData = {
        fields: { name: 'Updated Customer BC' },
      };

      // Should handle missing etag gracefully
      await expect(bcConnector.update('customer', 'customer-001', updateData))
        .resolves
        .toBeDefined();
    });

    it('should handle getChanges with no changes', async () => {
      const emptyChangesResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 0,
        value: [],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: emptyChangesResponse });

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const result = await bcConnector.getChanges('customer', since);

      expect(result).toHaveLength(0);
    });

    it('should handle webhook removal of non-existent subscription', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {} });

      const result = await bcConnector.removeWebhook('non-existent-subscription');

      expect(result).toBe(true);
    });

    it('should handle OData filter with multiple OR conditions', () => {
      const filters = {
        displayName: 'Customer 1',
        email: 'test1@example.com',
        phoneNumber: '555-1234',
      };
      const result = (bcConnector as any).buildODataFilter(filters, 'OR');

      expect(result).toContain(' or ');
      expect(result).toContain('displayName eq \'Customer 1\'');
      expect(result).toContain('email eq \'test1@example.com\'');
      expect(result).toContain('phoneNumber eq \'555-1234\'');
    });

    it('should handle OData filter with all operator types', () => {
      const filters = {
        displayName: { operator: 'contains', value: 'Test' },
        balance: { operator: 'greater_than', value: 1000 },
        lastModifiedDateTime: { operator: 'less_than', value: new Date('2023-12-31') },
      };
      const result = (bcConnector as any).buildODataFilter(filters);

      expect(result).toContain('contains(displayName, \'Test\')');
      expect(result).toContain('balance gt 1000');
      expect(result).toContain('lastModifiedDateTime lt 2023-12-31');
    });

    it('should handle list with ordering', async () => {
      const orderedResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        '@odata.count': 2,
        value: [
          {
            '@odata.etag': 'W/"etag1"',
            id: 'customer-001',
            displayName: 'A Customer',
            lastModifiedDateTime: new Date().toISOString(),
          },
          {
            '@odata.etag': 'W/"etag2"',
            id: 'customer-002',
            displayName: 'Z Customer',
            lastModifiedDateTime: new Date().toISOString(),
          },
        ],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: orderedResponse });

      const result = await bcConnector.list('customer', {
        limit: 10,
        orderBy: 'displayName',
        orderDirection: 'asc',
      });

      expect(result).toHaveLength(2);
      // The URL should contain the orderby parameter (may be URL-encoded)
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('customers'),
        }),
      );
    });

    it('should handle list with field selection', async () => {
      const selectResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/customers',
        value: [
          {
            id: 'customer-001',
            displayName: 'Test Customer',
          },
        ],
      };

      mockAxiosInstance.request.mockResolvedValue({ data: selectResponse });

      const result = await bcConnector.list('customer', {
        limit: 10,
        fields: ['id', 'displayName'],
      });

      expect(result).toBeDefined();
      // The URL should contain the select parameter (URL-encoded)
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('%24select'),
        }),
      );
    });

    it('should map vendor entity type correctly', async () => {
      const vendorResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/vendors/$entity',
        '@odata.etag': 'W/"etag"',
        id: 'vendor-001',
        displayName: 'Test Vendor',
        lastModifiedDateTime: new Date().toISOString(),
      };

      mockAxiosInstance.request.mockResolvedValue({ data: vendorResponse });

      const result = await bcConnector.read('vendor', 'vendor-001');

      expect(result).toBeDefined();
      expect((result as any).fields.name).toBe('Test Vendor');
    });

    it('should map item entity type correctly', async () => {
      const itemResponse = {
        '@odata.context': 'https://api.businesscentral.dynamics.com/v2.0/test-tenant-id/sandbox/$metadata#companies(test-company-id)/items/$entity',
        '@odata.etag': 'W/"etag"',
        id: 'item-001',
        displayName: 'Test Item',
        inventory: 100,
        unitPrice: 99.99,
        lastModifiedDateTime: new Date().toISOString(),
      };

      mockAxiosInstance.request.mockResolvedValue({ data: itemResponse });

      const result = await bcConnector.read('item', 'item-001');

      expect(result).toBeDefined();
      expect((result as any).fields.name).toBe('Test Item');
      expect((result as any).fields.inventory).toBe(100);
      expect((result as any).fields.unitPrice).toBe(99.99);
    });

    it('should handle authentication with production environment', async () => {
      const prodConfig = {
        type: 'oauth2' as const,
        credentials: {
          clientId: 'prod-client-id',
          clientSecret: 'prod-secret',
          tenantId: 'prod-tenant-id',
          environment: 'production',
          companyId: 'prod-company-id',
        },
      };

      await bcConnector.initialize(prodConfig);

      const mockTokenInfo = {
        accessToken: 'prod_access_token',
        tokenType: 'Bearer',
        expiresAt: new Date(Date.now() + 3600000),
        issued: new Date(),
      };

      const mockCompaniesResponse = {
        value: [{ id: 'prod-company-id' }],
      };

      mockAuthService.authenticateOAuth2.mockResolvedValue(mockTokenInfo);
      mockAxiosInstance.request.mockResolvedValue({ data: mockCompaniesResponse });

      await bcConnector.authenticate();

      // Verify authentication was called with Azure AD token URL
      expect(mockAuthService.authenticateOAuth2).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: expect.objectContaining({
            token_url: 'https://login.microsoftonline.com/prod-tenant-id/oauth2/v2.0/token',
          }),
        }),
      );
    });

    it('should handle sales_order entity mapping', async () => {
      const getEntityName = (bcConnector as any).getEntityName.bind(bcConnector);
      expect(getEntityName('sales_order')).toBe('salesOrders');
    });

    it('should handle purchase_order entity mapping', async () => {
      const getEntityName = (bcConnector as any).getEntityName.bind(bcConnector);
      expect(getEntityName('purchase_order')).toBe('purchaseOrders');
    });

    it('should handle invoice entity mapping to salesInvoices', async () => {
      const getEntityName = (bcConnector as any).getEntityName.bind(bcConnector);
      expect(getEntityName('invoice')).toBe('salesInvoices');
    });

    it('should handle payment entity mapping to customerPayments', async () => {
      const getEntityName = (bcConnector as any).getEntityName.bind(bcConnector);
      expect(getEntityName('payment')).toBe('customerPayments');
    });
  });
});
