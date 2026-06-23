// Global setup for integration/slow tests to ensure a strong production-like JWT secret
// Must run before app initialization in tests. Force a secure secret regardless of existing value.
export const STRONG_TEST_JWT_SECRET = 'integration-suite-strong-token-9fUa7qLz1rM2pXcV6bJ1tY8nH3kD5eQ0Ww4Zs7Lx9Cv2Bp6Jm1Ty8Nh3Kd5Eq0Ur4Ys7Zx9';
process.env.JWT_SECRET = STRONG_TEST_JWT_SECRET;

// Simulate production gating logic for tests that rely on it
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// Enable features commonly validated by integration tests unless they set their own
process.env.ENABLE_METRICS = process.env.ENABLE_METRICS ?? 'true';
process.env.ENABLE_DASHBOARD = process.env.ENABLE_DASHBOARD ?? 'true';

// Prevent background intervals/timers from running during integration tests
// This disables dashboard/EventBus intervals and Prometheus default metrics timers
process.env.DASHBOARD_DISABLE_INTERVALS = '1';
process.env.PROM_DISABLE_DEFAULT_METRICS = '1';
// Disable docs filesystem watch to prevent late console.log after tests complete
process.env.DOCS_DISABLE_WATCH = '1';

// Use a fast, isolated in-memory SQLite database for integration tests
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = ':memory:';

// Disable external dependencies during tests
process.env.DISABLE_REDIS = '1';
process.env.RATE_LIMIT_ENABLED = '0';

// Force full app mode (not lightweight) for integration tests
process.env.FORCE_FULL_APP_MODE = '1';
process.env.LIGHTWEIGHT_MODE = '0';


