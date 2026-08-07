import { injectable, inject } from 'inversify';
import { performance } from 'perf_hooks';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: Date;
  tags?: Record<string, string>;
}

export interface TimingMetric {
  operation: string;
  duration: number;
  timestamp: Date;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export interface ResourceUsage {
  cpuUsage: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  uptime: number;
  eventLoopDelay: number;
}

export interface PerformanceStats {
  averageResponseTime: number;
  requestsPerSecond: number;
  errorRate: number;
  throughputMbps: number;
  resourceUsage: ResourceUsage;
  topSlowOperations: {
    operation: string;
    averageDuration: number;
    count: number;
  }[];
}

/**
 * Performance monitoring service with metrics collection and analysis
 */
@injectable()
export class PerformanceMonitor {
  private readonly logger: Logger;

  private metrics: PerformanceMetric[] = [];
  private timings: TimingMetric[] = [];
  private activeTimers = new Map<string, number>();

  // Keep last 10000 metrics and timings for analysis
  private readonly maxMetricsHistory = 10000;
  private readonly maxTimingsHistory = 10000;

  // Performance thresholds
  private readonly thresholds = {
    slowOperationMs: 1000,
    highCpuPercent: 80,
    highMemoryMb: 1024,
    highErrorRate: 0.05, // 5%
  };

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize performance monitor
   */
  async initialize(): Promise<void> {
    try {
      // Start periodic resource usage collection
      setInterval(() => {
        this.collectResourceUsage();
      }, 10000); // Every 10 seconds

      // Start periodic cleanup of old metrics
      setInterval(() => {
        this.cleanupOldMetrics();
      }, 300000); // Every 5 minutes

      this.logger.info('Performance monitor initialized');
    } catch (error) {
      this.logger.error('Failed to initialize performance monitor', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Start timing an operation
   */
  startTiming(operation: string, metadata?: Record<string, unknown>): string {
    const timerId = `${operation}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.activeTimers.set(timerId, performance.now());

    this.logger.debug('Started timing operation', { operation, timerId });
    return timerId;
  }

  /**
   * End timing an operation
   */
  endTiming(
    timerId: string,
    operation: string,
    success = true,
    metadata?: Record<string, unknown>,
  ): number {
    const startTime = this.activeTimers.get(timerId);

    if (!startTime) {
      this.logger.warn('Timer not found', { timerId, operation });
      return 0;
    }

    const duration = performance.now() - startTime;
    this.activeTimers.delete(timerId);

    const timing: TimingMetric = {
      operation,
      duration,
      timestamp: new Date(),
      success,
      metadata,
    };

    this.recordTiming(timing);

    // Log slow operations
    if (duration > this.thresholds.slowOperationMs) {
      this.logger.warn('Slow operation detected', {
        operation,
        duration: Math.round(duration),
        success,
        metadata,
      });
    }

    return duration;
  }

  /**
   * Time a function execution
   */
  async timeFunction<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    const timerId = this.startTiming(operation, metadata);
    let success = true;

    try {
      const result = await fn();
      return result;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      this.endTiming(timerId, operation, success, metadata);
    }
  }

  /**
   * Record a custom metric
   */
  recordMetric(
    name: string,
    value: number,
    unit = 'count',
    tags?: Record<string, string>,
  ): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: new Date(),
      tags,
    };

    this.metrics.push(metric);

    // Keep metrics history within limits
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics = this.metrics.slice(-this.maxMetricsHistory);
    }

    this.logger.debug('Metric recorded', { name, value, unit, tags });
  }

  /**
   * Increment a counter metric
   */
  incrementCounter(name: string, by = 1, tags?: Record<string, string>): void {
    this.recordMetric(name, by, 'count', tags);
  }

  /**
   * Record a gauge metric (current value)
   */
  recordGauge(name: string, value: number, unit = 'value', tags?: Record<string, string>): void {
    this.recordMetric(name, value, unit, tags);
  }

  /**
   * Get performance statistics
   */
  getStatistics(periodMinutes = 60): PerformanceStats {
    const since = new Date(Date.now() - periodMinutes * 60 * 1000);

    const recentTimings = this.timings.filter(t => t.timestamp >= since);
    const recentMetrics = this.metrics.filter(m => m.timestamp >= since);

    // Calculate average response time
    const responseTimes = recentTimings
      .filter(t => t.operation.includes('request') || t.operation.includes('api'))
      .map(t => t.duration);

    const averageResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
      : 0;

    // Calculate requests per second
    const requestCount = recentTimings.filter(t =>
      t.operation.includes('request') || t.operation.includes('api'),
    ).length;
    const requestsPerSecond = requestCount / (periodMinutes * 60);

    // Calculate error rate
    const totalOperations = recentTimings.length;
    const failedOperations = recentTimings.filter(t => !t.success).length;
    const errorRate = totalOperations > 0 ? failedOperations / totalOperations : 0;

    // Calculate throughput (approximate)
    const throughputMetrics = recentMetrics.filter(m => m.name.includes('throughput'));
    const throughputMbps = throughputMetrics.length > 0
      ? throughputMetrics.reduce((sum, m) => sum + m.value, 0) / throughputMetrics.length
      : 0;

    // Get top slow operations
    const operationTimes = new Map<string, { total: number; count: number }>();

    recentTimings.forEach(timing => {
      const existing = operationTimes.get(timing.operation) || { total: 0, count: 0 };
      existing.total += timing.duration;
      existing.count += 1;
      operationTimes.set(timing.operation, existing);
    });

    const topSlowOperations = Array.from(operationTimes.entries())
      .map(([operation, stats]) => ({
        operation,
        averageDuration: stats.total / stats.count,
        count: stats.count,
      }))
      .sort((a, b) => b.averageDuration - a.averageDuration)
      .slice(0, 10);

    return {
      averageResponseTime,
      requestsPerSecond,
      errorRate,
      throughputMbps,
      resourceUsage: this.getCurrentResourceUsage(),
      topSlowOperations,
    };
  }

  /**
   * Get metrics by name
   */
  getMetrics(
    name: string,
    periodMinutes = 60,
    tags?: Record<string, string>,
  ): PerformanceMetric[] {
    const since = new Date(Date.now() - periodMinutes * 60 * 1000);

    return this.metrics.filter(metric => {
      if (metric.name !== name || metric.timestamp < since) {
        return false;
      }

      if (tags) {
        for (const [key, value] of Object.entries(tags)) {
          if (metric.tags?.[key] !== value) {
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Get operation timings
   */
  getTimings(operation: string, periodMinutes = 60): TimingMetric[] {
    const since = new Date(Date.now() - periodMinutes * 60 * 1000);

    return this.timings.filter(timing =>
      timing.operation === operation && timing.timestamp >= since,
    );
  }

  /**
   * Check if system is under stress
   */
  isSystemUnderStress(): {
    underStress: boolean;
    reasons: string[];
    severity: 'low' | 'medium' | 'high';
    } {
    const reasons: string[] = [];
    const stats = this.getStatistics(5); // Last 5 minutes

    // Check CPU usage
    if (stats.resourceUsage.cpuUsage > this.thresholds.highCpuPercent) {
      reasons.push(`High CPU usage: ${stats.resourceUsage.cpuUsage.toFixed(1)}%`);
    }

    // Check memory usage
    const memoryUsageMb = stats.resourceUsage.memoryUsage.heapUsed / (1024 * 1024);
    if (memoryUsageMb > this.thresholds.highMemoryMb) {
      reasons.push(`High memory usage: ${memoryUsageMb.toFixed(1)}MB`);
    }

    // Check error rate
    if (stats.errorRate > this.thresholds.highErrorRate) {
      reasons.push(`High error rate: ${(stats.errorRate * 100).toFixed(1)}%`);
    }

    // Check for slow operations
    const slowOperations = stats.topSlowOperations.filter(
      op => op.averageDuration > this.thresholds.slowOperationMs,
    );
    if (slowOperations.length > 0) {
      reasons.push(`${slowOperations.length} slow operations detected`);
    }

    // Determine severity
    let severity: 'low' | 'medium' | 'high' = 'low';
    if (reasons.length >= 3 || stats.errorRate > 0.1) {
      severity = 'high';
    } else if (reasons.length >= 2) {
      severity = 'medium';
    }

    return {
      underStress: reasons.length > 0,
      reasons,
      severity,
    };
  }

  /**
   * Generate performance report
   */
  generateReport(periodMinutes = 60): {
    summary: PerformanceStats;
    alerts: string[];
    recommendations: string[];
  } {
    const summary = this.getStatistics(periodMinutes);
    const stressCheck = this.isSystemUnderStress();

    const alerts: string[] = [];
    const recommendations: string[] = [];

    // Generate alerts
    if (stressCheck.underStress) {
      alerts.push(`System under ${stressCheck.severity} stress: ${stressCheck.reasons.join(', ')}`);
    }

    if (summary.averageResponseTime > 1000) {
      alerts.push(`High average response time: ${summary.averageResponseTime.toFixed(0)}ms`);
    }

    if (summary.errorRate > 0.05) {
      alerts.push(`High error rate: ${(summary.errorRate * 100).toFixed(1)}%`);
    }

    // Generate recommendations
    if (summary.resourceUsage.memoryUsage.heapUsed / summary.resourceUsage.memoryUsage.heapTotal > 0.8) {
      recommendations.push('Consider increasing memory allocation or optimizing memory usage');
    }

    if (summary.topSlowOperations.length > 0) {
      recommendations.push(`Optimize slow operations: ${
        summary.topSlowOperations.slice(0, 3).map(op => op.operation).join(', ')}`);
    }

    if (summary.requestsPerSecond > 100 && summary.averageResponseTime > 500) {
      recommendations.push('Consider implementing caching or scaling horizontally');
    }

    return {
      summary,
      alerts,
      recommendations,
    };
  }

  /**
   * Clear all metrics and timings
   */
  clearMetrics(): void {
    this.metrics = [];
    this.timings = [];
    this.activeTimers.clear();

    this.logger.info('Performance metrics cleared');
  }

  /**
   * Record timing metric
   */
  private recordTiming(timing: TimingMetric): void {
    this.timings.push(timing);

    // Keep timings history within limits
    if (this.timings.length > this.maxTimingsHistory) {
      this.timings = this.timings.slice(-this.maxTimingsHistory);
    }
  }

  /**
   * Collect current resource usage
   */
  private collectResourceUsage(): void {
    const resourceUsage = this.getCurrentResourceUsage();

    this.recordGauge('cpu_usage', resourceUsage.cpuUsage, 'percent');
    this.recordGauge('memory_heap_used', resourceUsage.memoryUsage.heapUsed, 'bytes');
    this.recordGauge('memory_heap_total', resourceUsage.memoryUsage.heapTotal, 'bytes');
    this.recordGauge('memory_external', resourceUsage.memoryUsage.external, 'bytes');
    this.recordGauge('memory_rss', resourceUsage.memoryUsage.rss, 'bytes');
    this.recordGauge('uptime', resourceUsage.uptime, 'seconds');
    this.recordGauge('event_loop_delay', resourceUsage.eventLoopDelay, 'milliseconds');
  }

  /**
   * Get current resource usage
   */
  private getCurrentResourceUsage(): ResourceUsage {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Approximate CPU usage percentage
    const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1000000) / process.uptime() * 100;

    return {
      cpuUsage: Math.min(100, Math.max(0, cpuPercent)),
      memoryUsage: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      uptime: process.uptime(),
      eventLoopDelay: this.measureEventLoopDelay(),
    };
  }

  /**
   * Measure event loop delay
   */
  private measureEventLoopDelay(): number {
    const start = performance.now();
    setImmediate(() => {
      const delay = performance.now() - start;
      this.recordGauge('event_loop_delay_immediate', delay, 'milliseconds');
    });
    return 0; // Placeholder - actual measurement happens asynchronously
  }

  /**
   * Clean up old metrics to prevent memory leaks
   */
  private cleanupOldMetrics(): void {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    const initialMetricsCount = this.metrics.length;
    const initialTimingsCount = this.timings.length;

    this.metrics = this.metrics.filter(metric => metric.timestamp > cutoffTime);
    this.timings = this.timings.filter(timing => timing.timestamp > cutoffTime);

    const removedMetrics = initialMetricsCount - this.metrics.length;
    const removedTimings = initialTimingsCount - this.timings.length;

    if (removedMetrics > 0 || removedTimings > 0) {
      this.logger.debug('Cleaned up old performance data', {
        removedMetrics,
        removedTimings,
        remainingMetrics: this.metrics.length,
        remainingTimings: this.timings.length,
      });
    }
  }
}
