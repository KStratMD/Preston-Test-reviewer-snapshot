import type { SupplierCentralRuntime } from './SupplierCentralRuntime';
import type { GovernanceConfig, GovernanceMetrics } from '../../types/supplierCentral';

const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  maxRequestsPerMinute: 60,
  maxConcurrent: 5,
  batchSize: 50,
  retryDelayMs: 1000,
  maxRetries: 3,
  cooldownMs: 2000,
};

/**
 * Governance pacing throttle for NetSuite API calls.
 * Owns rate-limit window state, concurrent-request counter, and config.
 */
export class GovernanceThrottle {
  private config: GovernanceConfig = { ...DEFAULT_GOVERNANCE_CONFIG };
  private requestTimestamps: number[] = [];
  private activeRequests = 0;

  constructor(private runtime: SupplierCentralRuntime) {}

  /**
   * Rate limiting check for governance pacing
   */
  async acquire(): Promise<void> {
    // Re-evaluate the rate-limit window after each wait so concurrent waiters
    // can't all wake up and push past maxRequestsPerMinute together.
    while (true) {
      const now = this.runtime.now();
      const oneMinuteAgo = now - 60000;
      this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);

      if (this.requestTimestamps.length < this.config.maxRequestsPerMinute) {
        break;
      }

      const oldestRequest = this.requestTimestamps[0];
      const waitTime = 60000 - (now - oldestRequest);
      this.runtime.logger.warn('Governance rate limit reached, waiting', { waitTime });
      await this.runtime.wait(waitTime);
    }

    // Check concurrent limit
    while (this.activeRequests >= this.config.maxConcurrent) {
      await this.runtime.wait(100);
    }

    this.requestTimestamps.push(this.runtime.now());
    this.activeRequests++;
  }

  /**
   * Release governance slot
   */
  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  /**
   * Update governance configuration
   */
  updateConfig(updates: Partial<GovernanceConfig>): void {
    this.config = { ...this.config, ...updates };
    this.runtime.logger.info('Governance config updated', { config: this.config });
  }

  /**
   * Get governance metrics
   */
  getMetrics(): GovernanceMetrics {
    const now = this.runtime.now();
    const oneMinuteAgo = now - 60000;
    const requestsInLastMinute = this.requestTimestamps.filter(ts => ts > oneMinuteAgo).length;

    let healthStatus: 'healthy' | 'throttled' | 'at_limit';
    if (requestsInLastMinute >= this.config.maxRequestsPerMinute * 0.9) {
      healthStatus = 'at_limit';
    } else if (requestsInLastMinute >= this.config.maxRequestsPerMinute * 0.7) {
      healthStatus = 'throttled';
    } else {
      healthStatus = 'healthy';
    }

    return {
      requestsInLastMinute,
      activeRequests: this.activeRequests,
      config: this.config,
      healthStatus,
    };
  }

  /**
   * Read current config (used by NetSuiteSyncService dashboards and batch pacing).
   */
  getConfig(): GovernanceConfig {
    return this.config;
  }

  /**
   * Count of requests recorded in the last 60s. Used by getNetSuiteSyncStatus.
   */
  getRequestsInLastMinute(): number {
    const now = this.runtime.now();
    const oneMinuteAgo = now - 60000;
    return this.requestTimestamps.filter(ts => ts > oneMinuteAgo).length;
  }

  /**
   * Current in-flight request count. Used by getNetSuiteSyncStatus.
   */
  getActiveRequests(): number {
    return this.activeRequests;
  }
}
