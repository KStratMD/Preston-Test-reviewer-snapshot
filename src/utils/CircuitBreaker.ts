import { EventEmitter } from "events";

export enum CircuitBreakerState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN"
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
  expectedErrors?: (error: unknown) => boolean;
  // Enhanced options
  slowCallDurationThreshold?: number;
  slowCallRateThreshold?: number;
  minimumNumberOfCalls?: number;
  slidingWindowSize?: number;
  permittedNumberOfCallsInHalfOpenState?: number;
  maxWaitDurationInHalfOpenState?: number;
  automaticTransitionFromOpenToHalfOpenEnabled?: boolean;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  totalCalls: number;
  failureRate: number;
  slowCallRate: number;
  lastFailureTime?: Date;
  stateChangedAt: Date;
  callsInWindow: number[];
  slowCallsInWindow: number[];
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: Date;

  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(20);

    this.options = {
      failureThreshold: options.failureThreshold,
      resetTimeout: options.resetTimeout,
      monitoringPeriod: options.monitoringPeriod,
      expectedErrors: options.expectedErrors || (() => true),
      slowCallDurationThreshold: options.slowCallDurationThreshold || 60000, // 60 seconds
      slowCallRateThreshold: options.slowCallRateThreshold || 0.5, // 50%
      minimumNumberOfCalls: options.minimumNumberOfCalls || 10,
      slidingWindowSize: options.slidingWindowSize || 100,
      permittedNumberOfCallsInHalfOpenState: options.permittedNumberOfCallsInHalfOpenState || 10,
      maxWaitDurationInHalfOpenState: options.maxWaitDurationInHalfOpenState || 60000,
      automaticTransitionFromOpenToHalfOpenEnabled: options.automaticTransitionFromOpenToHalfOpenEnabled ?? true,
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error("Circuit breaker is OPEN - calls are failing too frequently");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      // After a few successful calls in HALF_OPEN, close the circuit
      if (this.successCount >= 3) {
        this.state = CircuitBreakerState.CLOSED;
      }
    }
  }

  private onFailure(error: unknown): void {
    // Only count expected errors toward circuit breaker failures
    if (this.options.expectedErrors && !this.options.expectedErrors(error)) {
      return;
    }

    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) {
      return false;
    }

    const timeSinceLastFailure = Date.now() - this.lastFailureTime.getTime();
    return timeSinceLastFailure >= this.options.resetTimeout;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }
}
