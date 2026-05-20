import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/Logger';

const logger = new Logger('RateLimit');

// Extend Express Request interface for rate limiting
interface RateLimitInfo {
  limit: number;
  used: number;
  remaining: number;
  resetTime: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    rateLimit?: RateLimitInfo;
  }
}

// Create rate limit key generator
const createKeyGenerator = (prefix: string) => {
  return (req: Request): string => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userId = (req.user as any)?.id || 'anonymous';
    return `${prefix}:${ip}:${userId}`;
  };
};

// Custom rate limit handler
const rateLimitHandler = (req: Request, res: Response) => {
  const resetTime = new Date(Date.now() + (req.rateLimit?.resetTime || 0));

  logger.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    resetTime: resetTime.toISOString(),
    userAgent: req.get('User-Agent'),
  });

  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: Math.ceil((req.rateLimit?.resetTime || 0) / 1000),
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    resetTime: resetTime.toISOString(),
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

  // Skip for internal service accounts (if authenticated)
  if ((req.user as { role?: string })?.role === 'service') {
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
  const resetTime = req.rateLimit?.resetTime && !isNaN(req.rateLimit.resetTime)
    ? new Date(req.rateLimit.resetTime)
    : null;

  return {
    limit: req.rateLimit?.limit,
    used: req.rateLimit?.used,
    remaining: req.rateLimit?.remaining,
    resetTime,
  };
};
