import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  exponentialBase: number;
  jitter: boolean;
  retryCondition?: (error: unknown) => boolean;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  totalTime: number;
  errors: unknown[];
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  error?: unknown;
  timestamp: Date;
}

/**
 * Retry service with exponential backoff and jitter
 * Provides configurable retry logic for failed operations
 */
@injectable()
export class RetryService {
  private readonly logger: Logger;

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Execute operation with retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig,
    context?: string,
  ): Promise<RetryResult<T>> {
    const errors: unknown[] = [];
    const attempts: RetryAttempt[] = [];
    const startTime = Date.now();

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      const attemptStart = Date.now();

      try {
        this.logger.debug('Executing operation with retry', {
          context,
          attempt,
          maxAttempts: config.maxAttempts,
        });

        const result = await operation();

        const totalTime = Date.now() - startTime;

        this.logger.info('Operation succeeded', {
          context,
          attempt,
          totalTime,
          totalAttempts: attempt,
        });

        return {
          result,
          attempts: attempt,
          totalTime,
          errors,
        };
      } catch (error) {
        errors.push(error);

        const attemptTime = Date.now() - attemptStart;
        attempts.push({
          attempt,
          delay: 0,
          error,
          timestamp: new Date(),
        });

        this.logger.warn('Operation attempt failed', {
          context,
          attempt,
          maxAttempts: config.maxAttempts,
          error: error instanceof Error ? error.message : String(error),
          attemptTime,
        });

        // Check if we should retry this error
        if (config.retryCondition && !config.retryCondition(error)) {
          this.logger.info('Error not retryable, stopping', {
            context,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // Don't wait after the last attempt
        if (attempt === config.maxAttempts) {
          const totalTime = Date.now() - startTime;

          this.logger.error('All retry attempts exhausted', {
            context,
            totalAttempts: attempt,
            totalTime,
            errors: errors.map(e => e instanceof Error ? e.message : String(e)),
          });

          // Throw the last error
          throw error;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, config);
        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt) {
          lastAttempt.delay = delay;
        }

        this.logger.debug('Waiting before retry', {
          context,
          attempt,
          delay,
          nextAttempt: attempt + 1,
        });

        await this.sleep(delay);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new Error('Unexpected end of retry loop');
  }

  /**
   * Execute operation with simple retry (uses default config)
   */
  async retry<T>(
    operation: () => Promise<T>,
    maxAttempts = 3,
    baseDelay = 1000,
    context?: string,
  ): Promise<T> {
    const config: RetryConfig = {
      maxAttempts,
      baseDelay,
      maxDelay: 30000,
      exponentialBase: 2,
      jitter: true,
    };

    const result = await this.executeWithRetry(operation, config, context);
    return result.result;
  }

  /**
   * Create a retryable version of a function
   */
  retryable<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
    config: RetryConfig,
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      const result = await this.executeWithRetry(
        () => fn(...args),
        config,
        fn.name || 'anonymous',
      );
      return result.result;
    };
  }

  /**
   * Calculate delay with exponential backoff and optional jitter
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    // Calculate exponential backoff
    const exponentialDelay = config.baseDelay * Math.pow(config.exponentialBase, attempt - 1);

    // Apply maximum delay cap
    const cappedDelay = Math.min(exponentialDelay, config.maxDelay);

    // Apply jitter if enabled
    if (config.jitter) {
      // Add random jitter up to 10% of the delay
      const jitterAmount = cappedDelay * 0.1;
      const jitter = (Math.random() - 0.5) * 2 * jitterAmount;
      return Math.max(0, cappedDelay + jitter);
    }

    return cappedDelay;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Default retry condition - retries on most errors except auth/validation
   */
  static defaultRetryCondition(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Don't retry on authentication/authorization errors
      if (message.includes('unauthorized') ||
          message.includes('forbidden') ||
          message.includes('authentication') ||
          message.includes('invalid credentials')) {
        return false;
      }

      // Don't retry on validation errors
      if (message.includes('validation') ||
          message.includes('bad request') ||
          message.includes('invalid input')) {
        return false;
      }

      // Don't retry on not found errors
      if (message.includes('not found') ||
          message.includes('does not exist')) {
        return false;
      }
    }

    // Retry on network errors, timeouts, server errors, etc.
    return true;
  }

  /**
   * HTTP-specific retry condition
   */
  static httpRetryCondition(error: unknown): boolean {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as any).status;

      // Don't retry on 4xx errors (client errors)
      if (status >= 400 && status < 500) {
        // Except for these retryable 4xx errors
        return status === 408 || // Request Timeout
               status === 429;   // Too Many Requests
      }

      // Retry on 5xx errors (server errors)
      return status >= 500;
    }

    return RetryService.defaultRetryCondition(error);
  }

  /**
   * Database-specific retry condition
   */
  static databaseRetryCondition(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Retry on connection errors
      if (message.includes('connection') ||
          message.includes('timeout') ||
          message.includes('network')) {
        return true;
      }

      // Retry on deadlock errors
      if (message.includes('deadlock') ||
          message.includes('lock timeout')) {
        return true;
      }

      // Don't retry on syntax or constraint errors
      if (message.includes('syntax') ||
          message.includes('constraint') ||
          message.includes('duplicate key')) {
        return false;
      }
    }

    return RetryService.defaultRetryCondition(error);
  }

  /**
   * Get default retry configurations for common scenarios
   */
  static getDefaultConfigs() {
    return {
      // Network operations
      network: {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 10000,
        exponentialBase: 2,
        jitter: true,
        retryCondition: RetryService.httpRetryCondition,
      } as RetryConfig,

      // Database operations
      database: {
        maxAttempts: 3,
        baseDelay: 500,
        maxDelay: 5000,
        exponentialBase: 2,
        jitter: true,
        retryCondition: RetryService.databaseRetryCondition,
      } as RetryConfig,

      // External API calls
      api: {
        maxAttempts: 5,
        baseDelay: 1000,
        maxDelay: 30000,
        exponentialBase: 2,
        jitter: true,
        retryCondition: RetryService.httpRetryCondition,
      } as RetryConfig,

      // Queue operations
      queue: {
        maxAttempts: 3,
        baseDelay: 2000,
        maxDelay: 15000,
        exponentialBase: 2,
        jitter: true,
        retryCondition: RetryService.defaultRetryCondition,
      } as RetryConfig,

      // File operations
      file: {
        maxAttempts: 3,
        baseDelay: 500,
        maxDelay: 5000,
        exponentialBase: 1.5,
        jitter: false,
        retryCondition: (error: unknown) => {
          if (error instanceof Error) {
            const message = error.message.toLowerCase();
            // Retry on temporary file system errors
            return message.includes('ebusy') ||
                   message.includes('emfile') ||
                   message.includes('enotdir') ||
                   message.includes('temporary');
          }
          return false;
        },
      } as RetryConfig,
    };
  }
}
