import { EventEmitter } from "events";
import { Logger } from "./Logger";
import { CircuitBreaker } from "./CircuitBreaker";
// Logger instance for retry strategies
const logger = new Logger("AdvancedRetryStrategies");

export interface RetryOptions {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
  jitter: boolean;
  timeout?: number;
  retryCondition?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
  name?: string;
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  timestamp: Date;
  error?: unknown;
  success: boolean;
  duration: number;
}

export interface RetryMetrics {
  totalAttempts: number;
  successfulOperations: number;
  failedOperations: number;
  totalRetries: number;
  averageRetryCount: number;
  averageDelay: number;
  lastAttemptTime?: Date;
  successRate: number;
  operationHistory: RetryAttempt[];
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly originalError: unknown,
    public readonly retryable = true,
    public readonly delay?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export class RetryExhaustedException extends Error {
  constructor(
    message: string,
    public readonly attempts: RetryAttempt[],
    public readonly lastError: unknown,
  ) {
    super(message);
    this.name = "RetryExhaustedException";
  }
}

export type BackoffStrategy = "exponential" | "linear" | "fixed" | "fibonacci" | "custom";

export interface AdvancedRetryOptions extends RetryOptions {
  strategy: BackoffStrategy;
  customBackoff?: (attempt: number, baseDelay: number) => number;
  circuitBreakerName?: string;
  enableCircuitBreaker?: boolean;
  adaptiveRetry?: boolean;
  bulkheadName?: string;
  enableBulkhead?: boolean;
  maxConcurrentOperations?: number;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  name: string;
  retryableErrors: string[];
  nonRetryableErrors: string[];
  statusCodes?: {
    retryable: number[];
    nonRetryable: number[];
  };
  customErrorClassifier?: (error: unknown) => "retry" | "fail" | "circuit-break";
}

export interface BulkheadMetrics {
  name: string;
  maxConcurrent: number;
  currentConcurrent: number;
  totalRequests: number;
  rejectedRequests: number;
  averageWaitTime: number;
  queueSize: number;
}

interface QueueItem {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timestamp: Date;
  operation: () => Promise<unknown>;
}

class Bulkhead {
  private currentRequests = 0;
  private readonly queue: QueueItem[] = [];
  private readonly metrics: BulkheadMetrics;

  constructor(
    public readonly name: string,
    public readonly maxConcurrent: number,
  ) {
    this.metrics = {
      name,
      maxConcurrent,
      currentConcurrent: 0,
      totalRequests: 0,
      rejectedRequests: 0,
      averageWaitTime: 0,
      queueSize: 0,
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.metrics.totalRequests++;

    if (this.currentRequests < this.maxConcurrent) {
      return this.executeImmediate(operation);
    }

    // Queue the request
    return new Promise<T>((resolve, reject) => {
      const queueItem: QueueItem = {
        resolve: value => resolve(value as T),
        reject,
        timestamp: new Date(),
        operation: operation as () => Promise<unknown>,
      };
      this.queue.push(queueItem);
      this.metrics.queueSize = this.queue.length;
    });
  }

  private async executeImmediate<T>(operation: () => Promise<T>): Promise<T> {
    this.currentRequests++;
    this.metrics.currentConcurrent = this.currentRequests;

    try {
      const result = await operation();
      return result;
    } finally {
      this.currentRequests--;
      this.metrics.currentConcurrent = this.currentRequests;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length === 0 || this.currentRequests >= this.maxConcurrent) {
      return;
    }

    const queueItem = this.queue.shift();
    this.metrics.queueSize = this.queue.length;
    if (!queueItem) {
      return;
    }

    const waitTime = Date.now() - queueItem.timestamp.getTime();
    this.updateAverageWaitTime(waitTime);

    this.executeImmediate(async () => queueItem.operation())
      .then(result => queueItem.resolve(result))
      .catch(error => queueItem.reject(error));
  }

  private updateAverageWaitTime(waitTime: number): void {
    const totalProcessed = this.metrics.totalRequests - this.metrics.rejectedRequests - this.queue.length;
    if (totalProcessed === 1) {
      this.metrics.averageWaitTime = waitTime;
    } else {
      this.metrics.averageWaitTime =
        (this.metrics.averageWaitTime * (totalProcessed - 1) + waitTime) / totalProcessed;
    }
  }

  getMetrics(): BulkheadMetrics {
    return { ...this.metrics };
  }
}

export class AdvancedRetryManager extends EventEmitter {
  private static instance: AdvancedRetryManager;
  private readonly operationMetrics = new Map<string, RetryMetrics>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly bulkheads = new Map<string, Bulkhead>();
  private readonly retryPolicies = new Map<string, RetryPolicy>();
  private readonly adaptiveMetrics = new Map<string, { successRates: number[]; optimalDelay: number }>();

  private constructor() {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(30);
    this.setupDefaultPolicies();
  }

  public static getInstance(): AdvancedRetryManager {
    if (!AdvancedRetryManager.instance) {
      AdvancedRetryManager.instance = new AdvancedRetryManager();
    }
    return AdvancedRetryManager.instance;
  }

  private setupDefaultPolicies(): void {
    // HTTP retry policy
    this.addRetryPolicy({
      name: "http",
      retryableErrors: ["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"],
      nonRetryableErrors: ["EACCES", "EPERM"],
      statusCodes: {
        retryable: [408, 429, 500, 502, 503, 504],
        nonRetryable: [400, 401, 403, 404, 422],
      },
    });

    // Database retry policy
    this.addRetryPolicy({
      name: "database",
      retryableErrors: ["ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK", "CONNECTION_LOST"],
      nonRetryableErrors: ["ER_SYNTAX_ERROR", "ER_ACCESS_DENIED_ERROR"],
    });

    // Generic service retry policy
    this.addRetryPolicy({
      name: "service",
      retryableErrors: ["ServiceUnavailable", "TemporaryFailure", "RateLimitExceeded"],
      nonRetryableErrors: ["InvalidRequest", "Unauthorized", "Forbidden"],
    });
  }

  public addRetryPolicy(policy: RetryPolicy): void {
    this.retryPolicies.set(policy.name, policy);
    logger.info("Retry policy added", { name: policy.name });
  }

  public addBulkhead(name: string, maxConcurrent: number): void {
    this.bulkheads.set(name, new Bulkhead(name, maxConcurrent));
    logger.info("Bulkhead created", { name, maxConcurrent });
  }

  public async withRetry<T>(
    operation: () => Promise<T>,
    options: AdvancedRetryOptions,
  ): Promise<T> {
    const operationName = options.name || "unnamed";
    const startTime = Date.now();

    // Initialize metrics if not exists
    if (!this.operationMetrics.has(operationName)) {
      this.operationMetrics.set(operationName, {
        totalAttempts: 0,
        successfulOperations: 0,
        failedOperations: 0,
        totalRetries: 0,
        averageRetryCount: 0,
        averageDelay: 0,
        successRate: 0,
        operationHistory: [],
      });
    }

    const metrics = this.operationMetrics.get(operationName);
    if (!metrics) {
      throw new Error(`Retry metrics missing for operation '${operationName}'`);
    }
    const attempts: RetryAttempt[] = [];

    // Setup circuit breaker if enabled
    let circuitBreaker: CircuitBreaker | undefined;
    if (options.enableCircuitBreaker && options.circuitBreakerName) {
      if (!this.circuitBreakers.has(options.circuitBreakerName)) {
        this.circuitBreakers.set(options.circuitBreakerName, new CircuitBreaker({
          failureThreshold: 5,
          resetTimeout: 60000,
          monitoringPeriod: 60000,
        }));
      }
      circuitBreaker = this.circuitBreakers.get(options.circuitBreakerName);
    }

    // Setup bulkhead if enabled
    let bulkhead: Bulkhead | undefined;
    if (options.enableBulkhead && options.bulkheadName) {
      if (!this.bulkheads.has(options.bulkheadName)) {
        this.addBulkhead(options.bulkheadName, options.maxConcurrentOperations || 10);
      }
      bulkhead = this.bulkheads.get(options.bulkheadName);
    }

    // Adaptive retry adjustment
    if (options.adaptiveRetry) {
      this.adjustOptionsForAdaptiveRetry(operationName, options);
    }

    const executeOperation = async (): Promise<T> => {
      let wrappedOperation = operation;

      // Wrap with bulkhead if configured
      if (bulkhead) {
        wrappedOperation = async () => bulkhead.execute(operation);
      }

      // Wrap with circuit breaker if configured
      if (circuitBreaker) {
        const originalOperation = wrappedOperation;
        wrappedOperation = async () => circuitBreaker.execute(originalOperation);
      }

      return wrappedOperation();
    };

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const attemptStartTime = Date.now();
      metrics.totalAttempts++;

      try {
        // Add timeout if specified
        let result: T;
        if (options.timeout) {
          result = await Promise.race([
            executeOperation(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Operation timeout")), options.timeout),
            ),
          ]);
        } else {
          result = await executeOperation();
        }

        // Success
        const duration = Date.now() - attemptStartTime;
        const attemptData: RetryAttempt = {
          attempt,
          delay: 0,
          timestamp: new Date(),
          success: true,
          duration,
        };

        attempts.push(attemptData);
        metrics.operationHistory.push(attemptData);
        metrics.successfulOperations++;

        this.updateMetrics(operationName, attempts, true);

        if (options.adaptiveRetry) {
          this.updateAdaptiveMetrics(operationName, true, Date.now() - startTime);
        }

        logger.debug("Operation succeeded", {
          operationName,
          attempt,
          duration,
          totalDuration: Date.now() - startTime,
        });

        this.emit("operationSuccess", {
          operationName,
          attempt,
          duration,
          totalDuration: Date.now() - startTime,
          attempts,
        });

        return result;

      } catch (error) {
        const duration = Date.now() - attemptStartTime;
        const shouldRetry = this.shouldRetry(error, attempt, options);

        const attemptData: RetryAttempt = {
          attempt,
          delay: 0,
          timestamp: new Date(),
          error,
          success: false,
          duration,
        };

        attempts.push(attemptData);
        metrics.operationHistory.push(attemptData);

        // Trim history to last 100 operations
        if (metrics.operationHistory.length > 100) {
          metrics.operationHistory = metrics.operationHistory.slice(-100);
        }

        if (!shouldRetry || attempt >= options.maxAttempts) {
          // Final failure
          metrics.failedOperations++;
          this.updateMetrics(operationName, attempts, false);

          if (options.adaptiveRetry) {
            this.updateAdaptiveMetrics(operationName, false, Date.now() - startTime);
          }

          logger.error("Operation failed after all retries", {
            operationName,
            totalAttempts: attempt,
            totalDuration: Date.now() - startTime,
            lastError: error,
          });

          this.emit("operationFailed", {
            operationName,
            totalAttempts: attempt,
            totalDuration: Date.now() - startTime,
            lastError: error,
            attempts,
          });

          throw new RetryExhaustedException(
            `Operation failed after ${attempt} attempts`,
            attempts,
            error,
          );
        }

        // Calculate delay for next retry
        const delay = this.calculateDelay(attempt, options);
        attemptData.delay = delay;

        logger.warn("Operation attempt failed, retrying", {
          operationName,
          attempt,
          delay,
          error: error instanceof Error ? error.message : String(error),
          nextAttempt: attempt + 1,
        });

        if (options.onRetry) {
          options.onRetry(error, attempt, delay);
        }

        this.emit("operationRetry", {
          operationName,
          attempt,
          delay,
          error,
          nextAttempt: attempt + 1,
        });

        // Wait before next attempt
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // This should never be reached due to the loop logic above
    throw new Error("Unexpected end of retry loop");
  }

  private shouldRetry(error: unknown, attempt: number, options: AdvancedRetryOptions): boolean {
    // Check custom retry condition first
    if (options.retryCondition) {
      return options.retryCondition(error, attempt);
    }

    // Check retry policy if specified
    if (options.retryPolicy) {
      const classification = this.classifyError(error, options.retryPolicy);
      return classification === "retry";
    }

    // Default behavior - retry on most errors except explicit non-retryable ones
    if (error instanceof RetryableError) {
      return error.retryable;
    }

    // Check for common non-retryable errors
    const nonRetryableErrors = [
      "ValidationError",
      "AuthenticationError",
      "AuthorizationError",
      "NotFoundError",
    ];

    const { name: errorName } = this.extractErrorMetadata(error);
    if (errorName && nonRetryableErrors.includes(errorName)) {
      return false;
    }

    // Default to retryable
    return true;
  }

  private classifyError(error: unknown, policy: RetryPolicy): "retry" | "fail" | "circuit-break" {
    // Use custom classifier if available
    if (policy.customErrorClassifier) {
      return policy.customErrorClassifier(error);
    }

    const { code, name, statusCode } = this.extractErrorMetadata(error);
    const errorCode = code ?? name ?? "";

    // Check explicit non-retryable errors
    if (policy.nonRetryableErrors.includes(errorCode)) {
      return "fail";
    }

    // Check explicit retryable errors
    if (policy.retryableErrors.includes(errorCode)) {
      return "retry";
    }

    // Check status codes if applicable
    if (statusCode && policy.statusCodes) {
      if (policy.statusCodes.nonRetryable.includes(statusCode)) {
        return "fail";
      }
      if (policy.statusCodes.retryable.includes(statusCode)) {
        return "retry";
      }
    }

    // Default to retry for unknown errors
    return "retry";
  }

  private extractErrorMetadata(error: unknown): {
    name?: string;
    code?: string;
    statusCode?: number;
  } {
    const record = (typeof error === "object" && error !== null)
      ? error as Record<string, unknown>
      : undefined;

    let name: string | undefined;
    if (error instanceof Error && typeof error.name === "string") {
      name = error.name;
    } else if (typeof record?.name === "string") {
      name = record.name;
    } else if (record && typeof record.constructor === "function" && typeof record.constructor.name === "string") {
      name = record.constructor.name;
    }

    const codeValue = record?.code;
    let code: string | undefined;
    if (typeof codeValue === "string") {
      code = codeValue;
    } else if (typeof codeValue === "number") {
      code = String(codeValue);
    }

    const statusRaw = record?.status ?? record?.statusCode;
    const statusCode = typeof statusRaw === "number" ? statusRaw : undefined;

    return { name, code, statusCode };
  }

  private calculateDelay(attempt: number, options: AdvancedRetryOptions): number {
    let delay: number;

    switch (options.strategy) {
    case "exponential":
      delay = options.baseDelay * Math.pow(options.backoffFactor, attempt - 1);
      break;

    case "linear":
      delay = options.baseDelay * attempt;
      break;

    case "fixed":
      delay = options.baseDelay;
      break;

    case "fibonacci":
      delay = this.fibonacci(attempt) * options.baseDelay;
      break;

    case "custom":
      if (options.customBackoff) {
        delay = options.customBackoff(attempt, options.baseDelay);
      } else {
        delay = options.baseDelay;
      }
      break;

    default:
      delay = options.baseDelay * Math.pow(options.backoffFactor, attempt - 1);
    }

    // Apply max delay cap
    delay = Math.min(delay, options.maxDelay);

    // Apply jitter if enabled
    if (options.jitter) {
      const jitterFactor = 0.1; // 10% jitter
      const jitterAmount = delay * jitterFactor;
      delay = delay + (Math.random() * 2 - 1) * jitterAmount;
    }

    return Math.max(0, Math.round(delay));
  }

  private fibonacci(n: number): number {
    if (n <= 1) return 1;
    let a = 1, b = 1;
    for (let i = 2; i < n; i++) {
      [a, b] = [b, a + b];
    }
    return b;
  }

  private updateMetrics(operationName: string, attempts: RetryAttempt[], _success: boolean): void {
    const metrics = this.operationMetrics.get(operationName);
    if (!metrics) {
      return;
    }
    const retryCount = attempts.length - 1;

    if (retryCount > 0) {
      metrics.totalRetries += retryCount;
    }

    // Update average retry count
    const totalOperations = metrics.successfulOperations + metrics.failedOperations;
    metrics.averageRetryCount = metrics.totalRetries / Math.max(totalOperations, 1);

    // Update average delay
    const totalDelay = attempts.reduce((sum, attempt) => sum + attempt.delay, 0);
    if (totalDelay > 0) {
      const delayOperations = attempts.filter(a => a.delay > 0).length;
      metrics.averageDelay = totalDelay / Math.max(delayOperations, 1);
    }

    // Update success rate
    metrics.successRate = metrics.successfulOperations / Math.max(totalOperations, 1);
    metrics.lastAttemptTime = new Date();
  }

  private adjustOptionsForAdaptiveRetry(operationName: string, options: AdvancedRetryOptions): void {
    if (!this.adaptiveMetrics.has(operationName)) {
      this.adaptiveMetrics.set(operationName, {
        successRates: [],
        optimalDelay: options.baseDelay,
      });
    }

    const adaptive = this.adaptiveMetrics.get(operationName);
    if (!adaptive) {
      return;
    }

    // Adjust delay based on recent success rates
    if (adaptive.successRates.length > 5) {
      const recentSuccessRate = adaptive.successRates.slice(-5).reduce((a, b) => a + b) / 5;

      if (recentSuccessRate < 0.5) {
        // Low success rate, increase delay
        adaptive.optimalDelay = Math.min(adaptive.optimalDelay * 1.2, options.maxDelay);
      } else if (recentSuccessRate > 0.8) {
        // High success rate, decrease delay
        adaptive.optimalDelay = Math.max(adaptive.optimalDelay * 0.9, options.baseDelay);
      }

      options.baseDelay = adaptive.optimalDelay;
    }
  }

  private updateAdaptiveMetrics(operationName: string, success: boolean, _duration: number): void {
    const adaptive = this.adaptiveMetrics.get(operationName);
    if (!adaptive) {
      return;
    }
    adaptive.successRates.push(success ? 1 : 0);

    // Keep only last 20 results
    if (adaptive.successRates.length > 20) {
      adaptive.successRates = adaptive.successRates.slice(-20);
    }
  }

  public getMetrics(operationName?: string): RetryMetrics | Map<string, RetryMetrics> {
    if (operationName) {
      return this.operationMetrics.get(operationName) || {
        totalAttempts: 0,
        successfulOperations: 0,
        failedOperations: 0,
        totalRetries: 0,
        averageRetryCount: 0,
        averageDelay: 0,
        successRate: 0,
        operationHistory: [],
      };
    }
    return new Map(this.operationMetrics);
  }

  public getBulkheadMetrics(name?: string): BulkheadMetrics | Map<string, BulkheadMetrics> {
    if (name) {
      const bulkhead = this.bulkheads.get(name);
      if (!bulkhead) {
        throw new Error(`Bulkhead '${name}' not found`);
      }
      return bulkhead.getMetrics();
    }

    const allMetrics = new Map<string, BulkheadMetrics>();
    for (const [name, bulkhead] of this.bulkheads) {
      allMetrics.set(name, bulkhead.getMetrics());
    }
    return allMetrics;
  }

  public reset(): void {
    this.operationMetrics.clear();
    this.adaptiveMetrics.clear();
    logger.info("Retry manager metrics reset");
  }

  public resetOperation(operationName: string): void {
    this.operationMetrics.delete(operationName);
    this.adaptiveMetrics.delete(operationName);
    logger.info("Operation metrics reset", { operationName });
  }
}

// Convenience functions and decorators
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: Partial<AdvancedRetryOptions> = {},
): Promise<T> {
  const manager = AdvancedRetryManager.getInstance();

  const defaultOptions: AdvancedRetryOptions = {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    jitter: true,
    strategy: "exponential",
    ...options,
  };

  return manager.withRetry(operation, defaultOptions);
}

export function retryable(options: Partial<AdvancedRetryOptions> = {}) {
  return function (target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const operationName = `${target.constructor.name}.${propertyName}`;
      const retryOptions: AdvancedRetryOptions = {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 30000,
        backoffFactor: 2,
        jitter: true,
        strategy: "exponential",
        name: operationName,
        ...options,
      };

      return withRetry(() => method.apply(this, args), retryOptions);
    };

    return descriptor;
  };
}

export function getRetryManager(): AdvancedRetryManager {
  return AdvancedRetryManager.getInstance();
}

// Predefined retry configurations
export const RetryConfigurations = {
  http: {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2,
    jitter: true,
    strategy: "exponential" as BackoffStrategy,
    retryPolicy: "http",
    enableCircuitBreaker: true,
  },

  database: {
    maxAttempts: 5,
    baseDelay: 500,
    maxDelay: 5000,
    backoffFactor: 1.5,
    jitter: true,
    strategy: "exponential" as BackoffStrategy,
    retryPolicy: "database",
    enableCircuitBreaker: true,
  },

  external_service: {
    maxAttempts: 4,
    baseDelay: 2000,
    maxDelay: 30000,
    backoffFactor: 2,
    jitter: true,
    strategy: "exponential" as BackoffStrategy,
    retryPolicy: "service",
    enableCircuitBreaker: true,
    enableBulkhead: true,
    maxConcurrentOperations: 20,
  },

  critical_operation: {
    maxAttempts: 10,
    baseDelay: 100,
    maxDelay: 60000,
    backoffFactor: 1.8,
    jitter: true,
    strategy: "fibonacci" as BackoffStrategy,
    adaptiveRetry: true,
    enableCircuitBreaker: true,
    timeout: 30000,
  },
};
