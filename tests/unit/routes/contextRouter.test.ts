import express, { type RequestHandler } from 'express';
import request from 'supertest';

const mockContainerGet = jest.fn();
const mockAnalyzeContext = jest.fn();
const mockGetAIContextAnalyzer = jest.fn(() => ({ analyzeContext: mockAnalyzeContext }));
const mockGetCustomer = jest.fn();
const mockGetCustomerTickets = jest.fn();

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: { get: mockContainerGet },
}));

jest.mock('../../../src/services/ai/AIContextAnalyzer', () => ({
  getAIContextAnalyzer: mockGetAIContextAnalyzer,
}));

import { contextRouter } from '../../../src/routes/ContextRouter';

function createApp(authenticated: boolean): express.Application {
  const app = express();
  const identityStub: RequestHandler = (req, _res, next) => {
    if (authenticated) {
      req.user = {
        id: 'user-1',
        username: 'user-1',
        tenantId: 'tenant-a',
        roles: ['user'],
        permissions: [],
      };
    }
    next();
  };
  app.use(identityStub);
  app.use('/api/context', contextRouter);
  return app;
}

describe('ContextRouter F5 identity and anonymous isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContainerGet.mockReturnValue({
      getCustomer: mockGetCustomer,
      getCustomerTickets: mockGetCustomerTickets,
    });
    mockGetCustomer.mockResolvedValue({
      id: '123',
      metrics: {
        churnRisk: 'low',
        daysSinceLastOrder: 1,
        lifetimeValue: 100,
        npsScore: 80,
      },
    });
    mockGetCustomerTickets.mockResolvedValue([]);
    mockAnalyzeContext.mockResolvedValue([{ type: 'mocked-insight' }]);
  });

  it('returns the production envelope from fallback data without touching services or the analyzer when anonymous', async () => {
    const res = await request(createApp(false)).get('/api/context/NetSuite/Customer/123');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      system: 'netsuite',
      recordType: 'customer',
      recordId: '123',
      modules: ['CustomerCentral', 'PaymentCentral', 'SyncCentral'],
      dataSource: 'demo',
      aiInsights: [],
    });
    expect(res.body).toEqual(expect.objectContaining({
      riskScore: expect.any(Number),
      riskLevel: expect.any(String),
      alerts: expect.any(Array),
      quickActions: expect.any(Array),
      insights: expect.any(Array),
      lastUpdated: expect.any(String),
    }));
    expect(mockContainerGet).not.toHaveBeenCalled();
    expect(mockGetAIContextAnalyzer).not.toHaveBeenCalled();
    expect(mockAnalyzeContext).not.toHaveBeenCalled();
  });

  it('uses tenant identity but never calls the unscoped customer service for authenticated customer context', async () => {
    const res = await request(createApp(true)).get('/api/context/netsuite/customer/123');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      system: 'netsuite',
      recordType: 'customer',
      recordId: '123',
      dataSource: 'fallback',
      aiInsights: [{ type: 'mocked-insight' }],
    });
    expect(mockGetCustomer).not.toHaveBeenCalled();
    expect(mockGetCustomerTickets).not.toHaveBeenCalled();
    expect(mockGetAIContextAnalyzer).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeContext).toHaveBeenCalledTimes(1);
  });
});
