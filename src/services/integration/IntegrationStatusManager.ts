import { injectable, inject } from 'inversify';
import type { SyncResult } from '../../types';
import type { Logger } from '../../utils/Logger';
import { TYPES } from '../../inversify/types';

/**
 * Integration status information
 */
export interface IntegrationStatus {
  configId: string;
  isRunning: boolean;
  lastSync?: Date;
  lastSyncResult?: SyncResult;
  nextScheduledSync?: Date;
  errorCount: number;
  successCount: number;
  totalRuns: number;
  averageRunTime?: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Integration metrics and statistics
 */
export interface IntegrationMetrics {
  totalIntegrations: number;
  runningIntegrations: number;
  successfulRuns: number;
  failedRuns: number;
  averageRunTime: number;
  totalRecordsProcessed: number;
  errorRate: number;
  uptime: number;
}

/**
 * Service responsible for tracking and managing integration status and metrics
 */
@injectable()
export class IntegrationStatusManager {
  private readonly integrationStatus = new Map<string, IntegrationStatus>();
  private readonly runningIntegrations = new Set<string>();
  private readonly runTimes = new Map<string, number[]>(); // Track run times for averages
  private readonly logger: Logger;
  private readonly startTime = Date.now();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize status for a new integration configuration
   */
  initializeStatus(configId: string): void {
    if (!this.integrationStatus.has(configId)) {
      const status: IntegrationStatus = {
        configId,
        isRunning: false,
        errorCount: 0,
        successCount: 0,
        totalRuns: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      
      this.integrationStatus.set(configId, status);
      this.runTimes.set(configId, []);
      this.logger.debug(`Initialized status for integration ${configId}`);
    }
  }

  /**
   * Update integration status
   */
  updateStatus(configId: string, updates: Partial<IntegrationStatus>): void {
    const currentStatus = this.integrationStatus.get(configId);
    if (!currentStatus) {
      this.logger.warn(`Attempted to update status for unknown integration ${configId}`);
      return;
    }

    const updatedStatus: IntegrationStatus = {
      ...currentStatus,
      ...updates,
      updatedAt: new Date(),
    };

    this.integrationStatus.set(configId, updatedStatus);
    this.logger.debug(`Updated status for integration ${configId}`, updates);
  }

  /**
   * Mark integration as running
   */
  markAsRunning(configId: string): void {
    this.runningIntegrations.add(configId);
    this.updateStatus(configId, { isRunning: true });
  }

  /**
   * Mark integration as completed
   */
  markAsCompleted(configId: string, result: SyncResult, runTime: number): void {
    this.runningIntegrations.delete(configId);
    
    const currentStatus = this.integrationStatus.get(configId);
    if (!currentStatus) {
      this.logger.warn(`Attempted to mark unknown integration ${configId} as completed`);
      return;
    }

    // Update run times for average calculation
    const runTimes = this.runTimes.get(configId) || [];
    runTimes.push(runTime);
    
    // Keep only last 100 run times to prevent memory growth
    if (runTimes.length > 100) {
      runTimes.shift();
    }
    this.runTimes.set(configId, runTimes);

    const averageRunTime = runTimes.reduce((sum, time) => sum + time, 0) / runTimes.length;
    const isSuccess = result.status === 'success';

    this.updateStatus(configId, {
      isRunning: false,
      lastSync: new Date(),
      lastSyncResult: result,
      successCount: currentStatus.successCount + (isSuccess ? 1 : 0),
      errorCount: currentStatus.errorCount + (isSuccess ? 0 : 1),
      totalRuns: currentStatus.totalRuns + 1,
      averageRunTime,
      lastError: isSuccess ? undefined : result.errors?.[0],
    });
  }

  /**
   * Mark integration as failed
   */
  markAsFailed(configId: string, error: string, runTime: number): void {
    this.runningIntegrations.delete(configId);
    
    const currentStatus = this.integrationStatus.get(configId);
    if (!currentStatus) {
      this.logger.warn(`Attempted to mark unknown integration ${configId} as failed`);
      return;
    }

    // Update run times
    const runTimes = this.runTimes.get(configId) || [];
    runTimes.push(runTime);
    if (runTimes.length > 100) {
      runTimes.shift();
    }
    this.runTimes.set(configId, runTimes);

    const averageRunTime = runTimes.reduce((sum, time) => sum + time, 0) / runTimes.length;

    this.updateStatus(configId, {
      isRunning: false,
      errorCount: currentStatus.errorCount + 1,
      totalRuns: currentStatus.totalRuns + 1,
      averageRunTime,
      lastError: error,
    });
  }

  /**
   * Get status for a specific integration
   */
  getStatus(configId: string): IntegrationStatus | undefined {
    return this.integrationStatus.get(configId);
  }

  /**
   * Get all integration statuses
   */
  getAllStatuses(): IntegrationStatus[] {
    return Array.from(this.integrationStatus.values());
  }

  /**
   * Get running integrations
   */
  getRunningIntegrations(): Set<string> {
    return new Set(this.runningIntegrations);
  }

  /**
   * Check if integration is running
   */
  isRunning(configId: string): boolean {
    return this.runningIntegrations.has(configId);
  }

  /**
   * Get integration count by status
   */
  getIntegrationCounts(): {
    total: number;
    running: number;
    idle: number;
    withErrors: number;
  } {
    const statuses = this.getAllStatuses();
    
    return {
      total: statuses.length,
      running: this.runningIntegrations.size,
      idle: statuses.length - this.runningIntegrations.size,
      withErrors: statuses.filter(s => s.errorCount > 0).length,
    };
  }

  /**
   * Get comprehensive integration metrics
   */
  getMetrics(): IntegrationMetrics {
    const statuses = this.getAllStatuses();
    const totalRuns = statuses.reduce((sum, s) => sum + s.totalRuns, 0);
    const successfulRuns = statuses.reduce((sum, s) => sum + s.successCount, 0);
    const failedRuns = statuses.reduce((sum, s) => sum + s.errorCount, 0);
    
    const allRunTimes = Array.from(this.runTimes.values()).flat();
    const averageRunTime = allRunTimes.length > 0 
      ? allRunTimes.reduce((sum, time) => sum + time, 0) / allRunTimes.length 
      : 0;

    const totalRecordsProcessed = statuses.reduce((sum, s) => {
      return sum + (s.lastSyncResult?.recordsProcessed || 0);
    }, 0);

    const errorRate = totalRuns > 0 ? (failedRuns / totalRuns) * 100 : 0;
    const uptime = Date.now() - this.startTime;

    return {
      totalIntegrations: statuses.length,
      runningIntegrations: this.runningIntegrations.size,
      successfulRuns,
      failedRuns,
      averageRunTime,
      totalRecordsProcessed,
      errorRate,
      uptime,
    };
  }

  /**
   * Remove status for a configuration
   */
  removeStatus(configId: string): boolean {
    const removed = this.integrationStatus.delete(configId);
    this.runTimes.delete(configId);
    this.runningIntegrations.delete(configId);
    
    if (removed) {
      this.logger.debug(`Removed status for integration ${configId}`);
    }
    
    return removed;
  }

  /**
   * Clear all statuses (useful for testing)
   */
  clearAll(): void {
    this.integrationStatus.clear();
    this.runTimes.clear();
    this.runningIntegrations.clear();
    this.logger.debug('Cleared all integration statuses');
  }

  /**
   * Get integrations that haven't run recently (potential issues)
   */
  getStaleIntegrations(thresholdHours = 24): IntegrationStatus[] {
    const threshold = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
    
    return this.getAllStatuses().filter(status => {
      if (!status.lastSync) return true; // Never run
      return status.lastSync < threshold && !status.isRunning;
    });
  }

  /**
   * Get integrations with high error rates
   */
  getProblematicIntegrations(errorRateThreshold = 0.5): IntegrationStatus[] {
    return this.getAllStatuses().filter(status => {
      if (status.totalRuns === 0) return false;
      const errorRate = status.errorCount / status.totalRuns;
      return errorRate >= errorRateThreshold;
    });
  }
}

export default IntegrationStatusManager;