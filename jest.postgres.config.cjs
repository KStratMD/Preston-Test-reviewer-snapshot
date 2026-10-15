/* eslint-env node */
/* eslint-disable no-undef */
const slow = require('./jest.slow.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...slow,
  roots: ['<rootDir>/tests/integration/postgres'],
  testMatch: ['<rootDir>/tests/integration/postgres/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/tests/integration/setupEnvPostgres.ts'],
  // testEnvironment, transform, moduleFileExtensions, testTimeout, maxWorkers,
  // verbose, detectOpenHandles, forceExit, clearMocks, restoreMocks, and
  // globalTeardown all inherit from jest.slow.config.cjs via spread.
};
