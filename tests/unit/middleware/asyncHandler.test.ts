/**
 * AsyncHandler Middleware Unit Tests
 * Tests for async request handler wrapper
 */

import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../src/middleware/asyncHandler';

describe('asyncHandler', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  it('should call the handler function with req, res, and next', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(handler).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
  });

  it('should allow handler to complete successfully', async () => {
    const handler = jest.fn().mockImplementation(async (req, res) => {
      res.json({ success: true });
    });
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should catch errors and pass them to next', async () => {
    const error = new Error('Test error');
    const handler = jest.fn().mockRejectedValue(error);
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(error);
  });

  it('should catch synchronous errors thrown in handler', async () => {
    const error = new Error('Sync error');
    const handler = jest.fn().mockImplementation(async () => {
      throw error;
    });
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(error);
  });

  it('should handle handlers that return values', async () => {
    const handler = jest.fn().mockResolvedValue('some result');
    const wrappedHandler = asyncHandler(handler);

    const result = await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    // The wrapper returns the promise result
    expect(result).toBe('some result');
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should work with handlers that call next manually', async () => {
    const handler = jest.fn().mockImplementation(async (req, res, next) => {
      next();
    });
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should preserve the request/response context', async () => {
    (mockReq as any).user = { id: 'user-123' };
    (mockRes as any).locals = { data: 'test' };

    const handler = jest.fn().mockImplementation(async (req, res) => {
      expect((req as any).user.id).toBe('user-123');
      expect((res as any).locals.data).toBe('test');
    });
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(handler).toHaveBeenCalled();
  });

  it('should handle rejection with non-Error objects', async () => {
    const errorObj = { code: 'ERR_CUSTOM', message: 'Custom error' };
    const handler = jest.fn().mockRejectedValue(errorObj);
    const wrappedHandler = asyncHandler(handler);

    await wrappedHandler(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(errorObj);
  });
});
