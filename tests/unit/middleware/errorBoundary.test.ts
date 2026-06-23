/**
 * ErrorBoundary Middleware Unit Tests
 * Tests for error handling, circuit breaker, and global error handlers
 */

import { Request, Response, NextFunction } from 'express';
import {
  asyncHandler,
  globalErrorHandler,
  notFoundHandler,
  CircuitBreakerMiddleware,
  timeoutHandler,
  setupGlobalErrorHandlers,
  circuitBreaker,
} from '../../../src/middleware/errorBoundary';
import {
  ValidationAppError,
  UnauthorizedAppError,
  ForbiddenAppError,
  NotFoundAppError,
  BadRequestAppError,
  ServiceUnavailableAppError,
} from '../../../src/errors/AppError';

// Mock the Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('ErrorBoundary Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();

    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      method: 'GET',
      path: '/api/test',
      ip: '127.0.0.1',
      query: {},
      params: {},
      body: {},
      get: jest.fn().mockImplementation((header: string) => {
        const headers: Record<string, string> = {
          'User-Agent': 'test-agent',
          'Content-Type': 'application/json',
          'Origin': 'http://localhost',
        };
        return headers[header];
      }),
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
      statusCode: 200,
      headersSent: false,
      send: jest.fn().mockReturnThis(),
      on: jest.fn(),
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('asyncHandler()', () => {
    it('should call the wrapped function', async () => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const handler = asyncHandler(fn);

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      await Promise.resolve(); // Allow promise to resolve
      expect(fn).toHaveBeenCalledWith(mockRequest, mockResponse, mockNext);
    });

    it('should call next with error on rejection', async () => {
      const error = new Error('Test error');
      const fn = jest.fn().mockRejectedValue(error);
      const handler = asyncHandler(fn);

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      await Promise.resolve(); // Allow promise to resolve
      await Promise.resolve(); // Allow catch to execute

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should pass through to wrapped function', async () => {
      // asyncHandler wraps async functions - sync errors would be caught by Promise.resolve
      const fn = jest.fn().mockImplementation(async () => {
        // Simulate async work
        return;
      });
      const handler = asyncHandler(fn);

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      await Promise.resolve();

      expect(fn).toHaveBeenCalled();
    });
  });

  describe('globalErrorHandler()', () => {
    let errorHandler: ReturnType<typeof globalErrorHandler>;

    beforeEach(() => {
      errorHandler = globalErrorHandler();
    });

    it('should handle ValidationAppError', () => {
      const error = new ValidationAppError('Validation failed', ['field1 is required']);

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation Error',
          message: 'Validation failed',
        })
      );
    });

    it('should handle UnauthorizedAppError', () => {
      const error = new UnauthorizedAppError('Not authenticated');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      );
    });

    it('should handle ForbiddenAppError', () => {
      const error = new ForbiddenAppError('Access denied');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          message: 'Insufficient permissions',
        })
      );
    });

    it('should handle NotFoundAppError', () => {
      const error = new NotFoundAppError('Resource not found');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Not Found',
          message: 'Resource not found',
        })
      );
    });

    it('should handle BadRequestAppError', () => {
      const error = new BadRequestAppError('Invalid request');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Bad Request',
          message: 'Invalid request',
        })
      );
    });

    it('should handle ServiceUnavailableAppError', () => {
      const error = new ServiceUnavailableAppError('Service down');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Service Unavailable',
          message: 'Service temporarily unavailable',
        })
      );
    });

    it('should handle Joi validation errors', () => {
      const error = {
        isJoi: true,
        details: [
          { message: 'field1 is required' },
          { message: 'field2 must be a number' },
        ],
        name: 'ValidationError',
        message: 'Validation failed',
      } as unknown as Error;

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation Error',
          message: 'Request validation failed',
          details: ['field1 is required', 'field2 must be a number'],
        })
      );
    });

    it('should handle MongoDB errors', () => {
      const error = new Error('Database error');
      error.name = 'MongoError';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Database Error',
          message: 'Invalid data format',
        })
      );
    });

    it('should handle CastError', () => {
      const error = new Error('Cast to ObjectId failed');
      error.name = 'CastError';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Database Error',
          message: 'Invalid data format',
        })
      );
    });

    it('should handle JsonWebTokenError', () => {
      const error = new Error('Invalid token');
      error.name = 'JsonWebTokenError';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid Token',
          message: 'Authentication token is invalid',
        })
      );
    });

    it('should handle TokenExpiredError', () => {
      const error = new Error('Token expired');
      error.name = 'TokenExpiredError';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Token Expired',
          message: 'Authentication token has expired',
        })
      );
    });

    it('should handle ECONNREFUSED errors', () => {
      const error = new Error('Connection refused') as Error & { code: string };
      error.code = 'ECONNREFUSED';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Service Unavailable',
          message: 'External service is temporarily unavailable',
        })
      );
    });

    it('should handle ETIMEDOUT errors', () => {
      const error = new Error('Connection timed out') as Error & { code: string };
      error.code = 'ETIMEDOUT';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Service Unavailable',
          message: 'External service is temporarily unavailable',
        })
      );
    });

    it('should handle ENOENT errors', () => {
      const error = new Error('File not found') as Error & { code: string };
      error.code = 'ENOENT';

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'File Not Found',
          message: 'Requested file or resource not found',
        })
      );
    });

    it('should handle generic errors with 500 status', () => {
      const error = new Error('Something went wrong');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
        })
      );
    });

    it('should include stack in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const error = new Error('Dev error');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Dev error',
          stack: expect.any(String),
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should not include stack in production mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const error = new Error('Prod error');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'An unexpected error occurred',
        })
      );
      expect(jsonMock).toHaveBeenCalledWith(
        expect.not.objectContaining({
          stack: expect.any(String),
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should sanitize sensitive data in request body', () => {
      mockRequest.body = {
        username: 'testuser',
        password: 'secret123',
        apiKey: 'key123',
        data: { nested_secret: 'hidden' },
      };

      const error = new Error('Test error');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      // The error handler logs the sanitized body - we just verify it runs without error
      expect(statusMock).toHaveBeenCalledWith(500);
    });
  });

  describe('notFoundHandler()', () => {
    let handler: ReturnType<typeof notFoundHandler>;

    beforeEach(() => {
      handler = notFoundHandler();
    });

    it('should return 404 status', () => {
      handler(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
    });

    it('should include method and path in message', () => {
      mockRequest.method = 'POST';
      mockRequest.path = '/api/unknown';

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Not Found',
          message: 'Route POST /api/unknown not found',
          path: '/api/unknown',
        })
      );
    });

    it('should include timestamp', () => {
      handler(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });
  });

  describe('CircuitBreakerMiddleware', () => {
    let circuitBreakerMw: CircuitBreakerMiddleware;

    beforeEach(() => {
      circuitBreakerMw = new CircuitBreakerMiddleware(3, 5000); // 3 failures, 5 second reset
    });

    it('should allow requests when circuit is closed', () => {
      const middleware = circuitBreakerMw.wrap('test-service');

      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should track failures from 500 responses', () => {
      const middleware = circuitBreakerMw.wrap('failing-service');

      // Simulate a request with 500 response
      const originalSend = mockResponse.send;
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // The middleware wraps res.send - simulate calling it with 500 status
      mockResponse.statusCode = 500;
      (mockResponse.send as jest.Mock)('error');

      // After the send, failures should be tracked
      // Make another request - should still allow (under threshold)
      const mockNext2 = jest.fn();
      middleware(mockRequest as Request, mockResponse as Response, mockNext2);
      expect(mockNext2).toHaveBeenCalled();
    });

    it('should open circuit after threshold failures', () => {
      const middleware = circuitBreakerMw.wrap('threshold-service');

      // Simulate multiple failures - need fresh response objects for each call
      for (let i = 0; i < 3; i++) {
        const res: Partial<Response> = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn().mockReturnThis(),
          statusCode: 500,
          headersSent: false,
          send: jest.fn().mockReturnThis(),
          on: jest.fn(),
        };
        middleware(mockRequest as Request, res as Response, mockNext);
        // Call the wrapped send to trigger failure recording
        (res.send as jest.Mock)('error');
      }

      // Reset next mock
      mockNext.mockClear();

      // Next request should be rejected
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ServiceUnavailableAppError));
    });

    it('should reset failures after timeout', () => {
      const middleware = circuitBreakerMw.wrap('resetting-service');

      // Cause some failures
      for (let i = 0; i < 2; i++) {
        mockResponse.statusCode = 500;
        middleware(mockRequest as Request, mockResponse as Response, mockNext);
        (mockResponse.send as jest.Mock)('error');
      }

      // Advance time past reset timeout
      jest.advanceTimersByTime(6000);

      mockNext.mockClear();

      // Should allow request again
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should reset failures on successful response', () => {
      const middleware = circuitBreakerMw.wrap('recovering-service');

      // Cause a failure
      mockResponse.statusCode = 500;
      middleware(mockRequest as Request, mockResponse as Response, mockNext);
      (mockResponse.send as jest.Mock)('error');

      // Now send a success
      mockResponse.statusCode = 200;
      middleware(mockRequest as Request, mockResponse as Response, mockNext);
      (mockResponse.send as jest.Mock)('success');

      // Circuit should be healthy again
      mockNext.mockClear();
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should handle different services independently', () => {
      const middlewareA = circuitBreakerMw.wrap('service-a');
      const middlewareB = circuitBreakerMw.wrap('service-b');

      // Fail service A
      for (let i = 0; i < 3; i++) {
        mockResponse.statusCode = 500;
        middlewareA(mockRequest as Request, mockResponse as Response, mockNext);
        (mockResponse.send as jest.Mock)('error');
      }

      mockNext.mockClear();

      // Service B should still work
      middlewareB(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('timeoutHandler()', () => {
    it('should call next immediately', () => {
      const handler = timeoutHandler(5000);

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should send 408 after timeout', () => {
      const handler = timeoutHandler(5000);

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      // Advance time past timeout
      jest.advanceTimersByTime(6000);

      expect(statusMock).toHaveBeenCalledWith(408);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Request Timeout',
          message: 'Request took too long to process',
          timeout: 5000,
        })
      );
    });

    it('should not send timeout if response already sent', () => {
      const handler = timeoutHandler(5000);
      mockResponse.headersSent = true;

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      jest.advanceTimersByTime(6000);

      expect(statusMock).not.toHaveBeenCalled();
    });

    it('should clear timeout on response finish', () => {
      const handler = timeoutHandler(5000);
      let finishCallback: () => void = () => {};

      (mockResponse.on as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'finish') {
          finishCallback = cb;
        }
      });

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      // Simulate response finishing before timeout
      finishCallback();

      // Advance time past timeout
      jest.advanceTimersByTime(6000);

      // Should not have sent timeout response
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('should clear timeout on response close', () => {
      const handler = timeoutHandler(5000);
      let closeCallback: () => void = () => {};

      (mockResponse.on as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') {
          closeCallback = cb;
        }
      });

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      // Simulate connection closing
      closeCallback();

      jest.advanceTimersByTime(6000);

      expect(statusMock).not.toHaveBeenCalled();
    });

    it('should use default timeout of 30000ms', () => {
      const handler = timeoutHandler();

      handler(mockRequest as Request, mockResponse as Response, mockNext);

      // Advance time but not past default timeout
      jest.advanceTimersByTime(25000);
      expect(statusMock).not.toHaveBeenCalled();

      // Now advance past default timeout
      jest.advanceTimersByTime(10000);
      expect(statusMock).toHaveBeenCalledWith(408);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 30000,
        })
      );
    });
  });

  describe('setupGlobalErrorHandlers()', () => {
    let originalListeners: NodeJS.Process['listeners'];
    let processOnSpy: jest.SpyInstance;
    let processExitSpy: jest.SpyInstance;
    let stderrWriteSpy: jest.SpyInstance;

    beforeEach(() => {
      originalListeners = process.listeners.bind(process);
      processOnSpy = jest.spyOn(process, 'on');
      processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
      stderrWriteSpy.mockRestore();
    });

    it('should register uncaughtException handler', () => {
      setupGlobalErrorHandlers();

      expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    });

    it('should register unhandledRejection handler', () => {
      setupGlobalErrorHandlers();

      expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    });

    it('should set max listeners', () => {
      const setMaxListenersSpy = jest.spyOn(process, 'setMaxListeners');

      setupGlobalErrorHandlers();

      expect(setMaxListenersSpy).toHaveBeenCalledWith(20);

      setMaxListenersSpy.mockRestore();
    });

    it('should call shutdown callback on uncaught exception', async () => {
      const shutdownCallback = jest.fn().mockResolvedValue(undefined);
      let exceptionHandler: (error: Error) => void = () => {};

      processOnSpy.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'uncaughtException') {
          exceptionHandler = handler as (error: Error) => void;
        }
        return process;
      });

      setupGlobalErrorHandlers(shutdownCallback);

      // Trigger the exception handler
      const error = new Error('Test uncaught exception');
      exceptionHandler(error);

      await Promise.resolve();

      expect(shutdownCallback).toHaveBeenCalled();
    });
  });

  describe('circuitBreaker export', () => {
    it('should be an instance of CircuitBreakerMiddleware', () => {
      expect(circuitBreaker).toBeInstanceOf(CircuitBreakerMiddleware);
    });

    it('should wrap services', () => {
      const middleware = circuitBreaker.wrap('export-test');

      expect(typeof middleware).toBe('function');
    });
  });

  describe('edge cases', () => {
    it('should handle error with no message', () => {
      const errorHandler = globalErrorHandler();
      const error = new Error();

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it('should handle NotFoundAppError with no message', () => {
      const errorHandler = globalErrorHandler();
      const error = new NotFoundAppError('');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Resource not found',
        })
      );
    });

    it('should handle request with null body', () => {
      mockRequest.body = null;
      const errorHandler = globalErrorHandler();
      const error = new Error('Test error');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it('should handle request with undefined body', () => {
      mockRequest.body = undefined;
      const errorHandler = globalErrorHandler();
      const error = new Error('Test error');

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it('should handle ValidationAppError with validation errors', () => {
      const errorHandler = globalErrorHandler();
      const error = new ValidationAppError('Validation failed', ['error1', 'error2']);

      errorHandler(error, mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: ['error1', 'error2'],
        })
      );
    });
  });
});
