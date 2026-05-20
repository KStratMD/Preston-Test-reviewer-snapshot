/**
 * Tenant Isolation Middleware
 *
 * Ensures data isolation between tenants in multi-tenant deployments.
 * Extracts tenant context from JWT/headers and enforces query scoping.
 *
 * Phase 4 Implementation - SuiteCentral Parity
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger, type Logger } from '../utils/Logger';

// Extend Express Request to include tenant context
declare global {
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

export interface TenantContext {
  tenantId: string;
  tenantName?: string;
  organizationId?: string;
  environment?: 'production' | 'sandbox' | 'development';
  permissions?: string[];
  quotas?: {
    maxRecords?: number;
    maxApiCalls?: number;
    maxStorage?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface TenantIsolationOptions {
  /** Header name containing tenant ID (default: x-tenant-id) */
  tenantHeader?: string;
  /** JWT claim containing tenant ID (default: tenant_id) */
  jwtTenantClaim?: string;
  /** JWT claim containing organization ID (default: org_id) */
  jwtOrgClaim?: string;
  /** JWT secret for validation (optional - if not provided, uses process.env.JWT_SECRET) */
  jwtSecret?: string;
  /** Allow requests without tenant context (default: false) */
  allowAnonymous?: boolean;
  /** Trusted tenant IDs that bypass validation (for system services) */
  trustedTenants?: string[];
  /** Custom tenant resolver function */
  resolveTenant?: (req: Request) => Promise<TenantContext | null>;
  /** Logger instance */
  logger?: Logger;
  /** Skip isolation for specific paths */
  excludePaths?: string[];
  /** Enable strict mode - reject requests with invalid tenant context */
  strictMode?: boolean;
  /**
   * When true, skip the header-based tenant extraction step. The middleware
   * will still consult `resolveTenant`, JWT claims, and `trustedTenants`, but
   * an `x-tenant-id` header alone (un-authenticated) will NOT populate
   * `req.tenantContext`. Recommended pre-verified-auth deployments to prevent
   * header-based tenant impersonation. PR 4B's `mountCentralTenantGate`
   * passes `true` until PR 2C-Auth wires verified JWT auth.
   */
  disableHeaderExtraction?: boolean;
}

// Default tenant ID patterns
const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate tenant ID format
 */
function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_PATTERN.test(tenantId);
}

/**
 * Extract tenant context from JWT token
 */
function extractTenantFromJwt(
  token: string,
  secret: string,
  options: TenantIsolationOptions
): TenantContext | null {
  try {
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;
    const tenantClaim = options.jwtTenantClaim || 'tenant_id';
    const orgClaim = options.jwtOrgClaim || 'org_id';

    const tenantId = decoded[tenantClaim] as string;
    if (!tenantId || !isValidTenantId(tenantId)) {
      return null;
    }

    return {
      tenantId,
      organizationId: decoded[orgClaim] as string | undefined,
      permissions: decoded.permissions as string[] | undefined,
      environment: decoded.environment as TenantContext['environment'],
      metadata: {
        source: 'jwt',
        issuedAt: decoded.iat,
        expiresAt: decoded.exp,
        subject: decoded.sub,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Extract tenant context from request headers
 */
function extractTenantFromHeaders(
  req: Request,
  options: TenantIsolationOptions
): TenantContext | null {
  const headerName = options.tenantHeader || 'x-tenant-id';
  const tenantId = req.headers[headerName.toLowerCase()] as string;

  if (!tenantId || !isValidTenantId(tenantId)) {
    return null;
  }

  // Additional header-based context
  const orgId = req.headers['x-organization-id'] as string;
  const environment = req.headers['x-environment'] as TenantContext['environment'];

  return {
    tenantId,
    organizationId: orgId,
    environment,
    metadata: {
      source: 'header',
    },
  };
}

/**
 * Create tenant isolation middleware
 */
export function tenantIsolation(options: TenantIsolationOptions = {}) {
  const log = options.logger || logger;
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || '';
  const strictMode = options.strictMode ?? true;
  const excludePaths = options.excludePaths || ['/health', '/ready', '/metrics'];

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if path is excluded
      if (excludePaths.some(path => req.path.startsWith(path))) {
        return next();
      }

      let tenantContext: TenantContext | null = null;

      // 1. Try custom resolver first
      if (options.resolveTenant) {
        tenantContext = await options.resolveTenant(req);
      }

      // 2. Try JWT-based extraction
      if (!tenantContext) {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ') && jwtSecret) {
          const token = authHeader.slice(7);
          tenantContext = extractTenantFromJwt(token, jwtSecret, options);
        }
      }

      // 3. Check for trusted tenant BEFORE header extraction (system services)
      // Trusted tenants bypass normal validation and get special context
      if (!tenantContext && options.trustedTenants) {
        const headerName = options.tenantHeader || 'x-tenant-id';
        const tenantId = req.headers[headerName.toLowerCase()] as string;
        if (tenantId && options.trustedTenants.includes(tenantId)) {
          tenantContext = {
            tenantId,
            metadata: {
              source: 'trusted',
              isTrusted: true,
            },
          };
        }
      }

      // 4. Try header-based extraction (validates format)
      // Skipped when disableHeaderExtraction is true — see option JSDoc.
      if (!tenantContext && !options.disableHeaderExtraction) {
        const headerName = options.tenantHeader || 'x-tenant-id';
        const tenantId = req.headers[headerName.toLowerCase()] as string;

        // If header has a tenant ID but it's invalid format, return 400
        if (tenantId && !isValidTenantId(tenantId)) {
          log.warn('Invalid tenant ID format', {
            tenantId,
            path: req.path,
          });
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid tenant ID format',
            code: 'INVALID_TENANT_ID',
          });
        }

        tenantContext = extractTenantFromHeaders(req, options);
      }

      // Handle missing tenant context
      if (!tenantContext) {
        if (options.allowAnonymous) {
          // Set a default/anonymous tenant context
          tenantContext = {
            tenantId: 'anonymous',
            metadata: {
              source: 'anonymous',
              isAnonymous: true,
            },
          };
          log.debug('Anonymous tenant access allowed', { path: req.path });
        } else if (strictMode) {
          log.warn('Tenant context missing - access denied', {
            path: req.path,
            method: req.method,
            ip: req.ip,
          });
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Tenant context required',
            code: 'TENANT_REQUIRED',
          });
        } else {
          log.debug('Tenant context missing but not required', { path: req.path });
          return next();
        }
      }

      // Validate tenant ID format
      if (!isValidTenantId(tenantContext.tenantId)) {
        log.warn('Invalid tenant ID format', {
          tenantId: tenantContext.tenantId,
          path: req.path,
        });
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid tenant ID format',
          code: 'INVALID_TENANT_ID',
        });
      }

      // Attach tenant context to request
      req.tenantContext = tenantContext;

      log.debug('Tenant context established', {
        tenantId: tenantContext.tenantId,
        organizationId: tenantContext.organizationId,
        source: tenantContext.metadata?.source,
        path: req.path,
      });

      next();
    } catch (error) {
      log.error('Tenant isolation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });

      if (strictMode) {
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Tenant isolation failed',
          code: 'TENANT_ISOLATION_ERROR',
        });
      }

      next();
    }
  };
}

/**
 * Middleware to enforce tenant-scoped queries
 * Use this on routes that need data isolation
 */
export function requireTenant() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenantContext || req.tenantContext.tenantId === 'anonymous') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Authenticated tenant required for this operation',
        code: 'TENANT_AUTHENTICATION_REQUIRED',
      });
    }
    next();
  };
}

/**
 * Middleware to restrict access to specific tenants
 */
export function restrictToTenants(allowedTenants: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId || !allowedTenants.includes(tenantId)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied for this tenant',
        code: 'TENANT_ACCESS_DENIED',
      });
    }
    next();
  };
}

/**
 * Middleware to validate tenant has specific permissions
 */
export function requireTenantPermissions(requiredPermissions: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const permissions = req.tenantContext?.permissions || [];
    const hasAllPermissions = requiredPermissions.every(p => permissions.includes(p));

    if (!hasAllPermissions) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient tenant permissions',
        code: 'INSUFFICIENT_PERMISSIONS',
        required: requiredPermissions,
        current: permissions,
      });
    }
    next();
  };
}

/**
 * Helper to scope database queries by tenant
 */
export function scopeQueryByTenant<T extends Record<string, unknown>>(
  query: T,
  req: Request,
  tenantField = 'tenant_id'
): T & { [key: string]: string } {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId || tenantId === 'anonymous') {
    throw new Error('Tenant context required for scoped query');
  }

  return {
    ...query,
    [tenantField]: tenantId,
  };
}

/**
 * Helper to validate a record belongs to the current tenant
 */
export function validateTenantOwnership(
  record: Record<string, unknown>,
  req: Request,
  tenantField = 'tenant_id'
): boolean {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    return false;
  }
  return record[tenantField] === tenantId;
}

/**
 * Create a tenant-scoped filter for array operations
 */
export function tenantFilter<T extends Record<string, unknown>>(
  req: Request,
  tenantField = 'tenant_id'
): (item: T) => boolean {
  const tenantId = req.tenantContext?.tenantId;
  return (item: T) => item[tenantField] === tenantId;
}

/**
 * Generate a unique tenant-scoped ID
 */
export function generateTenantScopedId(req: Request, prefix = ''): string {
  const tenantId = req.tenantContext?.tenantId || 'default';
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}${tenantId}_${timestamp}_${random}`;
}
