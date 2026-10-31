/**
 * ShipStation Pagination Tests
 *
 * Verifies that ShipStation list endpoints return correct pagination metadata
 * with total/totalKnown/hasMore fields using DemoConnectorDecorator.count().
 */

import request from 'supertest';
import express from 'express';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { DataRecord } from '../../../../src/types';
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

// Mock the DI container
const mockConnector: Partial<IConnector> & { count?: (entityType: string, filters?: Record<string, unknown>, operator?: 'AND' | 'OR') => number } = {
  systemType: 'ShipStation',
  systemId: 'shipstation-1',
  initialize: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue([]),
  search: jest.fn().mockResolvedValue([]),
  testConnection: jest.fn().mockResolvedValue({ isConnected: true, systemType: 'ShipStation', systemId: 'shipstation-1', lastTestTime: new Date(), latency: 1 }),
  count: jest.fn().mockReturnValue(25),
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const TYPES = require('../../../../src/inversify/types').TYPES;
      if (type === TYPES.ShipStationConnector) return mockConnector;
      if (type === TYPES.Logger) return mockLogger;
      return undefined;
    }),
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  const { shipStationRouter } = require('../../../../src/routes/shipStation');
  app.use('/api/shipstation', shipStationRouter);
  return app;
}

describe('ShipStation Pagination', () => {
  let app: express.Application;

  beforeEach(() => {
    setDemoModeOverride(true);
    jest.clearAllMocks();
    app = createApp();

    // Default: count() returns 25, list returns 2 items
    (mockConnector.count as jest.Mock).mockReturnValue(25);
    (mockConnector.list as jest.Mock).mockResolvedValue([
      { id: 'ord-1', fields: { orderNumber: 'ORD-001' } },
      { id: 'ord-2', fields: { orderNumber: 'ORD-002' } },
    ] as DataRecord[]);
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('GET /orders', () => {
    it('should include totalKnown and hasMore in pagination when count is available', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 1,
        pageSize: 2,
        total: 25,
        totalKnown: true,
        hasMore: true,
      });
    });

    it('should set hasMore=false when on last page', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(2);

      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.pagination.hasMore).toBe(false);
    });

    it('should handle unknown count (count returns -1)', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 1,
        pageSize: 2,
        total: null,
        totalKnown: false,
        hasMore: true, // items.length === pageSize heuristic
      });
    });

    it('should set hasMore=false heuristic when items < pageSize', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);
      (mockConnector.list as jest.Mock).mockResolvedValue([
        { id: 'ord-1', fields: {} },
      ]);

      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=5');

      expect(res.body.pagination.hasMore).toBe(false);
    });
  });

  describe('GET /shipments', () => {
    it('should include accurate pagination metadata', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(15);

      const res = await request(app)
        .get('/api/shipstation/shipments?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(15);
      expect(res.body.pagination.totalKnown).toBe(true);
      expect(res.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /products', () => {
    it('should include accurate pagination metadata', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(8);

      const res = await request(app)
        .get('/api/shipstation/products?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(8);
      expect(res.body.pagination.totalKnown).toBe(true);
    });
  });

  describe('GET /dashboard', () => {
    it('should accept page and pageSize query params', async () => {
      const res = await request(app)
        .get('/api/shipstation/dashboard?page=2&pageSize=5');

      expect(res.status).toBe(200);
      expect(res.body.pendingOrdersPagination).toBeDefined();
      expect(res.body.pendingOrdersPagination.page).toBe(2);
      expect(res.body.pendingOrdersPagination.pageSize).toBe(5);
      expect(res.body.shipmentsPagination).toBeDefined();
      expect(res.body.shipmentsPagination.page).toBe(2);
    });

    it('should use count() for statistics when available', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(42);

      const res = await request(app)
        .get('/api/shipstation/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics.totalOrders).toBe(42);
      expect(res.body.statistics.totalShipments).toBe(42);
    });

    it('should default to page=1, pageSize=10', async () => {
      const res = await request(app)
        .get('/api/shipstation/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.pendingOrdersPagination.page).toBe(1);
      expect(res.body.pendingOrdersPagination.pageSize).toBe(10);
    });

    it('should fetch unpaginated lists for statistics when count is unavailable', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);
      // Paginated call returns 2, unpaginated fallback returns 7
      (mockConnector.list as jest.Mock).mockImplementation(
        (_entityType: string, options?: { limit?: number }) => {
          if (options?.limit) return Promise.resolve([{ id: '1', fields: {} }, { id: '2', fields: {} }]);
          return Promise.resolve(Array.from({ length: 7 }, (_, i) => ({ id: `all-${i}`, fields: {} })));
        },
      );

      const res = await request(app)
        .get('/api/shipstation/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics.totalOrders).toBe(7);
      expect(res.body.statistics.totalShipments).toBe(7);
    });
  });

  describe('Invalid pagination inputs', () => {
    it('should default page=1 when page=0', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=0&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default page=1 when page is negative', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=-3&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default page=1 when page is non-numeric', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=abc&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default pageSize=50 when pageSize=0', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=0');

      expect(res.status).toBe(200);
      expect(res.body.pagination.pageSize).toBe(50);
    });

    it('should default pageSize=50 when pageSize is non-numeric', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=abc');

      expect(res.status).toBe(200);
      expect(res.body.pagination.pageSize).toBe(50);
    });

    it('should handle both page and pageSize invalid', async () => {
      const res = await request(app)
        .get('/api/shipstation/orders?page=-1&pageSize=-5');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.pageSize).toBe(50);
    });
  });

  describe('Non-demo mode', () => {
    beforeEach(() => {
      setDemoModeOverride(false);
    });

    it('should return total=null and totalKnown=false for list endpoints', async () => {
      // In non-demo, count() returns -1
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .get('/api/shipstation/orders?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBeNull();
      expect(res.body.pagination.totalKnown).toBe(false);
    });

    it('should still return valid response structure for dashboard', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);
      (mockConnector.list as jest.Mock).mockResolvedValue([
        { id: '1', fields: {} },
      ]);

      const res = await request(app)
        .get('/api/shipstation/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics).toBeDefined();
      expect(res.body.pendingOrders).toBeDefined();
      expect(res.body.pendingOrdersPagination).toBeDefined();
      expect(res.body.shipmentsPagination).toBeDefined();
    });
  });
});
