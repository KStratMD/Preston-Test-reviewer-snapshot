import { Logger } from '../utils/Logger';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  monitoringPeriod?: number;
  minimumRequests?: number;
  logger?: Logger;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private requestCount = 0;
  private lastFailureTime?: number;
  private nextAttemptTime?: number;
  
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly monitoringPeriod: number;
  private readonly minimumRequests: number;
  private readonly logger?: Logger;
  
  constructor(private readonly name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 60000; // 1 minute
    this.monitoringPeriod = options.monitoringPeriod ?? 10000; // 10 seconds
    this.minimumRequests = options.minimumRequests ?? 3;
    this.logger = options.logger;
  }
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < (this.nextAttemptTime || 0)) {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
      // Move to half-open state
      this.state = CircuitState.HALF_OPEN;
      this.logger?.info(`Circuit breaker ${this.name} moving to HALF_OPEN state`);
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.successCount++;
    this.requestCount++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Successfully completed in half-open state, close the circuit
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
      this.successCount = 0;
      this.requestCount = 0;
      this.logger?.info(`Circuit breaker ${this.name} is now CLOSED`);
    }
  }
  
  private onFailure(): void {
    this.failureCount++;
    this.requestCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Failed in half-open state, open the circuit again
      this.openCircuit();
    } else if (this.state === CircuitState.CLOSED && 
               this.requestCount >= this.minimumRequests &&
               this.failureCount >= this.failureThreshold) {
      // Threshold exceeded, open the circuit
      this.openCircuit();
    }
  }
  
  private openCircuit(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.resetTimeout;
    this.logger?.warn(`Circuit breaker ${this.name} is now OPEN. Next attempt at ${new Date(this.nextAttemptTime).toISOString()}`);
  }
  
  getState(): CircuitState {
    return this.state;
  }
  
  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      requestCount: this.requestCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime
    };
  }
  
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
    this.lastFailureTime = undefined;
    this.nextAttemptTime = undefined;
    this.logger?.info(`Circuit breaker ${this.name} has been reset`);
  }
}