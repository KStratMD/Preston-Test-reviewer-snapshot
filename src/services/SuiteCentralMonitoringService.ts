import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import type { SuiteCentralConfigService } from './SuiteCentralConfigService';
import { TYPES } from '../inversify/types';
import { CryptoUtils } from '../utils/crypto';

export interface SuiteCentralHealthCheck {
  timestamp: Date;
  environmentId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number;
  availabilityScore: number;
  errors: {
    code: string;
    message: string;
    count: number;
  }[];
  metrics: {
    requestCount: number;
    successRate: number;
    averageLatency: number;
    peakLatency: number;
    throughput: number;
  };
}

export interface SuiteCentralAlert {
  id: string;
  environmentId: string;
  type: 'performance' | 'availability' | 'error_rate' | 'quota' | 'security';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  timestamp: Date;
  isResolved: boolean;
  resolvedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface SuiteCentralUsageMetrics {
  environmentId: string;
  period: {
    start: Date;
    end: Date;
  };
  requests: {
    total: number;
    successful: number;
    failed: number;
    byEndpoint: Record<string, number>;
    byMethod: Record<string, number>;
  };
  performance: {
    averageResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
  };
  errors: {
    statusCode: number;
    message: string;
    count: number;
    lastOccurred: Date;
  }[];
  quotaUsage: {
    daily: { used: number; limit: number; percentage: number };
    hourly: { used: number; limit: number; percentage: number };
  };
}

export interface SuiteCentralPerformanceInsight {
  environmentId: string;
  insight: string;
  impact: 'low' | 'medium' | 'high';
  recommendation: string;
  estimatedImprovement: string;
  implementationEffort: 'low' | 'medium' | 'high';
  category: 'performance' | 'reliability' | 'cost' | 'security';
}

/**
 * SuiteCentralMonitoringService provides comprehensive monitoring, alerting,
 * and performance insights for SuiteCentral connector operations.
 * 
 * Features:
 * - Real-time health monitoring
 * - Intelligent alerting with escalation
 * - Performance analytics and insights
 * - Usage tracking and quota management
 * - Proactive issue detection
 * - Automated remediation suggestions
 */
@injectable()
export class SuiteCentralMonitoringService {
  private healthChecks = new Map<string, SuiteCentralHealthCheck[]>();
  private alerts = new Map<string, SuiteCentralAlert>();
  private usageMetrics = new Map<string, SuiteCentralUsageMetrics>();
  private performanceInsights = new Map<string, SuiteCentralPerformanceInsight[]>();
  
  private monitoringIntervals = new Map<string, NodeJS.Timeout>();
  private alertThresholds = {
    responseTime: { warning: 2000, critical: 5000 },
    errorRate: { warning: 5, critical: 10 },
    availability: { warning: 95, critical: 90 },
    quotaUsage: { warning: 80, critical: 95 }
  };

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
    @inject(TYPES.SuiteCentralConfigService) private configService: SuiteCentralConfigService
  ) {
    this.initializeMonitoring();
    this.logger.info('SuiteCentralMonitoringService initialized');
  }

  // Health Monitoring
  async performHealthCheck(environmentId: string): Promise<SuiteCentralHealthCheck> {
    const environment = this.configService.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`Environment not found: ${environmentId}`);
    }

    const startTime = Date.now();
    const healthCheck: SuiteCentralHealthCheck = {
      timestamp: new Date(),
      environmentId,
      status: 'healthy',
      responseTime: 0,
      availabilityScore: 100,
      errors: [],
      metrics: {
        requestCount: 0,
        successRate: 100,
        averageLatency: 0,
        peakLatency: 0,
        throughput: 0
      }
    };

    try {
      // Simulate health check API call
      const mockResponseTime = Math.random() * 3000 + 100;
      await new Promise(resolve => setTimeout(resolve, mockResponseTime / 10)); // Simulated delay
      
      healthCheck.responseTime = mockResponseTime;
      healthCheck.metrics.averageLatency = mockResponseTime;

      // Determine health status based on response time and thresholds
      if (mockResponseTime > this.alertThresholds.responseTime.critical) {
        healthCheck.status = 'unhealthy';
        healthCheck.availabilityScore = 50;
      } else if (mockResponseTime > this.alertThresholds.responseTime.warning) {
        healthCheck.status = 'degraded';
        healthCheck.availabilityScore = 80;
      }

      // Simulate some metrics (in production, these would come from actual API responses)
      healthCheck.metrics.requestCount = Math.floor(Math.random() * 1000) + 100;
      healthCheck.metrics.successRate = Math.max(85, Math.random() * 15 + 85);
      healthCheck.metrics.throughput = healthCheck.metrics.requestCount / 60; // per minute
      healthCheck.metrics.peakLatency = mockResponseTime * (1 + Math.random() * 0.5);

      // Store health check result
      const checks = this.healthChecks.get(environmentId) || [];
      checks.push(healthCheck);
      
      // Keep only last 100 checks
      if (checks.length > 100) {
        checks.splice(0, checks.length - 100);
      }
      
      this.healthChecks.set(environmentId, checks);

      // Check for alert conditions
      await this.evaluateAlerts(environmentId, healthCheck);

      this.logger.debug('Health check completed', {
        environmentId,
        status: healthCheck.status,
        responseTime: healthCheck.responseTime
      });

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      healthCheck.status = 'unhealthy';
      healthCheck.availabilityScore = 0;
      healthCheck.errors.push({
        code: 'HEALTH_CHECK_FAILED',
        message: err.message,
        count: 1
      });

      this.logger.error('Health check failed', { environmentId, error });
    }

    return healthCheck;
  }

  getHealthHistory(environmentId: string, limit = 50): SuiteCentralHealthCheck[] {
    const checks = this.healthChecks.get(environmentId) || [];
    return checks.slice(-limit);
  }

  // Alert Management
  private async evaluateAlerts(environmentId: string, healthCheck: SuiteCentralHealthCheck): Promise<void> {
    const alerts: Omit<SuiteCentralAlert, 'id'>[] = [];

    // Response time alerts
    if (healthCheck.responseTime > this.alertThresholds.responseTime.critical) {
      alerts.push({
        environmentId,
        type: 'performance',
        severity: 'critical',
        title: 'Critical Response Time',
        description: `Response time (${healthCheck.responseTime}ms) exceeds critical threshold`,
        timestamp: new Date(),
        isResolved: false,
        metadata: { responseTime: healthCheck.responseTime, threshold: this.alertThresholds.responseTime.critical }
      });
    } else if (healthCheck.responseTime > this.alertThresholds.responseTime.warning) {
      alerts.push({
        environmentId,
        type: 'performance',
        severity: 'warning',
        title: 'High Response Time',
        description: `Response time (${healthCheck.responseTime}ms) exceeds warning threshold`,
        timestamp: new Date(),
        isResolved: false,
        metadata: { responseTime: healthCheck.responseTime, threshold: this.alertThresholds.responseTime.warning }
      });
    }

    // Availability alerts
    if (healthCheck.availabilityScore < this.alertThresholds.availability.critical) {
      alerts.push({
        environmentId,
        type: 'availability',
        severity: 'critical',
        title: 'Service Availability Critical',
        description: `Availability score (${healthCheck.availabilityScore}%) is critically low`,
        timestamp: new Date(),
        isResolved: false,
        metadata: { availabilityScore: healthCheck.availabilityScore }
      });
    }

    // Create alerts
    for (const alertData of alerts) {
      const alertId = await this.createAlert(alertData);
      this.logger.warn('Alert created', { alertId, type: alertData.type, severity: alertData.severity });
    }
  }

  async createAlert(alertData: Omit<SuiteCentralAlert, 'id'>): Promise<string> {
    const alertId = CryptoUtils.generateUUID();
    const alert: SuiteCentralAlert = {
      id: alertId,
      ...alertData
    };

    this.alerts.set(alertId, alert);

    // Send telemetry event
    try {
      // Create an audit event for the alert
      await this.telemetryService.recordEvent({
        id: CryptoUtils.generateUUID(),
        timestamp: Date.now(),
        type: 'AuditEvent',
        actor: 'SuiteCentralMonitoring',
        action: 'alert_created',
        resource: 'suite_central_alert',
        resourceId: alertId,
        piiTouched: false,
        ip: '127.0.0.1',
        userAgent: 'SuiteCentral-Monitor',
        outcome: 'success',
        metadata: {
          alertId,
          environmentId: alert.environmentId,
          alertType: alert.type,
          severity: alert.severity
        }
      });
    } catch (error) {
      this.logger.warn('Failed to record telemetry for alert', { alertId, error });
    }

    return alertId;
  }

  async resolveAlert(alertId: string, resolution?: string): Promise<boolean> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      return false;
    }

    alert.isResolved = true;
    alert.resolvedAt = new Date();
    if (resolution) {
      alert.metadata.resolution = resolution;
    }

    this.alerts.set(alertId, alert);

    this.logger.info('Alert resolved', { alertId, resolution });
    return true;
  }

  getActiveAlerts(environmentId?: string): SuiteCentralAlert[] {
    const allAlerts = Array.from(this.alerts.values());
    let filtered = allAlerts.filter(alert => !alert.isResolved);
    
    if (environmentId) {
      filtered = filtered.filter(alert => alert.environmentId === environmentId);
    }

    return filtered.sort((a, b) => {
      // Sort by severity (critical first) then by timestamp
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      return severityDiff !== 0 ? severityDiff : b.timestamp.getTime() - a.timestamp.getTime();
    });
  }

  // Usage Analytics
  async recordUsageMetrics(environmentId: string, metrics: {
    endpoint: string;
    method: string;
    statusCode: number;
    responseTime: number;
    timestamp: Date;
  }): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const existing = this.usageMetrics.get(environmentId);
    const usage: SuiteCentralUsageMetrics = existing || {
      environmentId,
      period: { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) },
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        byEndpoint: {},
        byMethod: {}
      },
      performance: {
        averageResponseTime: 0,
        p50ResponseTime: 0,
        p95ResponseTime: 0,
        p99ResponseTime: 0
      },
      errors: [],
      quotaUsage: {
        daily: { used: 0, limit: 10000, percentage: 0 },
        hourly: { used: 0, limit: 500, percentage: 0 }
      }
    };

    // Update request counts
    usage.requests.total++;
    usage.requests.byEndpoint[metrics.endpoint] = (usage.requests.byEndpoint[metrics.endpoint] || 0) + 1;
    usage.requests.byMethod[metrics.method] = (usage.requests.byMethod[metrics.method] || 0) + 1;

    if (metrics.statusCode >= 200 && metrics.statusCode < 400) {
      usage.requests.successful++;
    } else {
      usage.requests.failed++;
      
      // Record error
      const existingError = usage.errors.find(e => e.statusCode === metrics.statusCode);
      if (existingError) {
        existingError.count++;
        existingError.lastOccurred = metrics.timestamp;
      } else {
        usage.errors.push({
          statusCode: metrics.statusCode,
          message: `HTTP ${metrics.statusCode}`,
          count: 1,
          lastOccurred: metrics.timestamp
        });
      }
    }

    // Update performance metrics (simplified calculation)
    const totalRequests = usage.requests.total;
    usage.performance.averageResponseTime = 
      (usage.performance.averageResponseTime * (totalRequests - 1) + metrics.responseTime) / totalRequests;

    // Update quota usage
    usage.quotaUsage.daily.used = usage.requests.total;
    usage.quotaUsage.daily.percentage = (usage.requests.total / usage.quotaUsage.daily.limit) * 100;

    this.usageMetrics.set(environmentId, usage);

    // Check for quota alerts
    if (usage.quotaUsage.daily.percentage > this.alertThresholds.quotaUsage.warning) {
      const severity = usage.quotaUsage.daily.percentage > this.alertThresholds.quotaUsage.critical ? 'critical' : 'warning';
      
      await this.createAlert({
        environmentId,
        type: 'quota',
        severity,
        title: 'Daily Quota Usage High',
        description: `Daily quota usage is at ${usage.quotaUsage.daily.percentage.toFixed(1)}%`,
        timestamp: new Date(),
        isResolved: false,
        metadata: { quotaUsage: usage.quotaUsage.daily }
      });
    }
  }

  getUsageMetrics(environmentId: string): SuiteCentralUsageMetrics | null {
    return this.usageMetrics.get(environmentId) || null;
  }

  // Performance Insights
  async generatePerformanceInsights(environmentId: string): Promise<SuiteCentralPerformanceInsight[]> {
    const usage = this.usageMetrics.get(environmentId);
    const healthChecks = this.healthChecks.get(environmentId) || [];
    
    if (!usage || healthChecks.length === 0) {
      return [];
    }

    const insights: SuiteCentralPerformanceInsight[] = [];

    // Response time analysis
    if (usage.performance.averageResponseTime > 2000) {
      insights.push({
        environmentId,
        insight: 'Average response time is above optimal threshold',
        impact: 'high',
        recommendation: 'Consider implementing request caching or optimizing API queries',
        estimatedImprovement: '30-50% response time reduction',
        implementationEffort: 'medium',
        category: 'performance'
      });
    }

    // Error rate analysis
    const errorRate = (usage.requests.failed / usage.requests.total) * 100;
    if (errorRate > 5) {
      insights.push({
        environmentId,
        insight: `Error rate is ${errorRate.toFixed(1)}%, above recommended threshold`,
        impact: 'high',
        recommendation: 'Review error patterns and implement retry logic with exponential backoff',
        estimatedImprovement: '60-80% error reduction',
        implementationEffort: 'low',
        category: 'reliability'
      });
    }

    // Usage pattern analysis
    const topEndpoint = Object.entries(usage.requests.byEndpoint)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (topEndpoint && topEndpoint[1] > usage.requests.total * 0.5) {
      insights.push({
        environmentId,
        insight: `${topEndpoint[0]} accounts for ${((topEndpoint[1] / usage.requests.total) * 100).toFixed(1)}% of all requests`,
        impact: 'medium',
        recommendation: 'Consider implementing dedicated caching or rate limiting for this endpoint',
        estimatedImprovement: '20-30% overall performance improvement',
        implementationEffort: 'low',
        category: 'performance'
      });
    }

    // Quota efficiency analysis
    if (usage.quotaUsage.daily.percentage > 70) {
      insights.push({
        environmentId,
        insight: 'Daily quota usage is approaching limits',
        impact: 'medium',
        recommendation: 'Implement request batching or consider upgrading quota limits',
        estimatedImprovement: '40-60% quota efficiency improvement',
        implementationEffort: 'medium',
        category: 'cost'
      });
    }

    this.performanceInsights.set(environmentId, insights);
    return insights;
  }

  getPerformanceInsights(environmentId: string): SuiteCentralPerformanceInsight[] {
    return this.performanceInsights.get(environmentId) || [];
  }

  // Monitoring Lifecycle
  startMonitoring(environmentId: string, intervalMs = 300000): void {
    // Stop existing monitoring if running
    this.stopMonitoring(environmentId);

    const interval = setInterval(async () => {
      try {
        await this.performHealthCheck(environmentId);
        
        // Generate insights periodically
        if (Date.now() % (intervalMs * 4) === 0) {
          await this.generatePerformanceInsights(environmentId);
        }
      } catch (error) {
        this.logger.error('Monitoring interval error', { environmentId, error });
      }
    }, intervalMs);

    this.monitoringIntervals.set(environmentId, interval);
    this.logger.info('Started monitoring', { environmentId, intervalMs });
  }

  stopMonitoring(environmentId: string): void {
    const interval = this.monitoringIntervals.get(environmentId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(environmentId);
      this.logger.info('Stopped monitoring', { environmentId });
    }
  }

  // Dashboard Data
  async getMonitoringDashboard(environmentId: string): Promise<{
    health: {
      current: SuiteCentralHealthCheck | null;
      history: SuiteCentralHealthCheck[];
      trend: 'improving' | 'stable' | 'degrading';
    };
    alerts: {
      active: SuiteCentralAlert[];
      recentResolved: SuiteCentralAlert[];
      summary: Record<string, number>;
    };
    usage: SuiteCentralUsageMetrics | null;
    insights: SuiteCentralPerformanceInsight[];
  }> {
    const healthHistory = this.getHealthHistory(environmentId, 50);
    const currentHealth = healthHistory[healthHistory.length - 1] || null;
    
    // Determine health trend
    let trend: 'improving' | 'stable' | 'degrading' = 'stable';
    if (healthHistory.length >= 10) {
      const recent = healthHistory.slice(-10);
      const older = healthHistory.slice(-20, -10);
      
      const recentAvg = recent.reduce((sum, h) => sum + h.responseTime, 0) / recent.length;
      const olderAvg = older.reduce((sum, h) => sum + h.responseTime, 0) / older.length;
      
      if (recentAvg < olderAvg * 0.9) trend = 'improving';
      else if (recentAvg > olderAvg * 1.1) trend = 'degrading';
    }

    const activeAlerts = this.getActiveAlerts(environmentId);
    const allAlerts = Array.from(this.alerts.values())
      .filter(alert => alert.environmentId === environmentId);
    const recentResolved = allAlerts
      .filter(alert => alert.isResolved && alert.resolvedAt && 
        alert.resolvedAt > new Date(Date.now() - 24 * 60 * 60 * 1000))
      .sort((a, b) => (b.resolvedAt?.getTime() || 0) - (a.resolvedAt?.getTime() || 0))
      .slice(0, 10);

    const alertSummary = allAlerts.reduce((acc, alert) => {
      const key = `${alert.type}_${alert.severity}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      health: {
        current: currentHealth,
        history: healthHistory,
        trend
      },
      alerts: {
        active: activeAlerts,
        recentResolved,
        summary: alertSummary
      },
      usage: this.getUsageMetrics(environmentId),
      insights: this.getPerformanceInsights(environmentId)
    };
  }

  private initializeMonitoring(): void {
    // Start monitoring for all configured environments
    const environments = this.configService.getAllEnvironments();
    for (const env of environments) {
      if (env.monitoring.enableHealthCheck) {
        this.startMonitoring(env.id, env.monitoring.healthCheckInterval);
      }
    }

    this.logger.info('Initialized monitoring for environments', { count: environments.length });
  }

  // Cleanup on shutdown
  shutdown(): void {
    for (const [environmentId] of this.monitoringIntervals) {
      this.stopMonitoring(environmentId);
    }
    this.logger.info('SuiteCentralMonitoringService shutdown complete');
  }
}

export default SuiteCentralMonitoringService;