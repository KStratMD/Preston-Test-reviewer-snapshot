/* eslint-env node */
/* eslint-disable no-undef */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration', '<rootDir>/tests/load', '<rootDir>/tests/performance'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
  },
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.ts',
    '<rootDir>/tests/load/**/*.test.ts',
    '<rootDir>/tests/performance/**/*.test.ts'
  ],
  testPathIgnorePatterns: ['/node_modules/', '/tests/integration/postgres/'],
  testTimeout: 300000,
  maxWorkers: 1,
  verbose: true,
  detectOpenHandles: false, // Disable to prevent hanging
  forceExit: true, // Force exit after tests complete to prevent hanging on open handles
  clearMocks: true,
  restoreMocks: true,
  setupFiles: ['<rootDir>/tests/integration/setupEnv.ts'],
  // Add teardown to ensure clean exit
  globalTeardown: '<rootDir>/tests/integration/globalTeardown.ts'
};
