/**
 * Regression test for setupEnvPostgres.ts hard-fail guard (P2 + D17).
 *
 * The setup module must throw at module load time when DATABASE_URL is unset
 * or empty — there is no .skip fallback. This prevents tests from silently
 * running against an unintended dialect.
 */
describe('setupEnvPostgres hard-fail guard', () => {
  const TOUCHED_KEYS = [
    'DATABASE_URL',
    'DB_TYPE',
    'JWT_SECRET',
    'NODE_ENV',
    'ENABLE_METRICS',
    'ENABLE_DASHBOARD',
    'DASHBOARD_DISABLE_INTERVALS',
    'PROM_DISABLE_DEFAULT_METRICS',
    'DOCS_DISABLE_WATCH',
    'DISABLE_REDIS',
    'RATE_LIMIT_ENABLED',
    'FORCE_FULL_APP_MODE',
    'LIGHTWEIGHT_MODE',
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOUCHED_KEYS) {
      snapshot[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      const prev = snapshot[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    jest.resetModules();
  });

  it('throws when DATABASE_URL is unset', () => {
    delete process.env.DATABASE_URL;
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/DATABASE_URL is required/i);
  });

  it('throws when DATABASE_URL is an empty string', () => {
    process.env.DATABASE_URL = '';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/DATABASE_URL is required/i);
  });

  it('throws when DATABASE_URL is whitespace only', () => {
    process.env.DATABASE_URL = '   ';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/DATABASE_URL is required/i);
  });

  it('sets DB_TYPE=postgres when DATABASE_URL is valid', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).not.toThrow();
    expect(process.env.DB_TYPE).toBe('postgres');
  });

  it('throws when DATABASE_URL has no embedded credentials', () => {
    // No user:password — DatabaseService would fall back to DB_HOST/DB_NAME defaults
    // and diverge from the raw pg.Pool smoke tests that always use DATABASE_URL.
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/embedded credentials/i);
  });

  it('throws when DATABASE_URL has only username (no password)', () => {
    process.env.DATABASE_URL = 'postgres://user@localhost:5432/test';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/embedded credentials/i);
  });

  it('throws when DATABASE_URL is malformed', () => {
    process.env.DATABASE_URL = 'not-a-valid-url';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/malformed/i);
  });

  it('throws when DATABASE_URL uses a non-postgres scheme', () => {
    // Even with credentials, an https://... URL would pass the credentials check but
    // the suite is Postgres-only — fail fast at setup rather than fall through.
    process.env.DATABASE_URL = 'https://user:pass@example.com/db';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/postgres:\/\/ or postgresql:\/\/ scheme/i);
  });

  it('throws when DATABASE_URL has an empty host', () => {
    // `postgres://user:pass@/db` is path-only (no host). Node's URL constructor
    // rejects this as malformed (ERR_INVALID_URL), so the suite aborts with the
    // "malformed" error path. The explicit hostname guard added below the URL
    // constructor is defense-in-depth for any future URL-constructor change.
    process.env.DATABASE_URL = 'postgres://user:pass@/preston_test';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).toThrow(/malformed|non-empty host/i);
  });

  it('accepts the postgresql:// scheme (repo convention)', () => {
    // The rest of the repo uses postgresql:// (docker-compose.test.yml, src/config/env.ts,
    // k8s/secrets.yaml, etc.). Positive case that the alternate scheme is accepted.
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    jest.resetModules();
    expect(() => {
      require('../../integration/setupEnvPostgres');
    }).not.toThrow();
    expect(process.env.DB_TYPE).toBe('postgres');
  });
});
