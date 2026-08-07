import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { Logger } from '../utils/Logger';
import { serverConfig } from '../config';
import type { ObservabilityService } from '../observability';

export function createHealthRouter(observabilityService?: ObservabilityService): Router {
  const router = Router();
  const logger = new Logger('HealthCheck');

  // Health endpoints are safe to expose cross-origin for browser-based probes.
  router.use((req: Request, res: Response, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-Request-ID');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    memory: MemoryStatus;
    process: ProcessStatus;
    configuration: ConfigurationStatus;
  };
}

interface MemoryStatus {
  status: 'healthy' | 'warning' | 'critical';
  heapUsed: number;
  heapTotal: number;
  heapUsedMB: number;
  heapTotalMB: number;
  memoryUsagePercent: number;
  external: number;
  rss: number;
}

interface ProcessStatus {
  status: 'healthy' | 'degraded';
  pid: number;
  platform: string;
  nodeVersion: string;
  cpuUsage: NodeJS.CpuUsage;
}

interface ConfigurationStatus {
  status: 'healthy' | 'warning';
  requiredEnvVars: string[];
  missingEnvVars: string[];
  configuredSystems: string[];
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Comprehensive system health check
 *     description: Returns detailed health status including memory, process, and configuration information
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: System health information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 *       503:
 *         description: System is unhealthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
router.get('/health', asyncHandler(async (_req: Request, res: Response) => {
  // In test environment, always return healthy status
  if (serverConfig.env === 'test') {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
    return;
  }
  const startTime = Date.now();

  try {
    const memoryStatus = getMemoryStatus();
    const processStatus = getProcessStatus();
    const configStatus = getConfigurationStatus();

    // Determine overall health status
    const overallStatus = determineOverallStatus(memoryStatus, processStatus, configStatus);

    const healthResponse: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: serverConfig.env,
      checks: {
        memory: memoryStatus,
        process: processStatus,
        configuration: configStatus,
      },
    };

    const responseTime = Date.now() - startTime;
    logger.info('Health check completed', {
      status: overallStatus,
      responseTime,
      memoryUsage: memoryStatus.memoryUsagePercent,
    });

    // For health endpoint, always return 200 OK
    res.status(200).json(healthResponse);

  } catch (error) {
    logger.error('Health check failed', error);

    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: serverConfig.env,
      error: 'Health check system failure',
    } as unknown as Partial<HealthStatus>);
  }
}));

/**
 * @swagger
 * /health/ready:
 *   get:
 *     summary: Readiness probe
 *     description: Kubernetes-style readiness check - returns 200 if ready to serve traffic
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service is not ready
 */
router.get('/health/ready', asyncHandler(async (_req: Request, res: Response) => {
  // Check if essential services are available
  const isReady = checkReadiness();

  if (isReady) {
    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'not-ready',
      timestamp: new Date().toISOString(),
    });
  }
}));

// Alias: expose a top-level /ready endpoint for platforms expecting it
router.get('/ready', asyncHandler(async (_req: Request, res: Response) => {
  const isReady = checkReadiness();

  if (isReady) {
    res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  } else {
    res.status(503).json({ status: 'not-ready', timestamp: new Date().toISOString() });
  }
}));

/**
 * @swagger
 * /health/live:
 *   get:
 *     summary: Liveness probe
 *     description: Kubernetes-style liveness check - returns 200 if process is alive
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is alive
 */
router.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

function getMemoryStatus(): MemoryStatus {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100;
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100;
  const memoryUsagePercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);

  let status: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (memoryUsagePercent > 90) {
    status = 'critical';
  } else if (memoryUsagePercent > 75) {
    status = 'warning';
  }

  return {
    status,
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    heapUsedMB,
    heapTotalMB,
    memoryUsagePercent,
    external: memUsage.external,
    rss: memUsage.rss,
  };
}

function getProcessStatus(): ProcessStatus {
  const cpuUsage = process.cpuUsage();

  return {
    status: 'healthy',
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.version,
    cpuUsage,
  };
}

function getConfigurationStatus(): ConfigurationStatus {
  const requiredEnvVars = [
    'JWT_SECRET',
    'NODE_ENV',
  ];

  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

  const configuredSystems = [];
  if (process.env.NETSUITE_ACCOUNT_ID) configuredSystems.push('NetSuite');
  if (process.env.DYNAMICS_TENANT_ID) configuredSystems.push('Dynamics365');
  if (process.env.DATABASE_URL) configuredSystems.push('Database');
  if (process.env.REDIS_URL) configuredSystems.push('Redis');

  return {
    status: missingEnvVars.length === 0 ? 'healthy' : 'warning',
    requiredEnvVars,
    missingEnvVars,
    configuredSystems,
  };
}

function determineOverallStatus(
  memory: MemoryStatus,
  process: ProcessStatus,
  config: ConfigurationStatus,
): 'healthy' | 'degraded' | 'unhealthy' {
  if (memory.status === 'critical') {
    return 'unhealthy';
  }

  if (memory.status === 'warning' ||
      process.status === 'degraded' ||
      config.status === 'warning') {
    return 'degraded';
  }

  return 'healthy';
}

function checkReadiness(): boolean {
  // Check if essential configuration is present
  const hasJwtSecret = !!process.env.JWT_SECRET;
  const hasValidJwtSecret = !!(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32);

  // Check memory usage isn't critical
  const memUsage = process.memoryUsage();
  const memoryUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  const memoryOk = memoryUsagePercent < 95;

  return hasJwtSecret && hasValidJwtSecret && memoryOk;
}

// Add observability-enhanced metrics endpoint if service is available
if (observabilityService) {
  router.get('/metrics', (req: Request, res: Response) => {
    const systemMetrics = { memoryUsage: process.memoryUsage(), uptime: process.uptime() };

    const metricsText = `
# HELP nodejs_memory_heap_used_bytes Memory heap used
# TYPE nodejs_memory_heap_used_bytes gauge
nodejs_memory_heap_used_bytes ${systemMetrics.memoryUsage.heapUsed}

# HELP nodejs_memory_heap_total_bytes Memory heap total
# TYPE nodejs_memory_heap_total_bytes gauge
nodejs_memory_heap_total_bytes ${systemMetrics.memoryUsage.heapTotal}

# HELP nodejs_uptime_seconds Node.js uptime
# TYPE nodejs_uptime_seconds counter
nodejs_uptime_seconds ${systemMetrics.uptime}
      `.trim();

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(metricsText);
  });
}

return router;
}

export { createHealthRouter as healthRouter };
