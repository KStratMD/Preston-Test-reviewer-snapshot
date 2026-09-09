/**
 * Global test setup for Jest
 * This file runs before all tests to configure the environment
 */

import { logger } from '../../utils/Logger';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = '1';
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests

// Mock external dependencies that cause issues in tests
jest.mock('../../observability/DistributedTracing', () => ({
  tracer: {
    startSpan: jest.fn(() => ({
      setAttributes: jest.fn(),
      setStatus: jest.fn(),
      end: jest.fn(),
    })),
    getActiveSpan: jest.fn(),
  },
  initializeTracing: jest.fn(),
}));

// Mock heavy services that aren't needed for most tests
jest.mock('../../services/ai/ProviderRegistry', () => ({
  ProviderRegistry: jest.fn().mockImplementation(() => ({
    registerProvider: jest.fn(),
    getProvider: jest.fn(),
    testConnection: jest.fn().mockResolvedValue({ ok: true }),
    generateMappingSuggestions: jest.fn().mockResolvedValue([]),
  })),
}));

// Mock file system operations to avoid actual file I/O in tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(() => '{}'),
  unlinkSync: jest.fn(),
}));

// Mock network operations
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    defaults: { headers: { common: {} } },
  })),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
}));

// Increase test timeout for slower CI environments
jest.setTimeout(30000);

// Add global test utilities
declare global {
  var testTimeouts: ReturnType<typeof setTimeout>[];
}

// Track timeouts for cleanup
global.testTimeouts = [];

const originalSetTimeout = global.setTimeout;
// Forward all variadic args (Node/DOM timers support
// `setTimeout(fn, delay, ...args)`; the rest become arguments to the callback).
global.setTimeout = ((...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
  const timeoutId = originalSetTimeout(...args);
  global.testTimeouts.push(timeoutId);
  return timeoutId;
}) as typeof global.setTimeout;

// Clean up after each test
afterEach(() => {
  // Clear any remaining timeouts
  global.testTimeouts.forEach(clearTimeout);
  global.testTimeouts = [];

  // Clear all mocks
  jest.clearAllMocks();
});

// Clean up after all tests
afterAll(() => {
  // Final cleanup
  global.testTimeouts.forEach(clearTimeout);
  jest.restoreAllMocks();
});

logger.info('🧪 Test environment configured');

// Export to make this a module
export {};