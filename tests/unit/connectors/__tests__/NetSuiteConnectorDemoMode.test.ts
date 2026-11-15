/**
 * NetSuite Connector Demo Mode Tests (via DemoConnectorDecorator)
 *
 * Tests that NetSuite connector behavior in demo mode is handled correctly
 * by the DemoConnectorDecorator wrapping pattern introduced in Phase 8.
 *
 * The decorator checks isDemoMode() at runtime — in demo mode it intercepts
 * CRUD with in-memory storage; in non-demo mode it delegates to the inner
 * connector. initialize() always delegates so seed data still loads.
 */

import { DemoConnectorDecorator } from '../../../../src/connectors/DemoConnectorDecorator';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { Logger } from '../../../../src/utils/Logger';
import type { DataRecord } from '../../../../src/types';
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

describe('NetSuiteConnector - Demo Mode (via Decorator)', () => {
  let decorator: DemoConnectorDecorator;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(async () => {
    setDemoModeOverride(true);

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    // Use a mock IConnector with NetSuite-like identity.
    // initialize() always delegates to the inner connector (for seed data),
    // so we use a mock to avoid requiring real OAuth1 credentials.
    const mockInner: IConnector = {
      systemType: 'NetSuite',
      systemId: 'netsuite-test',
      initialize: jest.fn(),
      authenticate: jest.fn().mockResolvedValue(true),
      testConnection: jest.fn(),
      getSystemInfo: jest.fn(),
      create: jest.fn(),
      read: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      search: jest.fn(),
      bulkCreate: jest.fn(),
      bulkUpdate: jest.fn(),
      bulkDelete: jest.fn(),
    } as unknown as IConnector;

    decorator = new DemoConnectorDecorator(mockInner, mockLogger);

    await decorator.initialize({
      type: 'api_key',
      credentials: { apiKey: 'demo-key' },
    });

    await decorator.authenticate();
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('Demo Mode Initialization', () => {
    it('should log demo mode initialization', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('demo mode'),
      );
    });

    it('should authenticate successfully in demo mode', async () => {
      const result = await decorator.authenticate();
      expect(result).toBe(true);
    });

    it('should return demo system info', async () => {
      const systemInfo = await decorator.getSystemInfo();

      expect(systemInfo.name).toContain('NetSuite');
      expect(systemInfo.name).toContain('Demo');
      expect(systemInfo.type).toBe('NetSuite');
      expect(systemInfo.capabilities).toContain('demo_mode');
    });
  });

  describe('Demo Mode CRUD - Customers', () => {
    it('should create a customer in demo mode', async () => {
      const customerData: DataRecord = {
        id: 'CUST-DEMO-001',
        fields: {
          entityId: 'Demo Customer',
          companyName: 'Demo Corp',
          email: 'demo@example.com',
        },
      };

      const created = await decorator.create('customer', customerData);

      expect(created).toBeDefined();
      expect(created.id).toBeDefined();
      expect(created.fields.companyName).toBe('Demo Corp');
    });

    it('should read a customer by id in demo mode', async () => {
      const created = await decorator.create('customer', {
        fields: {
          entityId: 'Read Test',
          companyName: 'Read Test Corp',
        },
      });

      const customer = await decorator.read('customer', created.id);

      expect(customer).toBeDefined();
      expect(customer?.id).toBe(created.id);
      expect(customer?.fields.companyName).toBe('Read Test Corp');
    });

    it('should update a customer in demo mode', async () => {
      const created = await decorator.create('customer', {
        fields: {
          entityId: 'Update Test',
          companyName: 'Original Name',
          email: 'original@example.com',
        },
      });

      const updated = await decorator.update('customer', created.id, {
        fields: {
          companyName: 'Updated Name',
          email: 'original@example.com',
        },
      });

      expect(updated.fields.companyName).toBe('Updated Name');
      expect(updated.fields.email).toBe('original@example.com');
    });

    it('should delete a customer in demo mode', async () => {
      const created = await decorator.create('customer', {
        fields: {
          entityId: 'Delete Test',
          companyName: 'To Be Deleted',
        },
      });

      const result = await decorator.delete('customer', created.id);
      expect(result).toBe(true);

      const deleted = await decorator.read('customer', created.id);
      expect(deleted).toBeNull();
    });

    it('should list customers in demo mode', async () => {
      await decorator.create('customer', {
        fields: { entityId: 'List 1', companyName: 'List Customer 1' },
      });
      await decorator.create('customer', {
        fields: { entityId: 'List 2', companyName: 'List Customer 2' },
      });

      const customers = await decorator.list('customer');

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThanOrEqual(2);
    });

    it('should list customers with limit', async () => {
      await decorator.create('customer', { fields: { entityId: 'L1' } });
      await decorator.create('customer', { fields: { entityId: 'L2' } });

      const customers = await decorator.list('customer', { limit: 1 });
      expect(customers.length).toBeLessThanOrEqual(1);
    });

    it('should list customers with pagination', async () => {
      await decorator.create('customer', { fields: { entityId: 'Page 1' } });
      await decorator.create('customer', { fields: { entityId: 'Page 2' } });
      await decorator.create('customer', { fields: { entityId: 'Page 3' } });

      const page1 = await decorator.list('customer', { limit: 2, offset: 0 });
      const page2 = await decorator.list('customer', { limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBeGreaterThan(0);
    });
  });

  describe('Demo Mode CRUD - Vendors', () => {
    it('should create a vendor in demo mode', async () => {
      const vendorData: DataRecord = {
        fields: {
          entityId: 'Demo Vendor',
          companyName: 'Vendor Corp',
        },
      };

      const created = await decorator.create('vendor', vendorData);

      expect(created).toBeDefined();
      expect(created.fields.companyName).toBe('Vendor Corp');
    });

    it('should read a vendor by id', async () => {
      const created = await decorator.create('vendor', {
        fields: { entityId: 'Vendor Read', companyName: 'Vendor Test' },
      });

      const vendor = await decorator.read('vendor', created.id);
      expect(vendor).toBeDefined();
      expect(vendor?.fields.companyName).toBe('Vendor Test');
    });

    it('should list vendors', async () => {
      await decorator.create('vendor', { fields: { entityId: 'V1' } });
      await decorator.create('vendor', { fields: { entityId: 'V2' } });

      const vendors = await decorator.list('vendor');
      expect(vendors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Demo Mode CRUD - Items', () => {
    it('should create an item in demo mode', async () => {
      const itemData: DataRecord = {
        fields: {
          itemId: 'ITEM-001',
          displayName: 'Demo Item',
          description: 'Demo inventory item',
        },
      };

      const created = await decorator.create('item', itemData);

      expect(created).toBeDefined();
      expect(created.fields.displayName).toBe('Demo Item');
    });

    it('should read an item by id', async () => {
      const created = await decorator.create('item', {
        fields: { itemId: 'ITEM-READ', displayName: 'Read Item' },
      });

      const item = await decorator.read('item', created.id);
      expect(item).toBeDefined();
      expect(item?.fields.displayName).toBe('Read Item');
    });

    it('should list items', async () => {
      await decorator.create('item', { fields: { itemId: 'I1' } });
      await decorator.create('item', { fields: { itemId: 'I2' } });

      const items = await decorator.list('item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Demo Mode Error Handling', () => {
    it('should return null for non-existent customer', async () => {
      const result = await decorator.read('customer', 'NON-EXISTENT');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent customer', async () => {
      const result = await decorator.delete('customer', 'NON-EXISTENT');
      expect(result).toBe(false);
    });

    it('should handle empty entity type', async () => {
      const results = await decorator.list('unknown_entity');
      expect(results).toEqual([]);
    });
  });

  describe('Demo Mode Multiple Entity Types', () => {
    it('should handle customers', async () => {
      const customers = await decorator.list('customer');
      expect(Array.isArray(customers)).toBe(true);
    });

    it('should handle vendors', async () => {
      const vendors = await decorator.list('vendor');
      expect(Array.isArray(vendors)).toBe(true);
    });

    it('should handle items', async () => {
      const items = await decorator.list('item');
      expect(Array.isArray(items)).toBe(true);
    });

    it('should handle transactions', async () => {
      const transactions = await decorator.list('transaction');
      expect(Array.isArray(transactions)).toBe(true);
    });
  });

  describe('Demo Mode Field Preservation', () => {
    it('should preserve all fields on create', async () => {
      const customerData: DataRecord = {
        fields: {
          entityId: 'FIELD-TEST',
          companyName: 'Field Test Corp',
          email: 'field@example.com',
          phone: '555-1234',
          customField1: 'Custom Value 1',
          customField2: 'Custom Value 2',
        },
      };

      const created = await decorator.create('customer', customerData);

      expect(created.fields.entityId).toBe('FIELD-TEST');
      expect(created.fields.companyName).toBe('Field Test Corp');
      expect(created.fields.email).toBe('field@example.com');
      expect(created.fields.customField1).toBe('Custom Value 1');
      expect(created.fields.customField2).toBe('Custom Value 2');
    });

    it('should merge fields on update', async () => {
      const created = await decorator.create('customer', {
        fields: {
          entityId: 'MERGE-TEST',
          companyName: 'Original Name',
          email: 'original@example.com',
          phone: '555-0000',
        },
      });

      const updated = await decorator.update('customer', created.id, {
        fields: {
          companyName: 'Updated Name',
          city: 'New York',
        },
      });

      expect(updated.fields.companyName).toBe('Updated Name');
      expect(updated.fields.city).toBe('New York');
    });
  });
});
