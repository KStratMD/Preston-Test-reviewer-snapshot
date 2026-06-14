/**
 * Dashboard Routes Unit Tests
 * Tests for operational dashboard API endpoints
 */

import { Request, Response } from 'express';

// Mock dependencies before imports
const mockPerformanceMonitor = {
  getMetrics: jest.fn(),
  getHealthMetrics: jest.fn(),
};

const mockEventBus = {
  getMetrics: jest.fn(),
  getQueueStatus: jest.fn(),
};

const mockDistributedCache = {
  getMetrics: jest.fn(),
  cleanup: jest.fn(),
};

const mockTelemetryService = {
  getExecutiveSummary: jest.fn(),
  getROIMetrics: jest.fn(),
  getBusinessMetrics: jest.fn(),
  getDashboardData: jest.fn(),
  getSquireMetrics: jest.fn(),
};

const mockQueueProvider = {
  getQueues: jest.fn(),
};

const mockTraceProvider = {
  getRecentSpans: jest.fn(),
};

const mockCredentialProvider = {
  getSummary: jest.fn(),
};

jest.mock('../../../src/utils/monitoring', () => ({
  PerformanceMonitor: {
    getInstance: jest.fn(() => mockPerformanceMonitor),
  },
}));

jest.mock('../../../src/utils/EventBus', () => ({
  EventBus: {
    getInstance: jest.fn(() => mockEventBus),
  },
}));

jest.mock('../../../src/utils/DistributedCache', () => ({
  DistributedCache: jest.fn(() => mockDistributedCache),
}));

jest.mock('../../../src/dashboard/providers', () => ({
  createMockProviders: jest.fn(() => ({
    queueProvider: mockQueueProvider,
    traceProvider: mockTraceProvider,
    credentialProvider: mockCredentialProvider,
  })),
  QueueStatsProvider: jest.fn(),
  TraceProvider: jest.fn(),
  CredentialSummaryProvider: jest.fn(),
}));

jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn(() => mockTelemetryService),
  },
}));

jest.mock('../../../src/inversify/types', () => ({
  TYPES: {
    TelemetryService: Symbol.for('TelemetryService'),
  },
}));

jest.mock('prom-client', () => ({
  register: {
    metrics: jest.fn().mockResolvedValue(''),
  },
}));

// Set environment variable before importing
process.env.DASHBOARD_DISABLE_INTERVALS = '1';

import { OperationalDashboard, createOperationalDashboard } from '../../../src/routes/dashboard';

describe('Dashboard Routes', () => {
  let dashboard: OperationalDashboard;
  let router: ReturnType<typeof createOperationalDashboard>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock returns
    mockPerformanceMonitor.getMetrics.mockReturnValue({
      requestCount: 100,
      averageResponseTime: 50,
    });

    mockPerformanceMonitor.getHealthMetrics.mockReturnValue({
      telemetryEnabled: true,
    });

    mockEventBus.getMetrics.mockReturnValue({
      totalEventsProcessed: 1000,
      totalEventsFailed: 10,
      eventsByType: { sync: 500, webhook: 500 },
      errorsByType: { sync: 5, webhook: 5 },
      averageProcessingTime: 100,
      activeSubscriptions: 5,
    });

    mockEventBus.getQueueStatus.mockReturnValue({
      waiting: 10,
      processing: 5,
    });

    mockDistributedCache.getMetrics.mockResolvedValue({
      hitRate: 0.85,
      hits: 850,
      misses: 150,
      sets: 1000,
    });

    mockQueueProvider.getQueues.mockResolvedValue([
      { name: 'sync-queue', size: 100, processing: 5 },
    ]);

    mockTraceProvider.getRecentSpans.mockResolvedValue([
      { traceId: 'trace-1', name: 'request' },
    ]);

    mockCredentialProvider.getSummary.mockResolvedValue({
      totalStored: 10,
      providers: ['NetSuite', 'Salesforce'],
      encryption: 'AES-256',
    });

    dashboard = new OperationalDashboard();
    router = dashboard.getRouter();

    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockSend = jest.fn().mockReturnThis();
    mockRes = {
      json: mockJson,
      status: mockStatus,
      send: mockSend,
    };
    mockReq = {
      params: {},
      query: {},
    };
  });

  afterEach(() => {
    dashboard.cleanup();
  });

  const getRouteHandler = (method: string, path: string) => {
    const routes = (router as any).stack || [];
    for (const layer of routes) {
      if (layer.route && layer.route.path === path) {
        const methodHandler = layer.route.stack.find(
          (s: any) => s.method === method
        );
        if (methodHandler) {
          return methodHandler.handle;
        }
      }
    }
    return null;
  };

  describe('GET /', () => {
    it('should return dashboard HTML', async () => {
      const handler = getRouteHandler('get', '/');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockSend).toHaveBeenCalled();
      const htmlContent = mockSend.mock.calls[0][0];
      expect(htmlContent).toContain('<!DOCTYPE html>');
      expect(htmlContent).toContain('Operational Dashboard');
    });
  });

  describe('GET /api/business-metrics', () => {
    it('should return business metrics', async () => {
      const handler = getRouteHandler('get', '/api/business-metrics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationSuccessRates: expect.any(Object),
          dataVolumeProcessed: expect.objectContaining({
            total: expect.any(Number),
          }),
          errorPatterns: expect.objectContaining({
            totalErrors: expect.any(Number),
          }),
          performanceMetrics: expect.objectContaining({
            averageResponseTime: expect.any(Number),
          }),
          systemHealth: expect.objectContaining({
            uptime: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/security-metrics', () => {
    it('should return security metrics', async () => {
      const handler = getRouteHandler('get', '/api/security-metrics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticationAttempts: expect.objectContaining({
            successful: expect.any(Number),
            failed: expect.any(Number),
          }),
          rateLimitingEvents: expect.objectContaining({
            totalBlocked: expect.any(Number),
          }),
          threatDetection: expect.objectContaining({
            suspiciousActivity: expect.any(Number),
          }),
          securityMetrics: expect.objectContaining({
            cspViolations: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/performance-metrics', () => {
    it('should return performance metrics', async () => {
      const handler = getRouteHandler('get', '/api/performance-metrics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          responseTimes: expect.objectContaining({
            current: expect.any(Number),
          }),
          memoryUsage: expect.objectContaining({
            current: expect.any(Object),
          }),
          connectionPools: expect.objectContaining({
            totalConnections: expect.any(Number),
          }),
          cacheMetrics: expect.objectContaining({
            hitRate: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/system-status', () => {
    it('should return system status', async () => {
      const handler = getRouteHandler('get', '/api/system-status');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          overall: 'healthy',
          components: expect.objectContaining({
            monitoring: expect.any(Object),
            eventBus: expect.any(Object),
            cache: expect.any(Object),
          }),
          metrics: expect.objectContaining({
            uptime: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/metrics/history/:type', () => {
    it('should return business metrics history', async () => {
      mockReq.params = { type: 'business' };
      mockReq.query = { hours: '24' };

      const handler = getRouteHandler('get', '/api/metrics/history/:type');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'business',
          history: expect.any(Array),
          count: expect.any(Number),
        })
      );
    });

    it('should return security metrics history', async () => {
      mockReq.params = { type: 'security' };

      const handler = getRouteHandler('get', '/api/metrics/history/:type');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'security',
        })
      );
    });

    it('should return performance metrics history', async () => {
      mockReq.params = { type: 'performance' };

      const handler = getRouteHandler('get', '/api/metrics/history/:type');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'performance',
        })
      );
    });
  });

  describe('GET /api/websocket-info', () => {
    it('should return websocket info', async () => {
      const handler = getRouteHandler('get', '/api/websocket-info');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          available: false,
          pollingInterval: 5000,
          endpoints: expect.any(Object),
        })
      );
    });
  });

  describe('GET /api/summary', () => {
    it('should return summary stats', async () => {
      const handler = getRouteHandler('get', '/api/summary');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          activeIntegrations: expect.any(Number),
          successRate: expect.any(Number),
          timestamp: expect.any(String),
        })
      );
    });
  });

  describe('GET /api/recent-activity', () => {
    it('should return recent activity', async () => {
      const handler = getRouteHandler('get', '/api/recent-activity');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.any(Array),
        })
      );
    });
  });

  describe('POST /api/seed-mock', () => {
    it('should seed mock data', async () => {
      const handler = getRouteHandler('post', '/api/seed-mock');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          seeded: true,
          count: expect.any(Number),
        })
      );
    });
  });

  describe('GET /api/traces', () => {
    it('should return recent traces', async () => {
      const handler = getRouteHandler('get', '/api/traces');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockTraceProvider.getRecentSpans).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          spans: expect.any(Array),
        })
      );
    });
  });

  describe('GET /api/queues', () => {
    it('should return queue status', async () => {
      const handler = getRouteHandler('get', '/api/queues');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockQueueProvider.getQueues).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          queues: expect.any(Array),
          generatedAt: expect.any(String),
        })
      );
    });
  });

  describe('GET /api/credentials', () => {
    it('should return credential summary', async () => {
      const handler = getRouteHandler('get', '/api/credentials');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockCredentialProvider.getSummary).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          totalStored: 10,
          providers: ['NetSuite', 'Salesforce'],
          encryption: 'AES-256',
        })
      );
    });
  });

  describe('GET /api/ai-metrics', () => {
    it('should return AI metrics', async () => {
      const handler = getRouteHandler('get', '/api/ai-metrics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expect.any(String),
          suggestionsGenerated: expect.any(Number),
          avgLatencyMs: expect.any(Number),
          mappingAccuracy: expect.any(Number),
        })
      );
    });
  });

  describe('GET /api/capabilities', () => {
    it('should return system capabilities', async () => {
      const handler = getRouteHandler('get', '/api/capabilities');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          queues: expect.any(String),
          traces: expect.any(String),
          credentials: expect.any(String),
          streaming: 'sse',
        })
      );
    });
  });

  describe('GET /api/export', () => {
    it('should export dashboard snapshot', async () => {
      const mockSetHeader = jest.fn();
      mockRes.setHeader = mockSetHeader;

      const handler = getRouteHandler('get', '/api/export');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockSetHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockSetHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="dashboard-snapshot.json"'
      );
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          takenAt: expect.any(String),
          summary: expect.any(Object),
          recentActivity: expect.any(Array),
        })
      );
    });
  });

  describe('Squire Telemetry Endpoints', () => {
    describe('GET /api/squire/executive-summary', () => {
      it('should return executive summary', async () => {
        mockTelemetryService.getExecutiveSummary.mockResolvedValue({
          overallHealth: 'good',
          keyMetrics: {},
        });

        const handler = getRouteHandler('get', '/api/squire/executive-summary');
        if (handler) {
          await handler(mockReq as Request, mockRes as Response);
        }

        expect(mockTelemetryService.getExecutiveSummary).toHaveBeenCalled();
        expect(mockJson).toHaveBeenCalledWith({
          overallHealth: 'good',
          keyMetrics: {},
        });
      });
    });

    describe('GET /api/squire/roi-metrics', () => {
      it('should return ROI metrics', async () => {
        mockTelemetryService.getROIMetrics.mockResolvedValue({
          totalSavings: 50000,
          automationRate: 85,
        });

        const handler = getRouteHandler('get', '/api/squire/roi-metrics');
        if (handler) {
          await handler(mockReq as Request, mockRes as Response);
        }

        expect(mockTelemetryService.getROIMetrics).toHaveBeenCalled();
        expect(mockJson).toHaveBeenCalledWith({
          totalSavings: 50000,
          automationRate: 85,
        });
      });
    });

    describe('GET /api/squire/business-metrics', () => {
      it('should return Squire business metrics', async () => {
        mockTelemetryService.getBusinessMetrics.mockResolvedValue({
          integrations: 10,
          syncSuccess: 99.5,
        });

        const handler = getRouteHandler('get', '/api/squire/business-metrics');
        if (handler) {
          await handler(mockReq as Request, mockRes as Response);
        }

        expect(mockTelemetryService.getBusinessMetrics).toHaveBeenCalled();
      });
    });

    describe('GET /api/squire/dashboard-data', () => {
      it('should return Squire dashboard data', async () => {
        mockTelemetryService.getDashboardData.mockResolvedValue({
          widgets: [],
          lastUpdated: new Date().toISOString(),
        });

        const handler = getRouteHandler('get', '/api/squire/dashboard-data');
        if (handler) {
          await handler(mockReq as Request, mockRes as Response);
        }

        expect(mockTelemetryService.getDashboardData).toHaveBeenCalled();
      });
    });

    describe('GET /api/squire/metrics', () => {
      it('should return Squire-specific metrics', async () => {
        mockTelemetryService.getSquireMetrics.mockResolvedValue({
          customMetrics: {},
        });

        const handler = getRouteHandler('get', '/api/squire/metrics');
        if (handler) {
          await handler(mockReq as Request, mockRes as Response);
        }

        expect(mockTelemetryService.getSquireMetrics).toHaveBeenCalled();
      });
    });
  });

  describe('createOperationalDashboard', () => {
    it('should create a router instance', () => {
      const router = createOperationalDashboard();
      expect(router).toBeDefined();
      expect((router as any).stack).toBeDefined();
    });
  });
});
