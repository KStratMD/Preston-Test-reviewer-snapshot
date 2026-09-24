import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('ioredis automatic tracing through application composition', () => {
  it.each(['tracing', 'distributed'])('exports Redis success/error spans through %s and exits naturally', composition => {
    const root = path.resolve(__dirname, '../..');
    const result = spawnSync(process.execPath, [
      '-r', 'ts-node/register', path.join(root, 'scripts/redis-tracing-smoke.ts'), composition,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        DISABLE_TELEMETRY: 'false',
        DISABLE_JAEGER: 'false',
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'ioredis',
        OTEL_NODE_RESOURCE_DETECTORS: 'none',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_TRACES_SAMPLER: 'always_on',
      },
      encoding: 'utf8', timeout: 30000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Tracing child failed (${composition}, status ${result.status}): ${String(result.error ?? '')}\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(`Redis tracing smoke passed: ${composition};`);
  });
});
