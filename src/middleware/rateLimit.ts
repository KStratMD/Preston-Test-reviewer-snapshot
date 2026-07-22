import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { Logger } from '../utils/Logger';
import { env } from '../config';
import { isDemo } from '../utils/features';

const logger = new Logger('RateLimit');

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Extend Express Request interface for rate limiting.
// express-rate-limit v7 populates `resetTime` as a Date (v6 and earlier used a
// number of ms). Type it as the union and normalize at the read sites so the
// 429 handler can't crash on the actual runtime shape.
interface RateLimitInfo {
  limit: number;
  used: number;
  remaining: number;
  resetTime?: Date | number;
}

declare module 'express-serve-static-core' {
  interface Request {
    rateLimit?: RateLimitInfo;
  }
}

// Absolute reset time (ms since epoch), regardless of Date vs number shape.
const resetTimeMs = (req: Request): number | null => {
  const value = req.rateLimit?.resetTime;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
};

// Create rate limit key generator
const createKeyGenerator = (prefix: string) => {
  return (req: Request): string => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userId = (req.user as any)?.id || 'anonymous';
    return `${prefix}:${ip}:${userId}`;
  };
};

// Custom rate limit handler.
// resetTime is an ABSOLUTE timestamp, so retryAfter is (reset - now), and the
// ISO string comes straight from that timestamp. The previous code did
// `new Date(Date.now() + resetTime)` with a Date-typed resetTime, which
// string-concatenated into an Invalid Date and threw RangeError in toISOString
// — turning every 429 into a 500 (repo-review PR-E follow-up).
const rateLimitHandler = (req: Request, res: Response) => {
  const resetMs = resetTimeMs(req);
  const resetIso = resetMs !== null ? new Date(resetMs).toISOString() : undefined;
  const retryAfterSec = resetMs !== null ? Math.max(0, Math.ceil((resetMs - Date.now()) / 1000)) : undefined;

  logger.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    resetTime: resetIso,
    userAgent: req.get('User-Agent'),
  });

  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: retryAfterSec,
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    resetTime: resetIso,
  });
};

// Skip rate limiting for certain conditions
const skipRateLimit = (req: Request): boolean => {
  // Skip for health checks
  if (req.path === '/health' || req.path === '/api/health') {
    return true;
  }

  // Skip for trusted IPs (if configured)
  const trustedIPs = process.env.TRUSTED_IPS?.split(',') || [];
  if (req.ip && trustedIPs.includes(req.ip)) {
    return true;
  }

  // Skip for internal service accounts (if authenticated). Canonical JWT auth
  // writes `roles: string[]`; the legacy singular `role` is kept for any
  // shim-shaped user object.
  const user = req.user as { role?: string; roles?: unknown } | undefined;
  if (user?.role === 'service') {
    return true;
  }
  if (Array.isArray(user?.roles) && user.roles.includes('service')) {
    return true;
  }

  return false;
};

// Legacy rate limiter has been removed
// Use enhancedRateLimit from ./enhancedRateLimit.ts instead
// The enhanced version provides better configurability and performance

// Global rate limiter - applies to all requests
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('global'),
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

// Authentication rate limiter - stricter for login attempts
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 auth attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('auth'),
  handler: rateLimitHandler,
  skipSuccessfulRequests: true,
  skipFailedRequests: false,
});

// API rate limiter - for general API endpoints
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('api'),
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

// Integration operation rate limiter - for resource-intensive operations
export const integrationRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 integration operations per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('integration'),
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

// ERP write-family rate limiter (repo-review A1). The ERP write/sync families
// (/api/integrations, the SuiteCentral sync routes) have no rate limiting: the
// global limiter's skip list disables it for them. This dedicated limiter caps
// mutating traffic on those families to backstop resource-exhaustion / sync
// floods, while its skip mirrors the global limiter's gating so demos and the
// e2e portals (DEMO_MODE / RATE_LIMIT_ENABLED=0) are never throttled.
const skipErpWriteRateLimit = (req: Request): boolean => {
  if (skipRateLimit(req)) return true;
  // Non-hosted demo mode and disabled rate limiting both mean "no limiter here",
  // matching MiddlewareSetup.setupRateLimit's own gating.
  if (isDemo() && !env.HOSTED_DEMO) return true;
  if (!env.RATE_LIMIT_ENABLED && !env.HOSTED_DEMO) return true;
  return false;
};

// Factory: each call returns a fresh limiter with its own MemoryStore, so a
// caller chooses the sharing model — one instance reused across mounts for a
// single shared budget (what RouteSetup does for the ERP families), or one per
// mount for independent budgets; tests get a clean window per instance.
// 60 writes / 5 min per (IP, user) is generous for operator-driven and batch
// sync while still catching a flood.
export const createErpWriteRateLimit = (): RequestHandler => rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('erp-write'),
  handler: rateLimitHandler,
  skip: skipErpWriteRateLimit,
});

/**
 * Apply a limiter to mutating methods only. Safe methods (GET/HEAD/OPTIONS)
 * pass straight through, so read/poll traffic on a write-family mount is never
 * throttled — only POST/PUT/PATCH/DELETE consume the budget.
 */
export function limitMutatingMethods(limiter: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_HTTP_METHODS.has(req.method.toUpperCase())) {
      return next();
    }
    return limiter(req, res, next);
  };
}

// Testing runner rate limiter — POST /api/testing/run spawns real child
// processes, so beyond platform-admin auth it gets a small dedicated budget.
// Exposed as a factory (not a shared instance) so each router instance owns
// its own MemoryStore; production creates exactly one router, and tests get a
// fresh window per app instead of tripping each other's counters.
export const createTestingRunRateLimit = () => rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 test runs per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('testing-run'),
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

// MCP schema-discovery limiter — POST /api/testing/mcp-schema stays anonymous
// (consumed by public/js/ai-config-dashboard.js), and the global limiter is a
// documented no-op, so without this budget an anonymous caller could hammer
// schema discovery unthrottled (repo-review RVW-002). Keyed by IP ONLY — the
// default (ip, user) key would give each authenticated user its own bucket
// and exceed the per-IP budget this limiter exists to enforce. Factory for
// the same per-router MemoryStore reason as createTestingRunRateLimit above.
export const createMcpSchemaRateLimit = () => rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // generous for interactive dashboard use, stops floods
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `mcp-schema:${req.ip || req.connection.remoteAddress || 'unknown'}`,
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

// Configuration rate limiter - for configuration changes
export const configRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 configuration changes per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: createKeyGenerator('config'),
  handler: rateLimitHandler,
  skip: skipRateLimit,
});

/**
 * Enhanced middleware to extract rate limiting info
 */
export const rateLimitHeaders = (req: Request, res: Response, next: NextFunction) => {
  if (req.rateLimit) {
    const info = getRateLimitInfo(req);
    res.set({
      'X-RateLimit-Limit': info.limit?.toString(),
      'X-RateLimit-Used': info.used?.toString(),
      'X-RateLimit-Remaining': info.remaining?.toString(),
      'X-RateLimit-Reset': info.resetTime && !isNaN(info.resetTime.getTime()) ? info.resetTime.toISOString() : undefined,
    });
  }
  next();
};

// Utility function to get rate limit info
export const getRateLimitInfo = (req: Request) => {
  const resetMs = resetTimeMs(req);
  const resetTime = resetMs !== null ? new Date(resetMs) : null;

  return {
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    remaining: req.rateLimit?.remaining,
    resetTime,
  };
};
