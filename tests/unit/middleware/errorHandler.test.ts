/**
 * ErrorHandler Middleware Unit Tests
 * Tests for the basic error handler middleware
 */

import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../../src/middleware/errorHandler';

describe('ErrorHandler Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let mockLogger: { error: jest.Mock; info: jest.Mock; warn: jest.Mock; debug: jest.Mock };
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      path: '/api/test',
      method: 'GET',
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
      headersSent: false,
    };

    mockNext = jest.fn();

    mockLogger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should log the error with details', () => {
    const error = new Error('Test error');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'An unexpected error occurred',
      expect.objectContaining({
        error: 'Test error',
        stack: expect.any(String),
        path: '/api/test',
        method: 'GET',
      })
    );
  });

  it('should return 500 status code', () => {
    const error = new Error('Server error');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(500);
  });

  it('should return generic error message', () => {
    const error = new Error('Sensitive details');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(jsonMock).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred. Please try again later.',
    });
  });

  it('should call next with error if headers already sent', () => {
    mockResponse.headersSent = true;
    const error = new Error('Test error');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledWith(error);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('should not call next if headers not sent', () => {
    const error = new Error('Test error');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle error without stack trace', () => {
    const error = new Error('No stack');
    delete error.stack;

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'An unexpected error occurred',
      expect.objectContaining({
        error: 'No stack',
        stack: undefined,
      })
    );
    expect(statusMock).toHaveBeenCalledWith(500);
  });

  it('should handle empty error message', () => {
    const error = new Error('');

    const handler = errorHandler(mockLogger as any);
    handler(error, mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'An unexpected error occurred',
      expect.objectContaining({
        error: '',
      })
    );
    expect(statusMock).toHaveBeenCalledWith(500);
  });
});
