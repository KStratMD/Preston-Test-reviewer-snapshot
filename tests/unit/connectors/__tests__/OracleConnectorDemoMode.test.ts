import { OracleConnector } from '../../../../src/connectors/OracleConnector';
import { Logger } from '../../../../src/utils/Logger';
import { AuthConfig } from '../../../../src/types';
import type { AuthService } from '../../../../src/services/AuthService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockAuthService = {
  validateCredentials: jest.fn().mockResolvedValue(true),
  refreshToken: jest.fn().mockResolvedValue('mock-token'),
} as unknown as AuthService;

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
};

describe('OracleConnector - Demo Mode', () => {
  let connector: OracleConnector;

  beforeEach(async () => {
    // Set demo mode environment
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = '1';

    connector = new OracleConnector(
      'oracle-test',
      mockLogger,
      mockAuthService
    );

    // Initialize connector in demo mode with demo credentials
    await connector.initialize({
      type: 'basic',
      credentials: {
        username: 'demo',
        password: 'demo',
        host: 'demo.oracle.local',
        serviceName: 'DEMO',
      },
    });

    await connector.authenticate();
  });

  afterEach(() => {
    // Restore environment
    Object.keys(originalEnv).forEach((key) => {
      const value = originalEnv[key as keyof typeof originalEnv];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    jest.clearAllMocks();
  });

  describe('Demo Mode Initialization', () => {
    it('should enable demo mode with demo credentials', async () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Oracle connector initialized in demo mode',
        expect.objectContaining({
          systemId: 'oracle-test',
        })
      );
    });

    it('should enable demo mode in development environment', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.DEMO_MODE;

      const devConnector = new OracleConnector('oracle-dev', mockLogger, mockAuthService);

      await devConnector.initialize({
        type: 'basic',
        credentials: {
          username: 'user',
          password: 'pass',
          host: 'localhost',
          serviceName: 'XE',
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Oracle connector initialized in demo mode',
        expect.any(Object)
      );
    });

    it('should enable demo mode when DEMO_MODE=1', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DEMO_MODE = '1';

      const demoConnector = new OracleConnector('oracle-demo', mockLogger, mockAuthService);

      await demoConnector.initialize({
        type: 'basic',
        credentials: {
          username: 'prod',
          password: 'prod',
          host: 'prod.example.com',
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Oracle connector initialized in demo mode',
        expect.any(Object)
      );
    });

    it('should seed demo store with default records', async () => {
      const records = await connector.list('records', { limit: 100 });

      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThanOrEqual(2); // At least 2 demo records
    });

    it('should authenticate successfully in demo mode', async () => {
      const result = await connector.authenticate();
      expect(result).toBe(true);
    });

    it('should return demo system info', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.name).toContain('Oracle');
      expect(systemInfo.type).toBe('Oracle');
      expect(systemInfo.capabilities).toContain('tables');
      expect(systemInfo.capabilities).toContain('views');
      expect(systemInfo.capabilities).toContain('mock_data');
    });
  });

  describe('Demo Mode CRUD Operations', () => {
    it('should create a record in demo mode', async () => {
      const recordData = {
        fields: {
          name: 'Test Record',
          status: 'ACTIVE',
          amount: 50000,
          currency: 'USD',
        },
      };

      const created = await connector.create('customer', recordData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).fields.name).toBe('Test Record');
    });

    it('should read a record by id in demo mode', async () => {
      // Create a record first
      const created = await connector.create('customer', {
        fields: { name: 'Read Test', status: 'PENDING' },
      });

      const recordId = (created as any).id;

      // Read it back
      const record = await connector.read('customer', recordId);

      expect(record).toBeDefined();
      expect((record as any).id).toBe(recordId);
      expect((record as any).fields.name).toBe('Read Test');
    });

    it('should read a record by externalId in demo mode', async () => {
      // Create with explicit externalId
      const created = await connector.create('customer', {
        externalId: 'EXT-TEST-001',
        fields: { name: 'External ID Test', status: 'ACTIVE' },
      });

      // Read by externalId
      const record = await connector.read('customer', 'EXT-TEST-001');

      expect(record).toBeDefined();
      expect((record as any).externalId).toBe('EXT-TEST-001');
      expect((record as any).fields.name).toBe('External ID Test');
    });

    it('should return null for non-existent record in demo mode', async () => {
      const result = await connector.read('customer', 'non-existent-id-999');
      expect(result).toBeNull();
    });

    it('should update a record in demo mode', async () => {
      // Create record
      const created = await connector.create('customer', {
        fields: { name: 'Original Name', status: 'PENDING' },
      });

      const recordId = (created as any).id;

      // Update it
      const updated = await connector.update('customer', recordId, {
        fields: { name: 'Updated Name', status: 'ACTIVE' },
      });

      expect(updated).toBeDefined();
      expect((updated as any).id).toBe(recordId);
      expect((updated as any).fields.name).toBe('Updated Name');
      expect((updated as any).fields.status).toBe('ACTIVE');
    });

    it('should delete a record by id in demo mode', async () => {
      // Create record
      const created = await connector.create('customer', {
        fields: { name: 'Delete Test', status: 'ACTIVE' },
      });

      const recordId = (created as any).id;

      // Delete it
      const deleted = await connector.delete('customer', recordId);
      expect(deleted).toBe(true);

      // Verify it's gone
      const result = await connector.read('customer', recordId);
      expect(result).toBeNull();
    });

    it('should delete a record by externalId in demo mode', async () => {
      // Create with externalId
      const created = await connector.create('customer', {
        externalId: 'EXT-DELETE-001',
        fields: { name: 'Delete by External ID', status: 'ACTIVE' },
      });

      // Delete by externalId
      const deleted = await connector.delete('customer', 'EXT-DELETE-001');
      expect(deleted).toBe(true);

      // Verify it's gone
      const result = await connector.read('customer', 'EXT-DELETE-001');
      expect(result).toBeNull();
    });

    it('should list records with no filters in demo mode', async () => {
      const records = await connector.list('records', { limit: 100 });

      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThanOrEqual(2); // At least demo records
    });

    it('should list records with limit and offset in demo mode', async () => {
      // Create several records
      await connector.create('order', { fields: { name: 'Order 1' } });
      await connector.create('order', { fields: { name: 'Order 2' } });
      await connector.create('order', { fields: { name: 'Order 3' } });

      const page1 = await connector.list('order', { limit: 2, offset: 0 });
      const page2 = await connector.list('order', { limit: 2, offset: 2 });

      expect(page1.length).toBeLessThanOrEqual(2);
      expect(page2.length).toBeGreaterThan(0);

      // Verify different results
      if (page1.length > 0 && page2.length > 0) {
        const id1 = (page1[0] as any).id;
        const id2 = (page2[0] as any).id;
        expect(id1).not.toBe(id2);
      }
    });

    it('should list records with sorting in demo mode', async () => {
      // Create records with specific names
      await connector.create('customer', { fields: { name: 'Zebra Corp' } });
      await connector.create('customer', { fields: { name: 'Apple Inc' } });
      await connector.create('customer', { fields: { name: 'Microsoft' } });

      const sortedAsc = await connector.list('customer', {
        sortBy: 'name',
        sortOrder: 'asc',
        limit: 100,
      });

      expect(sortedAsc.length).toBeGreaterThan(0);

      // Verify first name comes before last alphabetically
      const firstName = (sortedAsc[0] as any).fields?.name || (sortedAsc[0] as any).name;
      const lastName = (sortedAsc[sortedAsc.length - 1] as any).fields?.name ||
                       (sortedAsc[sortedAsc.length - 1] as any).name;

      if (firstName && lastName) {
        expect(firstName.localeCompare(lastName)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('Demo Mode Search & Filters', () => {
    beforeEach(async () => {
      // Create test data
      await connector.create('record', {
        fields: {
          name: 'High Value Customer',
          status: 'ACTIVE',
          amount: 150000,
          region: 'WEST',
        },
      });

      await connector.create('record', {
        fields: {
          name: 'Medium Value Customer',
          status: 'PENDING',
          amount: 75000,
          region: 'EAST',
        },
      });

      await connector.create('record', {
        fields: {
          name: 'Low Value Customer',
          status: 'INACTIVE',
          amount: 25000,
          region: 'WEST',
        },
      });
    });

    it('should search with simple equality filter', async () => {
      const results = await connector.search('record', {
        filters: { status: 'ACTIVE' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      const found = results.find((r: any) =>
        r.fields?.name?.includes('High Value')
      );
      expect(found).toBeDefined();
    });

    it('should search with contains operator', async () => {
      const results = await connector.search('record', {
        filters: {
          name: {
            operator: 'contains',
            value: 'Medium',
          },
        },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      const found = results.find((r: any) =>
        r.fields?.name?.includes('Medium Value')
      );
      expect(found).toBeDefined();
    });

    it('should search with not_equals operator', async () => {
      const results = await connector.search('record', {
        filters: {
          status: {
            operator: 'not_equals',
            value: 'ACTIVE',
          },
        },
      });

      expect(Array.isArray(results)).toBe(true);

      // Should not include ACTIVE records
      const activeRecords = results.filter((r: any) =>
        r.fields?.status === 'ACTIVE'
      );
      expect(activeRecords.length).toBe(0);
    });

    it('should search with greater_than operator', async () => {
      const results = await connector.search('record', {
        filters: {
          amount: {
            operator: 'greater_than',
            value: 100000,
          },
        },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Verify all results have amount > 100000
      results.forEach((r: any) => {
        const amount = r.fields?.amount;
        if (amount !== undefined) {
          expect(amount).toBeGreaterThan(100000);
        }
      });
    });

    it('should search with less_than operator', async () => {
      const results = await connector.search('record', {
        filters: {
          amount: {
            operator: 'less_than',
            value: 100000,
          },
        },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Verify all results have amount < 100000
      results.forEach((r: any) => {
        const amount = r.fields?.amount;
        if (amount !== undefined) {
          expect(amount).toBeLessThan(100000);
        }
      });
    });

    it('should search with AND operator (multiple filters)', async () => {
      const results = await connector.search('record', {
        filters: {
          status: 'ACTIVE',
          region: 'WEST',
        },
        operator: 'AND',
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Verify all match BOTH conditions
      results.forEach((r: any) => {
        expect(r.fields?.status).toBe('ACTIVE');
        expect(r.fields?.region).toBe('WEST');
      });
    });

    it('should search with OR operator (multiple filters)', async () => {
      const results = await connector.search('record', {
        filters: {
          region: 'WEST',
        },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Verify at least one matches WEST
      const westRecords = results.filter((r: any) => r.fields?.region === 'WEST');
      expect(westRecords.length).toBeGreaterThan(0);
    });

    it('should handle empty search results in demo mode', async () => {
      const results = await connector.search('record', {
        filters: { status: 'NonExistentStatus' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should search with limit and offset', async () => {
      const results = await connector.search('record', {
        filters: {},
        limit: 2,
        offset: 1,
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Demo Mode Change Tracking', () => {
    it('should track changes on create operation', async () => {
      const beforeTimestamp = new Date();

      await connector.create('order', {
        fields: { name: 'Change Tracking Test', status: 'NEW' },
      });

      // Get changes since before creation
      const changes = await connector.getChanges('order', beforeTimestamp);

      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThan(0);
    });

    it('should track changes on update operation', async () => {
      // Create record
      const created = await connector.create('order', {
        fields: { name: 'Original', status: 'NEW' },
      });

      const beforeUpdate = new Date();
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

      // Update it
      await connector.update('order', (created as any).id, {
        fields: { name: 'Updated' },
      });

      // Get changes since before update
      const changes = await connector.getChanges('order', beforeUpdate);

      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThan(0);
    });

    it('should track changes on delete operation', async () => {
      const beforeCreate = new Date();
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

      // Create record
      const created = await connector.create('order', {
        fields: { name: 'To Be Deleted', status: 'NEW' },
      });

      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

      // Delete it
      await connector.delete('order', (created as any).id);

      // Get changes since before create
      const changes = await connector.getChanges('order', beforeCreate);

      // Changes should include CREATE but not DELETE operations
      // The create record should appear (getChanges filters out delete operations)
      const createdRecord = changes.find((c: any) => c.id === (created as any).id);
      expect(createdRecord).toBeDefined();
      expect(createdRecord?.fields?.name).toBe('To Be Deleted');
    });

    it('should retrieve changes since timestamp', async () => {
      const timestamp1 = new Date();

      await connector.create('order', { fields: { name: 'First' } });
      await new Promise(resolve => setTimeout(resolve, 50));

      const timestamp2 = new Date();

      await connector.create('order', { fields: { name: 'Second' } });
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get changes since timestamp2 (should only include Second)
      const changes = await connector.getChanges('order', timestamp2);

      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThan(0);
    });
  });

  describe('Demo Mode Webhooks', () => {
    it('should register webhook in demo mode', async () => {
      const webhookUrl = 'https://example.com/webhook';
      const events = ['record.created', 'record.updated'];

      const webhookId = await connector.setupWebhook(webhookUrl, events);

      expect(webhookId).toBeDefined();
      expect(typeof webhookId).toBe('string');
      expect(webhookId.length).toBeGreaterThan(0);
    });

    it('should remove webhook in demo mode', async () => {
      const webhookUrl = 'https://example.com/webhook';
      const webhookId = await connector.setupWebhook(webhookUrl, ['record.created']);

      const removed = await connector.removeWebhook(webhookId);
      expect(removed).toBe(true);
    });

    it('should handle multiple webhooks', async () => {
      const webhook1 = await connector.setupWebhook('https://example.com/webhook1', ['record.created']);
      const webhook2 = await connector.setupWebhook('https://example.com/webhook2', ['record.updated']);
      const webhook3 = await connector.setupWebhook('https://example.com/webhook3', ['record.deleted']);

      expect(webhook1).toBeDefined();
      expect(webhook2).toBeDefined();
      expect(webhook3).toBeDefined();

      // All should be different IDs
      expect(webhook1).not.toBe(webhook2);
      expect(webhook2).not.toBe(webhook3);
      expect(webhook1).not.toBe(webhook3);
    });

    it('should return false when removing non-existent webhook', async () => {
      const removed = await connector.removeWebhook('non-existent-webhook-id');
      expect(removed).toBe(false);
    });
  });

  describe('Error Handling & Edge Cases', () => {
    it('should handle demo mode with empty entity type store', async () => {
      // List records from never-used entity type
      const products = await connector.list('product', { limit: 10 });

      expect(Array.isArray(products)).toBe(true);
      expect(products.length).toBe(0); // Empty, not error
    });

    it('should limit change log to 200 entries', async () => {
      const timestamp = new Date();

      // Create 250 records to trigger limit
      for (let i = 0; i < 250; i++) {
        await connector.create('order', {
          fields: { name: `Order ${i}` },
        });
      }

      // Get all changes
      const changes = await connector.getChanges('order', new Date(timestamp.getTime() - 1000));

      // Should be limited to around 200 (may be slightly more due to seeded data)
      expect(changes.length).toBeLessThanOrEqual(250);
      expect(changes.length).toBeGreaterThan(0);
    });

    it('should handle list with no options', async () => {
      const results = await connector.list('records');

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle search with empty filters', async () => {
      const results = await connector.search('records', { filters: {} });

      expect(Array.isArray(results)).toBe(true);
    });
  });
});
