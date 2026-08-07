/**
 * Tests for MockConnectorAdapter
 *
 * This test suite validates the fixture-based connector adapter
 * that enables testing without real API credentials.
 */

import { MockConnectorAdapter } from '../MockConnectorAdapter';

describe('MockConnectorAdapter', () => {
  describe('Initialization', () => {
    it('should initialize with QuickBooks system ID', async () => {
      const adapter = new MockConnectorAdapter('quickbooks');
      await adapter.initialize();

      const metadata = adapter.getMetadata();
      expect(metadata.systemId).toBe('quickbooks');
      expect(metadata.type).toBe('mock');
      expect(metadata.status).toBe('planned');
    });

    it('should load available fixtures for Squire', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const metadata = adapter.getMetadata();
      expect(metadata.availableOperations).toContain('listCustomers');
      expect(metadata.availableOperations).toContain('listOrders');
    });

    it('should only initialize once', async () => {
      const adapter = new MockConnectorAdapter('shopify');
      await adapter.initialize();
      await adapter.initialize(); // Second call should be no-op

      // Should not throw or cause issues
      expect(true).toBe(true);
    });
  });

  describe('listCustomers', () => {
    it('should return customers for Squire', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const customers = await adapter.listCustomers();

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThan(0);
    });

    it('should return customers for shopify', async () => {
      const adapter = new MockConnectorAdapter('shopify');
      await adapter.initialize();

      const customers = await adapter.listCustomers();

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThan(0);
    });

    it('should return empty array for systems without customer fixtures', async () => {
      const adapter = new MockConnectorAdapter('woocommerce');
      await adapter.initialize();

      const customers = await adapter.listCustomers();

      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBe(0);
    });
  });

  describe('listOrders', () => {
    it('should return orders for QuickBooks', async () => {
      const adapter = new MockConnectorAdapter('quickbooks');
      await adapter.initialize();

      const orders = await adapter.listOrders();

      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThan(0);
      expect(orders[0]).toHaveProperty('Id');
    });

    it('should return orders for Shopify', async () => {
      const adapter = new MockConnectorAdapter('shopify');
      await adapter.initialize();

      const orders = await adapter.listOrders();

      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThan(0);
      expect(orders[0]).toHaveProperty('order_number');
    });
  });

  describe('listInvoices', () => {
    it('should return invoices for Stripe', async () => {
      const adapter = new MockConnectorAdapter('stripe');
      await adapter.initialize();

      const invoices = await adapter.listInvoices();

      expect(Array.isArray(invoices)).toBe(true);
      expect(invoices.length).toBeGreaterThan(0);
    });

    it('should return invoices for Xero', async () => {
      const adapter = new MockConnectorAdapter('xero');
      await adapter.initialize();

      const invoices = await adapter.listInvoices();

      expect(Array.isArray(invoices)).toBe(true);
      expect(invoices.length).toBeGreaterThan(0);
      expect(invoices[0]).toHaveProperty('InvoiceID');
    });
  });

  describe('listInventory', () => {
    it('should return inventory for Business Central', async () => {
      const adapter = new MockConnectorAdapter('businesscentral');
      await adapter.initialize();

      const inventory = await adapter.listInventory();

      expect(Array.isArray(inventory)).toBe(true);
      expect(inventory.length).toBeGreaterThan(0);
      expect(inventory[0]).toHaveProperty('inventory');
    });

    it('should return inventory for Square', async () => {
      const adapter = new MockConnectorAdapter('square');
      await adapter.initialize();

      const inventory = await adapter.listInventory();

      expect(Array.isArray(inventory)).toBe(true);
      expect(inventory.length).toBeGreaterThan(0);
    });
  });

  describe('getCustomer', () => {
    it('should get customer by ID for Squire', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const customers = await adapter.listCustomers();
      const firstCustomer = customers[0];

      const customer = await adapter.getCustomer(firstCustomer.id);

      expect(customer).not.toBeNull();
      expect(customer.id).toBe(firstCustomer.id);
    });

    it('should return null for non-existent customer ID', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const customer = await adapter.getCustomer('non-existent-id');

      expect(customer).toBeNull();
    });
  });

  describe('getOrder', () => {
    it('should get order by ID for QuickBooks', async () => {
      const adapter = new MockConnectorAdapter('quickbooks');
      await adapter.initialize();

      const orders = await adapter.listOrders();
      const firstOrder = orders[0];

      const order = await adapter.getOrder(firstOrder.Id);

      expect(order).not.toBeNull();
      expect(order.Id).toBe(firstOrder.Id);
    });

    it('should get order by order_number for Shopify', async () => {
      const adapter = new MockConnectorAdapter('shopify');
      await adapter.initialize();

      const orders = await adapter.listOrders();
      const firstOrder = orders[0];

      const order = await adapter.getOrder(firstOrder.order_number.toString());

      expect(order).not.toBeNull();
      expect(order.order_number).toBe(firstOrder.order_number);
    });
  });

  describe('createCustomer', () => {
    it('should create mock customer with generated ID', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const customerData = {
        email: 'test@example.com',
        name: 'Test Customer'
      };

      const created = await adapter.createCustomer(customerData);

      expect(created.id).toBeDefined();
      expect(created.id).toContain('MOCK_SQUIRE_');
      expect(created.email).toBe(customerData.email);
      expect(created._mock).toBe(true);
      expect(created._created).toBeDefined();
    });

    it('should throw error if email is missing', async () => {
      const adapter = new MockConnectorAdapter('squire');
      await adapter.initialize();

      const customerData = {
        name: 'Test Customer'
        // Missing email
      };

      await expect(adapter.createCustomer(customerData))
        .rejects.toThrow('Missing required field');
    });
  });

  describe('testConnection', () => {
    it('should return success for Salesforce', async () => {
      const adapter = new MockConnectorAdapter('salesforce');
      await adapter.initialize();

      const result = await adapter.testConnection();

      expect(result.success).toBe(true);
      expect(result.message).toContain('connected successfully');
      expect(result.details).toBeDefined();
      expect(result.details.systemId).toBe('salesforce');
    });

    it('should return fixture metadata', async () => {
      const adapter = new MockConnectorAdapter('quickbooks');
      await adapter.initialize();

      const result = await adapter.testConnection();

      expect(result.details.fixturesLoaded).toBeGreaterThan(0);
      expect(result.details.totalRecords).toBeGreaterThan(0);
      expect(result.details.availableTypes).toContain('orders');
    });
  });

  describe('getMetadata', () => {
    it('should return connector metadata', () => {
      const adapter = new MockConnectorAdapter('woocommerce');

      const metadata = adapter.getMetadata();

      expect(metadata.systemId).toBe('woocommerce');
      expect(metadata.type).toBe('mock');
      expect(metadata.status).toBe('planned');
      expect(metadata.dataSource).toBe('fixtures');
      expect(metadata.availableOperations).toContain('testConnection');
    });
  });
});
