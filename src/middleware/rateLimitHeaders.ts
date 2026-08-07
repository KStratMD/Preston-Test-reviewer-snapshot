import type { Request, Response, NextFunction } from 'express';
import { env } from '../config';
import { logger } from '../utils/Logger';

/**
 * Rate limiting headers middleware that adds standard rate limit headers to responses
 * Following RFC draft-polli-ratelimit-headers and industry best practices
 */

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
    firstRequestTime: number;
  };
}

// In-memory store for rate limit tracking (use Redis in production for distributed systems)
const rateLimitStore: RateLimitStore = {};

// Cleanup old entries every 5 minutes
let cleanupInterval: NodeJS.Timeout | undefined;
// Skip setting the interval when running under Jest to avoid open handle warnings
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    Object.keys(rateLimitStore).forEach(key => {
      const entry = rateLimitStore[key];
      if (entry && entry.resetTime < now) {
        delete rateLimitStore[key];
      }
    });
  }, 5 * 60 * 1000);
  // Do not keep the event loop alive just for cleanup in long-running tests or graceful shutdowns
  // In Node.js, setInterval returns a Timeout which typically supports unref()
  // Guard call so TypeScript doesn't require the method at compile time
  const timerInterval = cleanupInterval as unknown as NodeJS.Timeout;
  if (timerInterval && typeof timerInterval.unref === 'function') {
    timerInterval.unref();
  }
}

/**
 * For testing or controlled environments, allow stopping the cleanup interval explicitly
 */
export function stopRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

/**
 * Get client identifier for rate limiting
 */
function getClientId(req: Request): string {
  // Use IP address and optionally User-Agent for better client identification
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('user-agent') || 'unknown';
  
  // For authenticated requests, could use user ID instead
  const authHeader = req.get('authorization');
  if (authHeader) {
    // Create a hash of the auth header for privacy
    const crypto = require('crypto');
    const authHash = crypto.createHash('sha256').update(authHeader).digest('hex').substring(0, 16);
    return `auth:${authHash}`;
  }
  
  const crypto = require('crypto');
  return `${ip}:${crypto.createHash('sha256').update(userAgent).digest('hex').substring(0, 8)}`;
}

/**
 * Get rate limit configuration based on endpoint and request type
 */
function getRateLimitConfig(req: Request): { limit: number; windowMs: number } {
  const path = req.path;
  const method = req.method;

  // Authentication endpoints - stricter limits
  if (path.startsWith('/api/auth') || path.includes('/login') || path.includes('/token')) {
    return { limit: 10, windowMs: 15 * 60 * 1000 }; // 10 requests per 15 minutes
  }

  // File upload endpoints - moderate limits
  if (path.startsWith('/api/upload') || path.startsWith('/api/files')) {
    return { limit: 20, windowMs: 10 * 60 * 1000 }; // 20 requests per 10 minutes
  }

  // Heavy operations (integrations, bulk operations)
  if (path.includes('/integration') && (method === 'POST' || method === 'PUT')) {
    return { limit: 50, windowMs: 60 * 1000 }; // 50 requests per minute
  }

  // API documentation and health checks - higher limits
  if (path.startsWith('/api/docs') || path.startsWith('/health') || path.startsWith('/api/health')) {
    return { limit: 200, windowMs: 60 * 1000 }; // 200 requests per minute
  }

  // Default rate limit from environment
  return {
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
  };
}

/**
 * Calculate rate limit information for a client
 */
function calculateRateLimit(clientId: string, config: { limit: number; windowMs: number }): RateLimitInfo {
  const now = Date.now();
  const windowStart = now - config.windowMs;
  
  // Get or initialize client data
  if (!rateLimitStore[clientId] || rateLimitStore[clientId].resetTime < now) {
    rateLimitStore[clientId] = {
      count: 0,
      resetTime: now + config.windowMs,
      firstRequestTime: now,
    };
  }

  const clientData = rateLimitStore[clientId];
  
  // If we're in a new window, reset the count
  if (clientData.firstRequestTime < windowStart) {
    clientData.count = 0;
    clientData.firstRequestTime = now;
    clientData.resetTime = now + config.windowMs;
  }

  // Increment request count
  clientData.count++;

  const remaining = Math.max(0, config.limit - clientData.count);
  const resetTimeSeconds = Math.ceil(clientData.resetTime / 1000);

  const info: RateLimitInfo = {
    limit: config.limit,
    remaining,
    reset: resetTimeSeconds,
  };

  // Add retry-after if limit exceeded
  if (remaining === 0) {
    info.retryAfter = Math.ceil((clientData.resetTime - now) / 1000);
  }

  return info;
}

/**
 * Rate limit headers middleware
 * Adds standard rate limiting headers to all responses
 */
export function rateLimitHeaders(req: Request, res: Response, next: NextFunction): void {
  try {
    // Check if headers have already been sent
    if (res.headersSent) {
      return next();
    }

    const clientId = getClientId(req);
    const config = getRateLimitConfig(req);
    const rateLimitInfo = calculateRateLimit(clientId, config);

    // Set standard rate limit headers (RFC draft-polli-ratelimit-headers)
    if (!res.headersSent) {
      res.setHeader('RateLimit-Limit', rateLimitInfo.limit.toString());
      res.setHeader('RateLimit-Remaining', rateLimitInfo.remaining.toString());
      res.setHeader('RateLimit-Reset', rateLimitInfo.reset.toString());

      // Legacy headers for backwards compatibility
      res.setHeader('X-RateLimit-Limit', rateLimitInfo.limit.toString());
      res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());
      res.setHeader('X-RateLimit-Reset', rateLimitInfo.reset.toString());

      // Window information
      res.setHeader('X-RateLimit-Window', Math.ceil(config.windowMs / 1000).toString());
    }

    // If limit exceeded, add Retry-After header and return 429
    if (rateLimitInfo.remaining === 0 && rateLimitInfo.retryAfter && !res.headersSent) {
      res.setHeader('Retry-After', rateLimitInfo.retryAfter.toString());
      
      // Don't block the request here - let the rate limiter middleware handle the 429 response
      // We just add the headers for client information
    }

    // Add rate limit policy header for client information
    if (!res.headersSent) {
      const policyValue = `${rateLimitInfo.limit};w=${Math.ceil(config.windowMs / 1000)}`;
      res.setHeader('RateLimit-Policy', policyValue);
    }

    next();
  } catch (error) {
    // Don't let rate limit header errors break the request
    logger.warn('Rate limit headers middleware error:', error);
    next();
  }
}

/**
 * Enhanced rate limit headers with burst detection
 */
export function enhancedRateLimitHeaders(req: Request, res: Response, next: NextFunction): void {
  rateLimitHeaders(req, res, next);

  // Add additional security headers for suspicious patterns
  if (res.headersSent) {
    return;
  }

  try {
    const clientId = getClientId(req);
    const clientData = rateLimitStore[clientId];

    if (clientData && clientData.count > 0 && !res.headersSent) {
      // Calculate request rate
      const timeElapsed = Date.now() - clientData.firstRequestTime;
      const requestsPerSecond = clientData.count / (timeElapsed / 1000);

      // Add burst detection header if request rate is very high
      if (requestsPerSecond > 10) {
        res.setHeader('X-Rate-Limit-Burst-Detected', 'true');
      }

      // Add request pattern information
      res.setHeader('X-Rate-Limit-Requests-This-Window', clientData.count.toString());
    }
  } catch (error) {
    // Ignore errors in enhanced headers to prevent breaking the request
    logger.warn('Enhanced rate limit headers error:', error);
  }
}

/**
 * Middleware specifically for API endpoints with enhanced tracking
 */
export function apiRateLimitHeaders(req: Request, res: Response, next: NextFunction): void {
  // Only apply to API endpoints
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  enhancedRateLimitHeaders(req, res, next);
}

/**
 * Get current rate limit status for a client (useful for debugging)
 */
export function getRateLimitStatus(clientId: string): RateLimitInfo | null {
  const clientData = rateLimitStore[clientId];
  if (!clientData) {
    return null;
  }

  const now = Date.now();
  return {
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    remaining: Math.max(0, env.RATE_LIMIT_MAX_REQUESTS - clientData.count),
    reset: Math.ceil(clientData.resetTime / 1000),
    retryAfter: clientData.resetTime > now ? Math.ceil((clientData.resetTime - now) / 1000) : undefined,
  };
}

/**
 * Clear rate limit data for a client (useful for testing or admin operations)
 */
export function clearRateLimitData(clientId?: string): void {
  if (clientId) {
    delete rateLimitStore[clientId];
  } else {
    // Clear all data
    Object.keys(rateLimitStore).forEach(key => {
      delete rateLimitStore[key];
    });
  }
}