/**
 * Tests for Fixture Connector API Endpoints
 *
 * This test suite validates the REST API endpoints for accessing fixture data.
 */

import request from 'supertest';
import express, { Application } from 'express';
import fixtureConnectorsRouter from '../fixtureConnectors';

describe('Fixture Connectors API', () => {
  let app: Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fixtures', fixtureConnectorsRouter);
  });

  describe('GET /api/fixtures/available-systems', () => {
    it('should return list of available systems', async () => {
      const response = await request(app)
        .get('/api/fixtures/available-systems')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBeGreaterThan(0);
      expect(Array.isArray(response.body.systems)).toBe(true);
    });

    it('should include system metadata', async () => {
      const response = await request(app)
        .get('/api/fixtures/available-systems')
        .expect(200);

      const firstSystem = response.body.systems[0];
      expect(firstSystem).toHaveProperty('systemId');
      expect(firstSystem).toHaveProperty('status');
      expect(firstSystem).toHaveProperty('fixturesLoaded');
      expect(firstSystem).toHaveProperty('availableTypes');
    });
  });

  describe('GET /api/fixtures/:systemId/test-connection', () => {
    it('should test connection for QuickBooks', async () => {
      const response = await request(app)
        .get('/api/fixtures/quickbooks/test-connection')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('connected successfully');
      expect(response.body.details.systemId).toBe('quickbooks');
    });

    it('should test connection for Salesforce', async () => {
      const response = await request(app)
        .get('/api/fixtures/salesforce/test-connection')
        .expect(200);

      expect(response.body.details.fixturesLoaded).toBeGreaterThan(0);
      expect(response.body.details.totalRecords).toBeGreaterThan(0);
    });

    it('should return error for invalid system ID', async () => {
      const response = await request(app)
        .get('/api/fixtures/invalid-system/test-connection')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid system ID');
    });
  });

  describe('GET /api/fixtures/:systemId/orders', () => {
    it('should list orders for QuickBooks', async () => {
      const response = await request(app)
        .get('/api/fixtures/quickbooks/orders')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.systemId).toBe('quickbooks');
      expect(response.body.count).toBeGreaterThan(0);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should list orders for Shopify', async () => {
      const response = await request(app)
        .get('/api/fixtures/shopify/orders')
        .expect(200);

      expect(response.body.data[0]).toHaveProperty('order_number');
      expect(response.body.data[0]).toHaveProperty('email');
    });

    it('should return empty array for system without orders', async () => {
      const response = await request(app)
        .get('/api/fixtures/stripe/orders')
        .expect(200);

      expect(response.body.count).toBe(0);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('GET /api/fixtures/:systemId/orders/:id', () => {
    it('should get single order for QuickBooks', async () => {
      const response = await request(app)
        .get('/api/fixtures/quickbooks/orders/1001')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('Id', '1001');
    });

    it('should return 404 for non-existent order', async () => {
      const response = await request(app)
        .get('/api/fixtures/quickbooks/orders/999999')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('GET /api/fixtures/:systemId/invoices', () => {
    it('should list invoices for Stripe', async () => {
      const response = await request(app)
        .get('/api/fixtures/stripe/invoices')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0]).toHaveProperty('id');
    });

    it('should list invoices for Xero', async () => {
      const response = await request(app)
        .get('/api/fixtures/xero/invoices')
        .expect(200);

      expect(response.body.data[0]).toHaveProperty('InvoiceID');
      expect(response.body.data[0]).toHaveProperty('Total');
    });
  });

  describe('GET /api/fixtures/:systemId/inventory', () => {
    it('should list inventory for Business Central', async () => {
      const response = await request(app)
        .get('/api/fixtures/businesscentral/inventory')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0]).toHaveProperty('inventory');
    });

    it('should list inventory for Square', async () => {
      const response = await request(app)
        .get('/api/fixtures/square/inventory')
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/fixtures/:systemId/customers', () => {
    it('should list customers for Squire', async () => {
      const response = await request(app)
        .get('/api/fixtures/squire/customers')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.systemId).toBe('squire');
      expect(response.body.count).toBeGreaterThan(0);
    });

    it('should return empty array for systems without customers', async () => {
      const response = await request(app)
        .get('/api/fixtures/woocommerce/customers')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(0);
      expect(response.body.count).toBe(0);
    });
  });

  describe('GET /api/fixtures/:systemId/customers/:id', () => {
    it('should get single customer for Squire', async () => {
      const listResponse = await request(app)
        .get('/api/fixtures/squire/customers');

      const firstCustomer = listResponse.body.data[0];

      const response = await request(app)
        .get(`/api/fixtures/squire/customers/${firstCustomer.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(firstCustomer.id);
    });

    it('should return 404 for non-existent customer', async () => {
      const response = await request(app)
        .get('/api/fixtures/squire/customers/non-existent')
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/fixtures/:systemId/customers', () => {
    it('should create mock customer with generated ID', async () => {
      const customerData = {
        email: 'test@example.com',
        name: 'Test Customer'
      };

      const response = await request(app)
        .post('/api/fixtures/squire/customers')
        .send(customerData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toContain('MOCK_SQUIRE_');
      expect(response.body.data.email).toBe(customerData.email);
      expect(response.body.data._mock).toBe(true);
    });

    it('should return error if email is missing', async () => {
      const customerData = {
        name: 'Test Customer'
        // Missing email
      };

      const response = await request(app)
        .post('/api/fixtures/squire/customers')
        .send(customerData)
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('required field');
    });
  });

  describe('GET /api/fixtures/:systemId/products', () => {
    it('should list products for Squire', async () => {
      const response = await request(app)
        .get('/api/fixtures/squire/products')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBeGreaterThan(0);
    });
  });

  describe('GET /api/fixtures/:systemId/vendors', () => {
    it('should list vendors for Squire', async () => {
      const response = await request(app)
        .get('/api/fixtures/squire/vendors')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBeGreaterThan(0);
    });
  });

  describe('GET /api/fixtures/:systemId/metadata', () => {
    it('should get connector metadata for WooCommerce', async () => {
      const response = await request(app)
        .get('/api/fixtures/woocommerce/metadata')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.systemId).toBe('woocommerce');
      expect(response.body.data.type).toBe('mock');
      expect(response.body.data.status).toBe('planned');
      expect(response.body.data.availableOperations).toContain('testConnection');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid system ID gracefully', async () => {
      const response = await request(app)
        .get('/api/fixtures/invalid-system-xyz/orders')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid system ID');
      expect(response.body.validSystems).toBeDefined();
    });

    it('should handle server errors gracefully', async () => {
      // This would require mocking the loadFixture function to throw an error
      // For now, just verify the endpoint exists
      const response = await request(app)
        .get('/api/fixtures/squire/orders');

      expect(response.status).toBeLessThan(500);
    });
  });
});
