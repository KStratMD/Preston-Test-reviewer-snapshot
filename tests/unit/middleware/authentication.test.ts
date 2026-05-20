/**
 * AuthenticationMiddleware Unit Tests
 * Tests for authentication middleware functions
 */

import 'reflect-metadata';
import { AuthenticationMiddleware, requireAuth, requireOAuth, requireApiKey, requirePermissions, optionalAuth, requireAdmin, requireReadAccess, requireWriteAccess } from '../../../src/middleware/authentication';
import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../../../src/utils/Logger';
import type { OAuth2Service, OIDCClaims } from '../../../src/security/OAuth2Service';
import type { ApiKeyService, ApiKeyData } from '../../../src/security/ApiKeyService';
import type { AuditLogRepository } from '../../../src/database/repositories/AuditLogRepository';

describe('AuthenticationMiddleware', () => {
  let middleware: AuthenticationMiddleware;
  let mockLogger: jest.Mocked<Logger>;
  let mockOAuthService: jest.Mocked<OAuth2Service>;
  let mockApiKeyService: jest.Mocked<ApiKeyService>;
  let mockAuditLogRepository: jest.Mocked<AuditLogRepository>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockOAuthService = {
      validateAccessToken: jest.fn(),
      refreshAccessToken: jest.fn(),
      createAccessToken: jest.fn(),
    } as any;

    mockApiKeyService = {
      validateApiKey: jest.fn(),
      checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, currentUsage: 50, limit: 100 }),
      createApiKey: jest.fn(),
      revokeApiKey: jest.fn(),
    } as any;

    mockAuditLogRepository = {
      create: jest.fn().mockResolvedValue({}),
      findByUserId: jest.fn(),
      findByResource: jest.fn(),
    } as any;

    middleware = new AuthenticationMiddleware(
      mockLogger,
      mockOAuthService,
      mockApiKeyService,
      mockAuditLogRepository,
    );

    mockReq = {
      headers: {},
      query: {},
      path: '/api/test',
      method: 'GET',
      ip: '127.0.0.1',
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  describe('authenticate()', () => {
    describe('when authentication is not required', () => {
      it('should call next without authentication', async () => {
        const handler = middleware.authenticate({ requireAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockOAuthService.validateAccessToken).not.toHaveBeenCalled();
        expect(mockApiKeyService.validateApiKey).not.toHaveBeenCalled();
      });
    });

    describe('OAuth2 authentication', () => {
      it('should authenticate with valid Bearer token', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read write',
          tenant_id: 'tenant-1',
        } as OIDCClaims);

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.auth).toBeDefined();
        expect(mockReq.auth?.type).toBe('oauth');
        expect(mockReq.auth?.user?.sub).toBe('user-123');
      });

      it('should reject invalid Bearer token', async () => {
        mockReq.headers = { authorization: 'Bearer invalid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue(null);

        const handler = middleware.authenticate({ allowApiKey: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should map scopes to permissions', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read admin',
        } as OIDCClaims);

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockReq.auth?.permissions).toContain('read');
        expect(mockReq.auth?.permissions).toContain('*');
      });

      it('should check required scopes', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read',
        } as OIDCClaims);

        const handler = middleware.authenticate({
          allowApiKey: false,
          requiredScopes: ['admin'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
      });

      it('should pass scope check when user has required scope', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read admin',
        } as OIDCClaims);

        const handler = middleware.authenticate({
          allowApiKey: false,
          requiredScopes: ['admin'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });

    describe('API key authentication', () => {
      it('should authenticate with valid API key in header', async () => {
        mockReq.headers = { 'x-api-key': 'valid-api-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          name: 'Test Key',
          permissions: ['read', 'write'],
          tenantId: 'tenant-1',
        } as ApiKeyData);

        const handler = middleware.authenticate({ allowOAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.auth).toBeDefined();
        expect(mockReq.auth?.type).toBe('api_key');
        expect(mockReq.auth?.apiKey?.id).toBe('key-123');
      });

      it('should authenticate with valid API key in query', async () => {
        mockReq.query = { api_key: 'valid-api-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-456',
          name: 'Query Key',
          permissions: ['read'],
        } as ApiKeyData);

        const handler = middleware.authenticate({ allowOAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.auth?.type).toBe('api_key');
      });

      it('should reject invalid API key', async () => {
        mockReq.headers = { 'x-api-key': 'invalid-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue(null);

        const handler = middleware.authenticate({ allowOAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
      });

      it('should check rate limit for API key', async () => {
        mockReq.headers = { 'x-api-key': 'valid-api-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          name: 'Limited Key',
          permissions: ['read'],
          rateLimit: { limit: 100, window: 3600 },
        } as ApiKeyData);
        mockApiKeyService.checkRateLimit.mockResolvedValue({
          allowed: false,
          currentUsage: 100,
          limit: 100,
        });

        const handler = middleware.authenticate({ allowOAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(500); // Error thrown for rate limit
      });

      it('should skip rate limit when configured', async () => {
        mockReq.headers = { 'x-api-key': 'valid-api-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          name: 'Unlimited Key',
          permissions: ['read'],
          rateLimit: { limit: 100, window: 3600 },
        } as ApiKeyData);

        const handler = middleware.authenticate({
          allowOAuth: false,
          skipRateLimit: true,
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockApiKeyService.checkRateLimit).not.toHaveBeenCalled();
        expect(mockNext).toHaveBeenCalled();
      });
    });

    describe('permission checks', () => {
      it('should allow access when user has required permission', async () => {
        mockReq.headers = { 'x-api-key': 'valid-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          permissions: ['read', 'write'],
        } as ApiKeyData);

        const handler = middleware.authenticate({
          allowOAuth: false,
          requiredPermissions: ['write'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });

      it('should allow access with wildcard permission', async () => {
        mockReq.headers = { 'x-api-key': 'admin-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-admin',
          permissions: ['*'],
        } as ApiKeyData);

        const handler = middleware.authenticate({
          allowOAuth: false,
          requiredPermissions: ['admin:delete'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });

      it('should deny access when missing required permission', async () => {
        mockReq.headers = { 'x-api-key': 'valid-key' };
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          permissions: ['read'],
        } as ApiKeyData);

        const handler = middleware.authenticate({
          allowOAuth: false,
          requiredPermissions: ['admin:delete'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
      });
    });

    describe('fallback authentication', () => {
      it('should try API key when OAuth fails', async () => {
        mockReq.headers = {
          authorization: 'Bearer invalid-token',
          'x-api-key': 'valid-api-key',
        };
        mockOAuthService.validateAccessToken.mockResolvedValue(null);
        mockApiKeyService.validateApiKey.mockResolvedValue({
          id: 'key-123',
          permissions: ['read'],
        } as ApiKeyData);

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.auth?.type).toBe('api_key');
      });

      it('should fail if both OAuth and API key fail', async () => {
        mockReq.headers = {
          authorization: 'Bearer invalid-token',
          'x-api-key': 'invalid-key',
        };
        mockOAuthService.validateAccessToken.mockResolvedValue(null);
        mockApiKeyService.validateApiKey.mockResolvedValue(null);

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
      });
    });

    describe('audit logging', () => {
      it('should log successful authentication', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read',
        } as OIDCClaims);

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'authentication_success',
          })
        );
      });

      it('should log authentication failure', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read',
        } as OIDCClaims);

        const handler = middleware.authenticate({
          requiredPermissions: ['admin'],
        });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'authentication_failure',
          })
        );
      });

      it('should handle audit log errors gracefully', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockResolvedValue({
          sub: 'user-123',
          scope: 'read',
        } as OIDCClaims);
        mockAuditLogRepository.create.mockRejectedValue(new Error('DB error'));

        const handler = middleware.authenticate();
        await handler(mockReq as Request, mockRes as Response, mockNext);

        // Should still proceed despite audit log error
        expect(mockNext).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle OAuth service errors', async () => {
        mockReq.headers = { authorization: 'Bearer valid-token' };
        mockOAuthService.validateAccessToken.mockRejectedValue(new Error('OAuth error'));

        const handler = middleware.authenticate({ allowApiKey: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(500);
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should handle API key service errors', async () => {
        mockReq.headers = { 'x-api-key': 'valid-key' };
        mockApiKeyService.validateApiKey.mockRejectedValue(new Error('API key error'));

        const handler = middleware.authenticate({ allowOAuth: false });
        await handler(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(500);
      });
    });
  });

  describe('middleware factory functions', () => {
    it('requireAuth should create authentication middleware', () => {
      const handler = requireAuth(middleware);
      expect(typeof handler).toBe('function');
    });

    it('requireOAuth should create OAuth-only middleware', async () => {
      mockReq.headers = { 'x-api-key': 'valid-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: ['read'],
      } as ApiKeyData);

      const handler = requireOAuth(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      // Should reject because API key not allowed
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('requireApiKey should create API key-only middleware', async () => {
      mockReq.headers = { authorization: 'Bearer valid-token' };
      mockOAuthService.validateAccessToken.mockResolvedValue({
        sub: 'user-123',
      } as OIDCClaims);

      const handler = requireApiKey(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      // Should reject because OAuth not allowed
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('requirePermissions should check specific permissions', async () => {
      mockReq.headers = { 'x-api-key': 'valid-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: ['read'],
      } as ApiKeyData);

      const handler = requirePermissions(middleware, ['write']);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('optionalAuth should not require authentication', async () => {
      const handler = optionalAuth(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('requireAdmin should require wildcard permission', async () => {
      mockReq.headers = { 'x-api-key': 'user-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: ['read', 'write'],
      } as ApiKeyData);

      const handler = requireAdmin(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('requireAdmin should allow users with wildcard permission', async () => {
      mockReq.headers = { 'x-api-key': 'admin-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-admin',
        permissions: ['*'],
      } as ApiKeyData);

      const handler = requireAdmin(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('requireReadAccess should require read permission', async () => {
      mockReq.headers = { 'x-api-key': 'valid-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: ['read'],
      } as ApiKeyData);

      const handler = requireReadAccess(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('requireWriteAccess should require write permission', async () => {
      mockReq.headers = { 'x-api-key': 'valid-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: ['read'],
      } as ApiKeyData);

      const handler = requireWriteAccess(middleware);
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });

  describe('error code mapping', () => {
    it('should return UNAUTHORIZED for 401', async () => {
      const handler = middleware.authenticate();
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
          }),
        })
      );
    });

    it('should return FORBIDDEN for 403', async () => {
      mockReq.headers = { 'x-api-key': 'valid-key' };
      mockApiKeyService.validateApiKey.mockResolvedValue({
        id: 'key-123',
        permissions: [],
      } as ApiKeyData);

      const handler = middleware.authenticate({
        allowOAuth: false,
        requiredPermissions: ['admin'],
      });
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'FORBIDDEN',
          }),
        })
      );
    });

    it('should return AUTH_ERROR for 500', async () => {
      mockReq.headers = { authorization: 'Bearer token' };
      mockOAuthService.validateAccessToken.mockRejectedValue(new Error('Error'));

      const handler = middleware.authenticate({ allowApiKey: false });
      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'AUTH_ERROR',
          }),
        })
      );
    });
  });
});
