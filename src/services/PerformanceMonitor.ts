import { EventEmitter } from 'events';
import * as os from 'os';
import { performance, PerformanceObserver } from 'perf_hooks';
import { logger } from '../utils/Logger';

export interface PerformanceMetrics {
  timestamp: string;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    heapUtilization: number;
    memoryLeakRisk: 'low' | 'medium' | 'high';
  };
  cpu: {
    usage: number;
    loadAverage: number[];
    cores: number;
  };
  eventLoop: {
    lag: number;
    utilization: number;
  };
  gc: {
    collections: number;
    duration: number;
    type: string;
  }[];
  requests: {
    active: number;
    total: number;
    averageResponseTime: number;
    slowRequests: number;
  };
  database: {
    activeConnections: number;
    queryTime: number;
    slowQueries: number;
  };
  integrations: {
    [key: string]: {
      responseTime: number;
      errorRate: number;
      throughput: number;
    };
  };
}

export interface PerformanceAlert {
  type: 'memory' | 'cpu' | 'eventLoop' | 'response' | 'integration';
  severity: 'warning' | 'critical';
  message: string;
  metrics: unknown;
  timestamp: string;
}

export class PerformanceMonitor extends EventEmitter {
  private metrics: PerformanceMetrics[] = [];
  private alerts: PerformanceAlert[] = [];
  private performanceReport: unknown = null;
  private isMonitoring = false;
  private monitoringInterval?: NodeJS.Timeout;
  private performanceObserver?: PerformanceObserver;
  private gcMetrics: unknown[] = [];
  private requestMetrics = {
    active: 0,
    total: 0,
    responseTimes: [] as number[],
    slowRequests: 0
  };
  private integrationMetrics = new Map<string, {
    responseTimes: number[];
    errors: number;
    requests: number;
  }>();

  // Memory leak detection
  private memoryBaseline?: number;
  private memoryGrowthSamples: number[] = [];
  private readonly MEMORY_LEAK_THRESHOLD = 50 * 1024 * 1024; // 50MB growth
  private readonly MEMORY_SAMPLE_SIZE = 10;

  // Performance thresholds
  private readonly thresholds = {
    memory: {
      heapUtilization: 85, // %
      rss: 1024 * 1024 * 1024, // 1GB
    },
    cpu: {
      usage: 80, // %
      loadAverage: os.cpus().length * 2
    },
    eventLoop: {
      lag: 100, // ms
      utilization: 90 // %
    },
    response: {
      averageTime: 1000, // ms
      slowRequestThreshold: 2000 // ms
    }
  };

  constructor() {
    super();
    this.setupPerformanceObserver();
    this.setupGCMonitoring();
  }

  private setupPerformanceObserver(): void {
    this.performanceObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach((entry) => {
        if (entry.entryType === 'measure') {
          this.recordMeasurement(entry.name, entry.duration);
        }
      });
    });

    this.performanceObserver.observe({ entryTypes: ['measure', 'resource'] as any });
  }

  private gcInterval?: NodeJS.Timeout;

  private setupGCMonitoring(): void {
    // Monitor garbage collection if available
    if (process.env.NODE_ENV !== 'production') {
      try {
        // Disable GC monitoring during tests to prevent timeouts
        if (process.env.NODE_ENV === 'test') {
          return;
        }

        const v8 = require('v8');
        if (v8 && v8.getHeapStatistics) {
          // GC monitoring is available
          this.gcInterval = setInterval(() => {
            const heapStats = v8.getHeapStatistics();
            this.recordGCMetrics(heapStats);
          }, 5000);
        }
      } catch (error) {
        logger.warn('GC monitoring not available', { error: (error as Error).message });
      }
    }
  }

  public shutdown(): void {
    // Set monitoring state to false and clear the main monitoring interval
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    // Disconnect performance observer if present
    if (this.performanceObserver) {
      this.performanceObserver.disconnect();
    }

    // Clear GC interval if it was set
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }
  }

  public reset(): void {
    // Reset performance monitor state for tests
    this.metrics = [];
    this.alerts = [];
    this.performanceReport = null;
    this.gcMetrics = [];
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }
  }

  private recordGCMetrics(heapStats: unknown): void {
    this.gcMetrics.push({
      timestamp: new Date().toISOString(),
      heapSizeLimit: (heapStats as any).heap_size_limit,
      totalHeapSize: (heapStats as any).total_heap_size,
      usedHeapSize: (heapStats as any).used_heap_size,
      mallocedMemory: (heapStats as any).malloced_memory,
      peakMallocedMemory: (heapStats as any).peak_malloced_memory
    });

    // Keep only last 100 GC metrics
    if (this.gcMetrics.length > 100) {
      this.gcMetrics = this.gcMetrics.slice(-100);
    }
  }

  private recordMeasurement(name: string, duration: number): void {
    if (name.startsWith('integration-')) {
      const integrationName = name.replace('integration-', '');
      this.recordIntegrationMetric(integrationName, duration);
    } else if (name === 'request-duration') {
      this.recordRequestMetric(duration);
    }
  }

  public startMonitoring(intervalMs = 10000): void {
    if (this.isMonitoring) {
      logger.warn('Performance monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.memoryBaseline = process.memoryUsage().heapUsed;

    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);

    // In test environments, unref the interval to prevent Jest open handles
    if (process.env.NODE_ENV === 'test') {
      this.monitoringInterval.unref();
    }

    logger.info('Performance monitoring started', { interval: intervalMs });
  }

  public stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    if (this.performanceObserver) {
      this.performanceObserver.disconnect();
    }

    logger.info('Performance monitoring stopped');
  }

  private collectMetrics(): void {
    const timestamp = new Date().toISOString();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const loadAvg = os.loadavg();

    // Calculate memory leak risk
    const memoryLeakRisk = this.assessMemoryLeakRisk(memUsage.heapUsed);

    // Calculate event loop lag
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms

      const metrics: PerformanceMetrics = {
        timestamp,
        memory: {
          heapUsed: memUsage.heapUsed,
          heapTotal: memUsage.heapTotal,
          external: memUsage.external,
          rss: memUsage.rss,
          heapUtilization: (memUsage.heapUsed / memUsage.heapTotal) * 100,
          memoryLeakRisk
        },
        cpu: {
          usage: this.calculateCPUUsage(cpuUsage),
          loadAverage: loadAvg,
          cores: os.cpus().length
        },
        eventLoop: {
          lag,
          utilization: this.calculateEventLoopUtilization()
        },
        gc: this.getRecentGCMetrics() as { collections: number; duration: number; type: string; }[],
        requests: {
          active: this.requestMetrics.active,
          total: this.requestMetrics.total,
          averageResponseTime: this.calculateAverageResponseTime(),
          slowRequests: this.requestMetrics.slowRequests
        },
        database: {
          activeConnections: 0, // TODO: Implement database monitoring
          queryTime: 0,
          slowQueries: 0
        },
        integrations: this.getIntegrationMetrics() as { [key: string]: { responseTime: number; errorRate: number; throughput: number; } }
      };

      this.metrics.push(metrics);
      this.checkThresholds(metrics);

      // Keep only last 1000 metrics (about 2.7 hours at 10s intervals)
      if (this.metrics.length > 1000) {
        this.metrics = this.metrics.slice(-1000);
      }

      this.emit('metrics', metrics);
    });
  }

  private assessMemoryLeakRisk(currentHeapUsed: number): 'low' | 'medium' | 'high' {
    if (!this.memoryBaseline) {
      this.memoryBaseline = currentHeapUsed;
      return 'low';
    }

    const growth = currentHeapUsed - this.memoryBaseline;
    this.memoryGrowthSamples.push(growth);

    if (this.memoryGrowthSamples.length > this.MEMORY_SAMPLE_SIZE) {
      this.memoryGrowthSamples.shift();
    }

    if (this.memoryGrowthSamples.length < this.MEMORY_SAMPLE_SIZE) {
      return 'low';
    }

    // Check if memory is consistently growing
    const averageGrowth = this.memoryGrowthSamples.reduce((a, b) => a + b, 0) / this.memoryGrowthSamples.length;
    const isConsistentGrowth = this.memoryGrowthSamples.every(sample => sample > 0);

    if (averageGrowth > this.MEMORY_LEAK_THRESHOLD && isConsistentGrowth) {
      return 'high';
    } else if (averageGrowth > this.MEMORY_LEAK_THRESHOLD / 2) {
      return 'medium';
    }

    return 'low';
  }

  private calculateCPUUsage(cpuUsage: NodeJS.CpuUsage): number {
    // This is a simplified CPU usage calculation
    // In a real implementation, you'd want to track this over time
    const totalUsage = cpuUsage.user + cpuUsage.system;
    return Math.min(100, (totalUsage / 1000000) * 100); // Convert to percentage
  }

  private calculateEventLoopUtilization(): number {
    // Simplified event loop utilization
    // In practice, you'd use perf_hooks.eventLoopUtilization()
    try {
      const { eventLoopUtilization } = require('perf_hooks');
      if (eventLoopUtilization) {
        const utilization = eventLoopUtilization();
        return utilization.utilization * 100;
      }
    } catch (error) {
      // Fallback for older Node.js versions
    }
    return 0;
  }

  private getRecentGCMetrics(): unknown[] {
    return this.gcMetrics.slice(-5); // Last 5 GC events
  }

  private calculateAverageResponseTime(): number {
    if (this.requestMetrics.responseTimes.length === 0) return 0;
    
    const sum = this.requestMetrics.responseTimes.reduce((a, b) => a + b, 0);
    return sum / this.requestMetrics.responseTimes.length;
  }

  private getIntegrationMetrics(): { [key: string]: unknown } {
    const result: { [key: string]: unknown } = {};
    
    this.integrationMetrics.forEach((metrics, integration) => {
      const avgResponseTime = metrics.responseTimes.length > 0
        ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
        : 0;
      
      result[integration] = {
        responseTime: avgResponseTime,
        errorRate: metrics.requests > 0 ? (metrics.errors / metrics.requests) * 100 : 0,
        throughput: metrics.requests
      };
    });

    return result;
  }

  private checkThresholds(metrics: PerformanceMetrics): void {
    const alerts: PerformanceAlert[] = [];

    // Memory alerts
    if (metrics.memory.heapUtilization > this.thresholds.memory.heapUtilization) {
      alerts.push({
        type: 'memory',
        severity: 'warning',
        message: `High heap utilization: ${metrics.memory.heapUtilization.toFixed(1)}%`,
        metrics: metrics.memory,
        timestamp: metrics.timestamp
      });
    }

    if (metrics.memory.memoryLeakRisk === 'high') {
      alerts.push({
        type: 'memory',
        severity: 'critical',
        message: 'Potential memory leak detected',
        metrics: metrics.memory,
        timestamp: metrics.timestamp
      });
    }

    // CPU alerts
    if (metrics.cpu.usage > this.thresholds.cpu.usage) {
      alerts.push({
        type: 'cpu',
        severity: 'warning',
        message: `High CPU usage: ${metrics.cpu.usage.toFixed(1)}%`,
        metrics: metrics.cpu,
        timestamp: metrics.timestamp
      });
    }

    // Event loop alerts
    if (metrics.eventLoop.lag > this.thresholds.eventLoop.lag) {
      alerts.push({
        type: 'eventLoop',
        severity: 'warning',
        message: `High event loop lag: ${metrics.eventLoop.lag.toFixed(1)}ms`,
        metrics: metrics.eventLoop,
        timestamp: metrics.timestamp
      });
    }

    // Response time alerts
    if (metrics.requests.averageResponseTime > this.thresholds.response.averageTime) {
      alerts.push({
        type: 'response',
        severity: 'warning',
        message: `Slow average response time: ${metrics.requests.averageResponseTime.toFixed(1)}ms`,
        metrics: metrics.requests,
        timestamp: metrics.timestamp
      });
    }

    // Process alerts
    alerts.forEach(alert => {
      this.alerts.push(alert);
      this.emit('alert', alert);
      logger.warn('Performance alert', { alert });
    });

    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
  }

  public getAllMetrics(): PerformanceMetrics[] {
    return this.metrics;
  }

  // Public methods for recording metrics
  public recordRequestStart(): void {
    this.requestMetrics.active++;
    this.requestMetrics.total++;
  }

  public recordRequestEnd(duration: number): void {
    this.requestMetrics.active = Math.max(0, this.requestMetrics.active - 1);
    this.requestMetrics.responseTimes.push(duration);
    
    if (duration > this.thresholds.response.slowRequestThreshold) {
      this.requestMetrics.slowRequests++;
    }

    // Keep only last 1000 response times
    if (this.requestMetrics.responseTimes.length > 1000) {
      this.requestMetrics.responseTimes = this.requestMetrics.responseTimes.slice(-1000);
    }
  }

  private recordRequestMetric(duration: number): void {
    this.recordRequestEnd(duration);
  }

  public recordIntegrationMetric(integration: string, responseTime: number, isError = false): void {
    if (!this.integrationMetrics.has(integration)) {
      this.integrationMetrics.set(integration, {
        responseTimes: [],
        errors: 0,
        requests: 0
      });
    }

    const metrics = this.integrationMetrics.get(integration)!;
    metrics.responseTimes.push(responseTime);
    metrics.requests++;
    
    if (isError) {
      metrics.errors++;
    }

    // Keep only last 100 response times per integration
    if (metrics.responseTimes.length > 100) {
      metrics.responseTimes = metrics.responseTimes.slice(-100);
    }
  }

  // Getter methods
  public getMetrics(): PerformanceMetrics[] {
    return [...this.metrics];
  }

  public getLatestMetrics(): PerformanceMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1]! : null;
  }

  public getAlerts(): PerformanceAlert[] {
    return [...this.alerts];
  }

  public getRecentAlerts(minutes = 60): PerformanceAlert[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    return this.alerts.filter(alert => alert.timestamp > cutoff);
  }

  // Performance optimization methods
  public optimizeMemory(): void {
    if (global.gc) {
      global.gc();
      logger.info('Manual garbage collection triggered');
    } else {
      logger.warn('Garbage collection not available (run with --expose-gc)');
    }
  }

  public getPerformanceReport(): unknown {
    const latest = this.getLatestMetrics();
    const recentAlerts = this.getRecentAlerts(60);
    
    return {
      status: recentAlerts.some(a => a.severity === 'critical') ? 'critical' : 
              recentAlerts.some(a => a.severity === 'warning') ? 'warning' : 'healthy',
      timestamp: new Date().toISOString(),
      metrics: latest,
      alerts: recentAlerts,
      recommendations: this.generateRecommendations(latest, recentAlerts)
    };
  }

  private generateRecommendations(metrics: PerformanceMetrics | null, alerts: PerformanceAlert[]): string[] {
    const recommendations: string[] = [];

    if (!metrics) return recommendations;

    if (metrics.memory.heapUtilization > 80) {
      recommendations.push('Consider increasing heap size or optimizing memory usage');
    }

    if (metrics.memory.memoryLeakRisk === 'high') {
      recommendations.push('Investigate potential memory leaks in application code');
    }

    if (metrics.cpu.usage > 70) {
      recommendations.push('Consider scaling horizontally or optimizing CPU-intensive operations');
    }

    if (metrics.eventLoop.lag > 50) {
      recommendations.push('Reduce blocking operations in the event loop');
    }

    if (metrics.requests.averageResponseTime > 500) {
      recommendations.push('Optimize slow endpoints and database queries');
    }

    return recommendations;
  }


}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();