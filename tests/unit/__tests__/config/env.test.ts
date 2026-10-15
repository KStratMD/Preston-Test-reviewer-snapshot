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
        shell: false,
      },
    );
  };

  it('runs child scripts with the current Node executable', () => {
    const result = runScript('process.stdout.write(process.execPath)', {});

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(process.execPath);
  });

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

  it('applies schema defaults for omitted boolean flags (MCP gateway off, rate limiting ON)', () => {
    // Regression (Copilot on #1033): parseBooleanEnvFlag(undefined) returned
    // false, which fed a concrete `false` into z.preprocess and made every
    // `.default(...)` dead code — an UNSET RATE_LIMIT_ENABLED parsed to false
    // (silently disabling the ERP-write limiter in dev, and tripping the
    // production must-be-true guard into refusing to boot). The parser must
    // pass undefined through so each flag's schema default applies.
    const result = runScript(
      'require(\'ts-node/register\'); const { env } = require(\'./src/config/env.ts\'); process.stdout.write(\'\\nENVJSON:\' + JSON.stringify({ mcp: env.MCP_GATEWAY_ENABLED, rate: env.RATE_LIMIT_ENABLED, hosted: env.HOSTED_DEMO }));',
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        MCP_GATEWAY_ENABLED: undefined,
        RATE_LIMIT_ENABLED: undefined,
        HOSTED_DEMO: undefined,
      },
    );

    expect(result.status).toBe(0);
    const marker = (result.stdout || '').match(/ENVJSON:(\{.*\})/);
    expect(marker).not.toBeNull();
    const flags = JSON.parse(marker![1]!);
    expect(flags).toEqual({ mcp: false, rate: true, hosted: false });
  });

  it('treats an explicit false encryption flag as disabled in production', () => {
    const result = runEnvModule({
      NODE_ENV: 'production',
      HOSTED_DEMO: '0',
      JWT_SECRET: 'a-production-secret-that-is-long-enough-for-tests-123456789',
      DB_PASSWORD: 'CorrectHorseBatteryStaple123!',
      RATE_LIMIT_ENABLED: 'true',
      ENABLE_CREDENTIAL_ENCRYPTION: 'false',
      SECRET_MANAGER_PROVIDER: 'env',
      APPROVAL_FINGERPRINT_HMAC_KEY: 'a'.repeat(64),
      LOG_LEVEL: 'error',
    });

    expect(result.status).toBe(0);
  });

  describe('CARDINALITY_SALESFORCE_RELATIONSHIP_MODE (B3.5)', () => {
    it('defaults to disabled when omitted, and does not require Salesforce credentials', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: undefined,
        SALESFORCE_INSTANCE_URL: undefined,
        SALESFORCE_ACCESS_TOKEN: undefined,
      });

      expect(result.status).toBe(0);
    });

    it('accepts the explicit "disabled" value', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'disabled',
      });

      expect(result.status).toBe(0);
    });

    it('accepts "live" when both SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN are set', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
        SALESFORCE_ACCESS_TOKEN: 'a-test-token',
      });

      expect(result.status).toBe(0);
    });

    it('rejects an invalid mode value', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'enabled',
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/Invalid environment variables/i);
    });

    it('exits 1 with a fixed message when "live" is missing SALESFORCE_INSTANCE_URL', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: undefined,
        SALESFORCE_ACCESS_TOKEN: 'a-test-token',
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(
        /CARDINALITY_SALESFORCE_RELATIONSHIP_MODE=live requires both SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN/,
      );
    });

    it('exits 1 with a fixed message when "live" is missing SALESFORCE_ACCESS_TOKEN', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
        SALESFORCE_ACCESS_TOKEN: undefined,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(
        /CARDINALITY_SALESFORCE_RELATIONSHIP_MODE=live requires both SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN/,
      );
    });

    it('exits 1 with a fixed message when "live" is missing both credentials', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: undefined,
        SALESFORCE_ACCESS_TOKEN: undefined,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(
        /CARDINALITY_SALESFORCE_RELATIONSHIP_MODE=live requires both SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN/,
      );
    });

    it('exits 1 with a bounded message (not the raw value) when SALESFORCE_INSTANCE_URL is not a well-formed URL', () => {
      const invalidUrlMarker = 'not-a-valid-url-leaked-marker';
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: invalidUrlMarker,
        SALESFORCE_ACCESS_TOKEN: 'a-test-token',
      });

      expect(result.status).toBe(1);
      const output = result.stderr + result.stdout;
      expect(output).toMatch(/Invalid environment variables/i);
      // zod's built-in url() message does not echo the rejected input, but
      // this is the boundary that actually proves it, not an assumption.
      expect(output).not.toContain(invalidUrlMarker);
    });

    it('exits 1 with a fixed message (not the raw whitespace) when SALESFORCE_ACCESS_TOKEN is whitespace-only', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        CARDINALITY_SALESFORCE_RELATIONSHIP_MODE: 'live',
        SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
        SALESFORCE_ACCESS_TOKEN: '   ',
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(
        /CARDINALITY_SALESFORCE_RELATIONSHIP_MODE=live requires both SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN/,
      );
    });
  });

  describe('APPROVAL_FINGERPRINT_HMAC_KEY (A8)', () => {
    const prodBase = {
      NODE_ENV: 'production',
      JWT_SECRET: 'a-production-secret-that-is-long-enough-for-tests-123456789',
      DB_PASSWORD: 'CorrectHorseBatteryStaple123!',
      RATE_LIMIT_ENABLED: 'true',
      LOG_LEVEL: 'error',
    };

    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['too short', 'a'.repeat(63)],
      ['too long', 'a'.repeat(65)],
      ['non-hex', `${'a'.repeat(63)}z`],
    ])('exits 1 in production when the key is %s', (_label, value) => {
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        APPROVAL_FINGERPRINT_HMAC_KEY: value,
      });

      expect(result.status).toBe(1);
      const output = result.stderr + result.stdout;
      expect(output).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
      // The rejected value is still key material and must not be echoed.
      if (value) expect(output).not.toContain(value);
    });

    it('exits 1 under HOSTED_DEMO too — hosted is NOT exempt from this key', () => {
      // Deliberately unlike the JWT/DB guards, which HOSTED_DEMO waives. The
      // fingerprint is the approval queue's dedupe key; a hosted deployment
      // running without it would silently lose idempotency, which is exactly
      // the failure A8 exists to prevent. Same shape as A6's
      // requiresStrictRateLimitPolicy = HOSTED_DEMO || production.
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '1',
        APPROVAL_FINGERPRINT_HMAC_KEY: undefined,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
    });

    it('boots in production with a well-formed key', () => {
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        APPROVAL_FINGERPRINT_HMAC_KEY: 'A'.repeat(64),
      });

      expect(result.status).toBe(0);
    });

    it('rejects a key derived from JWT_SECRET even when it is well-formed hex', () => {
      // The design forbids reusing JWT, webhook, or encryption key material.
      // A operator who hex-encodes the JWT secret to satisfy the format check
      // would get a key whose compromise blast radius is the one the
      // separation exists to bound.
      const derived = Buffer.from(prodBase.JWT_SECRET).toString('hex').slice(0, 64);
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        APPROVAL_FINGERPRINT_HMAC_KEY: derived,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
    });

    it('rejects a key that is byte-identical to JWT_SECRET', () => {
      // Codex R1: this passed cleanly before. A JWT_SECRET that is itself 64
      // hex characters equals the key exactly, while its hex ENCODING is 128
      // characters and shares no prefix with it — so both prefix checks missed
      // the most direct form of reuse there is.
      const shared = 'a'.repeat(64);
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        JWT_SECRET: shared,
        APPROVAL_FINGERPRINT_HMAC_KEY: shared,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
    });

    it('rejects a key that is the raw first 32 bytes of JWT_SECRET', () => {
      // Built by repetition rather than written as one long random-looking
      // literal: a 64-character high-entropy string in a diff is exactly what
      // a secret scanner flags, and it would be right to. Low entropy is fine
      // here — the guard under test cares about the DERIVATION, not the
      // strength, of the value it rejects.
      const jwtSecret = 'a8-separation-fixture-not-a-secret-'.repeat(2);
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        JWT_SECRET: jwtSecret,
        APPROVAL_FINGERPRINT_HMAC_KEY: Buffer.from(jwtSecret, 'utf8').subarray(0, 32).toString('hex'),
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
    });

    it.each([
      ['AI_CONFIG_ENCRYPTION_KEY', 'AI_CONFIG_ENCRYPTION_KEY'],
      ['CREDENTIAL_ENCRYPTION_KEY', 'CREDENTIAL_ENCRYPTION_KEY'],
    ])('rejects a key that reuses %s', (_label, varName) => {
      const shared = 'c'.repeat(64);
      const result = runEnvModule({
        ...prodBase,
        HOSTED_DEMO: '0',
        [varName]: shared,
        APPROVAL_FINGERPRINT_HMAC_KEY: shared,
      });

      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/APPROVAL_FINGERPRINT_HMAC_KEY/);
    });

    it('does not require the key outside production or hosted demo', () => {
      const result = runEnvModule({
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        APPROVAL_FINGERPRINT_HMAC_KEY: undefined,
      });

      expect(result.status).toBe(0);
    });
  });
});
