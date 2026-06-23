/**
 * BatchProcessor Unit Tests
 * Tests for batch request processing middleware
 */

import { Request, Response } from 'express';
import { BatchProcessor, BatchRequest, BatchOperation, createBatchEndpoint } from '../../../src/middleware/batchProcessor';

describe('BatchProcessor', () => {
  let batchProcessor: BatchProcessor;
  let mockApp: any;
  let mockRequest: Partial<Request>;

  beforeEach(() => {
    mockApp = {
      handle: jest.fn(),
    };

    mockRequest = {
      headers: { 'content-type': 'application/json' },
      user: { id: 'user-123' },
    };

    batchProcessor = new BatchProcessor(mockApp, '/api');
  });

  describe('processBatch()', () => {
    describe('parallel processing', () => {
      it('should process operations in parallel by default', async () => {
        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/users' },
            { method: 'GET', path: '/items' },
          ],
          sequential: false,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.results.length).toBe(2);
        expect(result.successCount).toBe(2);
        expect(result.errorCount).toBe(0);
        expect(result.hasErrors).toBe(false);
      });

      it('should handle mixed success and failure in parallel', async () => {
        let callCount = 0;
        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          callCount++;
          if (callCount === 1) {
            res.status(200).json({ success: true });
          } else {
            res.status(404).json({ error: 'Not found' });
          }
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/users/1' },
            { method: 'GET', path: '/users/999' },
          ],
          sequential: false,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.hasErrors).toBe(true);
        expect(result.successCount).toBe(1);
        expect(result.errorCount).toBe(1);
      });
    });

    describe('sequential processing', () => {
      it('should process operations sequentially when sequential is true', async () => {
        const callOrder: number[] = [];
        let callCount = 0;

        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          callCount++;
          callOrder.push(callCount);
          res.status(200).json({ order: callCount });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/first' },
            { method: 'GET', path: '/second' },
            { method: 'GET', path: '/third' },
          ],
          sequential: true,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.results.length).toBe(3);
        expect(callOrder).toEqual([1, 2, 3]);
      });

      it('should stop on error when stopOnError is true', async () => {
        let callCount = 0;

        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          callCount++;
          if (callCount === 2) {
            res.status(500).json({ error: 'Server error' });
          } else {
            res.status(200).json({ success: true });
          }
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/first' },
            { method: 'GET', path: '/second' },
            { method: 'GET', path: '/third' },
          ],
          sequential: true,
          stopOnError: true,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        // Should stop after second operation fails
        expect(result.results.length).toBe(2);
        expect(result.successCount).toBe(1);
        expect(result.errorCount).toBe(1);
        expect(result.hasErrors).toBe(true);
      });

      it('should continue on error when stopOnError is false', async () => {
        let callCount = 0;

        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          callCount++;
          if (callCount === 2) {
            res.status(500).json({ error: 'Server error' });
          } else {
            res.status(200).json({ success: true });
          }
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/first' },
            { method: 'GET', path: '/second' },
            { method: 'GET', path: '/third' },
          ],
          sequential: true,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.results.length).toBe(3);
        expect(result.successCount).toBe(2);
        expect(result.errorCount).toBe(1);
      });
    });

    describe('operation handling', () => {
      it('should include operation id in response', async () => {
        mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { id: 'op-1', method: 'GET', path: '/users' },
            { id: 'op-2', method: 'POST', path: '/items' },
          ],
          sequential: false,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.results[0].id).toBe('op-1');
        expect(result.results[1].id).toBe('op-2');
      });

      it('should pass request body to operation', async () => {
        let capturedBody: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedBody = req.body;
          res.status(201).json({ created: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            {
              method: 'POST',
              path: '/users',
              body: { name: 'John', email: 'john@example.com' }
            },
          ],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedBody).toEqual({ name: 'John', email: 'john@example.com' });
      });

      it('should merge operation headers with original request headers', async () => {
        let capturedHeaders: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedHeaders = req.headers;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            {
              method: 'GET',
              path: '/users',
              headers: { 'x-custom-header': 'custom-value' }
            },
          ],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedHeaders['content-type']).toBe('application/json');
        expect(capturedHeaders['x-custom-header']).toBe('custom-value');
        expect(capturedHeaders['x-batch-request']).toBe('true');
      });

      it('should preserve user authentication', async () => {
        let capturedUser: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedUser = req.user;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [{ method: 'GET', path: '/protected' }],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedUser).toEqual({ id: 'user-123' });
      });

      it('should handle errors from operations', async () => {
        mockApp.handle.mockImplementation((_req: any, _res: any, next: any) => {
          next(new Error('Operation failed'));
        });

        const batchRequest: BatchRequest = {
          operations: [{ method: 'GET', path: '/error' }],
          sequential: false,
          stopOnError: false,
        };

        const result = await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(result.results[0].status).toBe(500);
        expect(result.results[0].error).toBe('Operation failed');
        expect(result.hasErrors).toBe(true);
      });
    });

    describe('query string parsing', () => {
      it('should parse query string from path', async () => {
        let capturedQuery: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedQuery = req.query;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/users?page=1&limit=10' },
          ],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedQuery).toEqual({ page: '1', limit: '10' });
      });

      it('should handle URL-encoded query parameters', async () => {
        let capturedQuery: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedQuery = req.query;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/search?q=hello%20world&filter=name%3Dtest' },
          ],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedQuery.q).toBe('hello world');
        expect(capturedQuery.filter).toBe('name=test');
      });

      it('should handle empty query string', async () => {
        let capturedQuery: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedQuery = req.query;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [{ method: 'GET', path: '/users' }],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedQuery).toEqual({});
      });

      it('should handle query parameter without value', async () => {
        let capturedQuery: any;

        mockApp.handle.mockImplementation((req: any, res: any, next: any) => {
          capturedQuery = req.query;
          res.status(200).json({ success: true });
          next();
        });

        const batchRequest: BatchRequest = {
          operations: [
            { method: 'GET', path: '/users?active&verified' },
          ],
          sequential: false,
          stopOnError: false,
        };

        await batchProcessor.processBatch(mockRequest as Request, batchRequest);

        expect(capturedQuery.active).toBe('');
        expect(capturedQuery.verified).toBe('');
      });
    });
  });
});

describe('createBatchEndpoint', () => {
  let mockApp: any;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    mockApp = {
      handle: jest.fn().mockImplementation((_req: any, res: any, next: any) => {
        res.status(200).json({ success: true });
        next();
      }),
    };

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      body: {
        operations: [{ method: 'GET', path: '/test' }],
      },
      headers: {},
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
    };
  });

  it('should create batch endpoint handler', () => {
    const handler = createBatchEndpoint(mockApp);

    expect(typeof handler).toBe('function');
  });

  it('should process valid batch request', async () => {
    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        results: expect.any(Array),
        hasErrors: false,
        successCount: 1,
        errorCount: 0,
      })
    );
  });

  it('should return 207 Multi-Status when there are errors', async () => {
    mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
      res.status(500).json({ error: 'fail' });
      next();
    });

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(207);
  });

  it('should return 400 for invalid batch request', async () => {
    mockRequest.body = {
      operations: [], // Empty operations array - invalid
    };

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Invalid batch request',
        details: expect.any(Array),
      })
    );
  });

  it('should return 400 for missing operations', async () => {
    mockRequest.body = {};

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('should return 400 for invalid method', async () => {
    mockRequest.body = {
      operations: [{ method: 'INVALID', path: '/test' }],
    };

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(400);
  });

  it('should handle errors within batch operations', async () => {
    // When operations fail, the batch processor catches them and returns 500 status per operation
    mockApp.handle.mockImplementation((_req: any, _res: any, next: any) => {
      next(new Error('Operation error'));
    });

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    // 207 Multi-Status because there are errors in the batch
    expect(statusMock).toHaveBeenCalledWith(207);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasErrors: true,
        errorCount: 1,
      })
    );
  });

  it('should handle sequential option from request', async () => {
    mockRequest.body = {
      operations: [
        { method: 'GET', path: '/first' },
        { method: 'GET', path: '/second' },
      ],
      sequential: true,
    };

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('should handle stopOnError option from request', async () => {
    mockRequest.body = {
      operations: [
        { method: 'GET', path: '/first' },
        { method: 'GET', path: '/second' },
      ],
      sequential: true,
      stopOnError: true,
    };

    let callCount = 0;
    mockApp.handle.mockImplementation((_req: any, res: any, next: any) => {
      callCount++;
      if (callCount === 1) {
        res.status(500).json({ error: 'fail' });
      } else {
        res.status(200).json({ success: true });
      }
      next();
    });

    const handler = createBatchEndpoint(mockApp);

    await handler(mockRequest as Request, mockResponse as Response);

    // Should stop after first failure
    expect(callCount).toBe(1);
  });
});
