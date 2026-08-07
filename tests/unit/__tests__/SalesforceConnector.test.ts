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
  let mockOutboundGovernance: ReturnType<typeof createMockOutboundGovernanceService>;

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
    // Shape-based (not hardcoded): existing tests reject plain Errors with no
    // `.isAxiosError` property (still false/falsy, matching the previous
    // auto-mocked no-op default), while the Task 4 upsert-propagation tests
    // craft axios-error-shaped fixtures that need this to resolve true.
    mockedAxios.isAxiosError.mockImplementation((error: unknown) =>
      Boolean(error && (error as Record<string, unknown>).isAxiosError));

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

    mockOutboundGovernance = createMockOutboundGovernanceService();
    salesforceConnector = new SalesforceConnector('test-system', mockLogger, mockAuthService, mockOutboundGovernance);

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

  /**
   * Task 4 (2026-07-27 NetSuite serialized-asset sync plan): live describe,
   * exact Product2 lookup, and Asset External ID upsert capabilities.
   */
  describe('describeSObject', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('parses field and object-level describe metadata via GET /sobjects/{type}/describe', async () => {
      const rawDescribe = {
        name: 'Asset',
        createable: true,
        updateable: true,
        queryable: true,
        fields: [
          {
            name: 'SerialNumber',
            type: 'string',
            createable: true,
            updateable: true,
            queryable: true,
            externalId: false,
            unique: false,
          },
          {
            name: 'External_Id__c',
            type: 'string',
            createable: true,
            updateable: true,
            queryable: true,
            externalId: true,
            unique: true,
          },
          {
            name: 'Product2Id',
            type: 'reference',
            createable: true,
            updateable: true,
            queryable: true,
            externalId: false,
            unique: false,
            referenceTo: ['Product2'],
          },
          // malformed entry (no name) must be dropped, not thrown on.
          { type: 'string' },
        ],
      };
      mockAxiosInstance.request.mockResolvedValue({ data: rawDescribe });

      const result = await salesforceConnector.describeSObject('Asset');

      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/sobjects/Asset/describe' }),
      );
      expect(result.name).toBe('Asset');
      expect(result.createable).toBe(true);
      expect(result.updateable).toBe(true);
      expect(result.queryable).toBe(true);
      expect(result.fields).toHaveLength(3);
      expect(result.fields.find((f) => f.name === 'External_Id__c')).toEqual(
        expect.objectContaining({ externalId: true, unique: true }),
      );
      expect(result.fields.find((f) => f.name === 'Product2Id')?.referenceTo).toEqual(['Product2']);
    });

    it('returns empty fields (never throws) for a malformed/non-object describe response', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: null });

      const result = await salesforceConnector.describeSObject('Product2');

      expect(result.fields).toEqual([]);
      expect(result.name).toBe('Product2');
      expect(result.createable).toBe(false);
    });

    /**
     * Task 6 readiness reads every one of these flags to decide activation, so
     * a non-boolean or absent value must normalize to FALSE (never truthy) and
     * a non-string `referenceTo` entry must be dropped. Anything else would let
     * a malformed describe response silently satisfy a readiness check.
     */
    it('normalizes absent / non-boolean object- and field-level flags to false (fail-closed)', async () => {
      mockAxiosInstance.request.mockResolvedValue({
        data: {
          name: 'Asset',
          createable: 'true',
          updateable: 1,
          // queryable absent entirely
          fields: [
            {
              name: 'Legacy_Key__c',
              type: 'string',
              createable: 'yes',
              updateable: null,
              queryable: undefined,
              externalId: 'true',
              unique: 1,
              referenceTo: ['Product2', 42, null, 'Pricebook2'],
            },
          ],
        },
      });

      const result = await salesforceConnector.describeSObject('Asset');

      expect(result.createable).toBe(false);
      expect(result.updateable).toBe(false);
      expect(result.queryable).toBe(false);
      expect(result.fields[0]).toEqual({
        name: 'Legacy_Key__c',
        type: 'string',
        createable: false,
        updateable: false,
        queryable: false,
        externalId: false,
        unique: false,
        referenceTo: ['Product2', 'Pricebook2'],
      });
    });

    it('defaults referenceTo to an empty array when the describe omits or malforms it', async () => {
      mockAxiosInstance.request.mockResolvedValue({
        data: {
          name: 'Product2',
          queryable: true,
          fields: [
            { name: 'SKU__c', type: 'string', externalId: true, unique: true, queryable: true },
            { name: 'Broken__c', type: 'reference', referenceTo: 'Product2' },
          ],
        },
      });

      const result = await salesforceConnector.describeSObject('Product2');

      expect(result.queryable).toBe(true);
      expect(result.fields.find((f) => f.name === 'SKU__c')).toEqual(
        expect.objectContaining({ externalId: true, unique: true, queryable: true, referenceTo: [] }),
      );
      expect(result.fields.find((f) => f.name === 'Broken__c')?.referenceTo).toEqual([]);
    });
  });

  describe('findProduct2ByExternalId', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
    });

    it('builds an exact SOQL query and returns matched rows', async () => {
      mockAxiosInstance.request.mockResolvedValue({
        data: { records: [{ Id: '01t000000000001AAA' }] },
      });

      const result = await salesforceConnector.findProduct2ByExternalId('SKU__c', 'ITEM-001');

      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/query',
          params: { q: "SELECT Id FROM Product2 WHERE SKU__c = 'ITEM-001'" },
        }),
      );
      expect(result).toEqual([{ Id: '01t000000000001AAA' }]);
    });

    it('escapes single quotes and backslashes in the lookup value (dedicated SOQL escape, not URL-encoding)', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: { records: [] } });

      await salesforceConnector.findProduct2ByExternalId('SKU__c', "O'Brien\\Item");

      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { q: "SELECT Id FROM Product2 WHERE SKU__c = 'O\\'Brien\\\\Item'" },
        }),
      );
    });

    it('rejects an invalid field identifier before building any query', async () => {
      await expect(
        salesforceConnector.findProduct2ByExternalId('Bad Field; DROP', 'ITEM-001'),
      ).rejects.toThrow();

      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
    });

    it('returns zero rows for no matches', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: { records: [] } });

      const result = await salesforceConnector.findProduct2ByExternalId('SKU__c', 'MISSING');

      expect(result).toEqual([]);
    });
  });

  describe('upsert (Asset External ID)', () => {
    beforeEach(async () => {
      await salesforceConnector.initialize(mockAuthConfig);
      (salesforceConnector as any).isAuthenticated = true;
      salesforceConnector.maxRetries = 1;
    });

    it('rejects any entity type other than the exact literal Asset', async () => {
      await expect(
        salesforceConnector.upsert('Account', 'External_Id__c', 'EXT-1', {}),
      ).rejects.toThrow();
      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
    });

    it('rejects a lowercase "asset" — the gate is an exact literal match, not case-insensitive', async () => {
      await expect(
        salesforceConnector.upsert('asset', 'External_Id__c', 'EXT-1', {}),
      ).rejects.toThrow();
      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
    });

    it('rejects "Asset " (trailing whitespace) — no trimming/normalization of entityType', async () => {
      await expect(
        salesforceConnector.upsert('Asset ', 'External_Id__c', 'EXT-1', {}),
      ).rejects.toThrow();
      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
    });

    it('rejects an invalid external-id field identifier', async () => {
      await expect(
        salesforceConnector.upsert('Asset', 'Bad Field', 'EXT-1', {}),
      ).rejects.toThrow();
      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
    });

    it('sends a PATCH to the exact External ID path, URL-encoding the value', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {}, status: 204, headers: {} });

      await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT/1 2', { SerialNumber: 'SN-1' });

      expect(mockAxiosInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          url: '/sobjects/Asset/External_Id__c/EXT%2F1%202',
          data: { SerialNumber: 'SN-1' },
        }),
      );
    });

    it('classifies 201 as created and surfaces the returned id', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: { id: 'a1x00000000001' }, status: 201, headers: {} });

      const result = await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' });

      expect(result).toEqual({ outcome: 'created', id: 'a1x00000000001' });
    });

    it('classifies a malformed 201 body (no id) as created with no id', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: null, status: 201, headers: {} });

      const result = await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' });

      expect(result).toEqual({ outcome: 'created', id: undefined });
    });

    it('classifies 204 as updated', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: '', status: 204, headers: {} });

      const result = await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' });

      expect(result).toEqual({ outcome: 'updated' });
    });

    it('classifies any other documented success status as unknown', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {}, status: 200, headers: {} });

      const result = await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' });

      expect(result).toEqual({ outcome: 'unknown' });
    });

    it('routes the payload through validateOutboundWrite without placing the External ID in governance metadata', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {}, status: 204, headers: {} });

      await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-SECRET-1', { SerialNumber: 'SN-1' });

      expect(mockOutboundGovernance.validateConnectorWrite).toHaveBeenCalledTimes(1);
      const [payloadArg, ctxArg] = mockOutboundGovernance.validateConnectorWrite.mock.calls[0];
      expect(payloadArg).toEqual({ SerialNumber: 'SN-1' });
      expect((ctxArg as { resourceId?: string }).resourceId).toBeUndefined();
      expect(JSON.stringify(ctxArg)).not.toContain('EXT-SECRET-1');
    });

    it('never logs the External ID value or payload', async () => {
      mockAxiosInstance.request.mockResolvedValue({ data: {}, status: 204, headers: {} });

      await salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-SECRET-2', { SerialNumber: 'SN-SECRET' });

      const allLogCalls = JSON.stringify([
        ...mockLogger.debug.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls,
      ]);
      expect(allLogCalls).not.toContain('EXT-SECRET-2');
      expect(allLogCalls).not.toContain('SN-SECRET');
    });

    it('propagates a 401 as an authentication failure', async () => {
      const axiosLikeError = {
        isAxiosError: true,
        message: 'Request failed with status code 401',
        response: { status: 401, data: {} },
        config: {},
      };
      mockAxiosInstance.request.mockRejectedValue(axiosLikeError);

      await expect(
        salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' }),
      ).rejects.toThrow();
    });

    it('propagates a 403 as an access-forbidden failure', async () => {
      const axiosLikeError = {
        isAxiosError: true,
        message: 'Request failed with status code 403',
        response: { status: 403, data: {} },
        config: {},
      };
      mockAxiosInstance.request.mockRejectedValue(axiosLikeError);

      await expect(
        salesforceConnector.upsert('Asset', 'External_Id__c', 'EXT-1', { SerialNumber: 'SN-1' }),
      ).rejects.toThrow();
    });
  });
});
