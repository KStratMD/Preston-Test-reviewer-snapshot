import { spawnSync } from 'child_process';

describe('Environment validation (src/config/env.ts)', () => {
  const node = process.execPath;

  const runScript = (script: string, extraEnv: Record<string, string | undefined>) => {
    return spawnSync(
      node,
      ['-e', script],
      {
        env: { ...process.env, ...extraEnv },
        encoding: 'utf8',
      },
    );
  };

  const runEnvModule = (extraEnv: Record<string, string | undefined>) =>
    runScript('require(\'ts-node/register\'); require(\'./src/config/env.ts\');', extraEnv);

  it('exits with code 1 on invalid PORT in development', () => {
    const result = runEnvModule({ NODE_ENV: 'development', PORT: 'abc', LOG_LEVEL: 'error' });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/Invalid environment variables|Invalid/i);
  });

  it('exits with code 1 when using default JWT secret in production', () => {
    // Do not provide JWT_SECRET so zod default is used, which should be rejected in production.
    // Pin HOSTED_DEMO/DB_PASSWORD/RATE_LIMIT_ENABLED explicitly so the assertion is hermetic —
    // otherwise a stray HOSTED_DEMO=1 in the developer or CI environment would skip the guard
    // and this test would silently fail for the wrong reason.
    const result = runEnvModule({
      NODE_ENV: 'production',
      HOSTED_DEMO: '0',
      DB_PASSWORD: 'CorrectHorseBatteryStaple123!',
      JWT_SECRET: undefined,
      RATE_LIMIT_ENABLED: 'true',
      LOG_LEVEL: 'error',
    });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/default or placeholder value in production/i);
  });

  it('exits with code 1 when using a placeholder JWT secret in production outside hosted demo', () => {
    const result = runEnvModule({
      NODE_ENV: 'production',
      HOSTED_DEMO: '0',
      DB_PASSWORD: 'CorrectHorseBatteryStaple123!',
      JWT_SECRET: 'placeholder-local-only-Q7xL2rM9vN4cP8sT1wY5zA3fH6jK0mB2dE7gU9iO4pR6tV8nC1qW5yZ3uX7hJ2kL4',
      RATE_LIMIT_ENABLED: 'true',
      LOG_LEVEL: 'error',
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/default or placeholder value in production/i);
  });

  it('does not fail startup when new MCP gateway env vars are omitted', () => {
    const result = runEnvModule({
      NODE_ENV: 'development',
      LOG_LEVEL: 'error',
      NETSUITE_MCP_ENDPOINT: undefined,
      NETSUITE_MCP_CLIENT_ID: undefined,
      NETSUITE_MCP_CLIENT_SECRET: undefined,
      NETSUITE_MCP_ACCESS_TOKEN: undefined,
      BC_MCP_ENDPOINT: undefined,
      BC_MCP_TENANT_ID: undefined,
      BC_MCP_CLIENT_ID: undefined,
      BC_MCP_CLIENT_SECRET: undefined,
      BC_MCP_ACCESS_TOKEN: undefined,
      MCP_GATEWAY_ENABLED: undefined,
    });

    expect(result.status).toBe(0);
  });

  it('defaults MCP_GATEWAY_ENABLED to false', () => {
    const result = runScript(
      'require(\'ts-node/register\'); const { env } = require(\'./src/config/env.ts\'); process.stdout.write(String(env.MCP_GATEWAY_ENABLED));',
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        MCP_GATEWAY_ENABLED: undefined,
      },
    );

    expect(result.status).toBe(0);
    expect((result.stdout || '').trim()).toContain('false');
  });
});
