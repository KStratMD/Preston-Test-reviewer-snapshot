/* eslint-env node */
/* eslint-disable no-undef */
/**
 * Real-Redis profile (#1102 activation).
 *
 * Deliberately NOT part of jest.slow.config.cjs. That profile is hermetic by
 * design — `tests/integration/setupEnv.ts:27` sets DISABLE_REDIS=1
 * unconditionally for every file it runs, and CI gives it no Redis service —
 * so a "real Redis" test placed there would silently exercise the *disabled*
 * path while claiming to prove the enabled one. This profile omits that setup
 * file entirely and runs only `tests/redis/**`.
 *
 * `forceExit` and `detectOpenHandles` are inverted relative to the slow
 * profile on purpose. The slow profile force-exits with open-handle detection
 * off, which means a clean exit there proves nothing about whether BullMQ
 * released its connections. Here the run must end on its own, so a leaked
 * handle shows up as a hanging or complaining run rather than a green one.
 * The lifecycle test still asserts close() positively — this is the backstop,
 * not the proof.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/redis'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
  },
  testMatch: ['<rootDir>/tests/redis/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Real network round-trips to Redis plus worker startup; generous but bounded.
  testTimeout: 60000,
  // Serial: the suite asserts on a real queue's state, so parallel workers
  // sharing one Redis would see each other's jobs.
  maxWorkers: 1,
  verbose: true,
  detectOpenHandles: true,
  forceExit: false,
  clearMocks: true,
  restoreMocks: true,
};
