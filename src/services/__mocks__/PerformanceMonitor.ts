import { EventEmitter } from 'events';

type PerfMetrics = {
  timestamp: string;
  memory: { heapUsed: number; heapTotal: number; external: number; rss: number; heapUtilization: number; memoryLeakRisk: 'low' | 'medium' | 'high' };
  cpu: { usage: number; loadAverage: number[]; cores: number };
  eventLoop: { lag: number; utilization: number };
  gc: unknown[];
  requests: { active: number; total: number; averageResponseTime: number; slowRequests: number };
  database: { activeConnections: number; queryTime: number; slowQueries: number };
  integrations: Record<string, { responseTime: number; errorRate: number; throughput: number }>;
};

export class PerformanceMonitor extends EventEmitter {
  private metrics: PerfMetrics[] = [];
  private alerts: unknown[] = [];
  private requestActive = 0;
  private requestTotal = 0;
  private responseTimes: number[] = [];
  private integrationStats = new Map<string, { times: number[]; errors: number; requests: number }>();
  private monitoring = false;

  startMonitoring(_intervalMs = 1000): void {
    this.monitoring = true;
    // Push an immediate, minimal metrics sample so tests can proceed without waiting
    this.collectOnce();
  }

  stopMonitoring(): void {
    this.monitoring = false;
  }

  shutdown(): void {
    this.monitoring = false;
  }

  reset(): void {
    this.metrics = [];
    this.alerts = [];
    this.requestActive = 0;
    this.requestTotal = 0;
    this.responseTimes = [];
    this.integrationStats.clear();
  }

  private collectOnce(): void {
    const avg = this.responseTimes.length
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
      : 0;
    const m: PerfMetrics = {
      timestamp: new Date().toISOString(),
      memory: { heapUsed: 1, heapTotal: 1, external: 0, rss: 1, heapUtilization: 50, memoryLeakRisk: 'low' },
      cpu: { usage: 1, loadAverage: [0, 0, 0], cores: 1 },
      eventLoop: { lag: 1, utilization: 1 },
      gc: [],
      requests: { active: this.requestActive, total: this.requestTotal, averageResponseTime: avg, slowRequests: 0 },
      database: { activeConnections: 0, queryTime: 0, slowQueries: 0 },
      integrations: {},
    };
    // populate integrations from stats map
    this.integrationStats.forEach((v, k) => {
      const avgRt = v.times.length ? v.times.reduce((a, b) => a + b, 0) / v.times.length : 0;
      (m.integrations as any)[k] = {
        responseTime: avgRt,
        errorRate: v.requests > 0 ? (v.errors / v.requests) * 100 : 0,
        throughput: v.requests,
      };
    });
    this.metrics.push(m);
  }

  // Expose for tests via private access pattern
  get ['isMonitoring'](): boolean {
    return this.monitoring;
  }

  recordRequestStart(): void {
    this.requestActive++;
    this.requestTotal++;
  }

  recordRequestEnd(duration: number): void {
    this.requestActive = Math.max(0, this.requestActive - 1);
    this.responseTimes.push(duration);
  }

  recordIntegrationMetric(integration: string, responseTime: number, isError = false): void {
    if (!this.integrationStats.has(integration)) {
      this.integrationStats.set(integration, { times: [], errors: 0, requests: 0 });
    }
    const st = this.integrationStats.get(integration)!;
    st.times.push(responseTime);
    st.requests++;
    if (isError) st.errors++;
  }

  getAllMetrics(): PerfMetrics[] {
    return this.metrics;
  }

  getMetrics(): PerfMetrics[] {
    return this.metrics;
  }

  getLatestMetrics(): PerfMetrics | null {
    return this.metrics.length ? this.metrics[this.metrics.length - 1] : null;
  }

  getAlerts(): unknown[] {
    return [...this.alerts];
  }

  getRecentAlerts(_minutes = 60): unknown[] {
    return [...this.alerts];
  }

  optimizeMemory(): void {
    // no-op in mock
  }

  getPerformanceReport(): unknown {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      metrics: this.getLatestMetrics(),
      alerts: this.getAlerts(),
      recommendations: [],
    };
  }
}

export const performanceMonitor = new PerformanceMonitor();
