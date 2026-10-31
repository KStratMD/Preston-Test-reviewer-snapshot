import type { Request, Response, NextFunction } from 'express';
import type { RBACService, AccessContext } from '../services/RBACService';
import { Logger } from '../utils/Logger';
import { UnauthorizedAppError, ForbiddenAppError } from '../errors/AppError';

const logger = new Logger('RBACMiddleware');

// Express Request augmentation (user, rbac) is defined in src/types/express.d.ts

/**
 * RBAC middleware factory for protecting routes with permission checks
 */
export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if user is authenticated
      if (!req.user?.id) {
        logger.warn('RBAC check failed - no authenticated user', {
          path: req.path,
          method: req.method,
          ip: req.ip,
        });
        return next(new UnauthorizedAppError('Authentication required'));
      }

      // Get RBAC service instance (would be injected in real implementation)
      const rbacService = getRBACServiceInstance();

      const context: AccessContext = {
        userId: req.user!.id,
        resource,
        action,
        metadata: {
          path: req.path,
          method: req.method,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
        },
      };

      const hasPermission = await rbacService.hasPermission(context);

      if (!hasPermission) {
        logger.warn('RBAC check failed - insufficient permissions', {
          userId: req.user!.id,
          resource,
          action,
          path: req.path,
          method: req.method,
          userRoles: req.user!.roles,
        });

        return next(new ForbiddenAppError(
          `Insufficient permissions. Required: ${resource}:${action}`,
        ));
      }

      // Add RBAC helper methods to request
      req.rbac = {
        hasPermission: async (checkResource: string, checkAction: string) => {
          return rbacService.hasPermission({
            userId: req.user!.id,
            resource: checkResource,
            action: checkAction,
          });
        },
        getUserPermissions: () => {
          return rbacService.getUserPermissions(req.user!.id);
        },
      };

      logger.debug('RBAC check passed', {
        userId: req.user!.id,
        resource,
        action,
        path: req.path,
      });

      return next();
    } catch (error) {
      logger.error('RBAC middleware error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        resource,
        action,
        path: req.path,
      });

      next(new ForbiddenAppError('Access control error'));
    }
  };
}

/**
 * Middleware to require any of multiple permissions (OR logic)
 */
export function requireAnyPermission(permissions: { resource: string; action: string }[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) {
        return next(new UnauthorizedAppError('Authentication required'));
      }

      const rbacService = getRBACServiceInstance();

      // Check if user has any of the required permissions
      const permissionChecks = permissions.map(async ({ resource, action }) =>
        rbacService.hasPermission({
          userId: req.user!.id,
          resource,
          action,
          metadata: {
            path: req.path,
            method: req.method,
            ip: req.ip,
          },
        }),
      );

      const results = await Promise.all(permissionChecks);
      const hasAnyPermission = results.some(result => result);

      if (!hasAnyPermission) {
        const requiredPerms = permissions.map(p => `${p.resource}:${p.action}`).join(' OR ');

        logger.warn('RBAC check failed - no matching permissions', {
          userId: req.user!.id,
          requiredPermissions: requiredPerms,
          path: req.path,
          userRoles: req.user!.roles,
        });

        return next(new ForbiddenAppError(
          `Insufficient permissions. Required one of: ${requiredPerms}`,
        ));
      }

      // Add RBAC helper methods to request
      req.rbac = {
        hasPermission: async (checkResource: string, checkAction: string) => {
          return rbacService.hasPermission({
            userId: req.user!.id,
            resource: checkResource,
            action: checkAction,
          });
        },
        getUserPermissions: () => {
          return rbacService.getUserPermissions(req.user!.id);
        },
      };

      return next();
    } catch (error) {
      logger.error('RBAC any-permission middleware error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        permissions,
        path: req.path,
      });

      next(new ForbiddenAppError('Access control error'));
    }
  };
}

/**
 * Middleware to require all permissions (AND logic)
 */
export function requireAllPermissions(permissions: { resource: string; action: string }[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) {
        return next(new UnauthorizedAppError('Authentication required'));
      }

      const rbacService = getRBACServiceInstance();

      // Check if user has all required permissions
      const permissionChecks = permissions.map(async ({ resource, action }) =>
        rbacService.hasPermission({
          userId: req.user!.id,
          resource,
          action,
          metadata: {
            path: req.path,
            method: req.method,
            ip: req.ip,
          },
        }),
      );

      const results = await Promise.all(permissionChecks);
      const hasAllPermissions = results.every(result => result);

      if (!hasAllPermissions) {
        const requiredPerms = permissions.map(p => `${p.resource}:${p.action}`).join(' AND ');

        logger.warn('RBAC check failed - missing required permissions', {
          userId: req.user!.id,
          requiredPermissions: requiredPerms,
          path: req.path,
          userRoles: req.user!.roles,
        });

        return next(new ForbiddenAppError(
          `Insufficient permissions. Required all of: ${requiredPerms}`,
        ));
      }

      // Add RBAC helper methods to request
      req.rbac = {
        hasPermission: async (checkResource: string, checkAction: string) => {
          return rbacService.hasPermission({
            userId: req.user!.id,
            resource: checkResource,
            action: checkAction,
          });
        },
        getUserPermissions: () => {
          return rbacService.getUserPermissions(req.user!.id);
        },
      };

      return next();
    } catch (error) {
      logger.error('RBAC all-permissions middleware error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        permissions,
        path: req.path,
      });

      next(new ForbiddenAppError('Access control error'));
    }
  };
}

/**
 * Admin-only middleware
 */
export const requireAdmin = requirePermission('*', '*');

/**
 * Service account middleware for automated systems
 */
export function requireServiceAccount() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id) {
      return next(new UnauthorizedAppError('Authentication required'));
    }

    // Check if user has service account role
    const userRoles = req.user!.roles || [];
    if (!userRoles.includes('service_account')) {
      logger.warn('Service account access denied', {
        userId: req.user!.id,
        userRoles,
        path: req.path,
        method: req.method,
      });

      return next(new ForbiddenAppError('Service account access required'));
    }

    return next();
  };
}

/**
 * Resource owner middleware - ensures user can only access their own resources
 */
export function requireResourceOwnership(resourceIdParam = 'id') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id) {
      return next(new UnauthorizedAppError('Authentication required'));
    }

    const resourceId = req.params[resourceIdParam];
    const userId = req.user!.id;

    // Allow if user is accessing their own resource
    if (resourceId === userId) {
      return next();
    }

    // Check if user has admin privileges to access any resource
    const userRoles = req.user!.roles || [];
    if (userRoles.includes('admin')) {
      return next();
    }

    logger.warn('Resource ownership check failed', {
      userId,
      resourceId,
      resourceIdParam,
      path: req.path,
      userRoles,
    });

    next(new ForbiddenAppError('Can only access your own resources'));
  };
}

/**
 * Test-only middleware to bypass RBAC
 * SECURITY: Only allowed in test environment (not development) to prevent accidental bypass
 */
export function testOnlyRbacBypass() {
  return (req: Request, res: Response, next: NextFunction) => {
    // SECURITY: Only allow RBAC bypass in explicit test mode, not development
    // This prevents accidental RBAC bypass in development environments
    if (process.env.NODE_ENV === 'test' && process.env.BYPASS_RBAC === 'true') {
      logger.warn('RBAC bypassed in test mode', {
        path: req.path,
        method: req.method,
      });

      // Add mock RBAC helper methods
      req.rbac = {
        hasPermission: async () => true,
        getUserPermissions: () => ['*'],
      };

      return next();
    }

    // SECURITY: Log a warning if someone tries to bypass RBAC outside of test mode
    if (process.env.BYPASS_RBAC === 'true' && process.env.NODE_ENV !== 'test') {
      logger.error('SECURITY: Attempted RBAC bypass outside of test environment - DENIED', {
        path: req.path,
        method: req.method,
        environment: process.env.NODE_ENV,
      });
    }

    return next();
  };
}

/**
 * Conditional permission middleware - applies permission check only if condition is met
 */
export function requirePermissionIf(
  condition: (req: Request) => boolean,
  resource: string,
  action: string,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (condition(req)) {
      return requirePermission(resource, action)(req, res, next);
    }
    return next();
  };
}

/**
 * Permission logging middleware - logs all permission checks for audit
 */
export function logPermissionChecks() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Wrap the RBAC helper to add logging
    const originalRbac = req.rbac;
    if (originalRbac) {
      req.rbac = {
        hasPermission: async (resource: string, action: string) => {
          const result = await originalRbac.hasPermission(resource, action);

          logger.info('Permission check', {
            userId: req.user?.id,
            resource,
            action,
            result,
            path: req.path,
            method: req.method,
            timestamp: new Date().toISOString(),
          });

          return result;
        },
        getUserPermissions: originalRbac.getUserPermissions,
      };
    }

    return next();
  };
}

// Helper function to get RBAC service instance
// In a real implementation, this would use dependency injection
let rbacServiceInstance: RBACService | null = null;

export function setRBACServiceInstance(instance: RBACService): void {
  rbacServiceInstance = instance;
}

function getRBACServiceInstance(): RBACService {
  if (!rbacServiceInstance) {
    throw new Error('RBAC service not initialized. Call setRBACServiceInstance() first.');
  }
  return rbacServiceInstance;
}

// Common permission combinations for easy use
export const IntegrationPermissions = {
  READ: { resource: 'integration', action: 'read' },
  WRITE: { resource: 'integration', action: 'write' },
  EXECUTE: { resource: 'integration', action: 'execute' },
  DELETE: { resource: 'integration', action: 'delete' },
};

export const ConfigPermissions = {
  READ: { resource: 'config', action: 'read' },
  WRITE: { resource: 'config', action: 'write' },
};

export const MonitoringPermissions = {
  READ: { resource: 'monitoring', action: 'read' },
  LOGS: { resource: 'logs', action: 'read' },
  HEALTH: { resource: 'health', action: 'read' },
};

export const UserPermissions = {
  READ: { resource: 'user', action: 'read' },
  WRITE: { resource: 'user', action: 'write' },
  DELETE: { resource: 'user', action: 'delete' },
};

export const RolePermissions = {
  READ: { resource: 'role', action: 'read' },
  WRITE: { resource: 'role', action: 'write' },
  ASSIGN: { resource: 'role', action: 'assign' },
};

/**
 * Simple RBAC middleware that checks for required roles
 */
export function rbacMiddleware(requiredRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
      }

      const userRoles = req.user!.roles || [];

      // Check if user has any of the required roles
      const hasRequiredRole = requiredRoles.some(role =>
        userRoles.includes(role) || userRoles.includes('admin'),
      );

      if (!hasRequiredRole) {
        logger.warn('RBAC check failed - insufficient roles', {
          userId: req.user!.id,
          userRoles,
          requiredRoles,
          path: req.path,
        });

        return res.status(403).json({
          success: false,
          error: `Insufficient permissions. Required roles: ${requiredRoles.join(', ')}`,
        });
      }

      logger.debug('RBAC check passed', {
        userId: req.user!.id,
        userRoles,
        requiredRoles,
        path: req.path,
      });

      return next();
    } catch (error) {
      logger.error('RBAC middleware error', {
        error: error instanceof Error ? error.message : String(error),
        userId: req.user?.id,
        requiredRoles,
        path: req.path,
      });

      return res.status(500).json({
        success: false,
        error: 'Access control error',
      });
    }
  };
}
