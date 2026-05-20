import { Router, type Request, type Response } from 'express';
import { logger } from '../utils/Logger';
import { sendError } from '../utils/errorResponse';
import { getDistributedCache } from '../utils/DistributedCache';
import type { AdvancedSecurityMiddleware } from '../middleware/advancedSecurity';
import os from 'os';

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  memory: { usage: number; status: string };
  cpu: { usage: number; status: string };
  cache: { status: string };
  security: { threats: number; status: string };
}

export class OperationalDashboard {
  private readonly router: Router;
  private readonly securityMiddleware?: AdvancedSecurityMiddleware;

  constructor(securityMiddleware?: AdvancedSecurityMiddleware) {
    this.router = Router();
    this.securityMiddleware = securityMiddleware;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.router.get('/health', this.getHealth.bind(this));
    this.router.get('/dashboard', this.getDashboardHTML.bind(this));
    this.router.get('/metrics', this.getMetrics.bind(this));
    this.router.post('/cache/clear', this.clearCache.bind(this));
  }

  private async getHealth(_req: Request, res: Response): Promise<void> {
    try {
      const memUsage = process.memoryUsage();
      const totalMem = os.totalmem();
      const memoryUsage = ((memUsage.rss / totalMem) * 100);
      const cpus = os.cpus();
      const load = os.loadavg();
      let cpuUsage = 0;
      if (load && load.length > 0 && cpus && cpus.length > 0) {
        const cpu = cpus[0];
        if (cpu && cpu.times && cpu.times.user && load[0] !== undefined) {
          cpuUsage = load[0] / cpu.times.user * 100;
        }
      }

      const cacheHealth = await getDistributedCache().getHealth();
      const securityMetrics = this.securityMiddleware?.getMetrics();

      const health: SystemHealth = {
        status: memoryUsage > 85 || cpuUsage > 80 ? 'unhealthy' : 'healthy',
        timestamp: new Date().toISOString(),
        memory: {
          usage: memoryUsage,
          status: memoryUsage > 85 ? 'unhealthy' : 'healthy',
        },
        cpu: {
          usage: cpuUsage,
          status: cpuUsage > 80 ? 'unhealthy' : 'healthy',
        },
        cache: {
          status: cacheHealth.status,
        },
        security: {
          threats: securityMetrics?.blockedRequests || 0,
          status: (securityMetrics?.blockedRequests || 0) > 100 ? 'degraded' : 'healthy',
        },
      };

      res.json(health);
    } catch (error) {
      logger.error('Health check failed', { error });
      sendError(res, 503, { code: 'HEALTH_CHECK_FAILED', message: 'Health check failed' });
    }
  }

  private async getMetrics(_req: Request, res: Response): Promise<void> {
    try {
      const cacheMetrics = await getDistributedCache().getMetrics();
      const securityMetrics = this.securityMiddleware?.getMetrics();

      res.json({
        cache: cacheMetrics,
        security: securityMetrics,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get metrics', { error });
      sendError(res, 500, { code: 'METRICS_FETCH_FAILED', message: 'Failed to get metrics' });
    }
  }

  private async clearCache(req: Request, res: Response): Promise<void> {
    try {
      const { type = 'all' } = req.body;

      if (type === 'distributed' || type === 'all') {
        await getDistributedCache().clear();
        logger.info('Distributed cache cleared');
      }

      res.json({ success: true, message: 'Cache cleared successfully' });
    } catch (error) {
      logger.error('Failed to clear cache', { error });
      sendError(res, 500, { code: 'CACHE_CLEAR_FAILED', message: 'Failed to clear cache' });
    }
  }

  private getDashboardHTML(_req: Request, res: Response): void {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Integration Hub Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .card { border: 1px solid #ddd; padding: 20px; margin: 10px; border-radius: 5px; }
        .healthy { background: #d4edda; }
        .degraded { background: #fff3cd; }
        .unhealthy { background: #f8d7da; }
        button { padding: 10px 20px; margin: 5px; }
    </style>
</head>
<body>
    <h1>🚀 Integration Hub Dashboard</h1>
    
    <button onclick="refreshHealth()">Refresh Health</button>
    <button onclick="refreshMetrics()">Refresh Metrics</button>
    <button onclick="clearCache()">Clear Cache</button>
    
    <div id="health" class="card">
        <h2>System Health</h2>
        <p>Loading...</p>
    </div>
    
    <div id="metrics" class="card">
        <h2>Metrics</h2>
        <p>Loading...</p>
    </div>

    <script>
        async function refreshHealth() {
            try {
                const response = await fetch('/operations/health');
                const health = await response.json();
                const healthDiv = document.getElementById('health');
                healthDiv.className = 'card ' + health.status;
                healthDiv.innerHTML = \`
                    <h2>System Health - \${health.status.toUpperCase()}</h2>
                    <p>Memory: \${health.memory.usage.toFixed(1)}% (\${health.memory.status})</p>
                    <p>CPU: \${health.cpu.usage.toFixed(1)}% (\${health.cpu.status})</p>
                    <p>Cache: \${health.cache.status}</p>
                    <p>Security Threats: \${health.security.threats}</p>
                    <p>Last Updated: \${health.timestamp}</p>
                \`;
            } catch (error) {
                console.error('Failed to refresh health:', error);
            }
        }

        async function refreshMetrics() {
            try {
                const response = await fetch('/operations/metrics');
                const metrics = await response.json();
                const metricsDiv = document.getElementById('metrics');
                metricsDiv.innerHTML = \`
                    <h2>System Metrics</h2>
                    <h3>Cache</h3>
                    <p>Hit Rate: \${metrics.cache.hitRate.toFixed(1)}%</p>
                    <p>Total Requests: \${metrics.cache.totalRequests}</p>
                    <h3>Security</h3>
                    <p>Blocked Requests: \${metrics.security?.blockedRequests || 0}</p>
                    <p>Blocked IPs: \${metrics.security?.blockedIPs?.size || 0}</p>
                    <p>Last Updated: \${metrics.timestamp}</p>
                \`;
            } catch (error) {
                console.error('Failed to refresh metrics:', error);
            }
        }

        async function clearCache() {
            try {
                const response = await fetch('/operations/cache/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'all' })
                });
                const result = await response.json();
                alert(result.message);
                refreshMetrics();
            } catch (error) {
                console.error('Failed to clear cache:', error);
            }
        }

        // Auto-refresh every 30 seconds
        setInterval(() => {
            refreshHealth();
            refreshMetrics();
        }, 30000);

        // Initial load
        refreshHealth();
        refreshMetrics();
    </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }

  public getRouter(): Router {
    return this.router;
  }
}

export function createOperationalDashboard(
  securityMiddleware?: AdvancedSecurityMiddleware,
): OperationalDashboard {
  return new OperationalDashboard(securityMiddleware);
}
