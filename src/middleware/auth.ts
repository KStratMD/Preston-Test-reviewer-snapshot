import type { Request, Response, NextFunction } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { AuthService } from '../services/AuthService';
import { logger as moduleLogger, type Logger } from '../utils/Logger';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

// Validate + normalize a tenantId claim extracted from a JWT. Returns the
// canonical string or `undefined` if the value is unsafe to propagate.
// Unsafe = empty/whitespace-only (would auto-register as an active tenant via
// the gate's seam — see TenantLifecycleService.requireActive), oversized
// (would bloat the tenants.id column which is VARCHAR(255) on Postgres), or
// shape-illegal — outside `[A-Za-z0-9_-]`. The allowlist rejects invisible /
// bidi / control characters (e.g. U+200B zero-width space, U+202E RTL
// override) that String.prototype.trim() does not strip, so a JWT cannot
// auto-register a tenant whose ID renders identically to an existing one but
// is byte-distinct, nor inject directional-override spoofing into downstream
// log/audit surfaces. Covers the conventional issuer formats (UUID, ULID,
// alphanumeric IDs from Auth0/Okta/Cognito/Azure AD); claims in any other
// shape fail closed at the gate (consistent with the fail-closed posture for
// JWTs without a tenantId claim).
const MAX_TENANT_ID_LENGTH = 255;
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
function normalizeTenantIdClaim(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (s.length === 0) return undefined;
  if (s.length > MAX_TENANT_ID_LENGTH) return undefined;
  if (!TENANT_ID_PATTERN.test(s)) return undefined;
  return s;
}

function normalizeJwtTextClaim(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

function normalizeJwtSubjectClaim(decoded: Record<string, unknown>): string | undefined {
  return normalizeJwtTextClaim(decoded.sub) ?? normalizeJwtTextClaim(decoded.id);
}

// Lazily resolve services to avoid failing at import time in tests where TYPES are mocked
type JwtShim = Pick<AuthService, 'generateJWT' | 'verifyJWT'>;
let cachedAuthService: (AuthService | JwtShim) | undefined;
let cachedLogger: Logger | undefined;
// A5: warn only once about a DI fallback. The shim is cached after the first
// failure (resolution does NOT retry per request), so this flag is
// belt-and-braces against a future cache reset re-triggering the warn path.
let diFallbackWarned = false;

function resolveServices(): { auth: AuthService | JwtShim; logger: Logger } {
  if (cachedAuthService && cachedLogger) return { auth: cachedAuthService, logger: cachedLogger };
  try {
    if (TYPES.AuthService) {
      cachedAuthService = container.get<AuthService>(TYPES.AuthService);
    }
    if (TYPES.Logger) {
      cachedLogger = container.get<Logger>(TYPES.Logger);
    }
  } catch (error) {
    // A5: don't silently swallow a DI resolution failure. In a real deployment
    // this means the AuthService wiring is broken and we're about to fall back
    // to the minimal JWT shim — a fact that must be visible, not hidden. The
    // shim is then CACHED (cachedAuthService below), so resolution does not
    // retry on later requests; the once-flag is belt-and-braces against a
    // future cache reset re-triggering this path. Elevate to error in
    // production, where the shim should never be the resolved path.
    if (!diFallbackWarned) {
      diFallbackWarned = true;
      // Key deliberately NOT `error`: Logger.error(message, error, metadata)
      // merges metadata into the context first and THEN assigns the thrown
      // error to context.error — a metadata key named `error` would be
      // overwritten by it.
      const detail = { resolutionError: error instanceof Error ? error.message : String(error) };
      const message = '[auth] AuthService DI resolution failed; falling back to JWT shim';
      if (env.NODE_ENV === 'production') {
        moduleLogger.error(message, error, detail);
      } else {
        moduleLogger.warn(message, detail);
      }
    }
  }

  // Fallbacks for tests or minimal environments
  if (!cachedAuthService) {
    // SECURITY: Only use fallback secret in test/development environments
    let secret = env.JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set in production');
      }
      secret = 'test-jwt-secret-for-development-only';
    }
    const shim: JwtShim = {
      generateJWT(payload: Record<string, unknown>, expiresIn = '24h'): string {
        return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
      },
      verifyJWT(token: string): Record<string, unknown> {
        // Pin HS256 (A3): tokens are symmetric-signed with JWT_SECRET, so
        // rejecting any other alg forecloses algorithm-confusion attacks.
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
        if (typeof decoded === 'string') {
          throw new Error('Invalid JWT payload format');
        }
        return decoded as Record<string, unknown>;
      },
    } as JwtShim;
    cachedAuthService = shim;
  }

  if (!cachedLogger) {
    // Minimal logger shim
    cachedLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => (cachedLogger as Logger),
    } as unknown as Logger;
  }

  return { auth: cachedAuthService, logger: cachedLogger };
}

// AuthenticatedRequest uses the global Request.user augmentation (src/types/express.d.ts)
export type AuthenticatedRequest = Request;

/**
 * Middleware for JWT authentication
 */
export const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  try {
    const { auth: authService, logger } = resolveServices();
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'No valid authorization header found',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      const decoded = authService.verifyJWT(token);

      // Extract user information from JWT payload
      // OAuth2 tokens may have sub/scope instead of username/email
      // tenantId is read defensively from any of the conventional claim names
      // (tenantId, tid, tenant_id) and normalized: trimmed, rejected if empty
      // or oversized. The normalized value (or undefined) lands on req.user;
      // the gate then fails closed for any authenticated request without a
      // valid tenantId, instead of letting whitespace-only or absurd values
      // silently auto-register as a tenant row.
      const tenantIdClaim = decoded.tenantId ?? decoded.tid ?? decoded.tenant_id;
      const subject = normalizeJwtSubjectClaim(decoded);

      if (!subject) {
        logger.warn('JWT rejected: missing or blank subject claim', { error: 'JWT subject claim required' });
        res.status(401).json({
          success: false,
          error: 'Invalid or expired token',
        });
        return;
      }

      req.user = {
        id: subject,
        username: normalizeJwtTextClaim(decoded.username) ?? normalizeJwtTextClaim(decoded.email) ?? subject,
        tenantId: normalizeTenantIdClaim(tenantIdClaim),
        roles: Array.isArray(decoded.roles) ? decoded.roles as string[] : ['user'],
        permissions: Array.isArray(decoded.permissions) ? decoded.permissions as string[] : [],
      };

      logger.debug('User authenticated successfully', {
        userId: req.user!.id,
        username: req.user!.username,
        tenantId: req.user!.tenantId,
        roles: req.user!.roles,
      });

      next();
    } catch (jwtError) {
      // SECURITY: Don't log token content - even partial tokens can aid attacks
      logger.warn('JWT verification failed', {
        error: jwtError instanceof Error ? jwtError.message : String(jwtError),
      });

      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
      });
    }
  } catch (error) {
    const { logger } = resolveServices();
    logger.error('Authentication middleware error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Authentication service error',
    });
  }
};

/**
 * Optional auth middleware - allows requests without authentication but adds user info if present
 */
export const optionalAuthMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const { auth: authService, logger } = resolveServices();
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = authService.verifyJWT(token);

    // Same tenantId-claim propagation as the required-auth path above:
    // read from any of the conventional claim names and normalize (trim,
    // reject empty/oversized) so the gate's auto-register seam can never
    // be hit by a malformed claim.
    const tenantIdClaim = decoded.tenantId ?? decoded.tid ?? decoded.tenant_id;
    const subject = normalizeJwtSubjectClaim(decoded);

    if (!subject) {
      logger.warn('Optional authentication rejected JWT without subject claim');
      res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
      });
      return;
    }

    req.user = {
      id: subject,
      username: normalizeJwtTextClaim(decoded.username) ?? normalizeJwtTextClaim(decoded.email) ?? subject,
      tenantId: normalizeTenantIdClaim(tenantIdClaim),
      roles: Array.isArray(decoded.roles) ? decoded.roles as string[] : ['user'],
      permissions: Array.isArray(decoded.permissions) ? decoded.permissions as string[] : [],
    };

    logger.debug('Optional authentication successful', {
      userId: req.user.id,
      username: req.user.username,
      tenantId: req.user.tenantId,
    });
  } catch (jwtError) {
    logger.debug('Optional authentication failed, continuing without auth', {
      error: jwtError instanceof Error ? jwtError.message : String(jwtError),
    });
  }

  next();
};

/**
 * Create a test/demo JWT token for development
 */
export const createTestToken = (userInfo: {
  id: string;
  username: string;
  roles?: string[];
  permissions?: string[];
}): string => {
  const { auth: authService } = resolveServices();
  return authService.generateJWT({
    sub: userInfo.id,
    username: userInfo.username,
    roles: userInfo.roles || ['admin'],
    permissions: userInfo.permissions || ['*'],
    iat: Math.floor(Date.now() / 1000),
  }, '24h');
};
