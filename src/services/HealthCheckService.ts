import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/Logger';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { integrationCache, responseCache, configCache, distributedCache } from '../services/AdvancedCache';
import { requestOptimizer } from '../middleware/RequestOptimizer';

export type HealthCheckDetail = {
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  responseTime?: number;
  details?: unknown;
};

export type HealthChecks = {
  [key: string]: HealthCheckDetail;
};

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  environment: string;
  checks: HealthChecks;
  metrics: {
    performance: unknown;
    cache: unknown;
    optimization: unknown;
  };
}

export interface DeploymentConfig {
  version: string;
  environment: 'development' | 'staging' | 'production';
  features: {
    [key: string]: boolean;
  };
  limits: {
    maxConnections: number;
    requestTimeout: number;
    memoryLimit: number;
    cpuLimit: number;
  };
  monitoring: {
    enableMetrics: boolean;
    enableTracing: boolean;
    enableProfiling: boolean;
    metricsInterval: number;
  };
  cache: {
    enabled: boolean;
    maxSize: number;
    defaultTTL: number;
  };
  security: {
    enableRateLimit: boolean;
    enableCORS: boolean;
    enableHelmet: boolean;
    trustedProxies: string[];
  };
}

export class HealthCheckService {
  private startTime: number;
  private version: string;
  private environment: string;
  private deploymentConfig: DeploymentConfig;

  constructor(deploymentConfig: DeploymentConfig) {
    this.startTime = Date.now();
    this.version = deploymentConfig.version;
    this.environment = deploymentConfig.environment;
    this.deploymentConfig = deploymentConfig;
  }

  public createHealthCheckMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/health' || req.path === '/health/live') {
        return this.handleLivenessCheck(req, res);
      }
      
      if (req.path === '/health/ready') {
        return this.handleReadinessCheck(req, res);
      }
      
      if (req.path === '/health/detailed') {
        return this.handleDetailedHealthCheck(req, res);
      }

      next();
    };
  }

  private async handleLivenessCheck(req: Request, res: Response): Promise<void> {
    // Basic liveness check - just verify the service is running
    const result = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime: Date.now() - this.startTime
    };

    res.status(200).json(result);
  }

  private async handleReadinessCheck(req: Request, res: Response): Promise<void> {
    // Readiness check - verify service is ready to handle requests
    const checks = await this.performReadinessChecks();
    const overallStatus = this.determineOverallStatus(checks);

    const result = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: this.version,
      checks
    };

    const statusCode = overallStatus === 'healthy' ? 200 : 503;
    res.status(statusCode).json(result);
  }

  private async handleDetailedHealthCheck(req: Request, res: Response): Promise<void> {
    const startTime = performance.now();
    
    try {
      const checks = await this.performAllHealthChecks();
      const overallStatus = this.determineOverallStatus(checks);
      
      const result: HealthCheckResult = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        version: this.version,
        uptime: Date.now() - this.startTime,
        environment: this.environment,
        checks,
        metrics: {
          performance: performanceMonitor.getPerformanceReport(),
          cache: this.getCacheMetrics(),
          optimization: requestOptimizer.getOptimizationReport()
        }
      };

      const responseTime = performance.now() - startTime;
      res.set('X-Health-Check-Duration', `${responseTime.toFixed(2)}ms`);
      
      const statusCode = overallStatus === 'healthy' ? 200 : 
                        overallStatus === 'degraded' ? 200 : 503;
      
      res.status(statusCode).json(result);
      
    } catch (error) {
      logger.error('Health check failed', { error: (error as Error).message });
      
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Health check system failure',
        message: (error as Error).message
      });
    }
  }

  private async performReadinessChecks(): Promise<HealthChecks> {
    const checks: HealthChecks = {};

    // Check memory usage
    const memUsage = process.memoryUsage();
    const memoryUtilization = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    checks.memory = {
      status: memoryUtilization < 85 ? 'pass' : memoryUtilization < 95 ? 'warn' : 'fail',
      message: `Memory utilization: ${memoryUtilization.toFixed(1)}%`,
      details: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        utilization: memoryUtilization
      }
    };

    // Check cache health
    const cacheHealth = integrationCache.getHealth();
    checks.cache = {
      status: (cacheHealth as any).status === 'healthy' ? 'pass' : 'warn',
      message: `Cache hit rate: ${(cacheHealth as any).hitRate.toFixed(1)}%`,
      details: cacheHealth
    };

    return checks;
  }

  private async performAllHealthChecks(): Promise<HealthChecks> {
    const checks: HealthChecks = {};
    const checkPromises: Promise<void>[] = [];

    // Memory check
    checkPromises.push(this.checkMemory().then(result => {
      checks.memory = result;
    }));

    // CPU check
    checkPromises.push(this.checkCPU().then(result => {
      checks.cpu = result;
    }));

    // Cache checks
    checkPromises.push(this.checkCaches().then(result => {
      checks.cache = result;
    }));

    // Performance check
    checkPromises.push(this.checkPerformance().then(result => {
      checks.performance = result;
    }));

    // Database connectivity (if applicable)
    checkPromises.push(this.checkDatabase().then(result => {
      checks.database = result;
    }));

    // External dependencies
    checkPromises.push(this.checkExternalDependencies().then(result => {
      checks.external = result;
    }));

    // Feature flags
    checkPromises.push(this.checkFeatureFlags().then(result => {
      checks.features = result;
    }));

    await Promise.all(checkPromises);
    return checks;
  }

  private async checkMemory(): Promise<HealthCheckDetail> {
    const memUsage = process.memoryUsage();
    const memoryUtilization = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    const rssUtilization = (memUsage.rss / (1024 * 1024 * 1024)) * 100; // GB

    let status: 'pass' | 'warn' | 'fail' = 'pass';
    let message = `Memory utilization: ${memoryUtilization.toFixed(1)}%`;

    if (memoryUtilization > 95 || rssUtilization > this.deploymentConfig.limits.memoryLimit) {
      status = 'fail';
      message += ' - Critical memory usage';
    } else if (memoryUtilization > 85) {
      status = 'warn';
      message += ' - High memory usage';
    }

    return {
      status,
      message,
      responseTime: 1, // Memory check is instant
      details: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
        utilization: memoryUtilization,
        rssGB: rssUtilization
      }
    };
  }

  private async checkCPU(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    const cpuUsage = process.cpuUsage();
    
    // Simple CPU check - in production you'd want more sophisticated monitoring
    const totalUsage = cpuUsage.user + cpuUsage.system;
    const cpuPercent = Math.min(100, (totalUsage / 1000000) * 100);

    let status: 'pass' | 'warn' | 'fail' = 'pass';
    let message = `CPU usage: ${cpuPercent.toFixed(1)}%`;

    if (cpuPercent > this.deploymentConfig.limits.cpuLimit) {
      status = 'fail';
      message += ' - Critical CPU usage';
    } else if (cpuPercent > 70) {
      status = 'warn';
      message += ' - High CPU usage';
    }

    return {
      status,
      message,
      responseTime: performance.now() - startTime,
      details: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        percent: cpuPercent
      }
    };
  }

  private async checkCaches(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    
    const caches = {
      integration: integrationCache.getHealth(),
      response: responseCache.getHealth(),
      config: configCache.getHealth(),
      distributed: distributedCache.getHealth()
    };

    const allHealthy = Object.values(caches).every(cache => (cache as any).status === 'healthy');
    const anyDegraded = Object.values(caches).some(cache => (cache as any).status === 'degraded');

    let status: 'pass' | 'warn' | 'fail' = 'pass';
    let message = 'All caches operational';

    if (!allHealthy && anyDegraded) {
      status = 'warn';
      message = 'Some caches degraded';
    } else if (!allHealthy) {
      status = 'fail';
      message = 'Cache system issues detected';
    }

    return {
      status,
      message,
      responseTime: performance.now() - startTime,
      details: caches
    };
  }

  private async checkPerformance(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    const perfReport = performanceMonitor.getPerformanceReport();

    let status: 'pass' | 'warn' | 'fail' = 'pass';
    const message = `Performance status: ${(perfReport as any).status}`;

    if ((perfReport as any).status === 'critical') {
      status = 'fail';
    } else if ((perfReport as any).status === 'warning') {
      status = 'warn';
    }

    return {
      status,
      message,
      responseTime: performance.now() - startTime,
      details: perfReport
    };
  }

  private async checkDatabase(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    
    // Placeholder for database connectivity check
    // In a real implementation, you'd test actual database connections
    
    return {
      status: 'pass' as const,
      message: 'Database connectivity not configured',
      responseTime: performance.now() - startTime,
      details: {
        note: 'No database connections configured for this service'
      }
    };
  }

  private async checkExternalDependencies(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    
    // Check external service connectivity
    const dependencies = [
      { name: 'Salesforce API', url: 'https://login.salesforce.com', timeout: 5000 },
      { name: 'NetSuite API', url: 'https://system.netsuite.com', timeout: 5000 }
    ];

    const results = await Promise.allSettled(
      dependencies.map(async (dep) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), dep.timeout);
          
          const response = await fetch(dep.url, {
            method: 'HEAD',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          return {
            name: dep.name,
            status: response.ok ? 'pass' : 'warn',
            responseTime: performance.now() - startTime
          };
        } catch (error) {
          return {
            name: dep.name,
            status: 'fail' as const,
            error: (error as Error).message,
            responseTime: performance.now() - startTime
          };
        }
      })
    );

    const dependencyResults = results.map((result, index) => ({
      ...(result.status === 'fulfilled' ? result.value : { status: 'fail', error: 'Check failed', name: dependencies[index]?.name || 'unknown' })
    }));

    const allPass = dependencyResults.every(dep => dep.status === 'pass');
    const anyFail = dependencyResults.some(dep => dep.status === 'fail');

    let status: 'pass' | 'warn' | 'fail' = 'pass';
    let message = 'All external dependencies accessible';

    if (anyFail) {
      status = 'fail';
      message = 'Some external dependencies unreachable';
    } else if (!allPass) {
      status = 'warn';
      message = 'Some external dependencies degraded';
    }

    return {
      status,
      message,
      responseTime: performance.now() - startTime,
      details: dependencyResults
    };
  }

  private async checkFeatureFlags(): Promise<HealthCheckDetail> {
    const startTime = performance.now();
    
    const features = this.deploymentConfig.features;
    const enabledFeatures = Object.entries(features).filter(([, enabled]) => enabled);
    
    return {
      status: 'pass' as const,
      message: `${enabledFeatures.length} features enabled`,
      responseTime: performance.now() - startTime,
      details: {
        enabled: enabledFeatures.map(([name]) => name),
        total: Object.keys(features).length
      }
    };
  }

  private determineOverallStatus(checks: HealthChecks): 'healthy' | 'degraded' | 'unhealthy' {
    const statuses = Object.values(checks).map((check) => check.status);
    
    if (statuses.includes('fail')) {
      return 'unhealthy';
    }
    
    if (statuses.includes('warn')) {
      return 'degraded';
    }
    
    return 'healthy';
  }

  private getCacheMetrics(): Record<string, unknown> {
    return {
      integration: integrationCache.getStats(),
      response: responseCache.getStats(),
      config: configCache.getStats(),
      distributed: distributedCache.getStats()
    };
  }

  public getDeploymentInfo(): Record<string, unknown> {
    return {
      version: this.version,
      environment: this.environment,
      startTime: new Date(this.startTime).toISOString(),
      uptime: Date.now() - this.startTime,
      config: {
        features: this.deploymentConfig.features,
        limits: this.deploymentConfig.limits,
        monitoring: this.deploymentConfig.monitoring
      }
    };
  }
}

// Default deployment configuration
export const defaultDeploymentConfig: DeploymentConfig = {
  version: process.env.APP_VERSION || '1.0.0',
  environment: (process.env.NODE_ENV as any) || 'development',
  features: {
    advancedCaching: true,
    requestOptimization: true,
    performanceMonitoring: true,
    rateLimiting: true,
    compression: true,
    batchProcessing: true,
    predictivePrefetch: true
  },
  limits: {
    maxConnections: parseInt(process.env.MAX_CONNECTIONS || '1000'),
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
    memoryLimit: parseInt(process.env.MEMORY_LIMIT_GB || '2'),
    cpuLimit: parseInt(process.env.CPU_LIMIT_PERCENT || '80')
  },
  monitoring: {
    enableMetrics: process.env.ENABLE_METRICS !== 'false',
    enableTracing: process.env.ENABLE_TRACING === 'true',
    enableProfiling: process.env.ENABLE_PROFILING === 'true',
    metricsInterval: parseInt(process.env.METRICS_INTERVAL || '10000')
  },
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    maxSize: parseInt(process.env.CACHE_MAX_SIZE || '104857600'), // 100MB
    defaultTTL: parseInt(process.env.CACHE_DEFAULT_TTL || '3600000') // 1 hour
  },
  security: {
    enableRateLimit: process.env.RATE_LIMIT_ENABLED !== 'false',
    enableCORS: process.env.CORS_ENABLED !== 'false',
    enableHelmet: process.env.HELMET_ENABLED !== 'false',
    trustedProxies: (process.env.TRUSTED_PROXIES || '').split(',').filter(Boolean)
  }
};

// Global health check service
export const healthCheckService = new HealthCheckService(defaultDeploymentConfig);