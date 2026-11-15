import { StripeConnector } from '../../../../src/connectors/StripeConnector';
import { Logger } from '../../../../src/utils/Logger';
import { AuthConfig } from '../../../../src/types';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
};

describe('StripeConnector - Demo Mode', () => {
  let connector: StripeConnector;

  beforeEach(async () => {
    // Set demo mode environment
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = '1';

    connector = new StripeConnector('Stripe', 'stripe-test', mockLogger);

    // Initialize connector in demo mode with demo credentials
    await connector.initialize({
      type: 'api_key',
      credentials: {
        apiKey: 'sk_test_demo_key_for_testing',
      },
    });
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
        'Stripe connector initialized in DEMO mode'
      );
    });

    it('should enable demo mode in test environment', async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.DEMO_MODE;

      const testConnector = new StripeConnector('Stripe', 'stripe-env-test', mockLogger);

      await testConnector.initialize({
        type: 'api_key',
        credentials: { apiKey: 'sk_live_normal_key' },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stripe connector initialized in DEMO mode'
      );
    });

    it('should enable demo mode when DEMO_MODE=1', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DEMO_MODE = '1';

      const demoConnector = new StripeConnector('Stripe', 'stripe-demo', mockLogger);

      await demoConnector.initialize({
        type: 'api_key',
        credentials: { apiKey: 'sk_live_normal_key' },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stripe connector initialized in DEMO mode'
      );
    });

    it('should seed demo data with charges and customers', async () => {
      // Demo data is seeded automatically in initialize
      const charges = await connector.list('charge', { limit: 100 });
      const customers = await connector.list('customer', { limit: 100 });

      expect(Array.isArray(charges)).toBe(true);
      expect(charges.length).toBeGreaterThan(0);

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThanOrEqual(2); // At least 2 demo customers
    });

    it('should authenticate successfully in demo mode', async () => {
      const result = await connector.authenticate();

      expect(result).toBe(true);

      // Check that authentication log was made (may be 3rd call after seed + init logs)
      const authCalls = (mockLogger.info as jest.Mock).mock.calls.filter(
        call => call[0] === 'Stripe authentication successful (demo mode)'
      );
      expect(authCalls.length).toBeGreaterThan(0);
    });

    it('should return demo system info', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.name).toBe('Stripe (Demo)');
      expect(systemInfo.type).toBe('Stripe');
      expect(systemInfo.capabilities).toContain('demo_mode');
      expect(systemInfo.capabilities).toContain('transactions');
      expect(systemInfo.capabilities).toContain('customers');
      expect(systemInfo.capabilities).toContain('refunds');
    });
  });

  describe('Demo Mode CRUD Operations', () => {
    it('should create a charge in demo mode', async () => {
      const chargeData = {
        fields: {
          amount: 5000,
          currency: 'usd',
          status: 'succeeded',
          description: 'Test charge for demo',
        },
      };

      const created = await connector.create('charge', chargeData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).id).toContain('charge_demo_');
      expect((created as any).fields.amount).toBe(5000);
      expect((created as any).fields.currency).toBe('usd');
    });

    it('should create a customer in demo mode', async () => {
      const customerData = {
        fields: {
          email: 'newcustomer@demo.com',
          name: 'New Demo Customer',
          phone: '+1-555-9999',
        },
      };

      const created = await connector.create('customer', customerData);

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).fields.email).toBe('newcustomer@demo.com');
      expect((created as any).fields.name).toBe('New Demo Customer');
    });

    it('should read a charge by id in demo mode', async () => {
      // Create a charge first
      const created = await connector.create('charge', {
        fields: { amount: 2500, currency: 'usd', status: 'succeeded' },
      });

      const chargeId = (created as any).id;

      // Read it back
      const charge = await connector.read('charge', chargeId);

      expect(charge).toBeDefined();
      expect((charge as any).id).toBe(chargeId);
      expect((charge as any).fields.amount).toBe(2500);
    });

    it('should read a customer by id in demo mode', async () => {
      // Use one of the seeded demo customers
      const customers = await connector.list('customer', { limit: 1 });
      expect(customers.length).toBeGreaterThan(0);

      const customerId = (customers[0] as any).id;

      const customer = await connector.read('customer', customerId);

      expect(customer).toBeDefined();
      expect((customer as any).id).toBe(customerId);
    });

    it('should return null for non-existent record in demo mode', async () => {
      const result = await connector.read('charge', 'ch_nonexistent_999');
      expect(result).toBeNull();
    });

    it('should update a charge in demo mode', async () => {
      // Create a charge
      const created = await connector.create('charge', {
        fields: { amount: 3000, currency: 'usd', status: 'pending' },
      });

      const chargeId = (created as any).id;

      // Update it
      const updated = await connector.update('charge', chargeId, {
        fields: { status: 'succeeded', description: 'Updated charge' },
      });

      expect(updated).toBeDefined();
      expect((updated as any).id).toBe(chargeId);
      expect((updated as any).fields.status).toBe('succeeded');
      expect((updated as any).fields.description).toBe('Updated charge');
      // Original fields should be preserved
      expect((updated as any).fields.amount).toBe(3000);
    });

    it('should throw error when updating non-existent record', async () => {
      await expect(
        connector.update('charge', 'ch_nonexistent_999', {
          fields: { status: 'succeeded' },
        })
      ).rejects.toThrow();
    });

    it('should delete a charge in demo mode', async () => {
      // Create a charge
      const created = await connector.create('charge', {
        fields: { amount: 1500, currency: 'usd', status: 'succeeded' },
      });

      const chargeId = (created as any).id;

      // Delete it
      const deleted = await connector.delete('charge', chargeId);
      expect(deleted).toBe(true);

      // Verify it's gone
      const result = await connector.read('charge', chargeId);
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent record', async () => {
      const deleted = await connector.delete('charge', 'ch_nonexistent_999');
      expect(deleted).toBe(false);
    });

    it('should list all charges in demo mode', async () => {
      // Create a few charges
      await connector.create('charge', { fields: { amount: 1000, currency: 'usd' } });
      await connector.create('charge', { fields: { amount: 2000, currency: 'usd' } });

      const charges = await connector.list('charge', { limit: 100 });

      expect(Array.isArray(charges)).toBe(true);
      expect(charges.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Demo Mode List with Options', () => {
    beforeEach(async () => {
      // Seed some test data
      await connector.create('charge', {
        fields: {
          amount: 5000,
          currency: 'usd',
          status: 'succeeded',
          customer: 'cus_test001',
        },
      });

      await connector.create('charge', {
        fields: {
          amount: 7500,
          currency: 'usd',
          status: 'pending',
          customer: 'cus_test002',
        },
      });

      await connector.create('charge', {
        fields: {
          amount: 3000,
          currency: 'eur',
          status: 'failed',
          customer: 'cus_test001',
        },
      });
    });

    it('should list charges with limit', async () => {
      const charges = await connector.list('charge', { limit: 2 });

      expect(Array.isArray(charges)).toBe(true);
      expect(charges.length).toBeLessThanOrEqual(2);
    });

    it('should filter charges by status', async () => {
      const succeededCharges = await connector.list('charge', {
        status: 'succeeded',
        limit: 100,
      });

      expect(Array.isArray(succeededCharges)).toBe(true);
      succeededCharges.forEach((charge: any) => {
        expect(charge.fields.status).toBe('succeeded');
      });
    });

    it('should filter charges by customer', async () => {
      const customerCharges = await connector.list('charge', {
        customer: 'cus_test001',
        limit: 100,
      });

      expect(Array.isArray(customerCharges)).toBe(true);
      expect(customerCharges.length).toBeGreaterThan(0);
      customerCharges.forEach((charge: any) => {
        expect(charge.fields.customer).toBe('cus_test001');
      });
    });

    it('should list all charges regardless of currency', async () => {
      // Note: listDemo only filters by status and customer, not currency
      const allCharges = await connector.list('charge', { limit: 100 });

      expect(Array.isArray(allCharges)).toBe(true);

      // Verify we have charges with different currencies
      const hasCurrencies = allCharges.some((charge: any) =>
        ['usd', 'eur'].includes(charge.fields.currency)
      );
      expect(hasCurrencies).toBe(true);
    });

    it('should return empty array for non-existent entity type', async () => {
      const results = await connector.list('nonexistent', { limit: 10 });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should list all customers', async () => {
      const customers = await connector.list('customer', { limit: 100 });

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThanOrEqual(2);

      // Verify demo customers are present
      const demoCustomer = customers.find((c: any) =>
        c.fields.email?.includes('demo.com')
      );
      expect(demoCustomer).toBeDefined();
    });
  });

  describe('Demo Mode Search & Filters', () => {
    beforeEach(async () => {
      // Create test data with various attributes
      await connector.create('charge', {
        fields: {
          amount: 10000,
          currency: 'usd',
          status: 'succeeded',
          description: 'Premium subscription',
          customer: 'cus_premium001',
        },
      });

      await connector.create('charge', {
        fields: {
          amount: 2500,
          currency: 'usd',
          status: 'succeeded',
          description: 'Basic plan',
          customer: 'cus_basic001',
        },
      });

      await connector.create('charge', {
        fields: {
          amount: 5000,
          currency: 'eur',
          status: 'pending',
          description: 'Standard subscription',
          customer: 'cus_standard001',
        },
      });
    });

    it('should search charges with simple filter', async () => {
      const results = await connector.search('charge', {
        filters: { status: 'succeeded' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach((charge: any) => {
        expect(charge.fields.status).toBe('succeeded');
      });
    });

    it('should search charges with multiple filters', async () => {
      const results = await connector.search('charge', {
        filters: {
          status: 'succeeded',
          currency: 'usd',
        },
      });

      expect(Array.isArray(results)).toBe(true);
      results.forEach((charge: any) => {
        expect(charge.fields.status).toBe('succeeded');
        expect(charge.fields.currency).toBe('usd');
      });
    });

    it('should search charges with text filter (case-insensitive)', async () => {
      const results = await connector.search('charge', {
        filters: {
          description: 'subscription',
        },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      results.forEach((charge: any) => {
        expect(charge.fields.description?.toLowerCase()).toContain('subscription');
      });
    });

    it('should search with limit', async () => {
      const results = await connector.search('charge', {
        filters: { currency: 'usd' },
        limit: 1,
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array when no matches found', async () => {
      const results = await connector.search('charge', {
        filters: { status: 'nonexistent_status' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should search customers by email', async () => {
      // Create customer first
      await connector.create('customer', {
        fields: {
          email: 'search@example.com',
          name: 'Searchable Customer',
        },
      });

      const results = await connector.search('customer', {
        filters: { email: 'search@example.com' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect((results[0] as any).fields.email).toBe('search@example.com');
    });

    it('should search customers by name (case-insensitive)', async () => {
      // Use seeded demo customer
      const results = await connector.search('customer', {
        filters: { name: 'john' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle search on empty entity store', async () => {
      const results = await connector.search('payout', {
        filters: { status: 'paid' },
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });

  describe('Stripe-Specific Features', () => {
    it('should handle transaction entity type alias', async () => {
      // Create using 'transaction' (alias for 'charge')
      const created = await connector.create('transaction', {
        fields: { amount: 4000, currency: 'usd', status: 'succeeded' },
      });

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();

      // Should be able to read as 'charge'
      const asCharge = await connector.read('charge', (created as any).id);
      expect(asCharge).toBeDefined();
    });

    it('should track created timestamp in unix format', async () => {
      const created = await connector.create('charge', {
        fields: { amount: 1000, currency: 'usd' },
      });

      expect((created as any).fields.created).toBeDefined();
      expect(typeof (created as any).fields.created).toBe('number');

      // Should be a reasonable timestamp (within last minute)
      const nowInSeconds = Math.floor(Date.now() / 1000);
      expect((created as any).fields.created).toBeLessThanOrEqual(nowInSeconds);
      expect((created as any).fields.created).toBeGreaterThan(nowInSeconds - 60);
    });

    it('should preserve metadata when creating records', async () => {
      const created = await connector.create('charge', {
        fields: {
          amount: 3500,
          currency: 'usd',
          metadata: {
            order_id: 'ORDER_12345',
            customer_note: 'VIP customer',
          },
        },
      });

      expect((created as any).fields.metadata).toBeDefined();
      expect((created as any).fields.metadata.order_id).toBe('ORDER_12345');
      expect((created as any).fields.metadata.customer_note).toBe('VIP customer');
    });

    it('should merge metadata when updating records', async () => {
      // Create with initial metadata
      const created = await connector.create('charge', {
        fields: {
          amount: 2000,
          currency: 'usd',
          metadata: { initial_key: 'initial_value' },
        },
      });

      const chargeId = (created as any).id;

      // Update with additional metadata
      const updated = await connector.update('charge', chargeId, {
        fields: {
          metadata: { additional_key: 'additional_value' },
        },
      });

      // Both metadata keys should exist
      expect((updated as any).fields.metadata.initial_key).toBe('initial_value');
      expect((updated as any).fields.metadata.additional_key).toBe(
        'additional_value'
      );
    });
  });

  describe('Error Handling & Edge Cases', () => {
    it('should handle empty fields when creating record', async () => {
      const created = await connector.create('charge', {
        fields: {},
      });

      expect(created).toBeDefined();
      expect((created as any).id).toBeDefined();
      expect((created as any).fields.metadata).toBeDefined();
    });

    it('should handle list with no options', async () => {
      const results = await connector.list('charge');

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle search with no criteria', async () => {
      const results = await connector.search('charge', {});

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle list with empty options object', async () => {
      const results = await connector.list('charge', {});

      expect(Array.isArray(results)).toBe(true);
    });
  });
});
