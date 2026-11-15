/* eslint-env node */
/* eslint-disable no-undef */

/**
 * Jest E2E Configuration
 * For Jest-based E2E tests (portal agent flows).
 * Playwright-based E2E tests use playwright.e2e.config.cjs instead.
 * @type {import('jest').Config}
 */
const baseConfig = require('./jest.base.config.cjs');

module.exports = {
  ...baseConfig,
  roots: ['<rootDir>/tests/e2e'],
  testMatch: [
    '<rootDir>/tests/e2e/**/*.e2e.test.ts',
  ],
  testPathIgnorePatterns: [],
  // E2E tests run against real agent logic — disable fake timers
  fakeTimers: {
    enableGlobally: false,
  },
  collectCoverage: false,
  testTimeout: 60000,
};
