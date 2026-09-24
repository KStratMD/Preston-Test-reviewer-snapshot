/**
 * API Version Middleware Unit Tests
 * Tests for API versioning middleware and route handlers
 */

import { Request, Response, NextFunction } from 'express';
import {
  apiVersionMiddleware,
  versionedRoute,
  API_VERSIONS,
  VersionedRequest,
} from '../../../src/middleware/apiVersion';

describe('API Version Middleware', () => {
  let mockRequest: Partial<VersionedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      path: '/api/test',
      headers: {},
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('API_VERSIONS constant', () => {
    it('should have V1 version', () => {
      expect(API_VERSIONS.V1).toBe('v1');
    });

    it('should have V2 version', () => {
      expect(API_VERSIONS.V2).toBe('v2');
    });

    it('should have DEFAULT version set to v1', () => {
      expect(API_VERSIONS.DEFAULT).toBe('v1');
    });
  });

  describe('apiVersionMiddleware()', () => {
    it('should extract version from URL path', () => {
      mockRequest.path = '/api/v1/users';

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v1');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should extract v2 from URL path', () => {
      mockRequest.path = '/api/v2/users';

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v2');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should extract version from api-version header', () => {
      mockRequest.path = '/api/users';
      mockRequest.headers = { 'api-version': 'v2' };

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v2');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should extract version from x-api-version header', () => {
      mockRequest.path = '/api/users';
      mockRequest.headers = { 'x-api-version': 'v1' };

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v1');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should prefer URL path version over header', () => {
      mockRequest.path = '/api/v2/users';
      mockRequest.headers = { 'api-version': 'v1' };

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v2');
    });

    it('should use default version when no version specified', () => {
      mockRequest.path = '/api/users';
      mockRequest.headers = {};

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe(API_VERSIONS.DEFAULT);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle non-api paths', () => {
      mockRequest.path = '/health';
      mockRequest.headers = {};

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe(API_VERSIONS.DEFAULT);
    });

    it('should handle array header values by using default', () => {
      mockRequest.path = '/api/users';
      mockRequest.headers = { 'api-version': ['v1', 'v2'] as any };

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe(API_VERSIONS.DEFAULT);
    });

    it('should handle numeric version in path', () => {
      mockRequest.path = '/api/v3/users';

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v3');
    });

    it('should handle nested API paths', () => {
      mockRequest.path = '/api/v1/users/123/orders';

      apiVersionMiddleware(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockRequest.apiVersion).toBe('v1');
    });
  });

  describe('versionedRoute()', () => {
    it('should call correct handler for v1', async () => {
      const v1Handler = jest.fn();
      const v2Handler = jest.fn();

      mockRequest.apiVersion = 'v1';

      const handler = versionedRoute({
        v1: v1Handler,
        v2: v2Handler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(v1Handler).toHaveBeenCalledWith(mockRequest, mockResponse, mockNext);
      expect(v2Handler).not.toHaveBeenCalled();
    });

    it('should call correct handler for v2', async () => {
      const v1Handler = jest.fn();
      const v2Handler = jest.fn();

      mockRequest.apiVersion = 'v2';

      const handler = versionedRoute({
        v1: v1Handler,
        v2: v2Handler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(v2Handler).toHaveBeenCalledWith(mockRequest, mockResponse, mockNext);
      expect(v1Handler).not.toHaveBeenCalled();
    });

    it('should use default version when apiVersion not set', async () => {
      const v1Handler = jest.fn();
      const v2Handler = jest.fn();

      mockRequest.apiVersion = undefined;

      const handler = versionedRoute({
        v1: v1Handler,
        v2: v2Handler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(v1Handler).toHaveBeenCalled();
    });

    it('should return 400 for unsupported version', async () => {
      const v1Handler = jest.fn();

      mockRequest.apiVersion = 'v3';

      const handler = versionedRoute({
        v1: v1Handler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unsupported_api_version',
          message: 'API version v3 is not supported',
          supported_versions: expect.any(Array),
        })
      );
      expect(v1Handler).not.toHaveBeenCalled();
    });

    it('should handle async handlers', async () => {
      const asyncHandler = jest.fn().mockResolvedValue(undefined);

      mockRequest.apiVersion = 'v1';

      const handler = versionedRoute({
        v1: asyncHandler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(asyncHandler).toHaveBeenCalled();
    });

    it('should call next with error on handler failure', async () => {
      const error = new Error('Handler error');
      const failingHandler = jest.fn().mockRejectedValue(error);

      mockRequest.apiVersion = 'v1';

      const handler = versionedRoute({
        v1: failingHandler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should call next with error on sync handler throw', async () => {
      const error = new Error('Sync error');
      const throwingHandler = jest.fn().mockImplementation(() => {
        throw error;
      });

      mockRequest.apiVersion = 'v1';

      const handler = versionedRoute({
        v1: throwingHandler,
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should include all API versions in error response', async () => {
      mockRequest.apiVersion = 'v99';

      const handler = versionedRoute({
        v1: jest.fn(),
      });

      await handler(mockRequest as VersionedRequest, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          supported_versions: expect.arrayContaining(['v1', 'v2']),
        })
      );
    });
  });
});
