/**
 * Batch Processing Routes Unit Tests
 * Tests for batch processing API endpoints
 */

import { Request, Response } from 'express';

// Mock dependencies
const mockBatchProcessingService = {
  submitBatch: jest.fn(),
  getBatchStatus: jest.fn(),
  getBatchMetrics: jest.fn(),
  pauseBatchProcessing: jest.fn(),
  resumeBatchProcessing: jest.fn(),
  retryFailedBatches: jest.fn(),
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
};

// Mock inversify
jest.mock('inversify', () => ({
  injectable: () => (target: any) => target,
  inject: () => () => undefined,
}));

jest.mock('../../../src/inversify/types', () => ({
  TYPES: {
    Logger: Symbol.for('Logger'),
    BatchProcessingService: Symbol.for('BatchProcessingService'),
  },
}));

import { BatchProcessingRouter } from '../../../src/routes/batchProcessing';

describe('Batch Processing Routes', () => {
  let batchRouter: BatchProcessingRouter;
  let router: ReturnType<typeof batchRouter.getRouter>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    batchRouter = new (BatchProcessingRouter as any)(mockLogger, mockBatchProcessingService);
    router = batchRouter.getRouter();
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockNext = jest.fn();
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockReq = {
      params: {},
      body: {},
    };
  });

  // Get the last handler for a route (skips validation middleware)
  const getRouteHandler = (method: string, path: string) => {
    const routes = (router as any).stack || [];
    for (const layer of routes) {
      if (layer.route && layer.route.path === path) {
        const handlers = layer.route.stack.filter(
          (s: any) => s.method === method || !s.method
        );
        // Return the last handler (the actual route handler, after middleware)
        if (handlers.length > 0) {
          return handlers[handlers.length - 1].handle;
        }
      }
    }
    return null;
  };

  describe('POST /submit', () => {
    it('should submit a batch successfully', async () => {
      mockReq.body = {
        integrationId: 'int-123',
        records: [
          { id: 'rec-1', fields: { name: 'Test' } },
          { id: 'rec-2', fields: { name: 'Test 2' } },
        ],
        options: {
          batchSize: 100,
          priority: 5,
        },
      };
      mockBatchProcessingService.submitBatch.mockResolvedValue('job-123');

      const handler = getRouteHandler('post', '/submit');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.submitBatch).toHaveBeenCalledWith(
        'int-123',
        expect.arrayContaining([
          expect.objectContaining({ id: 'rec-1' }),
        ]),
        expect.objectContaining({ batchSize: 100 })
      );
      expect(mockJson).toHaveBeenCalledWith({
        jobId: 'job-123',
        message: 'Batch submitted successfully',
      });
    });

    it('should log batch submission', async () => {
      mockReq.body = {
        integrationId: 'int-123',
        records: [{ id: 'rec-1', fields: {} }],
      };
      mockBatchProcessingService.submitBatch.mockResolvedValue('job-456');

      const handler = getRouteHandler('post', '/submit');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Batch submitted via API',
        expect.objectContaining({
          integrationId: 'int-123',
          recordCount: 1,
          jobId: 'job-456',
        })
      );
    });
  });

  describe('GET /status/:jobId', () => {
    it('should return batch status', async () => {
      mockReq.params = { jobId: 'job-123' };
      const mockStatus = {
        jobId: 'job-123',
        status: 'processing',
        totalRecords: 100,
        processedRecords: 50,
        failedRecords: 2,
      };
      mockBatchProcessingService.getBatchStatus.mockResolvedValue(mockStatus);

      const handler = getRouteHandler('get', '/status/:jobId');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.getBatchStatus).toHaveBeenCalledWith('job-123');
      expect(mockJson).toHaveBeenCalledWith(mockStatus);
    });

    it('should return 404 when job not found', async () => {
      mockReq.params = { jobId: 'nonexistent' };
      mockBatchProcessingService.getBatchStatus.mockResolvedValue(null);

      const handler = getRouteHandler('get', '/status/:jobId');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({
        error: 'Job not found',
        message: 'No batch job found with ID: nonexistent',
      });
    });

    it('should return 400 when job ID is missing', async () => {
      mockReq.params = {};

      const handler = getRouteHandler('get', '/status/:jobId');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: 'Missing job ID',
        message: 'Job ID is required',
      });
    });
  });

  describe('GET /metrics', () => {
    it('should return batch metrics', async () => {
      const mockMetrics = {
        waiting: 10,
        active: 5,
        completed: 100,
        failed: 3,
        delayed: 2,
        paused: false,
      };
      mockBatchProcessingService.getBatchMetrics.mockResolvedValue(mockMetrics);

      const handler = getRouteHandler('get', '/metrics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.getBatchMetrics).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockMetrics);
    });
  });

  describe('POST /pause', () => {
    it('should pause batch processing', async () => {
      mockBatchProcessingService.pauseBatchProcessing.mockResolvedValue(undefined);

      const handler = getRouteHandler('post', '/pause');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.pauseBatchProcessing).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Batch processing paused via API');
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Batch processing paused successfully',
      });
    });
  });

  describe('POST /resume', () => {
    it('should resume batch processing', async () => {
      mockBatchProcessingService.resumeBatchProcessing.mockResolvedValue(undefined);

      const handler = getRouteHandler('post', '/resume');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.resumeBatchProcessing).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Batch processing resumed via API');
      expect(mockJson).toHaveBeenCalledWith({
        message: 'Batch processing resumed successfully',
      });
    });
  });

  describe('POST /retry-failed', () => {
    it('should retry failed batches', async () => {
      mockBatchProcessingService.retryFailedBatches.mockResolvedValue(5);

      const handler = getRouteHandler('post', '/retry-failed');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockBatchProcessingService.retryFailedBatches).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Failed batches retried via API',
        { retriedCount: 5 }
      );
      expect(mockJson).toHaveBeenCalledWith({
        retriedCount: 5,
        message: '5 failed jobs retried successfully',
      });
    });

    it('should handle zero failed jobs', async () => {
      mockBatchProcessingService.retryFailedBatches.mockResolvedValue(0);

      const handler = getRouteHandler('post', '/retry-failed');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({
        retriedCount: 0,
        message: '0 failed jobs retried successfully',
      });
    });
  });

  describe('getRouter', () => {
    it('should return the router instance', () => {
      expect(batchRouter.getRouter()).toBeDefined();
      expect((batchRouter.getRouter() as any).stack).toBeDefined();
    });
  });
});
