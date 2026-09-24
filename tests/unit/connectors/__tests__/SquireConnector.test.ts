import { SquireConnector } from '../../../../src/connectors/SquireConnector';
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

describe('SquireConnector', () => {
  let connector: SquireConnector;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = '1'; // Enable demo mode for mock connector testing

    connector = new SquireConnector('Squire', 'squire-test', mockLogger, mockAuthService);

    // Initialize connector in demo mode
    await connector.initialize({
      type: 'api_key',
      credentials: { apiKey: 'test-key' },
    });
  });

  afterEach(() => {
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

    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with API key credentials', async () => {
      const newConnector = new SquireConnector('Squire', 'squire-init', mockLogger, mockAuthService);
      const authConfig: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'test-api-key' },
      };

      await newConnector.initialize(authConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Squire realistic business data seeded'),
        expect.any(Object)
      );
    });

    it('should set correct base URL', () => {
      const baseUrl = (connector as any).baseUrl || (connector as any).httpClient?.defaults?.baseURL;
      expect(baseUrl).toContain('squire.mock');
    });

    it('should seed fixture data on initialization', async () => {
      // Verify data was seeded by listing entities
      const customers = await connector.list('customer', { limit: 10 });
      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThan(0);
    });
  });

  describe('getSystemInfo', () => {
    it('should return system capabilities', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo).toBeDefined();
      expect(systemInfo.name).toBe('Squire Mock');
      expect(systemInfo.type).toBe('Squire');
      expect(systemInfo.version).toBe('1.0');
      expect(systemInfo.capabilities).toContain('customers');
      expect(systemInfo.capabilities).toContain('vendors');
      expect(systemInfo.capabilities).toContain('orders');
    });

    it('should return rate limit information', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.rateLimits).toBeDefined();
      expect(systemInfo.rateLimits?.requestsPerMinute).toBe(1000);
      expect(systemInfo.rateLimits?.requestsPerHour).toBe(60000);
      expect(systemInfo.rateLimits?.requestsPerDay).toBe(100000);
    });

    it('should return endpoint URLs', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.endpoints).toBeDefined();
      expect(systemInfo.endpoints?.baseUrl).toContain('squire.mock');
      expect(systemInfo.endpoints?.webhookUrl).toContain('/webhooks');
    });
  });

  describe('CRUD operations - customers', () => {
    it('should list customers from fixture data', async () => {
      const customers = await connector.list('customer', { limit: 5 });

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThan(0);
      expect(customers.length).toBeLessThanOrEqual(5);
    });

    it('should read a specific customer', async () => {
      // First get a valid customer ID from list
      const customers = await connector.list('customer', { limit: 1 });
      expect(customers.length).toBeGreaterThan(0);

      const customerId = (customers[0] as any).id;
      const customer = await connector.read('customer', customerId);

      expect(customer).toBeDefined();
      expect((customer as any).id).toBe(customerId);
    });

    it('should create a new customer', async () => {
      const newCustomer = {
        firstName: 'John',
        lastName: 'Smith',
        email: 'john.smith@example.com',
        phone: '555-0123',
      };

      const created = await connector.create('customer', newCustomer);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).firstName).toBe('John');
      expect((created as any).lastName).toBe('Smith');
    });

    it('should update an existing customer', async () => {
      // First create a customer
      const newCustomer = {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
      };
      const created = await connector.create('customer', newCustomer);
      const customerId = (created as any).id;

      // Now update it
      const updated = await connector.update('customer', customerId, {
        email: 'jane.updated@example.com',
      });

      expect(updated).toBeDefined();
      expect((updated as any).email).toBe('jane.updated@example.com');
    });

    it('should delete a customer', async () => {
      // First create a customer
      const newCustomer = {
        firstName: 'Delete',
        lastName: 'Me',
        email: 'delete@example.com',
      };
      const created = await connector.create('customer', newCustomer);
      const customerId = (created as any).id;

      // Delete it
      const deleteResult = await connector.delete('customer', customerId);
      expect(deleteResult).toBe(true);

      // Verify it's deleted by trying to read it - returns null for non-existent
      const readResult = await connector.read('customer', customerId);
      expect(readResult).toBeNull();
    });
  });

  describe('CRUD operations - vendors/contacts', () => {
    it('should list vendors (stored as contacts)', async () => {
      const vendors = await connector.list('contact', { limit: 5 });

      expect(Array.isArray(vendors)).toBe(true);
      expect(vendors.length).toBeGreaterThan(0);
    });

    it('should read a specific vendor', async () => {
      const vendors = await connector.list('contact', { limit: 1 });
      expect(vendors.length).toBeGreaterThan(0);

      const vendorId = (vendors[0] as any).id;
      const vendor = await connector.read('contact', vendorId);

      expect(vendor).toBeDefined();
      expect((vendor as any).id).toBe(vendorId);
    });
  });

  describe('CRUD operations - products', () => {
    it('should list products from fixture data', async () => {
      const products = await connector.list('product', { limit: 5 });

      expect(Array.isArray(products)).toBe(true);
      expect(products.length).toBeGreaterThan(0);
    });

    it('should create a new product', async () => {
      const newProduct = {
        name: 'Test Product',
        sku: 'TEST-001',
        price: 99.99,
      };

      const created = await connector.create('product', newProduct);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).name).toBe('Test Product');
    });
  });

  describe('CRUD operations - orders', () => {
    it('should list orders from fixture data', async () => {
      const orders = await connector.list('order', { limit: 5 });

      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThan(0);
    });

    it('should read a specific order', async () => {
      const orders = await connector.list('order', { limit: 1 });
      expect(orders.length).toBeGreaterThan(0);

      const orderId = (orders[0] as any).id;
      const order = await connector.read('order', orderId);

      expect(order).toBeDefined();
      expect((order as any).id).toBe(orderId);
    });
  });

  describe('search operations', () => {
    it('should search customers by criteria', async () => {
      // Create a customer with searchable data
      await connector.create('customer', {
        firstName: 'SearchTest',
        lastName: 'User',
        email: 'searchtest@example.com',
      });

      const results = await connector.search('customer', { firstName: 'SearchTest' });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty array or limited results for unlikely matches', async () => {
      const results = await connector.search('customer', { firstName: 'NonExistentName123456' });

      // MockConnectorBase may do partial matching, so accept empty or very few results
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThan(10);
    });
  });

  describe('error handling', () => {
    it('should handle reading non-existent entity gracefully', async () => {
      // MockConnectorBase returns null for non-existent entities instead of throwing
      const result = await connector.read('customer', 'non-existent-id-999');
      expect(result).toBeNull();
    });

    it('should handle updating non-existent entity', async () => {
      // MockConnectorBase may throw or return null for updates on non-existent entities
      await expect(
        connector.update('customer', 'non-existent-id-999', { firstName: 'Test' })
      ).rejects.toThrow();
    });

    it('should handle deleting non-existent entity gracefully', async () => {
      // MockConnectorBase returns false for deleting non-existent entities
      const result = await connector.delete('customer', 'non-existent-id-999');
      expect(result).toBe(false);
    });

    it('should handle invalid entity type gracefully', async () => {
      // MockConnectorBase returns empty array for invalid entity types
      const result = await connector.list('invalid-entity-type' as any, {});
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('data seeding', () => {
    it('should seed customers from fixtures', async () => {
      const customers = await connector.list('customer', { limit: 100 });

      expect(customers.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Squire realistic business data seeded'),
        expect.objectContaining({
          customers: expect.any(Number),
        })
      );
    });

    it('should seed vendors from fixtures', async () => {
      const vendors = await connector.list('contact', { limit: 100 });

      expect(vendors.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Squire realistic business data seeded'),
        expect.objectContaining({
          vendors: expect.any(Number),
        })
      );
    });

    it('should seed products from fixtures', async () => {
      const products = await connector.list('product', { limit: 100 });

      expect(products.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Squire realistic business data seeded'),
        expect.objectContaining({
          products: expect.any(Number),
        })
      );
    });

    it('should seed orders from fixtures', async () => {
      const orders = await connector.list('order', { limit: 100 });

      expect(orders.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Squire realistic business data seeded'),
        expect.objectContaining({
          orders: expect.any(Number),
        })
      );
    });
  });

  describe('pagination', () => {
    it('should support limit parameter', async () => {
      const results1 = await connector.list('customer', { limit: 2 });
      const results2 = await connector.list('customer', { limit: 5 });

      expect(results1.length).toBeLessThanOrEqual(2);
      expect(results2.length).toBeLessThanOrEqual(5);
      expect(results2.length).toBeGreaterThanOrEqual(results1.length);
    });

    it('should support offset parameter', async () => {
      const page1 = await connector.list('customer', { limit: 2, offset: 0 });
      const page2 = await connector.list('customer', { limit: 2, offset: 2 });

      expect(page1.length).toBeGreaterThan(0);
      expect(page2.length).toBeGreaterThan(0);

      // Verify different results (unless there are only 2 customers total)
      const id1 = (page1[0] as any).id;
      const id2 = (page2[0] as any).id;
      expect(id1).not.toBe(id2);
    });
  });

  describe('bulk operations', () => {
    it('should support creating multiple entities', async () => {
      const customer1 = await connector.create('customer', {
        firstName: 'Bulk1',
        lastName: 'Test',
        email: 'bulk1@example.com',
      });

      const customer2 = await connector.create('customer', {
        firstName: 'Bulk2',
        lastName: 'Test',
        email: 'bulk2@example.com',
      });

      expect((customer1 as any).id).not.toBe((customer2 as any).id);
    });
  });

  describe('change tracking', () => {
    it('should track when entities are modified', async () => {
      const created = await connector.create('customer', {
        firstName: 'Track',
        lastName: 'Changes',
        email: 'track@example.com',
      });

      const customerId = (created as any).id;

      await connector.update('customer', customerId, {
        email: 'updated@example.com',
      });

      const updated = await connector.read('customer', customerId);
      expect((updated as any).email).toBe('updated@example.com');
    });
  });
});
