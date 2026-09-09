import { getHeapStatistics } from 'node:v8';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { Logger } from '../utils/Logger';
import { env, serverConfig } from '../config';
import type { ObservabilityService } from '../observability';

// Heap-pressure thresholds, as a percentage of the V8 heap ceiling.
const HEAP_WARNING_PERCENT = 75;
const HEAP_CRITICAL_PERCENT = 90;

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
  /** `null` when the V8 ceiling could not be read; see `getHeapPressure`. */
  heapSizeLimit: number | null;
  /** `null` when the V8 ceiling could not be read. */
  heapSizeLimitMB: number | null;
  /**
   * heapUsed as a percentage of the V8 heap ceiling (`heap_size_limit`) — the
   * fraction of the heap the process can never exceed. This is deliberately not
   * a percentage of `heapTotal`: see `getHeapPressure`. `null` when the ceiling
   * could not be read, in which case `status` is `warning`.
   */
  heapLimitUtilizationPercent: number | null;
  /**
   * @deprecated Retained only so external consumers of `/health` that predate
   * `heapLimitUtilizationPercent` keep reading the field they were written
   * against. It is `heapUsed / heapTotal`, the elastic ratio this endpoint no
   * longer classifies on — a healthy compact process reports ~95% here — so it
   * must not be used for alerting. Use `heapLimitUtilizationPercent`, which is
   * measured against the V8 ceiling. No in-repository consumer reads this field;
   * it carries its original semantics unchanged so that restoring it cannot
   * silently redefine an existing external alert threshold.
   */
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
  integrationConfigurations?: HostedConfigurationHealth;
}

interface HostedConfigurationHealth {
  expectedCount: number;
  persistedCount: number;
  activeCount: number;
  inactiveDraftCount: number;
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
      heapLimitUtilizationPercent: memoryStatus.heapLimitUtilizationPercent,
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

/**
 * Classify JavaScript heap pressure against the V8 ceiling.
 *
 * `heapTotal` is elastic: V8 grows it on demand toward `heap_size_limit`, so
 * `heapUsed / heapTotal` describes how tightly the heap is currently sized, not
 * how close the process is to running out. A healthy compact process reports a
 * high ratio, which previously drove `/health` to `critical` and `/health/ready`
 * to 503 while using a low single-digit percentage of its actual ceiling.
 *
 * Both `/health` and `/health/ready` classify through this one function so their
 * thresholds cannot drift apart.
 */
function getHeapPressure(memUsage: NodeJS.MemoryUsage): {
  status: 'healthy' | 'warning' | 'critical';
  heapSizeLimit: number | null;
  heapLimitUtilizationPercent: number | null;
} {
  const heapSizeLimit = getHeapStatistics().heap_size_limit;

  // An unreadable ceiling reports `warning`, never `healthy`. Every comparison
  // against NaN is false, so falling through would classify a heap we cannot
  // measure as healthy — the one direction a probe must not fail in. `warning`
  // surfaces it on /health without pulling the process out of rotation, since
  // an unreadable diagnostic is not evidence of memory distress.
  if (!Number.isFinite(heapSizeLimit) || heapSizeLimit <= 0) {
    return { status: 'warning', heapSizeLimit: null, heapLimitUtilizationPercent: null };
  }

  // Classify on the exact ratio and round only for reporting: rounding first would
  // move the effective critical boundary to 90.5%, so a heap at 90.4% of the ceiling
  // would round to 90, fail `90 > 90`, and be classified `warning` rather than
  // `critical`. The consequential half is readiness: `warning` is not `critical`,
  // so the process would keep reporting ready while genuinely over the threshold.
  const utilization = (memUsage.heapUsed / heapSizeLimit) * 100;

  let status: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (utilization > HEAP_CRITICAL_PERCENT) {
    status = 'critical';
  } else if (utilization > HEAP_WARNING_PERCENT) {
    status = 'warning';
  }

  return { status, heapSizeLimit, heapLimitUtilizationPercent: Math.round(utilization) };
}

function getMemoryStatus(): MemoryStatus {
  const memUsage = process.memoryUsage();
  const { status, heapSizeLimit, heapLimitUtilizationPercent } = getHeapPressure(memUsage);

  return {
    status,
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
    heapSizeLimit,
    heapSizeLimitMB: heapSizeLimit === null ? null : Math.round(heapSizeLimit / 1024 / 1024 * 100) / 100,
    heapLimitUtilizationPercent,
    // Deprecated; original heapUsed/heapTotal semantics preserved verbatim.
    memoryUsagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
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

  const hostedConfigurationHealth = getHostedConfigurationHealth();
  const hostedConfigWarning = env.HOSTED_DEMO && (
    hostedConfigurationHealth === undefined
    || hostedConfigurationHealth.persistedCount < hostedConfigurationHealth.expectedCount
  );

  return {
    status: missingEnvVars.length === 0 && !hostedConfigWarning ? 'healthy' : 'warning',
    requiredEnvVars,
    missingEnvVars,
    configuredSystems,
    ...(hostedConfigurationHealth ? { integrationConfigurations: hostedConfigurationHealth } : {}),
  };
}

function getHostedConfigurationHealth(): HostedConfigurationHealth | undefined {
  if (!env.HOSTED_DEMO) return undefined;

  const values = [
    process.env.HOSTED_CONFIG_EXPECTED_COUNT,
    process.env.HOSTED_CONFIG_PERSISTED_COUNT,
    process.env.HOSTED_CONFIG_ACTIVE_COUNT,
    process.env.HOSTED_CONFIG_INACTIVE_DRAFT_COUNT,
  ].map(value => Number(value));
  if (values.some(value => !Number.isFinite(value) || value < 0)) return undefined;

  const [expectedCount, persistedCount, activeCount, inactiveDraftCount] = values;
  return { expectedCount, persistedCount, activeCount, inactiveDraftCount };
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

  // Check memory usage isn't critical, using the same classification as /health
  const memoryOk = getHeapPressure(process.memoryUsage()).status !== 'critical';
  const hostedConfigurationHealth = getHostedConfigurationHealth();
  const hostedConfigurationsOk = !env.HOSTED_DEMO
    || (hostedConfigurationHealth !== undefined
      && hostedConfigurationHealth.persistedCount >= hostedConfigurationHealth.expectedCount);

  return hasJwtSecret && hasValidJwtSecret && memoryOk && hostedConfigurationsOk;
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
