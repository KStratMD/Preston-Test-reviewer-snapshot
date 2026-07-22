import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryStore } from './TelemetryStore';
import type { TelemetryAggregator, ExecutiveSummary, ROIMetrics, BusinessMetrics, TrendData, PerformanceBreakdown } from './TelemetryAggregator';
import type { AllTelemetryEvents } from '../domain/telemetry/events';

export interface TelemetryDashboardData {
  executiveSummary: ExecutiveSummary;
  performanceBreakdown: PerformanceBreakdown[];
  trendData: {
    throughput: TrendData[];
    successRate: TrendData[];
    processingTime: TrendData[];
    errorCount: TrendData[];
  };
  realTimeMetrics: {
    activeIntegrations: number;
    recordsProcessedToday: number;
    systemHealth: number;
    costSavingsToday: number;
  };
}

export interface SquireSpecificMetrics {
  suiteCentralIntegrations: {
    total: number;
    active: number;
    successRate: number;
    averageSetupTime: number;
  };
  aiMappingPerformance: {
    suggestionsGenerated: number;
    acceptanceRate: number;
    timeReduction: number;
    accuracyImprovement: number;
  };
  paymentProcessing: {
    transactionsProcessed: number;
    reconciliationRate: number;
    processingSpeed: number;
    errorRate: number;
  };
  migrationAccelerator: {
    migrationsCompleted: number;
    averageMigrationTime: number;
    dataIntegrity: number;
    rollbackRate: number;
  };
}

type LightweightMetric = {
  value: number | string;
  metadata?: unknown;
  timestamp: Date;
};

/**
 * TelemetryService provides a unified interface for telemetry operations,
 * combining storage, aggregation, and specialized analytics for Squire.
 */
@injectable()
export class TelemetryService {
  private retentionPeriodMs = 90 * 24 * 60 * 60 * 1000; // 90 days
  private cleanupIntervalMs = 24 * 60 * 60 * 1000; // 24 hours
  private cleanupTimer?: NodeJS.Timeout;
  private lightweightMetrics = new Map<string, LightweightMetric[]>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryStore) private telemetryStore: TelemetryStore,
    @inject(TYPES.TelemetryAggregator) private telemetryAggregator: TelemetryAggregator,
  ) {
    this.logger.info('TelemetryService initialized');
    this.startCleanupScheduler();
  }

  /**
   * Record a telemetry event
   */
  async recordEvent(event: AllTelemetryEvents): Promise<void> {
    try {
      await this.telemetryStore.storeEvent(event);
      this.logger.debug('Telemetry event recorded', {
        eventId: event.id,
        eventType: event.type,
        flowId: event.flowId,
      });
    } catch (error) {
      this.logger.error('Failed to record telemetry event', { error, eventId: event.id });
      throw error;
    }
  }

  /**
   * Record lightweight service metrics for AI/Week 7 services that rely on the
   * legacy in-memory telemetry API.
   */
  private static readonly MAX_METRICS_PER_NAME = 1000;

  recordMetric(name: string, value: number | string, metadata?: unknown): void {
    if (!this.lightweightMetrics.has(name)) {
      this.lightweightMetrics.set(name, []);
    }

    const entries = this.lightweightMetrics.get(name)!;
    entries.push({
      value,
      metadata,
      timestamp: new Date(),
    });

    // Evict oldest entries when cap is exceeded
    if (entries.length > TelemetryService.MAX_METRICS_PER_NAME) {
      entries.splice(0, entries.length - TelemetryService.MAX_METRICS_PER_NAME);
    }

    this.logger.debug('Lightweight metric recorded', {
      metricName: name,
      value,
      metadata,
    });
  }

  /**
   * Retrieve lightweight metrics recorded through recordMetric().
   */
  getMetrics(name: string): LightweightMetric[] {
    return [...(this.lightweightMetrics.get(name) || [])];
  }

  /**
   * Retrieve all lightweight metrics recorded through recordMetric().
   */
  getAllMetrics(): Record<string, LightweightMetric[]> {
    const result: Record<string, LightweightMetric[]> = {};

    this.lightweightMetrics.forEach((value, key) => {
      result[key] = [...value];
    });

    return result;
  }

  /**
   * Clear lightweight metrics recorded through recordMetric().
   */
  clearMetrics(): void {
    this.lightweightMetrics.clear();
  }

  /**
   * Get comprehensive dashboard data for executives
   */
  async getDashboardData(timeRangeMs?: number): Promise<TelemetryDashboardData> {
    try {
      const timeRange = timeRangeMs || 30 * 24 * 60 * 60 * 1000; // 30 days default

      const [executiveSummary, performanceBreakdown, throughputTrend, successRateTrend, processingTimeTrend, errorCountTrend] = await Promise.all([
        this.telemetryAggregator.generateExecutiveSummary(this.telemetryStore, timeRange),
        this.telemetryAggregator.generatePerformanceBreakdown(this.telemetryStore, timeRange),
        this.telemetryAggregator.generateTrendData(this.telemetryStore, 'throughput', timeRange),
        this.telemetryAggregator.generateTrendData(this.telemetryStore, 'success_rate', timeRange),
        this.telemetryAggregator.generateTrendData(this.telemetryStore, 'processing_time', timeRange),
        this.telemetryAggregator.generateTrendData(this.telemetryStore, 'error_count', timeRange),
      ]);

      // Calculate real-time metrics
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayMetrics = await this.telemetryStore.getMetrics({
        startTime: todayStart.getTime(),
        endTime: Date.now(),
      });

      const realTimeMetrics = {
        activeIntegrations: executiveSummary.activeIntegrations,
        recordsProcessedToday: todayMetrics.totalRecordsProcessed,
        systemHealth: Math.round(executiveSummary.businessMetrics.systemUptime),
        costSavingsToday: Math.round(executiveSummary.roi.costSavings / 30), // Daily average
      };

      const dashboardData: TelemetryDashboardData = {
        executiveSummary,
        performanceBreakdown,
        trendData: {
          throughput: throughputTrend,
          successRate: successRateTrend,
          processingTime: processingTimeTrend,
          errorCount: errorCountTrend,
        },
        realTimeMetrics,
      };

      this.logger.info('Dashboard data generated', {
        executiveSummaryPeriod: executiveSummary.period.label,
        totalIntegrations: executiveSummary.totalIntegrations,
        roiPercentage: Math.round(executiveSummary.roi.roiPercentage),
      });

      return dashboardData;
    } catch (error) {
      this.logger.error('Failed to get dashboard data', { error, timeRangeMs });
      throw error;
    }
  }

  /**
   * Get Squire-specific metrics and insights
   */
  async getSquireMetrics(timeRangeMs?: number): Promise<SquireSpecificMetrics> {
    try {
      const timeRange = timeRangeMs || 30 * 24 * 60 * 60 * 1000;
      const endTime = Date.now();
      const startTime = endTime - timeRange;

      // Get SuiteCentral integration metrics
      const suiteCentralEvents = await this.telemetryStore.queryEvents({
        startTime,
        endTime,
        eventTypes: ['IntegrationFlowStarted', 'IntegrationFlowCompleted', 'IntegrationFlowFailed'],
      });

      const suiteCentralFlows = suiteCentralEvents.filter(e => 
        ('sourceSystem' in e && e.sourceSystem === 'SuiteCentral') ||
        ('targetSystem' in e && e.targetSystem === 'SuiteCentral')
      );

      const uniqueSuiteCentralFlows = new Set(suiteCentralFlows.map(e => e.flowId)).size;
      const activeSuiteCentralFlows = new Set(
        suiteCentralFlows
          .filter(e => e.type === 'IntegrationFlowStarted')
          .map(e => e.flowId)
      ).size;

      const completedFlows = suiteCentralFlows.filter(e => e.type === 'IntegrationFlowCompleted').length;
      const totalFlows = suiteCentralFlows.filter(e => e.type === 'IntegrationFlowStarted').length;
      const suiteCentralSuccessRate = totalFlows > 0 ? (completedFlows / totalFlows) * 100 : 100;

      const setupTimes = suiteCentralFlows
        .filter(e => e.type === 'IntegrationFlowCompleted' && 'durationMs' in e)
        .map(e => ('durationMs' in e ? e.durationMs : 0) as number);
      
      const averageSetupTime = setupTimes.length > 0 ? 
        setupTimes.reduce((sum, time) => sum + time, 0) / setupTimes.length : 0;

      // Get AI mapping metrics
      const mappingEvents = await this.telemetryStore.queryEvents({
        startTime,
        endTime,
        eventTypes: ['MappingSuggested', 'MappingAccepted', 'MappingRejected'],
      });

      const suggestionsGenerated = mappingEvents.filter(e => e.type === 'MappingSuggested').length;
      const suggestionsAccepted = mappingEvents.filter(e => e.type === 'MappingAccepted').length;
      const acceptanceRate = suggestionsGenerated > 0 ? 
        (suggestionsAccepted / suggestionsGenerated) * 100 : 0;

      // Estimate time reduction (80% reduction is typical with AI mapping)
      const timeReduction = acceptanceRate > 0 ? 80 : 0;
      const accuracyImprovement = acceptanceRate > 70 ? 95 : acceptanceRate;

      // Get payment processing metrics (placeholder for future payment connectors)
      const paymentEvents = await this.telemetryStore.queryEvents({
        startTime,
        endTime,
        eventTypes: ['PaymentReconciliation'],
      });

      const transactionsProcessed = paymentEvents.length;
      const matchedTransactions = paymentEvents.filter(e => 
        'status' in e && e.status === 'matched'
      ).length;
      const reconciliationRate = transactionsProcessed > 0 ? 
        (matchedTransactions / transactionsProcessed) * 100 : 0;

      // Get migration metrics
      const migrationEvents = await this.telemetryStore.queryEvents({
        startTime,
        endTime,
        eventTypes: ['MigrationJobStarted', 'MigrationJobCompleted', 'MigrationJobFailed'],
      });

      const migrationsStarted = migrationEvents.filter(e => e.type === 'MigrationJobStarted').length;
      const migrationsCompleted = migrationEvents.filter(e => e.type === 'MigrationJobCompleted').length;
      const migrationsFailed = migrationEvents.filter(e => e.type === 'MigrationJobFailed').length;

      const migrationTimes = migrationEvents
        .filter(e => e.type === 'MigrationJobCompleted' && 'durationMs' in e)
        .map(e => ('durationMs' in e ? e.durationMs : 0) as number);

      const averageMigrationTime = migrationTimes.length > 0 ? 
        migrationTimes.reduce((sum, time) => sum + time, 0) / migrationTimes.length : 0;

      const rollbackRate = migrationsStarted > 0 ? 
        (migrationsFailed / migrationsStarted) * 100 : 0;

      const dataIntegrity = Math.max(0, 100 - rollbackRate);

      const squireMetrics: SquireSpecificMetrics = {
        suiteCentralIntegrations: {
          total: uniqueSuiteCentralFlows,
          active: activeSuiteCentralFlows,
          successRate: suiteCentralSuccessRate,
          averageSetupTime: averageSetupTime / (60 * 1000), // Convert to minutes
        },
        aiMappingPerformance: {
          suggestionsGenerated,
          acceptanceRate,
          timeReduction,
          accuracyImprovement,
        },
        paymentProcessing: {
          transactionsProcessed,
          reconciliationRate,
          processingSpeed: transactionsProcessed > 0 ? transactionsProcessed / (timeRange / (60 * 60 * 1000)) : 0,
          errorRate: transactionsProcessed > 0 ? 
            ((transactionsProcessed - matchedTransactions) / transactionsProcessed) * 100 : 0,
        },
        migrationAccelerator: {
          migrationsCompleted,
          averageMigrationTime: averageMigrationTime / (60 * 60 * 1000), // Convert to hours
          dataIntegrity,
          rollbackRate,
        },
      };

      this.logger.info('Squire-specific metrics calculated', {
        suiteCentralIntegrations: uniqueSuiteCentralFlows,
        aiAcceptanceRate: Math.round(acceptanceRate),
        migrationsCompleted,
      });

      return squireMetrics;
    } catch (error) {
      this.logger.error('Failed to get Squire metrics', { error });
      throw error;
    }
  }

  /**
   * Get ROI metrics
   */
  async getROIMetrics(timeRangeMs?: number): Promise<ROIMetrics> {
    const timeRange = timeRangeMs || 30 * 24 * 60 * 60 * 1000;
    return this.telemetryAggregator.calculateROI(this.telemetryStore, timeRange);
  }

  /**
   * Get business metrics
   */
  async getBusinessMetrics(timeRangeMs?: number): Promise<BusinessMetrics> {
    const timeRange = timeRangeMs || 30 * 24 * 60 * 60 * 1000;
    return this.telemetryAggregator.calculateBusinessMetrics(this.telemetryStore, timeRange);
  }

  /**
   * Get executive summary
   */
  async getExecutiveSummary(timeRangeMs?: number): Promise<ExecutiveSummary> {
    const timeRange = timeRangeMs || 30 * 24 * 60 * 60 * 1000;
    return this.telemetryAggregator.generateExecutiveSummary(this.telemetryStore, timeRange);
  }

  /**
   * Get storage statistics for monitoring
   */
  getStorageStats() {
    return this.telemetryStore.getStorageStats();
  }

  /**
   * Manually trigger cleanup of old events
   */
  async cleanupOldEvents(): Promise<number> {
    const cutoffTime = Date.now() - this.retentionPeriodMs;
    return this.telemetryStore.clearOldEvents(cutoffTime);
  }

  /**
   * Start automatic cleanup scheduler
   */
  private startCleanupScheduler(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        const deletedCount = await this.cleanupOldEvents();
        if (deletedCount > 0) {
          this.logger.info('Automatic telemetry cleanup completed', { deletedCount });
        }
      } catch (error) {
        this.logger.error('Automatic telemetry cleanup failed', { error });
      }
    }, this.cleanupIntervalMs);

    this.logger.info('Telemetry cleanup scheduler started', {
      retentionPeriodDays: this.retentionPeriodMs / (24 * 60 * 60 * 1000),
      cleanupIntervalHours: this.cleanupIntervalMs / (60 * 60 * 1000),
    });
  }

  /**
   * Stop cleanup scheduler (for shutdown)
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      this.logger.info('Telemetry cleanup scheduler stopped');
    }

    this.clearMetrics();
  }
}
