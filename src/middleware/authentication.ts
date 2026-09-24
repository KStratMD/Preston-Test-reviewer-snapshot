import type { Request, Response, NextFunction } from 'express';
import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { OAuth2Service, OIDCClaims } from '../security/OAuth2Service';
import type { ApiKeyService, ApiKeyData } from '../security/ApiKeyService';
import type { AuditLogRepository } from '../database/repositories/AuditLogRepository';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

// Extend Express Request to include auth data
declare global {
  namespace Express {
    interface Request {
      auth?: {
        type: 'oauth' | 'api_key';
        user?: OIDCClaims;
        apiKey?: ApiKeyData;
        permissions?: string[];
        tenantId?: string;
      };
    }
  }
}

export interface AuthenticationOptions {
  requireAuth?: boolean;
  allowApiKey?: boolean;
  allowOAuth?: boolean;
  requiredPermissions?: string[];
  requiredScopes?: string[];
  skipRateLimit?: boolean;
}

type OAuthAuthenticationResult = {
  type: 'oauth';
  user: OIDCClaims;
  permissions: string[];
  tenantId?: string;
};

type ApiKeyAuthenticationResult = {
  type: 'api_key';
  apiKey: ApiKeyData;
  permissions: string[];
  tenantId?: string;
};

type AuthenticationResult = OAuthAuthenticationResult | ApiKeyAuthenticationResult;

function normalizeSubjectClaim(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Authentication middleware with OAuth2 and API key support
 */
@injectable()
export class AuthenticationMiddleware {
  private readonly logger: Logger;
  private readonly oauthService: OAuth2Service;
  private readonly apiKeyService: ApiKeyService;
  private readonly auditLogRepository: AuditLogRepository;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.OAuth2Service) oauthService: OAuth2Service,
    @inject(TYPES.ApiKeyService) apiKeyService: ApiKeyService,
    @inject(TYPES.AuditLogRepository) auditLogRepository: AuditLogRepository,
  ) {
    this.logger = logger;
    this.oauthService = oauthService;
    this.apiKeyService = apiKeyService;
    this.auditLogRepository = auditLogRepository;
  }

  /**
   * Create authentication middleware
   */
  authenticate(options: AuthenticationOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          requireAuth = true,
          allowApiKey = true,
          allowOAuth = true,
          requiredPermissions = [],
          requiredScopes = [],
          skipRateLimit = false,
        } = options;

        // Skip authentication if not required
        if (!requireAuth) {
          return next();
        }

        let authResult: AuthenticationResult | null = null;

        // Try OAuth2 Bearer token authentication
        if (allowOAuth) {
          authResult = await this.authenticateOAuth(req);
        }

        // Try API key authentication if OAuth failed
        if (!authResult && allowApiKey) {
          authResult = await this.authenticateApiKey(req, skipRateLimit);
        }

        // Check if authentication succeeded
        if (!authResult) {
          return this.sendAuthError(res, 'Authentication required', 401);
        }

        // Check required permissions
        if (requiredPermissions.length > 0) {
          const hasPermission = requiredPermissions.some(permission =>
            authResult.permissions.includes(permission) ||
            authResult.permissions.includes('*'),
          );

          if (!hasPermission) {
            await this.logAuthFailure(req, authResult, 'insufficient_permissions');
            return this.sendAuthError(res, 'Insufficient permissions', 403);
          }
        }

        // Check required scopes for OAuth
        if (authResult.type === 'oauth' && requiredScopes.length > 0) {
          const userScopes = authResult.user?.scope?.split(' ') || [];
          const hasScope = requiredScopes.some(scope => userScopes.includes(scope));

          if (!hasScope) {
            await this.logAuthFailure(req, authResult, 'insufficient_scopes');
            return this.sendAuthError(res, 'Insufficient scopes', 403);
          }
        }

        // Attach auth data to request
        req.auth = authResult;

        // Log successful authentication
        await this.logAuthSuccess(req, authResult);

        next();
      } catch (error) {
        this.logger.error('Authentication middleware error', {
          error: error instanceof Error ? error.message : String(error),
          path: req.path,
          method: req.method,
        });

        return this.sendAuthError(res, 'Authentication error', 500);
      }
    };
  }

  /**
   * Authenticate using OAuth2 Bearer token
   */
  private async authenticateOAuth(req: Request): Promise<OAuthAuthenticationResult | null> {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    const claims = await this.oauthService.validateAccessToken(token);

    if (!claims) {
      return null;
    }

    const subject = normalizeSubjectClaim(claims.sub);
    if (!subject) {
      this.logger.warn('OAuth token rejected without subject claim', { path: req.path, method: req.method });
      return null;
    }

    // Map scopes to permissions
    const scopes = claims.scope?.split(' ') || [];
    const permissions = this.mapScopesToPermissions(scopes);

    return {
      type: 'oauth',
      user: { ...claims, sub: subject },
      permissions,
      tenantId: claims.tenant_id,
    };
  }

  /**
   * Authenticate using API key
   */
  private async authenticateApiKey(
    req: Request,
    skipRateLimit = false,
  ): Promise<ApiKeyAuthenticationResult | null> {
    // Check for API key in header or query parameter
    const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string;

    if (!apiKey) {
      return null;
    }

    const keyData = await this.apiKeyService.validateApiKey(apiKey);

    if (!keyData) {
      return null;
    }

    // Check rate limit
    if (!skipRateLimit && keyData.rateLimit) {
      const rateLimitResult = await this.apiKeyService.checkRateLimit(keyData);

      if (!rateLimitResult.allowed) {
        throw new Error(`Rate limit exceeded. Current usage: ${rateLimitResult.currentUsage}/${rateLimitResult.limit}`);
      }
    }

    return {
      type: 'api_key',
      apiKey: keyData,
      permissions: keyData.permissions,
      tenantId: keyData.tenantId,
    };
  }

  /**
   * Log successful authentication
   */
  private async logAuthSuccess(
    req: Request,
    authResult: AuthenticationResult,
  ): Promise<void> {
    try {
      const userId = authResult.type === 'oauth'
        ? authResult.user.sub
        : `api_key:${authResult.apiKey.id}`;

      await this.auditLogRepository.create({
        tenant_id: authResult.tenantId ?? SYSTEM_IDENTITY.tenantId,
        user_id: userId,
        action: 'authentication_success',
        resource_type: 'auth',
        resource_id: authResult.type,
        old_values: null,
        new_values: {
          authType: authResult.type,
          endpoint: req.path,
          method: req.method,
          userAgent: req.headers['user-agent'],
        },
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
      });

      this.logger.debug('Authentication successful', {
        authType: authResult.type,
        userId,
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
    } catch (error) {
      this.logger.error('Failed to log auth success', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Log authentication failure
   */
  private async logAuthFailure(
    req: Request,
    authResult: AuthenticationResult,
    reason: string,
  ): Promise<void> {
    try {
      const userId = authResult.type === 'oauth'
        ? authResult.user.sub
        : `api_key:${authResult.apiKey.id}`;

      await this.auditLogRepository.create({
        tenant_id: authResult.tenantId ?? SYSTEM_IDENTITY.tenantId,
        user_id: userId,
        action: 'authentication_failure',
        resource_type: 'auth',
        resource_id: reason,
        old_values: null,
        new_values: {
          reason,
          endpoint: req.path,
          method: req.method,
          userAgent: req.headers['user-agent'],
        },
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
      });

      this.logger.warn('Authentication failed', {
        reason,
        userId,
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
    } catch (error) {
      this.logger.error('Failed to log auth failure', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send authentication error response
   */
  private sendAuthError(res: Response, message: string, status: number): void {
    res.status(status).json({
      error: {
        code: this.getErrorCode(status),
        message,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Map OAuth scopes to permissions
   */
  private mapScopesToPermissions(scopes: string[]): string[] {
    const scopePermissionMap: Record<string, string[]> = {
      'read': ['read', 'integrations:read', 'configs:read'],
      'write': ['write', 'integrations:write', 'configs:write'],
      'admin': ['*'], // Admin scope grants all permissions
      'integrations:read': ['integrations:read'],
      'integrations:write': ['integrations:write'],
      'configs:read': ['configs:read'],
      'configs:write': ['configs:write'],
      'audit:read': ['audit:read'],
      'metrics:read': ['metrics:read'],
      'users:read': ['users:read'],
      'users:write': ['users:write'],
    };

    const permissions = new Set<string>();

    for (const scope of scopes) {
      const scopePermissions = scopePermissionMap[scope] || [];
      scopePermissions.forEach(permission => permissions.add(permission));
    }

    return Array.from(permissions);
  }

  /**
   * Get error code for status
   */
  private getErrorCode(status: number): string {
    switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'AUTH_ERROR';
    }
  }
}

/**
 * Middleware factory functions
 */

// Require authentication (any method)
export const requireAuth = (authMiddleware: AuthenticationMiddleware) =>
  authMiddleware.authenticate({ requireAuth: true });

// Require OAuth only
export const requireOAuth = (authMiddleware: AuthenticationMiddleware, scopes: string[] = []) =>
  authMiddleware.authenticate({
    requireAuth: true,
    allowApiKey: false,
    requiredScopes: scopes,
  });

// Require API key only
export const requireApiKey = (authMiddleware: AuthenticationMiddleware, permissions: string[] = []) =>
  authMiddleware.authenticate({
    requireAuth: true,
    allowOAuth: false,
    requiredPermissions: permissions,
  });

// Require specific permissions
export const requirePermissions = (authMiddleware: AuthenticationMiddleware, permissions: string[]) =>
  authMiddleware.authenticate({
    requireAuth: true,
    requiredPermissions: permissions,
  });

// Optional authentication
export const optionalAuth = (authMiddleware: AuthenticationMiddleware) =>
  authMiddleware.authenticate({ requireAuth: false });

// Admin only
export const requireAdmin = (authMiddleware: AuthenticationMiddleware) =>
  authMiddleware.authenticate({
    requireAuth: true,
    requiredPermissions: ['*'],
  });

// Read-only access
export const requireReadAccess = (authMiddleware: AuthenticationMiddleware) =>
  authMiddleware.authenticate({
    requireAuth: true,
    requiredPermissions: ['read'],
  });

// Write access
export const requireWriteAccess = (authMiddleware: AuthenticationMiddleware) =>
  authMiddleware.authenticate({
    requireAuth: true,
    requiredPermissions: ['write'],
  });
