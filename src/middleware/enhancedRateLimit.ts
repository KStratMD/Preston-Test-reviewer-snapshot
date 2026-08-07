import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/Logger';

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  onLimitReached?: (req: Request, res: Response) => void;
  // Enhanced features
  burstLimit?: number;
  burstWindowMs?: number;
  dynamicLimit?: (req: Request) => number;
  whiteList?: string[];
  slidingWindow?: boolean;
  distributed?: boolean;
}

export interface RateLimitEntry {
  count: number;
  resetTime: number;
  burstCount?: number;
  burstResetTime?: number;
  history?: number[]; // For sliding window
}

export class EnhancedRateLimit {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(private config: RateLimitConfig) {
    // Set defaults after initialization
    this.setupDefaults();

    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  private setupDefaults(): void {
    this.config = {
      windowMs: this.config.windowMs || 60000, // 1 minute
      max: this.config.max || 100,
      message: this.config.message || 'Rate limit exceeded',
      standardHeaders: this.config.standardHeaders ?? true,
      legacyHeaders: this.config.legacyHeaders ?? false,
      skipSuccessfulRequests: this.config.skipSuccessfulRequests ?? false,
      skipFailedRequests: this.config.skipFailedRequests ?? false,
      keyGenerator: this.config.keyGenerator || this.defaultKeyGenerator,
      onLimitReached: this.config.onLimitReached || this.defaultOnLimitReached,
      burstLimit: this.config.burstLimit || this.config.max * 2,
      burstWindowMs: this.config.burstWindowMs || 10000, // 10 seconds
      dynamicLimit: this.config.dynamicLimit,
      whiteList: this.config.whiteList || [],
      slidingWindow: this.config.slidingWindow ?? true,
      distributed: this.config.distributed ?? false,
    };
  }

  public middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const keyGenerator = this.config.keyGenerator || this.defaultKeyGenerator;
        const key = keyGenerator(req);

        // Check whitelist
        const whiteList = this.config.whiteList || [];
        if (whiteList.includes(this.getClientIP(req))) {
          return next();
        }

        // Get current limit (dynamic or static)
        const currentLimit = this.config.dynamicLimit ? this.config.dynamicLimit(req) : this.config.max;

        const result = await this.checkLimit(key, currentLimit);

        // Set rate limit headers
        if (this.config.standardHeaders) {
          res.set({
            'RateLimit-Limit': currentLimit.toString(),
            'RateLimit-Remaining': Math.max(0, result.remaining).toString(),
            'RateLimit-Reset': new Date(result.resetTime).toISOString(),
            'RateLimit-Policy': `${currentLimit};w=${this.config.windowMs / 1000}`,
          });
        }

        if (this.config.legacyHeaders) {
          res.set({
            'X-RateLimit-Limit': currentLimit.toString(),
            'X-RateLimit-Remaining': Math.max(0, result.remaining).toString(),
            'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
          });
        }

        if (result.exceeded) {
          if (this.config.onLimitReached) {
            this.config.onLimitReached(req, res);
          }

          logger.warn('Rate limit exceeded', {
            key: this.sanitizeKey(key),
            ip: this.getClientIP(req),
            userAgent: req.get('User-Agent'),
            url: req.url,
            method: req.method,
            currentCount: result.currentCount,
            limit: currentLimit,
          });

          res.status(429).json({
            error: 'Rate limit exceeded',
            message: this.config.message || 'Rate limit exceeded',
            retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
          });
          return;
        }

        // Add rate limit info to request
        (req as any).rateLimit = {
          limit: currentLimit,
          remaining: result.remaining,
          reset: result.resetTime,
          used: result.currentCount,
        };

        next();
      } catch (error) {
        logger.error('Rate limiting error', error);
        next(); // Continue on error to avoid breaking the application
      }
    };
  }

  private async checkLimit(key: string, limit: number): Promise<{
    exceeded: boolean;
    remaining: number;
    resetTime: number;
    currentCount: number;
  }> {
    const now = Date.now();
    let entry = this.store.get(key);
    const burstWindowMs = this.config.burstWindowMs || 10000;

    if (!entry || (entry.resetTime <= now)) {
      // Create new entry or reset expired one
      entry = {
        count: 0,
        resetTime: now + this.config.windowMs,
        burstCount: 0,
        burstResetTime: now + burstWindowMs,
        history: this.config.slidingWindow ? [] : undefined,
      };
    }

    // Handle sliding window
    if (this.config.slidingWindow && entry.history) {
      // Remove old entries
      const windowStart = now - this.config.windowMs;
      entry.history = entry.history.filter(timestamp => timestamp > windowStart);

      // Add current request
      entry.history.push(now);
      entry.count = entry.history.length;
    } else {
      // Fixed window
      entry.count++;
    }

    // Handle burst limiting
    if (entry.burstResetTime && entry.burstResetTime <= now) {
      entry.burstCount = 0;
      entry.burstResetTime = now + burstWindowMs;
    }
    if (entry.burstCount !== undefined) {
      entry.burstCount++;
    }

    this.store.set(key, entry);

    // Check limits
    const regularExceeded = entry.count > limit;
    const burstLimit = this.config.burstLimit || limit * 2;
    const burstExceeded = entry.burstCount !== undefined && entry.burstCount > burstLimit;

    return {
      exceeded: regularExceeded || burstExceeded,
      remaining: Math.max(0, limit - entry.count),
      resetTime: entry.resetTime,
      currentCount: entry.count,
    };
  }

  private defaultKeyGenerator(req: Request): string {
    // Combine IP and optional user ID for more granular limiting
    const ip = this.getClientIP(req);
    const userId = (req as any).user?.id || (req as any).userId;
    return userId ? `${ip}:${userId}` : ip;
  }

  private defaultOnLimitReached(req: Request, _res: Response): void {
    // Provide a minimal side-effect to avoid empty-function lint issues
    logger.warn('Limit reached callback invoked', {
      ip: this.getClientIP(req),
      url: req.url,
      method: req.method,
    });
  }

  private getClientIP(req: Request): string {
    return (
      req.ip ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      (req.connection as any)?.socket?.remoteAddress ||
      req.get('X-Forwarded-For')?.split(',')[0] ||
      req.get('X-Real-IP') ||
      'unknown'
    );
  }

  private sanitizeKey(key: string): string {
    // Remove sensitive information from keys for logging
    return key.replace(/:\d+$/, ':***'); // Hide user IDs
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store.entries()) {
      if (entry.resetTime <= now && (!entry.burstResetTime || entry.burstResetTime <= now)) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Rate limit cleanup completed', {
        entriesRemoved: cleaned,
        activeEntries: this.store.size,
      });
    }
  }

  public getStats(): {
    activeKeys: number;
    totalRequests: number;
    config: Partial<RateLimitConfig>;
    } {
    const totalRequests = Array.from(this.store.values())
      .reduce((sum, entry) => sum + entry.count, 0);

    return {
      activeKeys: this.store.size,
      totalRequests,
      config: {
        windowMs: this.config.windowMs,
        max: this.config.max,
        burstLimit: this.config.burstLimit,
        slidingWindow: this.config.slidingWindow,
      },
    };
  }

  public resetKey(key: string): boolean {
    return this.store.delete(key);
  }

  public getKeyInfo(key: string): RateLimitEntry | undefined {
    return this.store.get(key);
  }

  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
    logger.info('Enhanced rate limit shutdown completed');
  }
}

// Factory for different rate limiting strategies
export class RateLimitFactory {
  static createBasicLimit(windowMs: number, max: number): EnhancedRateLimit {
    return new EnhancedRateLimit({
      windowMs,
      max,
      message: 'Too many requests',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyGenerator: (req) => req.ip || 'unknown',
      onLimitReached: (req) => {
        logger.warn('Rate limit reached (basic)', { ip: req.ip, path: req.url });
      },
      slidingWindow: false,
      distributed: false,
    });
  }

  static createSlidingWindowLimit(windowMs: number, max: number): EnhancedRateLimit {
    return new EnhancedRateLimit({
      windowMs,
      max,
      message: 'Rate limit exceeded - sliding window',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyGenerator: (req) => req.ip || 'unknown',
      onLimitReached: (req) => {
        logger.warn('Rate limit reached (sliding)', { ip: req.ip, path: req.url });
      },
      slidingWindow: true,
      distributed: false,
    });
  }

  static createBurstLimit(windowMs: number, max: number, burstLimit: number, burstWindowMs: number): EnhancedRateLimit {
    return new EnhancedRateLimit({
      windowMs,
      max,
      burstLimit,
      burstWindowMs,
      message: 'Burst limit exceeded',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyGenerator: (req) => req.ip || 'unknown',
      onLimitReached: (req) => {
        logger.warn('Rate limit reached (burst)', { ip: req.ip, path: req.url });
      },
      slidingWindow: true,
      distributed: false,
    });
  }

  static createUserBasedLimit(windowMs: number, max: number): EnhancedRateLimit {
    return new EnhancedRateLimit({
      windowMs,
      max,
      message: 'User rate limit exceeded',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyGenerator: (req) => {
        const userId = (req as any).user?.id || (req as any).userId;
        return userId ? `user:${userId}` : req.ip || 'unknown';
      },
      onLimitReached: (req) => {
        logger.warn('Rate limit reached (user)', { ip: req.ip, path: req.url });
      },
      slidingWindow: true,
      distributed: false,
    });
  }

  static createDynamicLimit(
    windowMs: number,
    baseLine: number,
    dynamicFn: (req: Request) => number,
  ): EnhancedRateLimit {
    return new EnhancedRateLimit({
      windowMs,
      max: baseLine,
      dynamicLimit: dynamicFn,
      message: 'Dynamic rate limit exceeded',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyGenerator: (req) => req.ip || 'unknown',
      onLimitReached: (req) => {
        logger.warn('Rate limit reached (dynamic)', { ip: req.ip, path: req.url });
      },
      slidingWindow: true,
      distributed: false,
    });
  }
}
