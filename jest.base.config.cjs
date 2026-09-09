/* eslint-env node */
/* eslint-disable no-undef */

/**
 * Jest Base Configuration
 * Shared settings for fast and CI test configs.
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit', '<rootDir>/src'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
  },
  resolver: '<rootDir>/tests/jest.resolver.cjs',
  setupFilesAfterEnv: ['<rootDir>/tests/fastMocks.ts'],
  moduleNameMapper: {
    '^ioredis$': '<rootDir>/tests/__mocks__/ioredis.js',
    '^src/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.ts',
    '<rootDir>/tests/unit/**/*.spec.ts',
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.spec.ts'
  ],
  testPathIgnorePatterns: [
    '<rootDir>/tests/e2e'
  ],
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
  maxWorkers: 1,
  globalTeardown: '<rootDir>/jest.teardown.js',
  // Enable fake timers globally to prevent timeout issues from services
  // that use setInterval in constructors (e.g., PerformanceOptimizationService)
  fakeTimers: {
    enableGlobally: true,
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask']
  }
};
