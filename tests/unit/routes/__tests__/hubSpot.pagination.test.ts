/**
 * HubSpot Pagination Tests
 *
 * Verifies that HubSpot list endpoints return correct pagination metadata
 * with total/totalKnown/hasMore fields using DemoConnectorDecorator.count().
 */

import request from 'supertest';
import express from 'express';
import type { IConnector } from '../../../../src/interfaces/IConnector';
import type { DataRecord } from '../../../../src/types';
import { setDemoModeOverride } from '../../../../src/config/runtimeFlags';

// Mock the DI container
const mockConnector: Partial<IConnector> & { count?: (entityType: string, filters?: Record<string, unknown>, operator?: 'AND' | 'OR') => number } = {
  systemType: 'HubSpot',
  systemId: 'hubspot-1',
  initialize: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue([]),
  search: jest.fn().mockResolvedValue([]),
  testConnection: jest.fn().mockResolvedValue({ isConnected: true, systemType: 'HubSpot', systemId: 'hubspot-1', lastTestTime: new Date(), latency: 1 }),
  count: jest.fn().mockReturnValue(30),
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
      if (type === TYPES.HubSpotConnector) return mockConnector;
      if (type === TYPES.Logger) return mockLogger;
      return undefined;
    }),
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  const { hubSpotRouter } = require('../../../../src/routes/hubSpot');
  app.use('/api/hubspot', hubSpotRouter);
  return app;
}

describe('HubSpot Pagination', () => {
  let app: express.Application;

  beforeEach(() => {
    setDemoModeOverride(true);
    jest.clearAllMocks();
    app = createApp();

    (mockConnector.count as jest.Mock).mockReturnValue(30);
    (mockConnector.list as jest.Mock).mockResolvedValue([
      { id: 'c1', fields: { email: 'a@test.com' } },
      { id: 'c2', fields: { email: 'b@test.com' } },
    ] as DataRecord[]);
    (mockConnector.search as jest.Mock).mockResolvedValue([
      { id: 's1', fields: { name: 'Search Result' } },
    ] as DataRecord[]);
  });

  afterEach(() => {
    setDemoModeOverride(undefined);
  });

  describe('GET /contacts', () => {
    it('should include totalKnown and hasMore in pagination', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 1,
        pageSize: 2,
        total: 30,
        totalKnown: true,
        hasMore: true,
      });
    });

    it('should handle unknown count', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .get('/api/hubspot/contacts?page=1&pageSize=2');

      expect(res.body.pagination.total).toBeNull();
      expect(res.body.pagination.totalKnown).toBe(false);
      expect(res.body.pagination.hasMore).toBe(true);
    });
  });

  describe('GET /companies', () => {
    it('should include pagination metadata', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(12);

      const res = await request(app)
        .get('/api/hubspot/companies?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(12);
      expect(res.body.pagination.totalKnown).toBe(true);
    });
  });

  describe('GET /deals', () => {
    it('should include pagination metadata', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(7);

      const res = await request(app)
        .get('/api/hubspot/deals?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(7);
      expect(res.body.pagination.totalKnown).toBe(true);
    });
  });

  describe('GET /tickets', () => {
    it('should include pagination metadata', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(5);

      const res = await request(app)
        .get('/api/hubspot/tickets?page=1&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.total).toBe(5);
      expect(res.body.pagination.totalKnown).toBe(true);
    });
  });

  describe('POST /search/:entityType', () => {
    it('should include totalKnown and hasMore in search response', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(10);

      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: { email: 'test' }, limit: 5, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(10);
      expect(res.body.totalKnown).toBe(true);
      expect(res.body.hasMore).toBe(true);
    });

    it('should return total=null when count unavailable', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: {}, limit: 100, offset: 0 });

      expect(res.body.total).toBeNull();
      expect(res.body.totalKnown).toBe(false);
    });
  });

  describe('GET /dashboard', () => {
    it('should accept page and pageSize query params', async () => {
      const res = await request(app)
        .get('/api/hubspot/dashboard?page=2&pageSize=5');

      expect(res.status).toBe(200);
      expect(res.body.contactsPagination).toBeDefined();
      expect(res.body.contactsPagination.page).toBe(2);
      expect(res.body.contactsPagination.pageSize).toBe(5);
      expect(res.body.companiesPagination).toBeDefined();
      expect(res.body.dealsPagination).toBeDefined();
      expect(res.body.ticketsPagination).toBeDefined();
    });

    it('should use count() for statistics', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(50);

      const res = await request(app)
        .get('/api/hubspot/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics.totalContacts).toBe(50);
      expect(res.body.statistics.totalCompanies).toBe(50);
      expect(res.body.statistics.totalDeals).toBe(50);
      expect(res.body.statistics.totalTickets).toBe(50);
    });

    it('should default to page=1, pageSize=10', async () => {
      const res = await request(app)
        .get('/api/hubspot/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.contactsPagination.page).toBe(1);
      expect(res.body.contactsPagination.pageSize).toBe(10);
    });

    it('should fetch unpaginated lists for statistics when count is unavailable', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);
      (mockConnector.list as jest.Mock).mockImplementation(
        (_entityType: string, options?: { limit?: number }) => {
          if (options?.limit) return Promise.resolve([{ id: '1', fields: {} }, { id: '2', fields: {} }]);
          return Promise.resolve(Array.from({ length: 15 }, (_, i) => ({ id: `all-${i}`, fields: {} })));
        },
      );

      const res = await request(app)
        .get('/api/hubspot/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics.totalContacts).toBe(15);
      expect(res.body.statistics.totalCompanies).toBe(15);
      expect(res.body.statistics.totalDeals).toBe(15);
      expect(res.body.statistics.totalTickets).toBe(15);
    });
  });

  describe('Invalid pagination inputs', () => {
    it('should default page=1 when page=0', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=0&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default page=1 when page is negative', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=-3&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default page=1 when page is non-numeric', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=abc&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
    });

    it('should default pageSize=50 when pageSize=0', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=1&pageSize=0');

      expect(res.status).toBe(200);
      expect(res.body.pagination.pageSize).toBe(50);
    });

    it('should default pageSize=50 when pageSize is non-numeric', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=1&pageSize=abc');

      expect(res.status).toBe(200);
      expect(res.body.pagination.pageSize).toBe(50);
    });

    it('should handle both page and pageSize invalid', async () => {
      const res = await request(app)
        .get('/api/hubspot/contacts?page=-1&pageSize=-5');

      expect(res.status).toBe(200);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.pageSize).toBe(50);
    });
  });

  describe('Invalid search inputs', () => {
    it('should default limit=100 when limit is negative', async () => {
      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: {}, limit: -5, offset: 0 });

      expect(res.status).toBe(200);
      // Search should still succeed with safe defaults
      expect(res.body.results).toBeDefined();
    });

    it('should default offset=0 when offset is negative', async () => {
      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: {}, limit: 10, offset: -2 });

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
    });

    it('should default limit=100 when limit is non-numeric', async () => {
      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: {}, limit: 'abc', offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
    });
  });

  describe('Non-demo mode', () => {
    beforeEach(() => {
      setDemoModeOverride(false);
    });

    it('should return total=null and totalKnown=false for list endpoints', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .get('/api/hubspot/contacts?page=1&pageSize=2');

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
        .get('/api/hubspot/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.statistics).toBeDefined();
      expect(res.body.recentContacts).toBeDefined();
      expect(res.body.contactsPagination).toBeDefined();
      expect(res.body.companiesPagination).toBeDefined();
      expect(res.body.dealsPagination).toBeDefined();
      expect(res.body.ticketsPagination).toBeDefined();
    });

    it('should return total=null for search when count unavailable', async () => {
      (mockConnector.count as jest.Mock).mockReturnValue(-1);

      const res = await request(app)
        .post('/api/hubspot/search/contacts')
        .send({ filters: {}, limit: 100, offset: 0 });

      expect(res.body.total).toBeNull();
      expect(res.body.totalKnown).toBe(false);
    });
  });
});
