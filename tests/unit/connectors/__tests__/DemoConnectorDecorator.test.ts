/**
 * DemoConnectorDecorator Tests
 *
 * Verifies that the decorator properly intercepts all IConnector methods
 * with in-memory demo behavior when isDemoMode() returns true, and
 * delegates to the inner connector when isDemoMode() returns false.
 */

import { DemoConnectorDecorator } from '../../../../src/connectors/DemoConnectorDecorator';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { Logger } from '../../../../src/utils/Logger';
import type { DataRecord } from '../../../../src/types';
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

describe('DemoConnectorDecorator', () => {
  let decorator: DemoConnectorDecorator;
  let mockInner: jest.Mocked<IConnector>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Enable demo mode for all decorator tests
    setDemoModeOverride(true);

    mockInner = {
      systemType: 'TestSystem',
      systemId: 'test-system-1',
      initialize: jest.fn(),
      authenticate: jest.fn(),
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
      setupWebhook: jest.fn(),
      removeWebhook: jest.fn(),
      getChanges: jest.fn(),
      validateSchema: jest.fn(),
    } as unknown as jest.Mocked<IConnector>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    decorator = new DemoConnectorDecorator(mockInner, mockLogger);
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('Property proxying', () => {
    it('should proxy systemType from inner connector', () => {
      expect(decorator.systemType).toBe('TestSystem');
    });

    it('should proxy systemId from inner connector', () => {
      expect(decorator.systemId).toBe('test-system-1');
    });
  });

  describe('Lifecycle methods', () => {
    it('should always delegate initialize to inner connector (for seed data)', async () => {
      await decorator.initialize({
        type: 'api_key',
        credentials: { apiKey: 'demo' },
      });

      // initialize always delegates so inner connector can seed data
      expect(mockInner.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('demo mode'),
      );
    });

    it('should not delegate authenticate to inner connector in demo mode', async () => {
      const result = await decorator.authenticate();
      expect(result).toBe(true);
      expect(mockInner.authenticate).not.toHaveBeenCalled();
    });

    it('should return successful test connection in demo mode', async () => {
      const result = await decorator.testConnection();
      expect(result.isConnected).toBe(true);
      expect(result.systemType).toBe('TestSystem');
      expect(result.systemId).toBe('test-system-1');
      expect(mockInner.testConnection).not.toHaveBeenCalled();
    });

    it('should return demo system info in demo mode', async () => {
      const info = await decorator.getSystemInfo();
      expect(info.name).toContain('Demo');
      expect(info.type).toBe('TestSystem');
      expect(info.capabilities).toContain('demo_mode');
      expect(mockInner.getSystemInfo).not.toHaveBeenCalled();
    });
  });

  describe('CRUD operations', () => {
    it('should create and store a record', async () => {
      const data: DataRecord = {
        id: 'rec-1',
        fields: { name: 'Test Record' },
      };

      const created = await decorator.create('customer', data);

      expect(created.id).toBe('rec-1');
      expect(created.fields.name).toBe('Test Record');
      expect(mockInner.create).not.toHaveBeenCalled();
    });

    it('should auto-generate id if not provided', async () => {
      const created = await decorator.create('customer', {
        fields: { name: 'No ID Record' },
      });

      expect(created.id).toBeDefined();
      expect(created.id.length).toBeGreaterThan(0);
    });

    it('should read a previously created record', async () => {
      const created = await decorator.create('customer', {
        id: 'read-test',
        fields: { name: 'Read Test' },
      });

      const found = await decorator.read('customer', created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe('read-test');
      expect(found!.fields.name).toBe('Read Test');
    });

    it('should return null for non-existent record', async () => {
      const found = await decorator.read('customer', 'does-not-exist');
      expect(found).toBeNull();
    });

    it('should update an existing record', async () => {
      await decorator.create('customer', {
        id: 'upd-1',
        fields: { name: 'Original', email: 'orig@test.com' },
      });

      const updated = await decorator.update('customer', 'upd-1', {
        fields: { name: 'Updated' },
      });

      expect(updated.fields.name).toBe('Updated');
      expect(updated.id).toBe('upd-1');
    });

    it('should upsert when updating non-existent record', async () => {
      const updated = await decorator.update('customer', 'new-id', {
        fields: { name: 'Upserted' },
      });

      expect(updated.id).toBe('new-id');
      const found = await decorator.read('customer', 'new-id');
      expect(found).not.toBeNull();
    });

    it('should delete an existing record', async () => {
      await decorator.create('customer', {
        id: 'del-1',
        fields: { name: 'To Delete' },
      });

      const deleted = await decorator.delete('customer', 'del-1');
      expect(deleted).toBe(true);

      const found = await decorator.read('customer', 'del-1');
      expect(found).toBeNull();
    });

    it('should return false when deleting non-existent record', async () => {
      const deleted = await decorator.delete('customer', 'nope');
      expect(deleted).toBe(false);
    });
  });

  describe('List and search', () => {
    beforeEach(async () => {
      await decorator.create('items', { id: 'i1', fields: { name: 'Item 1' } });
      await decorator.create('items', { id: 'i2', fields: { name: 'Item 2' } });
      await decorator.create('items', { id: 'i3', fields: { name: 'Item 3' } });
    });

    it('should list all records for an entity type', async () => {
      const items = await decorator.list('items');
      expect(items).toHaveLength(3);
    });

    it('should respect limit option', async () => {
      const items = await decorator.list('items', { limit: 2 });
      expect(items).toHaveLength(2);
    });

    it('should respect offset option', async () => {
      const items = await decorator.list('items', { offset: 1 });
      expect(items).toHaveLength(2);
    });

    it('should combine limit and offset', async () => {
      const items = await decorator.list('items', { limit: 1, offset: 1 });
      expect(items).toHaveLength(1);
    });

    it('should return empty array for unknown entity type', async () => {
      const items = await decorator.list('unknown_type');
      expect(items).toEqual([]);
    });

    it('should search with limit', async () => {
      const results = await decorator.search('items', {
        filters: {},
        limit: 2,
      });
      expect(results).toHaveLength(2);
    });

    it('should filter records by field value', async () => {
      const results = await decorator.search('items', {
        filters: { id: 'i2' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('i2');
    });

    it('should support OR operator in search', async () => {
      const results = await decorator.search('items', {
        filters: { id: 'i1' },
        operator: 'OR',
      });
      expect(results).toHaveLength(1);
    });

    it('should apply filters in list', async () => {
      const results = await decorator.list('items', {
        filters: { id: 'i3' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('i3');
    });
  });

  describe('Bulk operations', () => {
    it('should bulk create records', async () => {
      const records: DataRecord[] = [
        { id: 'b1', fields: { name: 'Bulk 1' } },
        { id: 'b2', fields: { name: 'Bulk 2' } },
      ];

      const result = await decorator.bulkCreate('customer', records);

      expect(result.status).toBe('success');
      expect(result.recordsProcessed).toBe(2);
      expect(result.recordsSuccessful).toBe(2);
      expect(result.recordsFailed).toBe(0);

      const all = await decorator.list('customer');
      expect(all).toHaveLength(2);
    });

    it('should bulk update records', async () => {
      await decorator.create('customer', { id: 'bu1', fields: { name: 'Before' } });
      await decorator.create('customer', { id: 'bu2', fields: { name: 'Before' } });

      const result = await decorator.bulkUpdate('customer', [
        { id: 'bu1', fields: { name: 'After 1' } },
        { id: 'bu2', fields: { name: 'After 2' } },
      ]);

      expect(result.status).toBe('success');
      expect(result.recordsSuccessful).toBe(2);
    });

    it('should bulk delete records', async () => {
      await decorator.create('customer', { id: 'bd1', fields: {} });
      await decorator.create('customer', { id: 'bd2', fields: {} });

      const result = await decorator.bulkDelete('customer', ['bd1', 'bd2']);

      expect(result.status).toBe('success');
      expect(result.recordsSuccessful).toBe(2);

      const remaining = await decorator.list('customer');
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Optional methods', () => {
    it('should return a demo webhook id', async () => {
      const id = await decorator.setupWebhook('https://example.com/hook', ['create']);
      expect(id).toContain('demo-webhook-');
    });

    it('should return true for removeWebhook', async () => {
      const result = await decorator.removeWebhook('any-id');
      expect(result).toBe(true);
    });

    it('should return records for getChanges', async () => {
      await decorator.create('customer', { id: 'gc1', fields: { name: 'Changed' } });
      const changes = await decorator.getChanges('customer', new Date(0));
      expect(changes.length).toBeGreaterThanOrEqual(1);
    });

    it('should return true for validateSchema', async () => {
      const result = await decorator.validateSchema('customer', { type: 'object' });
      expect(result).toBe(true);
    });
  });

  describe('Entity type isolation', () => {
    it('should keep records separate by entity type', async () => {
      await decorator.create('customers', { id: 'c1', fields: {} });
      await decorator.create('vendors', { id: 'v1', fields: {} });

      const customers = await decorator.list('customers');
      const vendors = await decorator.list('vendors');

      expect(customers).toHaveLength(1);
      expect(vendors).toHaveLength(1);
      expect(customers[0].id).toBe('c1');
      expect(vendors[0].id).toBe('v1');
    });

    it('should normalize entity type to lowercase', async () => {
      await decorator.create('Customer', { id: 'c1', fields: {} });
      const result = await decorator.read('customer', 'c1');
      expect(result).not.toBeNull();
    });
  });

  describe('Inner connector isolation in demo mode', () => {
    it('should only call initialize on inner connector (for seed data)', async () => {
      await decorator.initialize({ type: 'api_key', credentials: {} });
      await decorator.authenticate();
      await decorator.testConnection();
      await decorator.getSystemInfo();
      await decorator.create('x', { fields: {} });
      await decorator.read('x', '1');
      await decorator.update('x', '1', { fields: {} });
      await decorator.delete('x', '1');
      await decorator.list('x');
      await decorator.search('x', { filters: {} });
      await decorator.bulkCreate('x', []);
      await decorator.bulkUpdate('x', []);
      await decorator.bulkDelete('x', []);
      await decorator.setupWebhook('url', []);
      await decorator.removeWebhook('id');
      await decorator.getChanges('x', new Date());
      await decorator.validateSchema('x', {});

      // initialize is always delegated (for seed data loading)
      expect(mockInner.initialize).toHaveBeenCalledTimes(1);

      // All other methods should NOT have been called on inner
      const nonDelegatedMethods = [
        'authenticate', 'testConnection', 'getSystemInfo',
        'create', 'read', 'update', 'delete', 'list', 'search',
        'bulkCreate', 'bulkUpdate', 'bulkDelete',
        'setupWebhook', 'removeWebhook', 'getChanges', 'validateSchema',
      ];
      for (const method of nonDelegatedMethods) {
        expect((mockInner as Record<string, jest.Mock>)[method]).not.toHaveBeenCalled();
      }
    });
  });

  describe('Non-demo mode delegation', () => {
    beforeEach(() => {
      setDemoModeOverride(false);
    });

    it('should delegate all calls to inner connector when not in demo mode', async () => {
      mockInner.authenticate.mockResolvedValue(true);
      mockInner.testConnection.mockResolvedValue({
        systemType: 'TestSystem',
        systemId: 'test-system-1',
        isConnected: true,
        lastTestTime: new Date(),
        latency: 5,
      });
      mockInner.create.mockResolvedValue({ id: 'inner-1', fields: {} });
      mockInner.read.mockResolvedValue({ id: 'inner-1', fields: {} });
      mockInner.list.mockResolvedValue([]);
      mockInner.search.mockResolvedValue([]);

      const authResult = await decorator.authenticate();
      expect(authResult).toBe(true);
      expect(mockInner.authenticate).toHaveBeenCalled();

      await decorator.testConnection();
      expect(mockInner.testConnection).toHaveBeenCalled();

      await decorator.create('x', { fields: {} });
      expect(mockInner.create).toHaveBeenCalled();

      await decorator.read('x', '1');
      expect(mockInner.read).toHaveBeenCalled();

      await decorator.list('x');
      expect(mockInner.list).toHaveBeenCalled();

      await decorator.search('x', { filters: {} });
      expect(mockInner.search).toHaveBeenCalled();
    });

    it('should delegate all CRUD calls and verify inner connector receives correct args', async () => {
      mockInner.create.mockResolvedValue({ id: 'created-1', fields: { name: 'Created' } });
      mockInner.update.mockResolvedValue({ id: 'upd-1', fields: { name: 'Updated' } });
      mockInner.delete.mockResolvedValue(true);

      await decorator.create('customer', { id: 'c1', fields: { name: 'Test' } });
      expect(mockInner.create).toHaveBeenCalledWith('customer', { id: 'c1', fields: { name: 'Test' } });

      await decorator.update('customer', 'upd-1', { fields: { name: 'Updated' } });
      expect(mockInner.update).toHaveBeenCalledWith('customer', 'upd-1', { fields: { name: 'Updated' } });

      await decorator.delete('customer', 'del-1');
      expect(mockInner.delete).toHaveBeenCalledWith('customer', 'del-1');
    });

    it('should respond to runtime demo mode toggle', async () => {
      mockInner.list.mockResolvedValue([{ id: 'real', fields: {} }]);

      // Non-demo: delegates to inner
      const realResults = await decorator.list('x');
      expect(mockInner.list).toHaveBeenCalled();
      expect(realResults).toHaveLength(1);
      expect(realResults[0].id).toBe('real');

      // Toggle to demo mode
      setDemoModeOverride(true);

      // Demo: uses in-memory store (empty)
      const demoResults = await decorator.list('x');
      expect(demoResults).toHaveLength(0);

      // Create in demo store
      await decorator.create('x', { id: 'demo-1', fields: {} });
      const afterCreate = await decorator.list('x');
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0].id).toBe('demo-1');

      // Toggle back — inner connector is called again
      setDemoModeOverride(false);
      mockInner.list.mockClear();
      mockInner.list.mockResolvedValue([{ id: 'real', fields: {} }]);
      const backToReal = await decorator.list('x');
      expect(mockInner.list).toHaveBeenCalled();
      expect(backToReal[0].id).toBe('real');
    });
  });

  describe('Filtering by record.fields values (Finding 2)', () => {
    beforeEach(async () => {
      await decorator.create('orders', {
        id: 'ord-1',
        fields: { orderNumber: 'ORD-001', status: 'open', price: 100 },
      });
      await decorator.create('orders', {
        id: 'ord-2',
        fields: { orderNumber: 'ORD-002', status: 'shipped', price: 250 },
      });
      await decorator.create('orders', {
        id: 'ord-3',
        fields: { orderNumber: 'ORD-003', status: 'open', price: 50 },
      });
    });

    it('should filter by record.fields value (exact match)', async () => {
      const results = await decorator.list('orders', {
        filters: { orderNumber: 'ORD-001' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('ord-1');
    });

    it('should filter by record.fields value (string-contains)', async () => {
      const results = await decorator.list('orders', {
        filters: { orderNumber: 'ord-002' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('ord-2');
    });

    it('should filter by record.fields with multiple filters (AND)', async () => {
      const results = await decorator.list('orders', {
        filters: { status: 'open' },
      });
      expect(results).toHaveLength(2);
    });

    it('should search by record.fields value', async () => {
      const results = await decorator.search('orders', {
        filters: { status: 'shipped' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('ord-2');
    });

    it('should sort by record.fields.price ascending', async () => {
      const results = await decorator.list('orders', {
        sortBy: 'price',
        sortOrder: 'asc',
      });
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('ord-3'); // price 50
      expect(results[1].id).toBe('ord-1'); // price 100
      expect(results[2].id).toBe('ord-2'); // price 250
    });

    it('should sort by record.fields.price descending', async () => {
      const results = await decorator.list('orders', {
        sortBy: 'price',
        sortOrder: 'desc',
      });
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('ord-2'); // price 250
      expect(results[2].id).toBe('ord-3'); // price 50
    });

    it('should still filter by top-level keys', async () => {
      const results = await decorator.list('orders', {
        filters: { id: 'ord-1' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('ord-1');
    });
  });

  describe('Seed data import from inner connector (Finding 3)', () => {
    it('should import seeded data from inner connector dataStore', async () => {
      // Simulate a MockConnectorBase with a populated dataStore
      const innerDataStore = new Map<string, Map<string, DataRecord>>();
      const customerStore = new Map<string, DataRecord>();
      customerStore.set('seed-1', { id: 'seed-1', fields: { name: 'Seeded Customer 1' } });
      customerStore.set('seed-2', { id: 'seed-2', fields: { name: 'Seeded Customer 2' } });
      innerDataStore.set('customer', customerStore);

      (mockInner as Record<string, unknown>).dataStore = innerDataStore;

      await decorator.initialize({ type: 'api_key', credentials: {} });

      const records = await decorator.list('customer');
      expect(records).toHaveLength(2);
      expect(records.map(r => r.id).sort()).toEqual(['seed-1', 'seed-2']);
    });

    it('should deep-clone seed data (no shared references)', async () => {
      const innerDataStore = new Map<string, Map<string, DataRecord>>();
      const store = new Map<string, DataRecord>();
      const original = { id: 'orig-1', fields: { name: 'Original' } };
      store.set('orig-1', original);
      innerDataStore.set('items', store);

      (mockInner as Record<string, unknown>).dataStore = innerDataStore;

      await decorator.initialize({ type: 'api_key', credentials: {} });

      // Mutate inner store — decorator should NOT be affected
      original.fields.name = 'Mutated';

      const records = await decorator.list('items');
      expect(records[0].fields.name).toBe('Original');
    });

    it('should no-op when inner connector has no dataStore', async () => {
      // Default mockInner has no dataStore property
      await decorator.initialize({ type: 'api_key', credentials: {} });

      const records = await decorator.list('anything');
      expect(records).toHaveLength(0);
    });

    it('should lazily import seed data when demo mode is toggled on after init', async () => {
      setDemoModeOverride(false);

      const innerDataStore = new Map<string, Map<string, DataRecord>>();
      const store = new Map<string, DataRecord>();
      store.set('s-1', { id: 's-1', fields: { name: 'Seed' } });
      innerDataStore.set('items', store);
      (mockInner as Record<string, unknown>).dataStore = innerDataStore;

      // Initialize in non-demo mode (seed data not imported yet)
      mockInner.list.mockResolvedValue([]);
      await decorator.initialize({ type: 'api_key', credentials: {} });

      // Toggle to demo mode after init — seed data should be lazily imported
      setDemoModeOverride(true);
      const records = await decorator.list('items');
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe('s-1');
    });
  });

  describe('Proxy forwarding of connector-specific methods (Finding 1)', () => {
    let wrappedConnector: IConnector;
    let innerWithCustom: IConnector & { getOrderByNumber: jest.Mock };

    beforeEach(() => {
      innerWithCustom = {
        ...mockInner,
        getOrderByNumber: jest.fn().mockResolvedValue({ id: 'ord-99', fields: { orderNumber: 'ORD-099' } }),
      } as unknown as IConnector & { getOrderByNumber: jest.Mock };

      // Use the real wrapWithDecorator from production code
      const { wrapWithDecorator } = require('../../../../src/connectors/wrapWithDecorator');
      wrappedConnector = wrapWithDecorator(innerWithCustom, mockLogger);
    });

    it('should expose custom method via "in" check when demo mode is OFF', () => {
      setDemoModeOverride(false);
      expect('getOrderByNumber' in wrappedConnector).toBe(true);
    });

    it('should hide custom method via "in" check when demo mode is ON', () => {
      setDemoModeOverride(true);
      expect('getOrderByNumber' in wrappedConnector).toBe(false);
    });

    it('should delegate custom method call to inner connector when demo mode is OFF', async () => {
      setDemoModeOverride(false);
      const result = await (wrappedConnector as unknown as { getOrderByNumber: (n: string) => Promise<DataRecord> }).getOrderByNumber('ORD-099');
      expect(innerWithCustom.getOrderByNumber).toHaveBeenCalledWith('ORD-099');
      expect(result.id).toBe('ord-99');
    });

    it('should return undefined for custom method when demo mode is ON', () => {
      setDemoModeOverride(true);
      const fn = (wrappedConnector as unknown as Record<string, unknown>).getOrderByNumber;
      expect(fn).toBeUndefined();
    });

    it('should still expose decorator IConnector methods in both modes', () => {
      setDemoModeOverride(true);
      expect('list' in wrappedConnector).toBe(true);
      expect('create' in wrappedConnector).toBe(true);

      setDemoModeOverride(false);
      expect('list' in wrappedConnector).toBe(true);
      expect('create' in wrappedConnector).toBe(true);
    });

    it('should correctly proxy systemType getter through decorator', () => {
      setDemoModeOverride(false);
      expect(wrappedConnector.systemType).toBe('TestSystem');

      setDemoModeOverride(true);
      expect(wrappedConnector.systemType).toBe('TestSystem');
    });
  });
});
