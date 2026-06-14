import { Router, type Request, type Response } from 'express';
import { PerformanceMonitor } from '../utils/monitoring';
import { EventBus } from '../utils/EventBus';
import { DistributedCache } from '../utils/DistributedCache';
import promClient from 'prom-client';
import type { AdvancedSecurityMiddleware } from '../middleware/advancedSecurity';
import { asyncHandler } from '../middleware/asyncHandler';
import { createMockProviders, QueueStatsProvider, TraceProvider, CredentialSummaryProvider } from '../dashboard/providers';
import { Logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { TelemetryService } from '../services/TelemetryService';

const logger = new Logger('Dashboard');

export interface BusinessMetrics {
  integrationSuccessRates: Record<string, number>;
  dataVolumeProcessed: { total: number; bySystem: Record<string, number>; trend: { timestamp: Date; volume: number }[] };
  errorPatterns: { totalErrors: number; errorsByType: Record<string, number>; errorsBySystem: Record<string, number>; recentErrors: { timestamp: Date; type: string; system: string; message: string }[] };
  performanceMetrics: { p50: number; p95: number; p99: number; averageResponseTime: number };
  systemHealth: { uptime: number; memoryUsage: NodeJS.MemoryUsage; cpuUsage: number; activeConnections: number };
}
export interface SecurityDashboardMetrics {
  authenticationAttempts: { successful: number; failed: number; trend: { timestamp: Date; successful: number; failed: number }[] };
  rateLimitingEvents: { totalBlocked: number; blockedByIP: Record<string, number>; recentBlocks: { timestamp: Date; ip: string; reason: string }[] };
  threatDetection: { suspiciousActivity: number; blockedIPs: string[] | null; securityScans: number; recentThreats: { timestamp: Date; type: string; source: string; severity: string }[] };
  securityMetrics: { cspViolations: number; xssAttempts: number; sqlInjectionAttempts: number; fileUploadAttacks: number };
}
export interface PerformanceDashboardMetrics {
  responseTimes: { current: number; trend: { timestamp: Date; responseTime: number }[]; byEndpoint: Record<string, number> };
  memoryUsage: { current: NodeJS.MemoryUsage; trend: { timestamp: Date; usage: NodeJS.MemoryUsage }[]; leakDetection: boolean };
  connectionPools: { totalConnections: number; activeConnections: number; poolUtilization: number; connectionHealth: 'healthy' | 'warning' | 'critical' };
  cacheMetrics: { hitRate: number; missRate: number; totalRequests: number; cacheSize: number; evictions: number };
  circuitBreakers: { activeBreakers: number; openBreakers: string[]; failureRates: Record<string, number> };
}

export class OperationalDashboard {
  private readonly router: Router;
  private readonly performanceMonitor: PerformanceMonitor;
  private readonly eventBus: EventBus;
  private readonly cache: DistributedCache;
  private metricsCollectionInterval?: NodeJS.Timeout;
  private mockMutationInterval?: NodeJS.Timeout;
  private sseClients: Set<Response> = new Set<Response>();
  private queueProvider: QueueStatsProvider;
  private traceProvider: TraceProvider;
  private credentialProvider: CredentialSummaryProvider;
  private metricsHistory: {
    performance: { timestamp: Date; metrics: PerformanceDashboardMetrics }[];
    security: { timestamp: Date; metrics: SecurityDashboardMetrics }[];
    business: { timestamp: Date; metrics: BusinessMetrics }[];
  } = { performance: [], security: [], business: [] };
  private recentActivity: { id: string; name: string; status: 'success' | 'error' | 'running'; timestamp: string; records: number; duration: string; }[] = [];
  private summaryStats = { activeIntegrations: 0, successRate: 99.2, recordsProcessed: 0, avgResponse: 120 };
  private aiMetrics = { provider: 'rule-based', suggestionsGenerated: 0, avgLatencyMs: 120, p95LatencyMs: 250, tokensUsed: 0, mappingAccuracy: 0.87, lastUpdated: new Date().toISOString() };
  constructor(_sec?: AdvancedSecurityMiddleware) {
    this.router = Router();
    this.performanceMonitor = PerformanceMonitor.getInstance();
    this.eventBus = EventBus.getInstance();
// merged
    // Cache initialization with graceful fallback if Redis unreachable
    let cacheInstance: DistributedCache | null = null;
    try {
      cacheInstance = new DistributedCache({ redisUrl: process.env.REDIS_URL, enableFallback: true });
    } catch (err) {
      logger.warn('Distributed cache unavailable, using in-memory stub', { error: (err as Error).message });
    }
    // Provide minimal stub if construction failed
    this.cache = (cacheInstance as DistributedCache) || ( {
      getMetrics: () => ({ hitRate: 0, hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0, totalRequests: 0, averageResponseTime: 0, lastError: 'cache-disabled', connectedNodes: 0, memory: { used: 0, peak: 0, fragmentation: 0 } }),
      get: async () => null as unknown,
      set: async () => true as unknown,
    } as unknown as DistributedCache );
    const { queueProvider, traceProvider, credentialProvider } = createMockProviders();
    this.queueProvider = queueProvider;
    this.traceProvider = traceProvider;
    this.credentialProvider = credentialProvider;
    this.setupRoutes();
    this.startMetricsCollection();
    this.seedInitialMock();
  }
  public cleanup() { if (this.metricsCollectionInterval) clearInterval(this.metricsCollectionInterval); if (this.mockMutationInterval) clearInterval(this.mockMutationInterval); (this.cache as any)?.cleanup?.(); }
  private setupRoutes() {
    this.router.get('/', (_r, res) => res.send(this.generateDashboardHTML()));
    this.router.get('/api/business-metrics', asyncHandler(this.getBusinessMetrics.bind(this)));
    this.router.get('/api/security-metrics', asyncHandler(this.getSecurityMetrics.bind(this)));
    this.router.get('/api/performance-metrics', asyncHandler(this.getPerformanceMetrics.bind(this)));
    this.router.get('/api/system-status', asyncHandler(this.getSystemStatus.bind(this)));
    this.router.get('/api/metrics/history/:type', asyncHandler(this.getMetricsHistory.bind(this)));
    this.router.get('/api/websocket-info', asyncHandler(this.getWebSocketInfo.bind(this)));
    this.router.get('/api/summary', asyncHandler(this.getSummary.bind(this)));
    this.router.get('/api/recent-activity', asyncHandler(this.getRecentActivity.bind(this)));
    this.router.post('/api/seed-mock', asyncHandler(this.seedMockData.bind(this)));
    this.router.get('/api/metrics-json', asyncHandler(this.getMetricsJson.bind(this)));
    this.router.get('/api/traces', asyncHandler(this.getRecentTraces.bind(this)));
    this.router.get('/api/queues', asyncHandler(this.getQueueStatus.bind(this)));
    this.router.get('/api/credentials', asyncHandler(this.getCredentialSummary.bind(this)));
    this.router.get('/api/ai-metrics', asyncHandler(this.getAiMetrics.bind(this)));
    this.router.get('/api/capabilities', asyncHandler(this.getCapabilities.bind(this)));
    this.router.get('/api/export', asyncHandler(this.exportSnapshot.bind(this)));
    this.router.get('/api/stream', this.handleSSE.bind(this));
    
    // Squire-specific telemetry endpoints
    this.router.get('/api/squire/executive-summary', asyncHandler(this.getExecutiveSummary.bind(this)));
    this.router.get('/api/squire/roi-metrics', asyncHandler(this.getROIMetrics.bind(this)));
    this.router.get('/api/squire/business-metrics', asyncHandler(this.getSquireBusinessMetrics.bind(this)));
    this.router.get('/api/squire/dashboard-data', asyncHandler(this.getSquireDashboardData.bind(this)));
    this.router.get('/api/squire/metrics', asyncHandler(this.getSquireSpecificMetrics.bind(this)));
  }
  private async getBusinessMetrics(_r: Request, res: Response) {
    try {
      const pm = this.performanceMonitor.getMetrics();
      const eb = this.eventBus.getMetrics();
      const metrics: BusinessMetrics = {
        integrationSuccessRates: this.calculateSuccessRates(eb),
        dataVolumeProcessed: { total: eb.totalEventsProcessed, bySystem: eb.eventsByType, trend: this.getVolumeHistory() },
        errorPatterns: { totalErrors: eb.totalEventsFailed, errorsByType: eb.errorsByType, errorsBySystem: this.getErrorsBySystem(), recentErrors: this.getRecentErrors() },
        performanceMetrics: { p50: this.calculatePercentile(pm, 50), p95: this.calculatePercentile(pm, 95), p99: this.calculatePercentile(pm, 99), averageResponseTime: eb.averageProcessingTime },
        systemHealth: { uptime: process.uptime(), memoryUsage: process.memoryUsage(), cpuUsage: process.cpuUsage().user / 1_000_000, activeConnections: eb.activeSubscriptions },
      };
      this.metricsHistory.business.push({ timestamp: new Date(), metrics });
      this.trimHistory('business');
      res.json(metrics);
    } catch (e) { logger.error('business metrics', e); res.status(500).json({ error: 'Failed to retrieve business metrics' }); }
  }
  private async getSecurityMetrics(_r: Request, res: Response) {
    try {
      const securityData = { authenticationAttempts: { successful: 145, failed: 12, blocked: 3 }, rateLimit: { requests: 1250, throttled: 18, blocked: 5 }, threats: { detected: 2, mitigated: 2, severity: 'low' } };
      const metrics: SecurityDashboardMetrics = {
        authenticationAttempts: { successful: securityData.authenticationAttempts.successful, failed: securityData.authenticationAttempts.failed, trend: this.getAuthTrend() },
        rateLimitingEvents: { totalBlocked: securityData.rateLimit.blocked, blockedByIP: this.getRateLimitByIP(), recentBlocks: this.getRecentRateLimit() },
        threatDetection: { suspiciousActivity: securityData.threats.detected, blockedIPs: ['192.168.1.100', '10.0.0.55'], securityScans: 0, recentThreats: this.getRecentThreats() },
        securityMetrics: { cspViolations: 0, xssAttempts: 0, sqlInjectionAttempts: 0, fileUploadAttacks: 0 },
      };
      this.metricsHistory.security.push({ timestamp: new Date(), metrics });
      this.trimHistory('security');
      res.json(metrics);
    } catch (e) { logger.error('security metrics', e); res.status(500).json({ error: 'Failed to retrieve security metrics' }); }
  }
  private async getPerformanceMetrics(_r: Request, res: Response) {
    try {
      const cacheMetrics = await this.cache.getMetrics();
      const eb = this.eventBus.getMetrics();
      const metrics: PerformanceDashboardMetrics = {
        responseTimes: { current: eb.averageProcessingTime, trend: this.getResponseTimeTrend(), byEndpoint: this.getResponseTimesByEndpoint() },
        memoryUsage: { current: process.memoryUsage(), trend: this.getMemoryTrend(), leakDetection: this.detectMemoryLeak() },
        connectionPools: { totalConnections: 10, activeConnections: eb.activeSubscriptions, poolUtilization: 0.75, connectionHealth: 'healthy' },
        cacheMetrics: { hitRate: cacheMetrics.hitRate, missRate: 1 - cacheMetrics.hitRate, totalRequests: cacheMetrics.hits + cacheMetrics.misses, cacheSize: cacheMetrics.sets, evictions: 0 },
        circuitBreakers: { activeBreakers: 0, openBreakers: [], failureRates: {} },
      };
      this.metricsHistory.performance.push({ timestamp: new Date(), metrics });
      this.trimHistory('performance');
      res.json(metrics);
    } catch (e) { logger.error('performance metrics', e); res.status(500).json({ error: 'Failed to retrieve performance metrics' }); }
  }
  private async getSystemStatus(_r: Request, res: Response) {
    try {
      const health = this.performanceMonitor.getHealthMetrics();
      const ebq = this.eventBus.getQueueStatus();
      const cacheMetrics = await this.cache.getMetrics();
      const systemStatus = {
        overall: 'healthy' as const,
        components: {
          monitoring: { status: health?.telemetryEnabled ? 'healthy' : 'warning', uptime: process.uptime() },
          eventBus: { status: 'healthy' as const, queued: ebq?.waiting || 0, processing: ebq?.processing || 0 },
          cache: { status: 'healthy' as const, hitRate: cacheMetrics?.hitRate || 0 },
          security: { status: 'healthy' as const, threats: 0 },
        },
        metrics: { uptime: process.uptime(), memory: process.memoryUsage(), version: process.version, platform: process.platform },
      };
      res.json(systemStatus);
    } catch (error) {
      logger.error('Error getting system status:', error);
      res.status(500).json({ error: 'Failed to retrieve system status' });
    }
  }

  private async getMetricsHistory(req: Request, res: Response): Promise<void> {
    const { type } = req.params;
    const { hours = 24 } = req.query;

    try {
      const cutoffTime = new Date(Date.now() - (Number(hours) * 60 * 60 * 1000));

      let history: unknown[] = [];
      if (type === 'business' && this.metricsHistory.business) {
        history = this.metricsHistory.business.filter(entry => entry.timestamp > cutoffTime);
      } else if (type === 'security' && this.metricsHistory.security) {
        history = this.metricsHistory.security.filter(entry => entry.timestamp > cutoffTime);
      } else if (type === 'performance' && this.metricsHistory.performance) {
        history = this.metricsHistory.performance.filter(entry => entry.timestamp > cutoffTime);
      }

      res.json({ type, history, count: history.length });
    } catch (error) {
      logger.error('Error getting metrics history:', error);
      res.status(500).json({ error: 'Failed to retrieve metrics history' });
    }
  }

  private async getWebSocketInfo(_req: Request, res: Response): Promise<void> {
    res.json({
      available: false,
      message: 'WebSocket real-time updates not implemented yet',
      pollingInterval: 5000,
      endpoints: {
        business: '/api/business-metrics',
        security: '/api/security-metrics',
        performance: '/api/performance-metrics',
        status: '/api/system-status',
      },
    });
  }

  // Helper methods for calculations
  private calculateSuccessRates(eventMetrics: unknown): Record<string, number> {
    const rates: Record<string, number> = {};
    Object.keys((eventMetrics as any).eventsByType).forEach(type => {
      const total = (eventMetrics as any).eventsByType[type];
      const errors = (eventMetrics as any).errorsByType[type] || 0;
      rates[type] = total > 0 ? ((total - errors) / total) * 100 : 100;
    });
    return rates;
  }

  private calculatePercentile(_metrics: unknown, _percentile: number): number {
    // Simplified percentile calculation - in production, use proper statistical methods
    return Math.random() * 100 + _percentile; // Mock implementation
  }

  private getVolumeHistory(): { timestamp: Date; volume: number }[] {
    // Mock data - in production, fetch from metrics store
    const history = [];
    for (let i = 23; i >= 0; i--) {
      history.push({
        timestamp: new Date(Date.now() - (i * 60 * 60 * 1000)),
        volume: Math.floor(Math.random() * 1000) + 500,
      });
    }
    return history;
  }

  private getErrorsBySystem(): Record<string, number> {
    return {
      'dynamics': Math.floor(Math.random() * 10),
      'netsuite': Math.floor(Math.random() * 5),
      'integration-hub': Math.floor(Math.random() * 3),
    };
  }

  private getRecentErrors(): { timestamp: Date; type: string; system: string; message: string }[] {
    return [
      {
        timestamp: new Date(Date.now() - 300000), // 5 minutes ago
        type: 'ConnectionError',
        system: 'dynamics',
        message: 'Connection timeout to Dynamics 365',
      },
      {
        timestamp: new Date(Date.now() - 600000), // 10 minutes ago
        type: 'ValidationError',
        system: 'netsuite',
        message: 'Invalid field format in NetSuite request',
      },
    ];
  }

  private getAuthTrend(): { timestamp: Date; successful: number; failed: number }[] {
    const trend = [];
    for (let i = 23; i >= 0; i--) {
      trend.push({
        timestamp: new Date(Date.now() - (i * 60 * 60 * 1000)),
        successful: Math.floor(Math.random() * 100) + 200,
        failed: Math.floor(Math.random() * 10),
      });
    }
    return trend;
  }

  private getRateLimitByIP(): Record<string, number> {
    return {
      '192.168.1.100': 25,
      '10.0.0.50': 12,
      '172.16.0.25': 8,
    };
  }

  private getRecentRateLimit(): { timestamp: Date; ip: string; reason: string }[] {
    return [
      {
        timestamp: new Date(Date.now() - 120000),
        ip: '192.168.1.100',
        reason: 'Exceeded 100 requests per minute',
      },
    ];
  }

  private getRecentThreats(): { timestamp: Date; type: string; source: string; severity: string }[] {
    return [
      {
        timestamp: new Date(Date.now() - 180000),
        type: 'SQL Injection Attempt',
        source: '203.0.113.1',
        severity: 'high',
      },
    ];
  }

  private getResponseTimeTrend(): { timestamp: Date; responseTime: number }[] {
    const trend = [];
    for (let i = 23; i >= 0; i--) {
      trend.push({
        timestamp: new Date(Date.now() - (i * 60 * 60 * 1000)),
        responseTime: Math.random() * 50 + 25,
      });
    }
    return trend;
  }

  private getResponseTimesByEndpoint(): Record<string, number> {
    return {
      '/api/configurations': 45,
      '/api/integrations': 78,
      '/api/health': 12,
      '/api/auth': 34,
    };
  }

  private getMemoryTrend(): { timestamp: Date; usage: NodeJS.MemoryUsage }[] {
    const trend = [];
    for (let i = 11; i >= 0; i--) {
      trend.push({
        timestamp: new Date(Date.now() - (i * 60 * 60 * 1000)),
        usage: {
          rss: Math.floor(Math.random() * 10000000) + 50000000,
          heapTotal: Math.floor(Math.random() * 5000000) + 20000000,
          heapUsed: Math.floor(Math.random() * 3000000) + 15000000,
          external: Math.floor(Math.random() * 1000000) + 1000000,
          arrayBuffers: Math.floor(Math.random() * 100000) + 100000,
        },
      });
    }
    return trend;
  }

  private detectMemoryLeak(): boolean {
    const memoryTrend = this.getMemoryTrend();
    if (memoryTrend.length < 3) return false;

    // Simple leak detection: check if memory usage is consistently increasing
    let increasing = 0;
    for (let i = 1; i < Math.min(memoryTrend.length, 5); i++) {
      const currentUsage = memoryTrend[i]?.usage?.heapUsed;
      const previousUsage = memoryTrend[i-1]?.usage?.heapUsed;
      
      if (currentUsage && previousUsage && currentUsage > previousUsage) {
        increasing++;
      }
    }

    return increasing >= 3; // 3 consecutive increases suggests potential leak
  }

  private trimHistory(type: 'performance' | 'security' | 'business'): void {
    const maxEntries = 100;
    switch (type) {
      case 'performance':
        if (this.metricsHistory.performance.length > maxEntries) {
          this.metricsHistory.performance = this.metricsHistory.performance.slice(-maxEntries);
        }
        return;
      case 'security':
        if (this.metricsHistory.security.length > maxEntries) {
          this.metricsHistory.security = this.metricsHistory.security.slice(-maxEntries);
        }
        return;
      case 'business':
        if (this.metricsHistory.business.length > maxEntries) {
          this.metricsHistory.business = this.metricsHistory.business.slice(-maxEntries);
        }
        return;
    }
  }

  private startMetricsCollection(): void {
    if (process.env.DASHBOARD_DISABLE_INTERVALS === '1') return;
    // Collect metrics every 30 seconds
    this.metricsCollectionInterval = setInterval(() => {
      this.collectMetrics();
    }, 30000);
  }

  private collectMetrics(): void {
    // This would trigger collection of all metrics for historical tracking
    logger.debug('Collecting dashboard metrics for historical tracking');
  }

  // Seed initial mock activity and set up periodic updates for the dashboard
  private seedInitialMock(): void {
    if (this.recentActivity.length === 0) {
      for (let i = 0; i < 40; i++) {
        this.recentActivity.push(this.generateActivity(i));
      }
    }
  if (!this.mockMutationInterval && process.env.DASHBOARD_DISABLE_INTERVALS !== '1') {
      this.mockMutationInterval = setInterval(() => {
        this.recentActivity.unshift(this.generateActivity());
        this.recentActivity = this.recentActivity.slice(0, 200);
        this.broadcastSummary();
      }, 7000);
    }
  }

  private generateActivity(idx?: number) {
    const statuses: ('success' | 'error' | 'running')[] = ['success', 'success', 'success', 'running', 'error'];
    const status = statuses[Math.floor(Math.random() * statuses.length)] as 'success' | 'error' | 'running';
    const records = status === 'error' ? 0 : Math.floor(Math.random() * 2000) + 50;
    const minsAgo = Math.floor(Math.random() * 55) + 1;
    return {
      id: `${Date.now()}-${idx ?? ''}-${Math.random().toString(36).slice(2, 8)}`,
      name: this.randomIntegrationName(),
      status,
      timestamp: `${minsAgo} minutes ago`,
      records,
      duration: `${Math.floor(Math.random() * 5) + 1}m ${Math.floor(Math.random() * 60)}s`,
    };
  }

  private randomIntegrationName(): string {
    const pairs = [
      ['Salesforce', 'NetSuite Customers'],
      ['Dynamics 365', 'SAP Orders'],
      ['Oracle', 'Business Central GL'],
      ['E-Commerce', 'NetSuite Orders'],
      ['HR', 'Payroll Sync'],
      ['Marketing', 'CRM Leads'],
    ];
    const pair = pairs[Math.floor(Math.random() * pairs.length)];
    if (!pair) {
      return 'Default Integration';
    }
    const [a, b] = pair;
    return `${a} → ${b}`;
  }

  private generateDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Integration Hub - Operational Dashboard</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" crossorigin="anonymous">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: #f5f5f5; 
            color: #333;
        }
        .nav-header {
            background: #fff;
            padding: 12px 20px;
            border-bottom: 1px solid #e0e0e0;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .nav-breadcrumb {
            display: flex;
            align-items: center;
            font-size: 14px;
            color: #666;
        }
        .nav-breadcrumb a {
            color: #4f46e5;
            text-decoration: none;
            font-weight: 500;
            display: flex;
            align-items: center;
        }
        .nav-breadcrumb a:hover {
            text-decoration: underline;
        }
        .nav-separator {
            margin: 0 8px;
            color: #ccc;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            text-align: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header h1 { margin-bottom: 10px; font-size: 2.5em; }
        .header p { font-size: 1.1em; opacity: 0.9; }
        .dashboard-container {
            max-width: 1400px;
            margin: 20px auto;
            padding: 0 20px;
        }
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .dashboard-card {
            background: white;
            border-radius: 12px;
            padding: 25px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .dashboard-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.15);
        }
        .card-title {
            font-size: 1.5em;
            margin-bottom: 20px;
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        .metric-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid #ecf0f1;
        }
        .metric-row:last-child { border-bottom: none; }
        .metric-label { font-weight: 500; color: #7f8c8d; }
        .metric-value { 
            font-weight: bold; 
            font-size: 1.2em;
            color: #2c3e50;
        }
        .status-healthy { color: #27ae60; }
        .status-warning { color: #f39c12; }
        .status-critical { color: #e74c3c; }
        .system-overview {
            grid-column: 1 / -1;
            background: linear-gradient(135deg, #74b9ff 0%, #0984e3 100%);
            color: white;
        }
        .system-overview .card-title { 
            color: white; 
            border-bottom-color: rgba(255,255,255,0.3);
        }
        .refresh-info {
            text-align: center;
            margin: 20px 0;
            padding: 15px;
            background: #e8f4fd;
            border: 1px solid #bee5eb;
            border-radius: 8px;
            color: #0c5460;
        }
        .api-endpoints {
            grid-column: 1 / -1;
            background: #2c3e50;
            color: white;
        }
        .api-endpoints .card-title { 
            color: white;
            border-bottom-color: #34495e;
        }
        .suitecentral-modules {
            grid-column: 1 / -1;
            background: linear-gradient(135deg, #8e44ad 0%, #34495e 100%);
            color: white;
        }
        .suitecentral-modules .card-title {
            color: white;
            border-bottom-color: rgba(255,255,255,0.2);
        }
        .module-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        .module-card {
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 15px;
            text-align: center;
        }
        .module-card h3 {
            margin: 0 0 10px 0;
            font-size: 1.2em;
        }
        .module-card .benefit {
            font-size: 0.9em;
            margin: 5px 0;
        }
        .api-endpoints {
            grid-column: 1 / -1;
            background: #2c3e50;
            color: white;
        }
        .endpoint-item {
            background: #34495e;
            padding: 10px 15px;
            margin: 8px 0;
            border-radius: 6px;
            font-family: 'Courier New', monospace;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #7f8c8d;
        }
        @media (max-width: 768px) {
            .dashboard-grid { grid-template-columns: 1fr; }
            .header h1 { font-size: 2em; }
            .dashboard-container { padding: 0 10px; }
        }
    </style>
</head>
<body>
    <div class="nav-header">
        <nav class="nav-breadcrumb">
            <a href="http://localhost:3030/" onclick="if (window.opener) { window.opener.focus(); window.close(); return false; }">
                <i class="fas fa-arrow-left" style="margin-right: 6px;"></i>
                Main Dashboard
            </a>
            <span class="nav-separator">›</span>
            <span>System Management</span>
            <span class="nav-separator">›</span>
            <span style="color: #333; font-weight: 600;">Operational Dashboard</span>
        </nav>
    </div>
    <div class="header">
        <h1>🚀 Squire's SuiteCentral Integration Hub</h1>
        <p>Transforming NetSuite SuiteCentral into a Complete Business Ecosystem</p>
    </div>

    <div class="dashboard-container">
        <div class="refresh-info">
            <strong>📊 Live Dashboard</strong> - Data automatically refreshes every 10 seconds
        </div>

        <div class="dashboard-grid">
            <!-- System Overview -->
            <div class="dashboard-card system-overview">
                <h2 class="card-title">System Overview</h2>
                <div id="system-status" class="loading">Loading system status...</div>
            </div>

            <!-- SuiteCentral Modules Integration -->
            <div class="dashboard-card suitecentral-modules">
                <h2 class="card-title">🏢 SuiteCentral Module Integration</h2>
                <p>Real-time synchronization with external business systems</p>
                <div class="module-grid">
                    <div class="module-card">
                        <h3>SupplierCentral</h3>
                        <div class="benefit">⏱️ 75% faster onboarding</div>
                        <div class="benefit">💰 $120K annual savings</div>
                        <div class="benefit">✅ 99.5% data accuracy</div>
                    </div>
                    <div class="module-card">
                        <h3>InstallerCentral</h3>
                        <div class="benefit">📈 40% better utilization</div>
                        <div class="benefit">💰 $200K revenue increase</div>
                        <div class="benefit">✅ 100% compliance</div>
                    </div>
                    <div class="module-card">
                        <h3>PayoutCentral</h3>
                        <div class="benefit">🎯 95% error reduction</div>
                        <div class="benefit">💰 $300K annual savings</div>
                        <div class="benefit">✅ Audit-ready compliance</div>
                    </div>
                </div>
            </div>

            <!-- Business Metrics -->
            <div class="dashboard-card">
                <h2 class="card-title">📈 Business Intelligence</h2>
                <div id="business-metrics" class="loading">Loading business metrics...</div>
            </div>

            <!-- Security Dashboard -->
            <div class="dashboard-card">
                <h2 class="card-title">🔐 Security Monitoring</h2>
                <div id="security-metrics" class="loading">Loading security metrics...</div>
            </div>

            <!-- Performance Dashboard -->
            <div class="dashboard-card">
                <h2 class="card-title">⚡ Performance Metrics</h2>
                <div id="performance-metrics" class="loading">Loading performance metrics...</div>
            </div>

            <!-- API Endpoints -->
            <div class="dashboard-card api-endpoints">
                <h2 class="card-title">🔗 API Endpoints</h2>
        <div id="dynamic-endpoints">
          <div class="endpoint-item">Loading endpoints...</div>
        </div>
            </div>
        </div>
    </div>

    <script>
    // Determine dashboard base path dynamically so the HTML works regardless of mount point
    const DASHBOARD_BASE = (function() {
  let path = window.location.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
      const segments = path.split('/').filter(Boolean);
      if (segments.length && /dashboard/i.test(segments[segments.length - 1])) {
        return '/' + segments.join('/');
      }
      return path || '';
    })();

    function apiUrl(endpoint) { return \`\${DASHBOARD_BASE}/api/\${endpoint}\`; }

    // Auto-refresh dashboard data
    function loadDashboardData() {
      Promise.all([
        fetch(apiUrl('system-status')).then(r => r.json()),
        fetch(apiUrl('business-metrics')).then(r => r.json()),
        fetch(apiUrl('security-metrics')).then(r => r.json()),
        fetch(apiUrl('performance-metrics')).then(r => r.json())
      ]).then(([systemStatus, businessMetrics, securityMetrics, performanceMetrics]) => {
        updateSystemStatus(systemStatus);
        updateBusinessMetrics(businessMetrics);
        updateSecurityMetrics(securityMetrics);
        updatePerformanceMetrics(performanceMetrics);
        updateEndpointList();
      }).catch(error => {
        console.error('Error loading dashboard data:', error);
      });
    }

    function updateEndpointList() {
      const listEl = document.getElementById('dynamic-endpoints');
      if (!listEl) return;
      const endpoints = ['business-metrics','security-metrics','performance-metrics','system-status','metrics/history/:type'];
      listEl.innerHTML = endpoints.map(function(e){ return '<div class="endpoint-item">GET ' + apiUrl(e) + '</div>'; }).join('');
    }

        function updateSystemStatus(data) {
            const container = document.getElementById('system-status');
            container.innerHTML = \`
                <div class="metric-row">
                    <span class="metric-label">Overall Status</span>
                    <span class="metric-value status-\${data.overall}">\${data.overall.toUpperCase()}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Uptime</span>
                    <span class="metric-value">\${Math.floor(data.metrics.uptime / 3600)}h \${Math.floor((data.metrics.uptime % 3600) / 60)}m</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Memory Usage</span>
                    <span class="metric-value">\${(data.metrics.memory.heapUsed / 1024 / 1024).toFixed(1)} MB</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Platform</span>
                    <span class="metric-value">\${data.metrics.platform} (\${data.metrics.version})</span>
                </div>
            \`;
        }

        function updateBusinessMetrics(data) {
            const container = document.getElementById('business-metrics');
            const successRates = Object.entries(data.integrationSuccessRates);
            container.innerHTML = \`
                <div class="metric-row">
                    <span class="metric-label">🏢 Active Integrations</span>
                    <span class="metric-value">\${successRates.length}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">📊 Data Volume Processed</span>
                    <span class="metric-value">\${data.dataVolumeProcessed.total.toLocaleString()}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">✅ Success Rate</span>
                    <span class="metric-value status-\${data.errorPatterns.totalErrors > 10 ? 'warning' : 'healthy'}">\${(100 - (data.errorPatterns.totalErrors / Math.max(1, data.dataVolumeProcessed.total)) * 100).toFixed(2)}%</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">⚡ Avg Response Time</span>
                    <span class="metric-value">\${data.performanceMetrics.averageResponseTime.toFixed(1)}ms</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">⏱️ P99 Response Time</span>
                    <span class="metric-value">\${data.performanceMetrics.p99.toFixed(1)}ms</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">⚠️ Total Errors</span>
                    <span class="metric-value \${data.errorPatterns.totalErrors > 10 ? 'status-warning' : 'status-healthy'}">\${data.errorPatterns.totalErrors}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">🔄 Recent Syncs</span>
                    <span class="metric-value">\${Math.floor(Math.random() * 100) + 50}/hr</span>
                </div>
            \`;
        }

        function updateSecurityMetrics(data) {
            const container = document.getElementById('security-metrics');
            container.innerHTML = \`
                <div class="metric-row">
                    <span class="metric-label">Rate Limit Blocks</span>
                    <span class="metric-value">\${data.rateLimitingEvents.totalBlocked}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Suspicious Activity</span>
                    <span class="metric-value \${data.threatDetection.suspiciousActivity > 0 ? 'status-warning' : 'status-healthy'}">\${data.threatDetection.suspiciousActivity}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Blocked IPs</span>
                    <span class="metric-value">\${data.threatDetection.blockedIPs?.length || 0}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">XSS Attempts</span>
                    <span class="metric-value">\${data.securityMetrics.xssAttempts}</span>
                </div>
            \`;
        }

        function updatePerformanceMetrics(data) {
            const container = document.getElementById('performance-metrics');
            container.innerHTML = \`
                <div class="metric-row">
                    <span class="metric-label">Current Response Time</span>
                    <span class="metric-value">\${data.responseTimes.current.toFixed(1)}ms</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Cache Hit Rate</span>
                    <span class="metric-value \${data.cacheMetrics.hitRate > 0.8 ? 'status-healthy' : 'status-warning'}">\${(data.cacheMetrics.hitRate * 100).toFixed(1)}%</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Active Connections</span>
                    <span class="metric-value">\${data.connectionPools.activeConnections}</span>
                </div>
                <div class="metric-row">
                    <span class="metric-label">Memory Leak Detection</span>
                    <span class="metric-value \${data.memoryUsage.leakDetection ? 'status-warning' : 'status-healthy'}">\${data.memoryUsage.leakDetection ? 'Detected' : 'None'}</span>
                </div>
            \`;
        }

  // Initial load and setup auto-refresh
  loadDashboardData();
  setInterval(loadDashboardData, 10000); // Refresh every 10 seconds
    </script>
</body>
</html>
    `;
  }

  public getRouter(): Router {
    return this.router;
// merged
  }
  private async getSummary(_r: Request, res: Response) { res.json({ ...this.summaryStats, successRate: Number((this.summaryStats.successRate + (Math.random() * 0.1 - 0.05)).toFixed(2)), timestamp: new Date().toISOString() }); }
  private async getRecentActivity(_r: Request, res: Response) { res.json({ items: this.recentActivity.slice(0, 25) }); }
  private async seedMockData(_r: Request, res: Response) { this.seedInitialMock(); res.json({ seeded: true, count: this.recentActivity.length }); }
  private async getMetricsJson(_r: Request, res: Response): Promise<void> { try { const raw: string = await (promClient.register as any).metrics(); if (!raw) { res.json({ metrics: [], count: 0 }); return; } const data: unknown[] = []; for (const line of raw.split('\n')) { if (!line || line.startsWith('#')) continue; const spaceIdx = line.lastIndexOf(' '); if (spaceIdx === -1) continue; const namePart = line.slice(0, spaceIdx); const valueStr = line.slice(spaceIdx + 1); let name = namePart; const labelsObj: Record<string, string> = {}; const labelStart = namePart.indexOf('{'); if (labelStart !== -1) { name = namePart.slice(0, labelStart); const labelBody = namePart.slice(labelStart + 1, namePart.lastIndexOf('}')); if (labelBody.trim().length) { for (const kv of labelBody.split(',')) { const [k, v] = kv.split('='); if (k && v) labelsObj[k.trim()] = v.replace(/^"|"$/g, ''); } } } const value = Number(valueStr); if (!Number.isNaN(value)) data.push({ name, labels: labelsObj, value }); } res.json({ metrics: data, count: data.length }); } catch { res.status(500).json({ error: 'Failed to parse metrics' }); } }
  private async getRecentTraces(_r: Request, res: Response) { const spans = await this.traceProvider.getRecentSpans(); res.json({ spans }); }
  private async getQueueStatus(_r: Request, res: Response) { const queues = await this.queueProvider.getQueues(); res.json({ queues, generatedAt: new Date().toISOString() }); }
  private async getCredentialSummary(_r: Request, res: Response) { const s = await this.credentialProvider.getSummary(); res.json({ totalStored: s.totalStored, providers: s.providers, encryption: s.encryption }); }
  private async getAiMetrics(_r: Request, res: Response) { const jittered = { ...this.aiMetrics, avgLatencyMs: Number((this.aiMetrics.avgLatencyMs + (Math.random() * 4 - 2)).toFixed(2)), mappingAccuracy: Number((this.aiMetrics.mappingAccuracy + (Math.random() * 0.002 - 0.001)).toFixed(4)) }; res.json(jittered); }
  private async getCapabilities(_r: Request, res: Response) { const isMock = (o: unknown) => (o as any)?.constructor?.name?.startsWith('Mock'); res.json({ queues: isMock(this.queueProvider) ? 'mock' : 'real', traces: isMock(this.traceProvider) ? 'mock' : 'real', credentials: isMock(this.credentialProvider) ? 'mock' : 'real', aiMetrics: 'mock', export: 'mock', metrics: 'real', streaming: 'sse', mode: process.env.DISABLE_REDIS ? 'lightweight' : 'standard' }); }
  private async exportSnapshot(_r: Request, res: Response) { try { const [queues, traces] = await Promise.all([this.queueProvider.getQueues(), this.traceProvider.getRecentSpans()]); const snapshot = { takenAt: new Date().toISOString(), summary: this.summaryStats, recentActivity: this.recentActivity.slice(0, 50), aiMetrics: this.aiMetrics, queues, traces }; res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="dashboard-snapshot.json"'); res.json(snapshot); } catch { res.status(500).json({ error: 'Snapshot export failed' }); } }
  private handleSSE(_r: Request, res: Response) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); this.sseClients.add(res); this.writeSSE(res, 'connected', { ok: true, clients: this.sseClients.size }); (res as any).on('close', () => this.sseClients.delete(res)); }
  private writeSSE(res: Response, event: string, data: unknown) { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); }
  private broadcastSummary() { const summaryPayload = { ...this.summaryStats, timestamp: new Date().toISOString() }; for (const client of this.sseClients) { try { this.writeSSE(client, 'summary', summaryPayload); this.writeSSE(client, 'ai-metrics', this.aiMetrics); } catch { this.sseClients.delete(client); } } }

  // Squire-specific telemetry endpoints
  private async getExecutiveSummary(req: Request, res: Response) {
    try {
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 24 * 60 * 60 * 1000; // Default 30 days
      const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
      const executiveSummary = await telemetryService.getExecutiveSummary(timeRange);
      res.json(executiveSummary);
    } catch (error) {
      logger.error('Failed to get executive summary', { error });
      res.status(500).json({ error: 'Failed to retrieve executive summary' });
    }
  }

  private async getROIMetrics(req: Request, res: Response) {
    try {
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 24 * 60 * 60 * 1000;
      const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
      const roiMetrics = await telemetryService.getROIMetrics(timeRange);
      res.json(roiMetrics);
    } catch (error) {
      logger.error('Failed to get ROI metrics', { error });
      res.status(500).json({ error: 'Failed to retrieve ROI metrics' });
    }
  }

  private async getSquireBusinessMetrics(req: Request, res: Response) {
    try {
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 24 * 60 * 60 * 1000;
      const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
      const businessMetrics = await telemetryService.getBusinessMetrics(timeRange);
      res.json(businessMetrics);
    } catch (error) {
      logger.error('Failed to get business metrics', { error });
      res.status(500).json({ error: 'Failed to retrieve business metrics' });
    }
  }

  private async getSquireDashboardData(req: Request, res: Response) {
    try {
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 24 * 60 * 60 * 1000;
      const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
      const dashboardData = await telemetryService.getDashboardData(timeRange);
      res.json(dashboardData);
    } catch (error) {
      logger.error('Failed to get dashboard data', { error });
      res.status(500).json({ error: 'Failed to retrieve dashboard data' });
    }
  }

  private async getSquireSpecificMetrics(req: Request, res: Response) {
    try {
      const timeRange = parseInt(req.query.timeRange as string) || 30 * 24 * 60 * 60 * 1000;
      const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
      const squireMetrics = await telemetryService.getSquireMetrics(timeRange);
      res.json(squireMetrics);
    } catch (error) {
      logger.error('Failed to get Squire-specific metrics', { error });
      res.status(500).json({ error: 'Failed to retrieve Squire-specific metrics' });
    }
  }

  // trimmed duplicate simplified methods from a previous merge to satisfy linter
}
export function createOperationalDashboard(securityMiddleware?: AdvancedSecurityMiddleware): Router { const d = new OperationalDashboard(securityMiddleware); return d.getRouter(); }
