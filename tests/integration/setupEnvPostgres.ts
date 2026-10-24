/**
 * Postgres integration suite env-setup module.
 *
 * Contract (per PR-OP-3-pre spec P2 + D17 from PR-OP-3 spec):
 *   tests/integration/postgres/** is the canonical home for any Postgres-only
 *   test. The postgres-integration CI job is the canonical CI runner; local
 *   dev runs them via `npm run test:integration:postgres` with DATABASE_URL set.
 *   DATABASE_URL unset is a hard load-time failure, not a .skip — no SQLite fallback.
 *
 * This file is loaded by jest.postgres.config.cjs as a setupFile, which runs
 * BEFORE any test file is imported. Throwing here aborts the suite cleanly
 * without polluting test output.
 *
 * The companion regression test is tests/unit/scripts/setup-env-postgres.test.ts.
 */

// Inversify decorators require reflect-metadata to be loaded before any decorated
// class is imported. Existing integration tests include this per-file; for the
// postgres suite it lives here so the polyfill fires regardless of test order.
import 'reflect-metadata';

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  throw new Error(
    '[setupEnvPostgres] DATABASE_URL is required for the postgres integration suite. ' +
      'Set DATABASE_URL=postgres://… or DATABASE_URL=postgresql://… and re-run. ' +
      'CI provides this via the postgres-integration job env.',
  );
}

// Validate that DATABASE_URL has embedded credentials (user:password@host). DatabaseService
// only uses env.DATABASE_URL when it contains BOTH user AND password — see hasDbUrlCredentials
// in src/utils/dbUrlHelper.ts. Without credentials, DatabaseService falls back to
// DB_HOST/DB_NAME/DB_USER/DB_PASSWORD defaults, while the raw pg.Pool smoke tests
// (connection.test.ts, for-update.test.ts) always use DATABASE_URL directly. Diverging
// connection targets between the two paths is a silent footgun this guard prevents.
try {
  const parsed = new URL(process.env.DATABASE_URL);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `[setupEnvPostgres] DATABASE_URL must use postgres:// or postgresql:// scheme. ` +
        `Got protocol '${parsed.protocol}'. The integration suite is Postgres-only; ` +
        `other schemes fall through to pg/DatabaseService failures instead of failing fast here.`,
    );
  }
  if (!parsed.username || !parsed.password) {
    throw new Error(
      '[setupEnvPostgres] DATABASE_URL must include embedded credentials ' +
        '(postgres://user:password@host:port/db). Got URL without user/password — ' +
        'DatabaseService would fall back to DB_HOST/DB_NAME, diverging from the raw pg smoke tests.',
    );
  }
  if (!parsed.hostname) {
    throw new Error(
      '[setupEnvPostgres] DATABASE_URL must include a non-empty host ' +
        '(postgres://user:password@host:port/db). Got URL with empty host — ' +
        'this is a malformed connection string the workflow drift gate also rejects.',
    );
  }
} catch (e) {
  if (e instanceof Error && e.message.startsWith('[setupEnvPostgres]')) {
    throw e;
  }
  throw new Error(
    `[setupEnvPostgres] DATABASE_URL is malformed: ${(e as Error).message ?? String(e)}`,
  );
}

// Match tests/integration/setupEnv.ts for all non-DB env, then override DB knobs.
export const STRONG_TEST_JWT_SECRET =
  'integration-suite-strong-token-9fUa7qLz1rM2pXcV6bJ1tY8nH3kD5eQ0Ww4Zs7Lx9Cv2Bp6Jm1Ty8Nh3Kd5Eq0Ur4Ys7Zx9';
process.env.JWT_SECRET = STRONG_TEST_JWT_SECRET;

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

process.env.ENABLE_METRICS = process.env.ENABLE_METRICS ?? 'true';
process.env.ENABLE_DASHBOARD = process.env.ENABLE_DASHBOARD ?? 'true';
process.env.DASHBOARD_DISABLE_INTERVALS = '1';
process.env.PROM_DISABLE_DEFAULT_METRICS = '1';
process.env.DOCS_DISABLE_WATCH = '1';

// Postgres-specific (overrides setupEnv.ts SQLite default).
process.env.DB_TYPE = 'postgres';

// External-dep gates — match setupEnv.ts.
process.env.DISABLE_REDIS = '1';
process.env.RATE_LIMIT_ENABLED = '0';
process.env.FORCE_FULL_APP_MODE = '1';
process.env.LIGHTWEIGHT_MODE = '0';
