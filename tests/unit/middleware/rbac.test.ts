/**
 * RBAC Middleware Unit Tests
 * Tests for Role-Based Access Control middleware functions
 */

import type { Request, Response, NextFunction } from 'express';
import {
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  requireServiceAccount,
  requireResourceOwnership,
  testOnlyRbacBypass,
  requirePermissionIf,
  logPermissionChecks,
  rbacMiddleware,
  setRBACServiceInstance,
  IntegrationPermissions,
  ConfigPermissions,
} from '../../../src/middleware/rbac';
import type { RBACService, AccessContext } from '../../../src/services/RBACService';

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('RBAC Middleware', () => {
  let mockRBACService: jest.Mocked<RBACService>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockRBACService = {
      hasPermission: jest.fn().mockResolvedValue(true),
      getUserPermissions: jest.fn().mockReturnValue(['read', 'write']),
      getRolePermissions: jest.fn(),
      addRolePermission: jest.fn(),
      removeRolePermission: jest.fn(),
    } as any;

    setRBACServiceInstance(mockRBACService);

    mockReq = {
      user: {
        id: 'user-123',
        username: 'testuser',
        roles: ['user'],
        permissions: ['read'],
      },
      path: '/api/test',
      method: 'GET',
      ip: '127.0.0.1',
      params: {},
      get: jest.fn().mockReturnValue('Mozilla/5.0'),
    } as any;

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  describe('requirePermission()', () => {
    it('should call next() when user has permission', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should add rbac helpers to request', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeDefined();
      expect(typeof mockReq.rbac?.hasPermission).toBe('function');
      expect(typeof mockReq.rbac?.getUserPermissions).toBe('function');
    });

    it('should call next with UnauthorizedError when no user', async () => {
      mockReq.user = undefined;

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required' })
      );
    });

    it('should call next with ForbiddenError when permission denied', async () => {
      mockRBACService.hasPermission.mockResolvedValue(false);

      const middleware = requirePermission('integration', 'delete');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Insufficient permissions'),
        })
      );
    });

    it('should handle RBAC service errors', async () => {
      mockRBACService.hasPermission.mockRejectedValue(new Error('Service error'));

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Access control error' })
      );
    });
  });

  describe('requireAnyPermission()', () => {
    it('should allow access when user has any permission', async () => {
      mockRBACService.hasPermission
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const middleware = requireAnyPermission([
        { resource: 'integration', action: 'read' },
        { resource: 'config', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should deny access when user has no matching permissions', async () => {
      mockRBACService.hasPermission.mockResolvedValue(false);

      const middleware = requireAnyPermission([
        { resource: 'admin', action: 'delete' },
        { resource: 'admin', action: 'write' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Required one of'),
        })
      );
    });

    it('should require authentication', async () => {
      mockReq.user = undefined;

      const middleware = requireAnyPermission([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required' })
      );
    });

    it('should add rbac helpers to request', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requireAnyPermission([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeDefined();
    });

    it('should handle errors', async () => {
      mockRBACService.hasPermission.mockRejectedValue(new Error('Service error'));

      const middleware = requireAnyPermission([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Access control error' })
      );
    });
  });

  describe('requireAllPermissions()', () => {
    it('should allow access when user has all permissions', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requireAllPermissions([
        { resource: 'integration', action: 'read' },
        { resource: 'integration', action: 'write' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should deny access when missing any permission', async () => {
      mockRBACService.hasPermission
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const middleware = requireAllPermissions([
        { resource: 'integration', action: 'read' },
        { resource: 'integration', action: 'delete' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Required all of'),
        })
      );
    });

    it('should require authentication', async () => {
      mockReq.user = undefined;

      const middleware = requireAllPermissions([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required' })
      );
    });

    it('should add rbac helpers to request', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requireAllPermissions([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeDefined();
    });

    it('should handle errors', async () => {
      mockRBACService.hasPermission.mockRejectedValue(new Error('Service error'));

      const middleware = requireAllPermissions([
        { resource: 'integration', action: 'read' },
      ]);
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Access control error' })
      );
    });
  });

  describe('requireServiceAccount()', () => {
    it('should allow service accounts', () => {
      mockReq.user = {
        id: 'service-123',
        username: 'api-service',
        roles: ['service_account'],
        permissions: [],
      } as any;

      const middleware = requireServiceAccount();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should deny non-service accounts', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'regular-user',
        roles: ['user'],
        permissions: [],
      } as any;

      const middleware = requireServiceAccount();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Service account access required',
        })
      );
    });

    it('should require authentication', () => {
      mockReq.user = undefined;

      const middleware = requireServiceAccount();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required' })
      );
    });

    it('should handle user with no roles array', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: undefined as any,
        permissions: [],
      } as any;

      const middleware = requireServiceAccount();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('requireResourceOwnership()', () => {
    it('should allow access to own resources', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: ['user'],
        permissions: [],
      } as any;
      mockReq.params = { id: 'user-123' };

      const middleware = requireResourceOwnership();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should allow admin access to any resource', () => {
      mockReq.user = {
        id: 'admin-456',
        username: 'admin',
        roles: ['admin'],
        permissions: [],
      } as any;
      mockReq.params = { id: 'user-123' };

      const middleware = requireResourceOwnership();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should deny access to other users resources', () => {
      mockReq.user = {
        id: 'user-456',
        username: 'other',
        roles: ['user'],
        permissions: [],
      } as any;
      mockReq.params = { id: 'user-123' };

      const middleware = requireResourceOwnership();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Can only access your own resources',
        })
      );
    });

    it('should use custom resource ID parameter', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: ['user'],
        permissions: [],
      } as any;
      mockReq.params = { userId: 'user-123' };

      const middleware = requireResourceOwnership('userId');
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should require authentication', () => {
      mockReq.user = undefined;

      const middleware = requireResourceOwnership();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Authentication required' })
      );
    });
  });

  describe('testOnlyRbacBypass()', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should bypass RBAC in test environment with flag', () => {
      process.env.NODE_ENV = 'test';
      process.env.BYPASS_RBAC = 'true';

      const middleware = testOnlyRbacBypass();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeDefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should add mock RBAC helpers in bypass mode', async () => {
      process.env.NODE_ENV = 'test';
      process.env.BYPASS_RBAC = 'true';

      const middleware = testOnlyRbacBypass();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      const hasPermission = await mockReq.rbac?.hasPermission('any', 'action');
      expect(hasPermission).toBe(true);

      const permissions = mockReq.rbac?.getUserPermissions();
      expect(permissions).toEqual(['*']);
    });

    it('should not bypass in non-test environment', () => {
      process.env.NODE_ENV = 'development';
      process.env.BYPASS_RBAC = 'true';

      const middleware = testOnlyRbacBypass();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should not bypass without flag', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.BYPASS_RBAC;

      const middleware = testOnlyRbacBypass();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.rbac).toBeUndefined();
    });
  });

  describe('requirePermissionIf()', () => {
    it('should check permission when condition is true', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const condition = (req: Request) => req.method === 'POST';
      mockReq.method = 'POST';

      const middleware = requirePermissionIf(condition, 'integration', 'write');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRBACService.hasPermission).toHaveBeenCalled();
    });

    it('should skip permission check when condition is false', async () => {
      const condition = (req: Request) => req.method === 'POST';
      mockReq.method = 'GET';

      const middleware = requirePermissionIf(condition, 'integration', 'write');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRBACService.hasPermission).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('logPermissionChecks()', () => {
    it('should wrap existing rbac helpers with logging', async () => {
      // First set up rbac helpers
      mockReq.rbac = {
        hasPermission: jest.fn().mockResolvedValue(true),
        getUserPermissions: jest.fn().mockReturnValue(['read']),
      };

      const middleware = logPermissionChecks();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      // Call the wrapped method
      const result = await mockReq.rbac?.hasPermission('test', 'read');

      expect(result).toBe(true);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should continue without error when no rbac helpers', () => {
      mockReq.rbac = undefined;

      const middleware = logPermissionChecks();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should preserve getUserPermissions method', () => {
      mockReq.rbac = {
        hasPermission: jest.fn().mockResolvedValue(true),
        getUserPermissions: jest.fn().mockReturnValue(['read', 'write']),
      };

      const middleware = logPermissionChecks();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      const permissions = mockReq.rbac?.getUserPermissions();
      expect(permissions).toEqual(['read', 'write']);
    });
  });

  describe('rbacMiddleware()', () => {
    it('should allow users with required role', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: ['editor'],
        permissions: [],
      } as any;

      const middleware = rbacMiddleware(['editor', 'admin']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should allow admin users regardless of required role', () => {
      mockReq.user = {
        id: 'admin-123',
        username: 'admin',
        roles: ['admin'],
        permissions: [],
      } as any;

      const middleware = rbacMiddleware(['editor']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should deny users without required role', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: ['user'],
        permissions: [],
      } as any;

      const middleware = rbacMiddleware(['editor', 'admin']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Insufficient permissions'),
        })
      );
    });

    it('should return 401 when no user', () => {
      mockReq.user = undefined;

      const middleware = rbacMiddleware(['user']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Authentication required',
        })
      );
    });

    it('should handle users with no roles array', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        roles: undefined as any,
        permissions: [],
      } as any;

      const middleware = rbacMiddleware(['user']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should handle errors gracefully', () => {
      mockReq.user = {
        id: 'user-123',
        username: 'test',
        // Cause error by making roles getter throw
        get roles() {
          throw new Error('Test error');
        },
        permissions: [],
      } as any;

      const middleware = rbacMiddleware(['user']);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Access control error',
        })
      );
    });
  });

  describe('Permission Constants', () => {
    it('should export IntegrationPermissions', () => {
      expect(IntegrationPermissions.READ).toEqual({
        resource: 'integration',
        action: 'read',
      });
      expect(IntegrationPermissions.WRITE).toEqual({
        resource: 'integration',
        action: 'write',
      });
      expect(IntegrationPermissions.EXECUTE).toEqual({
        resource: 'integration',
        action: 'execute',
      });
      expect(IntegrationPermissions.DELETE).toEqual({
        resource: 'integration',
        action: 'delete',
      });
    });

    it('should export ConfigPermissions', () => {
      expect(ConfigPermissions.READ).toEqual({
        resource: 'config',
        action: 'read',
      });
      expect(ConfigPermissions.WRITE).toEqual({
        resource: 'config',
        action: 'write',
      });
    });
  });

  describe('RBAC Service Instance', () => {
    it('should allow setting RBAC service instance', () => {
      const newService = {
        hasPermission: jest.fn().mockResolvedValue(true),
        getUserPermissions: jest.fn().mockReturnValue([]),
      } as any;

      expect(() => setRBACServiceInstance(newService)).not.toThrow();
    });
  });

  describe('RBAC Helper Methods', () => {
    it('should allow checking additional permissions', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      // Use the rbac helper to check another permission
      const canWrite = await mockReq.rbac?.hasPermission('integration', 'write');
      expect(canWrite).toBe(true);
    });

    it('should return user permissions', async () => {
      mockRBACService.hasPermission.mockResolvedValue(true);
      mockRBACService.getUserPermissions.mockReturnValue(['read', 'write']);

      const middleware = requirePermission('integration', 'read');
      await middleware(mockReq as Request, mockRes as Response, mockNext);

      const permissions = mockReq.rbac?.getUserPermissions();
      expect(permissions).toEqual(['read', 'write']);
    });
  });
});
