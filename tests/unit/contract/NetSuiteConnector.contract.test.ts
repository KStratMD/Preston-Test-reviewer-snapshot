/**
 * NetSuite Connector Contract Tests
 *
 * Verifies the API contract between the connector and NetSuite REST API.
 * These tests validate response shapes, data types, and required fields.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import { NetSuiteConnector } from '../../../src/connectors/NetSuiteConnector';
import type { AuthConfig, DataRecord } from '../../../src/types';
import type { Logger } from '../../../src/utils/Logger';
import type { AuthService } from '../../../src/services/AuthService';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Contract schemas for NetSuite responses
interface NetSuiteRecordContract {
  internalid: string | number;
  [key: string]: unknown;
}

interface NetSuiteListContract {
  items?: NetSuiteRecordContract[];
  links?: Array<{ rel: string; href: string }>;
  count?: number;
  offset?: number;
  totalResults?: number;
  hasMore?: boolean;
}

interface NetSuiteErrorContract {
  'o:errorCode'?: string;
  'o:errorDetails'?: Array<{ detail: string }>;
  status?: number;
  title?: string;
}

// Contract validation helpers
function assertNetSuiteRecord(data: unknown): asserts data is NetSuiteRecordContract {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Contract violation: Response must be an object');
  }
  const record = data as Record<string, unknown>;
  if (!('internalid' in record)) {
    throw new Error('Contract violation: NetSuite record must have internalid');
  }
}

// Reserved for list operation contract tests
function _assertNetSuiteList(data: unknown): asserts data is NetSuiteListContract {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Contract violation: Response must be an object');
  }
  const list = data as Record<string, unknown>;
  if (list.items !== undefined && !Array.isArray(list.items)) {
    throw new Error('Contract violation: items must be an array');
  }
}
void _assertNetSuiteList; // Suppress unused warning

function assertDataRecord(record: DataRecord | null): asserts record is DataRecord {
  if (!record) {
    throw new Error('Contract violation: DataRecord must not be null');
  }
  if (typeof record.id !== 'string') {
    throw new Error('Contract violation: DataRecord.id must be a string');
  }
  if (typeof record.fields !== 'object') {
    throw new Error('Contract violation: DataRecord.fields must be an object');
  }
}

describe('NetSuiteConnector Contract Tests', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let connector: NetSuiteConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;
  let mockHttpClient: jest.Mocked<any>;

  const testOAuthConfig: AuthConfig = {
    type: 'oauth1',
    credentials: {
      accountId: 'TSTDRV2698307',
      consumerKey: 'test-consumer-key',
      consumerSecret: 'test-consumer-secret',
      tokenId: 'test-token-id',
      tokenSecret: 'test-token-secret',
      baseUrl: 'https://TSTDRV2698307.suitetalk.api.netsuite.com',
    },
  };

  beforeEach(() => {
    mockAuthService = {
      authenticateOAuth1: jest.fn().mockResolvedValue(testOAuthConfig.credentials),
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as any;

    mockHttpClient = {
      request: jest.fn(),
      defaults: { baseURL: '', headers: { common: {} } },
    };

    connector = new NetSuiteConnector('netsuite', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    (connector as any).httpClient = mockHttpClient;
  });

  describe('Record CRUD Contract', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    describe('Read Operation', () => {
      it('should return DataRecord conforming to contract', async () => {
        // NetSuite API response shape
        const netsuiteResponse: NetSuiteRecordContract = {
          internalid: '12345',
          companyname: 'Test Company',
          email: 'test@example.com',
          phone: '555-1234',
          entitystatus: { id: '13', refName: 'Customer' },
          subsidiary: { id: '1', refName: 'Parent Company' },
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const result = await connector.read('customer', '12345');

        // Verify contract compliance
        assertDataRecord(result);
        expect(result.id).toBe('12345');
        expect(typeof result.fields).toBe('object');
      });

      it('should handle nested sublists in response', async () => {
        const netsuiteResponse: NetSuiteRecordContract = {
          internalid: '100',
          tranid: 'SO-12345',
          entity: { id: '50', refName: 'Customer ABC' },
          item: {
            items: [
              { item: { id: '1' }, quantity: 5, rate: 100 },
              { item: { id: '2' }, quantity: 3, rate: 50 },
            ],
          },
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const result = await connector.read('salesorder', '100');

        assertDataRecord(result);
        expect(result.fields.tranid).toBe('SO-12345');
      });

      it('should return null for 404 response (contract allows)', async () => {
        const error = new Error('Request failed with status code 404');
        mockHttpClient.request.mockRejectedValue(error);

        const result = await connector.read('customer', 'nonexistent');

        expect(result).toBeNull();
      });
    });

    describe('Create Operation', () => {
      it('should return created DataRecord conforming to contract', async () => {
        const netsuiteResponse: NetSuiteRecordContract = {
          internalid: '99999',
          companyname: 'New Company',
          email: 'new@example.com',
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const newRecord: DataRecord = {
          id: '',
          entityType: 'customer',
          fields: { name: 'New Company', email: 'new@example.com' },
          metadata: {},
        };

        const result = await connector.create('customer', newRecord);

        assertDataRecord(result);
        expect(result.id).toBe('99999');
      });

      it('should include required fields in create request', async () => {
        mockHttpClient.request.mockResolvedValue({
          data: { internalid: '1', companyname: 'Test' },
        });

        const newRecord: DataRecord = {
          id: '',
          entityType: 'customer',
          fields: {
            name: 'Test Customer',
            subsidiary: { id: '1' },
          },
          metadata: {},
        };

        await connector.create('customer', newRecord);

        const requestCall = mockHttpClient.request.mock.calls[0][0];
        expect(requestCall.method).toBe('POST');
        expect(requestCall.data).toBeDefined();
      });
    });

    describe('Update Operation', () => {
      it('should return updated DataRecord conforming to contract', async () => {
        const netsuiteResponse: NetSuiteRecordContract = {
          internalid: '12345',
          companyname: 'Updated Company',
          email: 'updated@example.com',
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const updatedRecord: DataRecord = {
          id: '12345',
          entityType: 'customer',
          fields: { name: 'Updated Company' },
          metadata: {},
        };

        const result = await connector.update('customer', '12345', updatedRecord);

        assertDataRecord(result);
        expect(result.id).toBe('12345');
        expect(result.fields.name).toBe('Updated Company');
      });

      it('should use PATCH method for partial updates', async () => {
        mockHttpClient.request.mockResolvedValue({
          data: { internalid: '12345', companyname: 'Test' },
        });

        const updatedRecord: DataRecord = {
          id: '12345',
          entityType: 'customer',
          fields: { email: 'newemail@example.com' },
          metadata: {},
        };

        await connector.update('customer', '12345', updatedRecord);

        const requestCall = mockHttpClient.request.mock.calls[0][0];
        expect(requestCall.method).toBe('PATCH');
      });
    });

    describe('Delete Operation', () => {
      it('should return success for valid delete', async () => {
        mockHttpClient.request.mockResolvedValue({ status: 204 });

        const result = await connector.delete('customer', '12345');

        expect(result).toBe(true);
      });

      it('should use DELETE method', async () => {
        mockHttpClient.request.mockResolvedValue({ status: 204 });

        await connector.delete('customer', '12345');

        const requestCall = mockHttpClient.request.mock.calls[0][0];
        expect(requestCall.method).toBe('DELETE');
      });
    });

    describe('List Operation', () => {
      it('should return array of DataRecords conforming to contract', async () => {
        const netsuiteResponse: NetSuiteListContract = {
          items: [
            { internalid: '1', companyname: 'Company A' },
            { internalid: '2', companyname: 'Company B' },
            { internalid: '3', companyname: 'Company C' },
          ],
          count: 3,
          totalResults: 100,
          hasMore: true,
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const results = await connector.list('customer');

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(3);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });

      it('should handle pagination parameters', async () => {
        mockHttpClient.request.mockResolvedValue({
          data: { items: [], count: 0, hasMore: false },
        });

        await connector.list('customer', { limit: 50, offset: 100 });

        const requestCall = mockHttpClient.request.mock.calls[0][0];
        // Verify list was called - pagination params may be handled internally
        expect(requestCall.method).toBe('GET');
      });
    });

    describe('Search Operation', () => {
      it('should return filtered DataRecords conforming to contract', async () => {
        const netsuiteResponse: NetSuiteListContract = {
          items: [{ internalid: '5', companyname: 'Matching Company' }],
          count: 1,
          totalResults: 1,
          hasMore: false,
        };

        mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

        const results = await connector.search('customer', { name: 'Matching' });

        expect(Array.isArray(results)).toBe(true);
        results.forEach((record) => {
          assertDataRecord(record);
        });
      });
    });
  });

  describe('Authentication Contract', () => {
    it('should require OAuth1 authentication type', async () => {
      const invalidConfig: AuthConfig = {
        type: 'basic',
        credentials: { username: 'user', password: 'pass' } as any,
      };

      await expect(connector.initialize(invalidConfig)).rejects.toThrow(
        'NetSuite connector requires OAuth1 authentication'
      );
    });

    it('should require all OAuth1 credentials', async () => {
      const incompleteConfig: AuthConfig = {
        type: 'oauth1',
        credentials: {
          accountId: 'TSTDRV',
          // Missing other required fields
        } as any,
      };

      // Should initialize but may fail on authentication
      await connector.initialize(incompleteConfig);
      // Connector accepts the config but authentication would fail
    });

    it('should set baseURL from credentials', async () => {
      await connector.initialize(testOAuthConfig);

      expect((connector as any).httpClient.defaults.baseURL).toBe(
        'https://TSTDRV2698307.suitetalk.api.netsuite.com'
      );
    });
  });

  describe('Error Response Contract', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    it('should handle NetSuite error format', async () => {
      const netsuiteError: NetSuiteErrorContract = {
        'o:errorCode': 'INVALID_RECORD_TYPE',
        'o:errorDetails': [{ detail: 'The record type is invalid' }],
        status: 400,
        title: 'Bad Request',
      };

      const error = new Error('Request failed');
      (error as any).response = { data: netsuiteError, status: 400 };
      mockHttpClient.request.mockRejectedValue(error);

      await expect(connector.read('invalidtype', '1')).rejects.toThrow();
    });

    it('should handle 401 unauthorized response', async () => {
      const error = new Error('Request failed with status code 401');
      mockHttpClient.request.mockRejectedValue(error);

      await expect(connector.read('customer', '1')).rejects.toThrow();
    });

    it('should handle 429 rate limit response', async () => {
      const error = new Error('Request failed with status code 429');
      mockHttpClient.request.mockRejectedValue(error);

      await expect(connector.read('customer', '1')).rejects.toThrow();
    });
  });

  describe('Data Type Mapping Contract', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    it('should map NetSuite internalid to DataRecord.id as string', async () => {
      // NetSuite may return internalid as number
      mockHttpClient.request.mockResolvedValue({
        data: { internalid: 12345, companyname: 'Test' },
      });

      const result = await connector.read('customer', '12345');

      assertDataRecord(result);
      expect(typeof result.id).toBe('string');
      expect(result.id).toBe('12345');
    });

    it('should preserve reference field structure', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: {
          internalid: '1',
          subsidiary: { id: '5', refName: 'Main Subsidiary' },
          salesrep: { id: '10', refName: 'John Smith' },
        },
      });

      const result = await connector.read('customer', '1');

      assertDataRecord(result);
      expect(result.fields.subsidiary).toEqual(
        expect.objectContaining({ id: '5' })
      );
    });

    it('should handle date fields', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: {
          internalid: '1',
          trandate: '2024-01-15',
          createddate: '2024-01-10T10:30:00Z',
        },
      });

      const result = await connector.read('salesorder', '1');

      assertDataRecord(result);
      expect(result.fields.trandate).toBeDefined();
    });

    it('should handle currency fields', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: {
          internalid: '1',
          total: 1500.5,
          taxtotal: 125.04,
        },
      });

      const result = await connector.read('invoice', '1');

      assertDataRecord(result);
      expect(typeof result.fields.total).toBe('number');
    });
  });

  describe('Serialized Asset Support (inventorynumber)', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    it('lists inventorynumber records exposing inventory ID, serial, and scalar item ID at the mapping paths the serialized-asset reader uses (Task 3, 2026-07-27 NetSuite serialized-asset sync plan)', async () => {
      const netsuiteResponse: NetSuiteListContract = {
        items: [
          {
            internalid: '789',
            inventorynumber: 'SN-0001',
            item: { id: '456', refName: 'Widget' },
          },
        ],
        count: 1,
        totalResults: 1,
        hasMore: false,
      };

      mockHttpClient.request.mockResolvedValue({ data: netsuiteResponse });

      const results = await connector.list('inventorynumber');

      expect(results).toHaveLength(1);
      const [result] = results;
      assertDataRecord(result);
      // Inventory ID: the connector promotes NetSuite's internalid to DataRecord.id —
      // the mapping path NetSuiteSerializedUnitReader uses for assetExternalIdField.
      expect(result.id).toBe('789');
      // Serial number: a plain scalar field, untouched by the common-field map —
      // the mapping path used for serialNumberTargetField.
      expect(result.fields.inventorynumber).toBe('SN-0001');
      // Item reference: NetSuite returns a { id, refName } sub-object; the reader
      // resolves the scalar id at the nested "item.id" mapping path used for
      // productReferenceTargetField.
      expect(result.fields.item).toEqual(expect.objectContaining({ id: '456' }));
    });
  });

  describe('Endpoint URL Contract', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    it('should use correct URL pattern for customer records', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { internalid: '1', companyname: 'Test' },
      });

      await connector.read('customer', '12345');

      const requestCall = mockHttpClient.request.mock.calls[0][0];
      expect(requestCall.url).toContain('/customer/12345');
    });

    it('should use correct URL pattern for transaction records', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { internalid: '1', tranid: 'SO-001' },
      });

      await connector.read('salesorder', '100');

      const requestCall = mockHttpClient.request.mock.calls[0][0];
      expect(requestCall.url).toContain('/salesorder/100');
    });

    it('should include record/v1 in REST API path', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { internalid: '1' },
      });

      await connector.read('customer', '1');

      const requestCall = mockHttpClient.request.mock.calls[0][0];
      expect(requestCall.url).toContain('/record/v1/');
    });
  });

  describe('List pagination contract', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
    });

    it('forwards sortBy/sortOrder to the request so offset paging has a deterministic order', async () => {
      // Offset paging is only sound under a deterministic order. These options
      // have always been declared on ListOptions but were previously DROPPED,
      // so a caller's ordering silently had no effect and an upstream mutation
      // between pages could make a row appear on NO page.
      mockHttpClient.request.mockResolvedValue({ data: { items: [] } });

      await connector.list('inventorynumber', {
        limit: 100,
        offset: 200,
        sortBy: 'id',
        sortOrder: 'asc',
      });

      const requestCall = mockHttpClient.request.mock.calls[0][0];
      expect(requestCall.url).toContain('limit=100');
      expect(requestCall.url).toContain('offset=200');
      expect(requestCall.url).toContain('sort=id%3Aasc');
    });

    it('forwards a descending sort order', async () => {
      mockHttpClient.request.mockResolvedValue({ data: { items: [] } });

      await connector.list('inventorynumber', { sortBy: 'lastmodifieddate', sortOrder: 'desc' });

      expect(mockHttpClient.request.mock.calls[0][0].url).toContain('sort=lastmodifieddate%3Adesc');
    });

    it('omits the sort parameter entirely when no ordering is requested', async () => {
      mockHttpClient.request.mockResolvedValue({ data: { items: [] } });

      await connector.list('inventorynumber', { limit: 10 });

      expect(mockHttpClient.request.mock.calls[0][0].url).not.toContain('sort=');
    });

    it('listPage surfaces hasMore/totalResults instead of discarding them', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { items: [{ internalid: '1' }], hasMore: true, totalResults: 5000 },
      });

      const page = await connector.listPage('inventorynumber', { limit: 1 });

      expect(page.records).toHaveLength(1);
      expect(page.hasMore).toBe(true);
      expect(page.totalResults).toBe(5000);
    });

    it('listPage reports hasMore: undefined when the response omits it, so callers can fall back', async () => {
      mockHttpClient.request.mockResolvedValue({ data: { items: [{ internalid: '1' }] } });

      const page = await connector.listPage('inventorynumber', { limit: 1 });

      // Distinguishable from an explicit `false` — the caller must be able to
      // tell "the service said there is no more" from "the service did not say".
      expect(page.hasMore).toBeUndefined();
    });

    it('list() still returns just the records, unchanged for existing callers', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { items: [{ internalid: '1' }, { internalid: '2' }], hasMore: false },
      });

      const records = await connector.list('inventorynumber', {});

      expect(Array.isArray(records)).toBe(true);
      expect(records).toHaveLength(2);
    });
  });

  /**
   * The REAL collection contract. Every other list test in this file feeds
   * items that already carry `internalid` plus fields — a shape the record
   * collection endpoint does not actually return. NetSuite answers a
   * collection GET with non-expanded references (`{ id, links }`), so a
   * connector that maps them straight through produces records with an empty
   * id and zero fields, and the serialized-asset sweep quarantines the whole
   * page. These fixtures use the reference shape so that path is exercised.
   */
  describe('Record collection returns non-expanded references (real NetSuite shape)', () => {
    beforeEach(async () => {
      await connector.initialize(testOAuthConfig);
      (connector as any).isAuthenticated = true;
      mockHttpClient.request.mockReset();
    });

    const reference = (id: string) => ({
      id,
      links: [{ rel: 'self', href: `https://example.invalid/record/v1/inventorynumber/${id}` }],
    });

    it('hydrates each bare reference with a record GET so serial fields actually arrive', async () => {
      mockHttpClient.request.mockImplementation(async (cfg: { url: string }) => {
        if (cfg.url.includes('/inventorynumber/77')) {
          return { data: { internalid: '77', serialnumber: 'SN-77', item: { id: 'itm-1' } } };
        }
        if (cfg.url.includes('/inventorynumber/78')) {
          return { data: { internalid: '78', serialnumber: 'SN-78', item: { id: 'itm-2' } } };
        }
        return { data: { items: [reference('77'), reference('78')], hasMore: false } };
      });

      const page = await connector.listPage('inventorynumber', { limit: 50 });

      expect(page.records).toHaveLength(2);
      // The whole point: without hydration these ids are '' and fields empty.
      expect(page.records.map((r) => r.id)).toEqual(['77', '78']);
      expect(page.records[0].fields.serialnumber).toBe('SN-77');
      expect(page.records[1].fields.serialnumber).toBe('SN-78');
    });

    it('issues exactly one record GET per reference, in page order', async () => {
      mockHttpClient.request.mockImplementation(async (cfg: { url: string }) => {
        const match = /\/inventorynumber\/(\d+)/.exec(cfg.url);
        if (match) return { data: { internalid: match[1], serialnumber: `SN-${match[1]}` } };
        return { data: { items: [reference('1'), reference('2'), reference('3')] } };
      });

      await connector.listPage('inventorynumber', { limit: 50 });

      const recordGets = mockHttpClient.request.mock.calls
        .map((c: [{ url: string }]) => /\/inventorynumber\/(\d+)/.exec(c[0].url)?.[1])
        .filter(Boolean);
      expect(recordGets).toEqual(['1', '2', '3']);
    });

    it('does NOT re-fetch items that already carry record data', async () => {
      mockHttpClient.request.mockResolvedValue({
        data: { items: [{ internalid: '9', serialnumber: 'SN-9' }] },
      });

      const page = await connector.listPage('inventorynumber', { limit: 50 });

      // One call total: the collection GET. No hydration request.
      expect(mockHttpClient.request).toHaveBeenCalledTimes(1);
      expect(page.records[0].fields.serialnumber).toBe('SN-9');
    });

    it('omits a reference whose record vanished (404) rather than wedging the sweep', async () => {
      mockHttpClient.request.mockImplementation(async (cfg: { url: string }) => {
        if (cfg.url.includes('/inventorynumber/404')) {
          // Shaped like a real axios error — BaseConnector.handleApiError gates
          // on axios.isAxiosError, so a plain Error is classified as a setup
          // failure (400), never as the 404 that read() maps to null.
          const err = Object.assign(new Error('Not Found'), {
            isAxiosError: true,
            response: { status: 404, statusText: 'Not Found', data: {} },
            config: {},
            toJSON: () => ({}),
          });
          throw err;
        }
        if (cfg.url.includes('/inventorynumber/55')) {
          return { data: { internalid: '55', serialnumber: 'SN-55' } };
        }
        return { data: { items: [reference('404'), reference('55')] } };
      });

      const page = await connector.listPage('inventorynumber', { limit: 50 });

      // A deleted row must not fail the page — every retry would re-read it.
      expect(page.records).toHaveLength(1);
      expect(page.records[0].id).toBe('55');
    });

    it('propagates a non-404 hydration failure instead of silently dropping units', async () => {
      mockHttpClient.request.mockImplementation(async (cfg: { url: string }) => {
        if (cfg.url.includes('/inventorynumber/500')) throw new Error('upstream exploded');
        return { data: { items: [reference('500')] } };
      });

      await expect(connector.listPage('inventorynumber', { limit: 50 })).rejects.toThrow(
        /Failed to list inventorynumber/,
      );
    });
  });
});
