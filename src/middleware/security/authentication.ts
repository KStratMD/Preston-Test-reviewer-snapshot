import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../../utils/Logger';
import { UnauthorizedAppError } from '../../errors/AppError';
import { timingSafeCompare } from '../../utils/securityHelpers';

/** Shape of the user object attached by auth middleware */
interface AuthenticatedUser { id: string; username: string; roles: string[]; permissions: string[] }

// Extend Request interface to include session
// NOTE: req.user augmentation is in src/types/express.d.ts (single source of truth)
declare module 'express' {
  interface Request {
    session?: {
      id: string;
      user?: unknown;
      expiresAt?: string;
      lastActivity?: string;
      destroy?: (callback: (err: unknown) => void) => void;
    };
  }
}

/**
 * API key validation middleware
 * SECURITY: Uses timing-safe comparison to prevent timing attacks
 */
export function createApiKeyValidator(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      logger.warn('Missing API key', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('API key is required'));
    }

    // In production, validate against database or secure store
    const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];

    // SECURITY: Use timing-safe comparison to prevent timing attacks
    const isValid = validApiKeys.some(validKey => timingSafeCompare(apiKey, validKey.trim()));

    if (!isValid) {
      // SECURITY: Don't log partial API key - could aid in brute force
      logger.error('Invalid API key attempt', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('Invalid API key'));
    }

    next();
  };
}

/**
 * JWT token validation middleware
 */
export function createJWTValidator(logger: Logger, jwtSecret: string) {
  const jwt = require('jsonwebtoken');

  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization as string;
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      logger.warn('Missing JWT token', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('JWT token is required'));
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
      next();
    } catch (error) {
      logger.error('Invalid JWT token', {
        ip: req.ip,
        path: req.path,
        tokenPrefix: `${token.substring(0, 20)}...`,
        error: (error as Error).message,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('Invalid JWT token'));
    }
  };
}

/**
 * Basic authentication middleware
 */
export function createBasicAuthValidator(
  logger: Logger, 
  credentials: { username: string; password: string }[]
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization as string;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      logger.warn('Missing Basic auth header', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });
      
      return next(new UnauthorizedAppError('Basic authentication required'));
    }

    try {
      const base64Credentials = authHeader.substring(6);
      const credentials_string = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials_string.split(':');

      const isValidUser = credentials.some(
        cred => cred.username === username && cred.password === password
      );

      if (!isValidUser) {
        logger.error('Invalid Basic auth credentials', {
          ip: req.ip,
          path: req.path,
          username,
          userAgent: req.get('User-Agent'),
        });

        return next(new UnauthorizedAppError('Invalid credentials'));
      }

      req.user = { id: username, username, roles: [], permissions: [] };
      next();
    } catch (error) {
      logger.error('Basic auth parsing error', {
        ip: req.ip,
        path: req.path,
        error: (error as Error).message,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('Invalid authentication format'));
    }
  };
}

/**
 * Session-based authentication middleware
 */
export function createSessionValidator(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.session) {
      logger.error('Session middleware not configured', {
        ip: req.ip,
        path: req.path,
      });
      
      return next(new Error('Session middleware not configured'));
    }

    if (!req.session.user) {
      logger.warn('No user session found', {
        ip: req.ip,
        path: req.path,
        sessionId: req.session.id,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('Authentication required'));
    }

    // Check session expiry
    if (req.session.expiresAt && new Date() > new Date(req.session.expiresAt)) {
      logger.warn('Session expired', {
        ip: req.ip,
        path: req.path,
        sessionId: req.session.id,
        expiresAt: req.session.expiresAt,
        userAgent: req.get('User-Agent'),
      });

      req.session?.destroy?.((err) => {
        if (err) {
          logger.error('Failed to destroy expired session', err);
        }
      });

      return next(new UnauthorizedAppError('Session expired'));
    }

    // Update last activity
    req.session.lastActivity = new Date().toISOString();

    // Validate session user shape before assigning to req.user
    const sessionUser = req.session.user as Record<string, unknown> | undefined;
    if (sessionUser && typeof sessionUser.id === 'string' && typeof sessionUser.username === 'string') {
      req.user = {
        id: sessionUser.id,
        username: sessionUser.username,
        email: typeof sessionUser.email === 'string' ? sessionUser.email : undefined,
        roles: Array.isArray(sessionUser.roles) ? sessionUser.roles as string[] : ['user'],
        permissions: Array.isArray(sessionUser.permissions) ? sessionUser.permissions as string[] : [],
      };
    } else {
      logger.warn('Session user has unexpected shape, rejecting', {
        sessionId: req.session.id,
        hasUser: !!sessionUser,
      });
      return next(new UnauthorizedAppError('Invalid session user'));
    }
    next();
  };
}

/**
 * Role-based access control middleware
 */
export function createRoleValidator(logger: Logger, allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      logger.error('Role validation called without user context', {
        ip: req.ip,
        path: req.path,
      });
      
      return next(new UnauthorizedAppError('Authentication required'));
    }

    const user = req.user as AuthenticatedUser;
    const userRoles = user.roles || [];
    const hasRequiredRole = allowedRoles.some(role => userRoles.includes(role));

    if (!hasRequiredRole) {
      logger.warn('Insufficient permissions', {
        ip: req.ip,
        path: req.path,
        userId: user.id,
        userRoles,
        requiredRoles: allowedRoles,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError(
        `Access denied. Required roles: ${allowedRoles.join(', ')}`
      ));
    }

    next();
  };
}

/**
 * Permission-based access control middleware
 */
export function createPermissionValidator(logger: Logger, requiredPermissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthorizedAppError('Authentication required'));
    }

    const user = req.user as AuthenticatedUser;
    const userPermissions = user.permissions || [];
    const hasAllPermissions = requiredPermissions.every(permission =>
      userPermissions.includes(permission)
    );

    if (!hasAllPermissions) {
      logger.warn('Insufficient permissions', {
        ip: req.ip,
        path: req.path,
        userId: user.id,
        userPermissions,
        requiredPermissions,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError(
        `Access denied. Required permissions: ${requiredPermissions.join(', ')}`
      ));
    }

    next();
  };
}