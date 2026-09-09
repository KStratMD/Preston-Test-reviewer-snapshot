/**
 * CustomerCentralService Unit Tests
 *
 * Tests for customer relationship management including:
 * - Customer CRUD operations
 * - Segmentation and analytics
 * - Order tracking
 * - Support ticket management
 * - Health score calculations
 */

import 'reflect-metadata';
import { CustomerCentralService } from '../../../../src/services/CustomerCentralService';
import type { Logger } from 'pino';

// Mock logger
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

describe('CustomerCentralService', () => {
  let service: CustomerCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new CustomerCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('CustomerCentralService initialized');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          customers: expect.any(Number),
          orders: expect.any(Number),
          tickets: expect.any(Number),
        }),
        'CustomerCentralService demo data initialized'
      );
    });
  });

  describe('Dashboard & Analytics', () => {
    describe('getDashboard', () => {
      it('should return comprehensive dashboard data', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard).toHaveProperty('summary');
        expect(dashboard).toHaveProperty('metrics');
        expect(dashboard).toHaveProperty('sentiment');
        expect(dashboard).toHaveProperty('recentActivity');
        expect(dashboard).toHaveProperty('topSegments');
        expect(dashboard).toHaveProperty('atRiskCustomers');
        expect(dashboard).toHaveProperty('recentCustomers');
        expect(dashboard).toHaveProperty('lastUpdated');
      });

      it('should have valid summary metrics', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.summary.activeCustomers).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.ordersThisMonth).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.openTickets).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.customerSatisfaction).toBeGreaterThanOrEqual(0);
      });

      it('should have valid metrics', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.metrics.avgOrderValue).toBeGreaterThanOrEqual(0);
        expect(dashboard.metrics.retentionRate).toBeGreaterThanOrEqual(0);
        expect(dashboard.metrics.retentionRate).toBeLessThanOrEqual(100);
        expect(dashboard.metrics.churnRate).toBeGreaterThanOrEqual(0);
      });

      it('should have sentiment percentages that sum correctly', async () => {
        const dashboard = await service.getDashboard();
        const total = dashboard.sentiment.positive + dashboard.sentiment.neutral + dashboard.sentiment.negative;
        // Allow for rounding differences
        expect(total).toBeGreaterThanOrEqual(95);
        expect(total).toBeLessThanOrEqual(105);
      });
    });

    describe('getSegmentStats', () => {
      it('should return stats for all segments', async () => {
        const stats = await service.getSegmentStats();

        expect(stats.length).toBe(4);
        const segments = stats.map((s) => s.segment);
        expect(segments).toContain('enterprise');
        expect(segments).toContain('mid-market');
        expect(segments).toContain('smb');
        expect(segments).toContain('startup');
      });

      it('should have valid segment data', async () => {
        const stats = await service.getSegmentStats();

        stats.forEach((segment) => {
          expect(segment).toHaveProperty('count');
          expect(segment).toHaveProperty('percentage');
          expect(segment).toHaveProperty('avgLifetimeValue');
          expect(segment).toHaveProperty('avgOrderValue');
          expect(segment).toHaveProperty('totalRevenue');
          expect(segment).toHaveProperty('growth');
        });
      });
    });

    describe('getLifetimeValueAnalysis', () => {
      it('should return LTV analysis', async () => {
        const analysis = await service.getLifetimeValueAnalysis();

        expect(analysis).toHaveProperty('totalLTV');
        expect(analysis).toHaveProperty('avgLTV');
        expect(analysis).toHaveProperty('medianLTV');
        expect(analysis).toHaveProperty('ltvBySegment');
        expect(analysis).toHaveProperty('ltvByTier');
        expect(analysis).toHaveProperty('topCustomers');
      });

      it('should have LTV by segment', async () => {
        const analysis = await service.getLifetimeValueAnalysis();

        expect(analysis.ltvBySegment).toHaveProperty('enterprise');
        expect(analysis.ltvBySegment).toHaveProperty('mid-market');
        expect(analysis.ltvBySegment).toHaveProperty('smb');
        expect(analysis.ltvBySegment).toHaveProperty('startup');
      });

      it('should have LTV by tier', async () => {
        const analysis = await service.getLifetimeValueAnalysis();

        expect(analysis.ltvByTier).toHaveProperty('platinum');
        expect(analysis.ltvByTier).toHaveProperty('gold');
        expect(analysis.ltvByTier).toHaveProperty('silver');
        expect(analysis.ltvByTier).toHaveProperty('bronze');
      });
    });
  });

  describe('Customer CRUD Operations', () => {
    describe('getCustomers', () => {
      it('should return customers with pagination info', async () => {
        const result = await service.getCustomers();

        expect(result).toHaveProperty('customers');
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('page');
        expect(result).toHaveProperty('pageSize');
        expect(result.customers.length).toBeGreaterThan(0);
      });

      it('should filter by segment', async () => {
        const result = await service.getCustomers({ segment: 'enterprise' });

        result.customers.forEach((customer) => {
          expect(customer.segment).toBe('enterprise');
        });
      });

      it('should filter by status', async () => {
        const result = await service.getCustomers({ status: 'active' });

        result.customers.forEach((customer) => {
          expect(customer.status).toBe('active');
        });
      });

      it('should filter by tier', async () => {
        const result = await service.getCustomers({ tier: 'platinum' });

        result.customers.forEach((customer) => {
          expect(customer.tier).toBe('platinum');
        });
      });

      it('should filter by churn risk', async () => {
        const result = await service.getCustomers({ churnRisk: 'high' });

        result.customers.forEach((customer) => {
          expect(customer.metrics.churnRisk).toBe('high');
        });
      });

      it('should filter by lifetime value range', async () => {
        const result = await service.getCustomers({
          minLifetimeValue: 10000,
          maxLifetimeValue: 100000,
        });

        result.customers.forEach((customer) => {
          expect(customer.metrics.lifetimeValue).toBeGreaterThanOrEqual(10000);
          expect(customer.metrics.lifetimeValue).toBeLessThanOrEqual(100000);
        });
      });

      it('should search by query', async () => {
        const result = await service.getCustomers({ query: 'acme' });

        expect(result.customers.length).toBeGreaterThan(0);
        result.customers.forEach((customer) => {
          const matches =
            customer.name.toLowerCase().includes('acme') ||
            customer.email.toLowerCase().includes('acme') ||
            (customer.company && customer.company.toLowerCase().includes('acme'));
          expect(matches).toBe(true);
        });
      });

      it('should limit results', async () => {
        const result = await service.getCustomers({ limit: 2 });
        expect(result.customers.length).toBeLessThanOrEqual(2);
      });

      it('should support pagination', async () => {
        const page1 = await service.getCustomers({ limit: 2, offset: 0 });
        const page2 = await service.getCustomers({ limit: 2, offset: 2 });

        if (page1.total > 2) {
          expect(page1.customers[0].id).not.toBe(page2.customers[0]?.id);
        }
      });
    });

    describe('getCustomer', () => {
      it('should return a specific customer', async () => {
        const customers = await service.getCustomers();
        const customer = await service.getCustomer(customers.customers[0].id);

        expect(customer).not.toBeNull();
        expect(customer!.id).toBe(customers.customers[0].id);
      });

      it('should return null for non-existent customer', async () => {
        const customer = await service.getCustomer('NON-EXISTENT');
        expect(customer).toBeNull();
      });
    });

    describe('getCustomerByEmail', () => {
      it('should return customer by email', async () => {
        const customers = await service.getCustomers();
        const email = customers.customers[0].email;
        const customer = await service.getCustomerByEmail(email);

        expect(customer).not.toBeNull();
        expect(customer!.email.toLowerCase()).toBe(email.toLowerCase());
      });

      it('should return null for non-existent email', async () => {
        const customer = await service.getCustomerByEmail('nonexistent@example.com');
        expect(customer).toBeNull();
      });
    });

    describe('createCustomer', () => {
      it('should create a new customer', async () => {
        const customer = await service.createCustomer({
          name: 'Test Customer',
          email: 'test@example.com',
          phone: '555-0999',
          company: 'Test Corp',
          type: 'business',
          segment: 'smb',
          billingAddress: {
            line1: '123 Test St',
            city: 'Test City',
            state: 'TS',
            zipCode: '12345',
            country: 'USA',
          },
        });

        expect(customer.id).toMatch(/^CUST-/);
        expect(customer.name).toBe('Test Customer');
        expect(customer.email).toBe('test@example.com');
        expect(customer.status).toBe('active');
        expect(customer.tier).toBe('bronze');
        expect(customer.metrics.healthScore).toBe(100);
        expect(customer.metrics.churnRisk).toBe('low');
      });

      it('should set initial metrics', async () => {
        const customer = await service.createCustomer({
          name: 'New Customer',
          email: 'new@example.com',
          type: 'individual',
          segment: 'startup',
          billingAddress: {
            line1: '1',
            city: 'C',
            state: 'S',
            zipCode: '1',
            country: 'USA',
          },
        });

        expect(customer.metrics.lifetimeValue).toBe(0);
        expect(customer.metrics.totalOrders).toBe(0);
        expect(customer.metrics.totalSpent).toBe(0);
        expect(customer.metrics.openTickets).toBe(0);
      });
    });

    describe('updateCustomer', () => {
      it('should update customer details', async () => {
        const customers = await service.getCustomers();
        const customerId = customers.customers[0].id;

        const updated = await service.updateCustomer(customerId, {
          name: 'Updated Name',
          tier: 'gold',
        });

        expect(updated).not.toBeNull();
        expect(updated!.name).toBe('Updated Name');
        expect(updated!.tier).toBe('gold');
      });

      it('should merge custom fields', async () => {
        const customer = await service.createCustomer({
          name: 'Test',
          email: 'test2@example.com',
          type: 'business',
          segment: 'smb',
          billingAddress: { line1: '1', city: 'C', state: 'S', zipCode: '1', country: 'USA' },
          customFields: { field1: 'value1' },
        });

        const updated = await service.updateCustomer(customer.id, {
          customFields: { field2: 'value2' },
        });

        expect(updated!.customFields.field1).toBe('value1');
        expect(updated!.customFields.field2).toBe('value2');
      });

      it('should return null for non-existent customer', async () => {
        const result = await service.updateCustomer('NON-EXISTENT', { name: 'Test' });
        expect(result).toBeNull();
      });
    });

    describe('deleteCustomer', () => {
      it('should soft delete customer', async () => {
        const customer = await service.createCustomer({
          name: 'To Delete',
          email: 'delete@example.com',
          type: 'individual',
          segment: 'smb',
          billingAddress: { line1: '1', city: 'C', state: 'S', zipCode: '1', country: 'USA' },
        });

        const success = await service.deleteCustomer(customer.id);
        expect(success).toBe(true);

        const deleted = await service.getCustomer(customer.id);
        expect(deleted!.status).toBe('inactive');
      });

      it('should return false for non-existent customer', async () => {
        const success = await service.deleteCustomer('NON-EXISTENT');
        expect(success).toBe(false);
      });
    });
  });

  describe('Order Management', () => {
    describe('getCustomerOrders', () => {
      it('should return orders for a customer', async () => {
        const customers = await service.getCustomers();
        const orders = await service.getCustomerOrders(customers.customers[0].id);

        expect(Array.isArray(orders)).toBe(true);
      });

      it('should limit results', async () => {
        const customers = await service.getCustomers();
        const orders = await service.getCustomerOrders(customers.customers[0].id, 1);

        expect(orders.length).toBeLessThanOrEqual(1);
      });
    });

    describe('recordOrder', () => {
      it('should record a new order and update metrics', async () => {
        const customer = await service.createCustomer({
          name: 'Order Test',
          email: 'ordertest@example.com',
          type: 'business',
          segment: 'smb',
          billingAddress: { line1: '1', city: 'C', state: 'S', zipCode: '1', country: 'USA' },
        });

        const order = await service.recordOrder(customer.id, {
          orderNumber: 'ORD-TEST-001',
          status: 'delivered',
          total: 500,
          subtotal: 450,
          tax: 40,
          shipping: 10,
          discount: 0,
          items: [{ sku: 'TEST-001', name: 'Test Product', quantity: 1, unitPrice: 450, total: 450 }],
          shippedAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
        });

        expect(order).not.toBeNull();
        expect(order!.orderNumber).toBe('ORD-TEST-001');

        const updatedCustomer = await service.getCustomer(customer.id);
        expect(updatedCustomer!.metrics.totalOrders).toBe(1);
        expect(updatedCustomer!.metrics.totalSpent).toBe(500);
        expect(updatedCustomer!.metrics.avgOrderValue).toBe(500);
      });

      it('should return null for non-existent customer', async () => {
        const result = await service.recordOrder('NON-EXISTENT', {
          orderNumber: 'ORD-001',
          status: 'pending',
          total: 100,
          subtotal: 100,
          tax: 0,
          shipping: 0,
          discount: 0,
          items: [],
          shippedAt: null,
          deliveredAt: null,
        });
        expect(result).toBeNull();
      });
    });

    describe('getOrder', () => {
      it('should return order by ID', async () => {
        const customers = await service.getCustomers();
        const orders = await service.getCustomerOrders(customers.customers[0].id);

        if (orders.length > 0) {
          const order = await service.getOrder(orders[0].id);
          expect(order).not.toBeNull();
          expect(order!.id).toBe(orders[0].id);
        }
      });

      it('should return null for non-existent order', async () => {
        const order = await service.getOrder('NON-EXISTENT');
        expect(order).toBeNull();
      });
    });
  });

  describe('Support Ticket Management', () => {
    describe('getCustomerTickets', () => {
      it('should return tickets for a customer', async () => {
        const customers = await service.getCustomers();
        const tickets = await service.getCustomerTickets(customers.customers[0].id);

        expect(Array.isArray(tickets)).toBe(true);
      });
    });

    describe('createTicket', () => {
      it('should create a support ticket and update metrics', async () => {
        const customer = await service.createCustomer({
          name: 'Ticket Test',
          email: 'tickettest@example.com',
          type: 'individual',
          segment: 'smb',
          billingAddress: { line1: '1', city: 'C', state: 'S', zipCode: '1', country: 'USA' },
        });

        const ticket = await service.createTicket(customer.id, {
          subject: 'Test Issue',
          description: 'Test description',
          priority: 'high',
          category: 'Technical Support',
        });

        expect(ticket).not.toBeNull();
        expect(ticket!.subject).toBe('Test Issue');
        expect(ticket!.status).toBe('open');

        const updatedCustomer = await service.getCustomer(customer.id);
        expect(updatedCustomer!.metrics.openTickets).toBe(1);
      });

      it('should return null for non-existent customer', async () => {
        const result = await service.createTicket('NON-EXISTENT', {
          subject: 'Test',
          description: 'Test',
          priority: 'low',
          category: 'General',
        });
        expect(result).toBeNull();
      });
    });

    describe('resolveTicket', () => {
      it('should resolve a ticket and update metrics', async () => {
        const customer = await service.createCustomer({
          name: 'Resolve Test',
          email: 'resolvetest@example.com',
          type: 'individual',
          segment: 'smb',
          billingAddress: { line1: '1', city: 'C', state: 'S', zipCode: '1', country: 'USA' },
        });

        const ticket = await service.createTicket(customer.id, {
          subject: 'To Resolve',
          description: 'Test',
          priority: 'low',
          category: 'General',
        });

        const resolved = await service.resolveTicket(ticket!.id, { satisfactionRating: 5 });

        expect(resolved).not.toBeNull();
        expect(resolved!.status).toBe('resolved');
        expect(resolved!.satisfactionRating).toBe(5);
        expect(resolved!.resolvedAt).not.toBeNull();

        const updatedCustomer = await service.getCustomer(customer.id);
        expect(updatedCustomer!.metrics.openTickets).toBe(0);
        expect(updatedCustomer!.metrics.resolvedTickets).toBe(1);
      });

      it('should return null for non-existent ticket', async () => {
        const result = await service.resolveTicket('NON-EXISTENT', {});
        expect(result).toBeNull();
      });
    });
  });

  describe('Customer Health & Analytics', () => {
    describe('getAtRiskCustomers', () => {
      it('should return at-risk customers', async () => {
        const atRisk = await service.getAtRiskCustomers();

        expect(Array.isArray(atRisk)).toBe(true);
        atRisk.forEach((customer) => {
          expect(['high', 'medium']).toContain(customer.metrics.churnRisk);
        });
      });

      it('should respect limit', async () => {
        const atRisk = await service.getAtRiskCustomers(2);
        expect(atRisk.length).toBeLessThanOrEqual(2);
      });

      it('should sort by risk level', async () => {
        const atRisk = await service.getAtRiskCustomers();

        if (atRisk.length >= 2) {
          const riskOrder = { high: 0, medium: 1, low: 2 };
          for (let i = 0; i < atRisk.length - 1; i++) {
            expect(riskOrder[atRisk[i].metrics.churnRisk])
              .toBeLessThanOrEqual(riskOrder[atRisk[i + 1].metrics.churnRisk]);
          }
        }
      });
    });

    describe('updateHealthScore', () => {
      it('should update health score', async () => {
        const customers = await service.getCustomers();
        const score = await service.updateHealthScore(customers.customers[0].id);

        expect(score).not.toBeNull();
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      });

      it('should return null for non-existent customer', async () => {
        const score = await service.updateHealthScore('NON-EXISTENT');
        expect(score).toBeNull();
      });
    });

    describe('recordNPSScore', () => {
      it('should record NPS score', async () => {
        const customers = await service.getCustomers();
        const customer = await service.recordNPSScore(customers.customers[0].id, 9);

        expect(customer).not.toBeNull();
        expect(customer!.metrics.npsScore).toBe(9);
      });

      it('should reject invalid NPS scores', async () => {
        const customers = await service.getCustomers();
        const result1 = await service.recordNPSScore(customers.customers[0].id, -1);
        const result2 = await service.recordNPSScore(customers.customers[0].id, 11);

        expect(result1).toBeNull();
        expect(result2).toBeNull();
      });

      it('should return null for non-existent customer', async () => {
        const result = await service.recordNPSScore('NON-EXISTENT', 8);
        expect(result).toBeNull();
      });
    });
  });
});
