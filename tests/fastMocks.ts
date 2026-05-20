// @ts-nocheck
import { jest } from '@jest/globals';

// Set max listeners for process to prevent warnings in tests
process.setMaxListeners(20);

// Ensure test environment for env parsing and config
process.env.NODE_ENV = 'test';
// Force-disable demo modes that change connector behavior under unit tests
process.env.FORCE_DISABLE_DEMO_MODE = '1';

// Global test cleanup
afterEach(() => {
  // Clean up any timers
  jest.clearAllTimers();
  jest.useRealTimers();
});

beforeEach(() => {
  // Reset all mocks before each test
  jest.clearAllMocks();
});

// Mock IORedis globally
jest.mock('ioredis', () => {
  const MockIORedis = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
    status: 'ready',
    quit: jest.fn().mockResolvedValue(undefined),
  }));
  
  return {
    __esModule: true,
    default: MockIORedis,
  };
});

// A more robust mock for ObservabilityService
jest.mock('../src/observability', () => {
  const pino = require('pino');
  const logger = pino({ enabled: false });

  const mockSpan = {
    end: jest.fn(),
    recordException: jest.fn(),
    setStatus: jest.fn(),
  };

  const mockScope = {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn().mockReturnThis(), // Chainable
      createChildLogger: jest.fn().mockReturnThis(),
      getLogger: jest.fn().mockReturnThis()
    },
    metrics: {
      incrementActiveIntegrations: jest.fn(),
      decrementActiveIntegrations: jest.fn(),
      recordIntegrationRun: jest.fn(),
      recordBatchProcessing: jest.fn(),
      recordError: jest.fn(),
    },
    tracing: {
      startSpan: jest.fn(() => mockSpan),
      shutdown: jest.fn().mockResolvedValue(undefined),
    },
    span: mockSpan,
  };

  return {
    ObservabilityService: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      createScope: jest.fn().mockReturnValue(mockScope),
      getLogger: jest.fn().mockReturnValue(logger),
    })),
  };
});

// Mock other dependencies if needed
jest.mock('../src/services/AuthService', () => ({
  AuthService: jest.fn().mockImplementation(() => {
    const tokenCache = new Map();
    return {
      validate: jest.fn().mockResolvedValue({ valid: true }),
      generateToken: jest.fn().mockResolvedValue('mock-token'),
      verifyToken: jest.fn().mockResolvedValue({ userId: 'test-user' }),
      refreshToken: jest.fn().mockResolvedValue('refreshed-token'),
      cleanup: jest.fn(),
      clearTokenCache: jest.fn().mockImplementation((credentials) => {
        if (credentials) {
          tokenCache.delete(JSON.stringify(credentials));
        } else {
          tokenCache.clear();
        }
      }),
      getTokenCacheStats: jest.fn().mockReturnValue({ 
        size: 0, 
        hits: 0, 
        misses: 0,
        totalTokens: 0,
        expiredTokens: 0,
        tokensExpiringInHour: 0
      }),
      hashPassword: jest.fn().mockResolvedValue('hashed-password'),
      validateBasicAuth: jest.fn().mockImplementation((user, password, hashedPassword) => {
        if (password === 'wrong') return Promise.resolve(false);
        return Promise.resolve(true);
      }),
      validateApiKey: jest.fn().mockImplementation((provided, expected) => provided === expected),
      generateJWT: jest.fn().mockReturnValue('jwt-token'),
      verifyJWT: jest.fn().mockReturnValue({ user: 'demo' }),
      authenticateOAuth2: jest.fn().mockResolvedValue({
        accessToken: 'mock_access_token',
        refreshToken: 'mock_refresh_token',
        expiresIn: 3600,
        tokenType: 'Bearer'
      }),
      tokenCache: tokenCache
    };
  }),
}));

// Mock TelemetryService globally
jest.mock('../src/services/TelemetryService', () => ({
  TelemetryService: jest.fn().mockImplementation(() => ({
    recordEvent: jest.fn().mockResolvedValue(undefined),
    recordMetric: jest.fn(),
    getMetrics: jest.fn().mockReturnValue([]),
    getAllMetrics: jest.fn().mockReturnValue({}),
    clearMetrics: jest.fn(),
    trackEvent: jest.fn(),
    trackError: jest.fn(),
    trackMetric: jest.fn(),
    flush: jest.fn(),
    getDashboardData: jest.fn().mockResolvedValue({
      executiveSummary: {
        totalIntegrations: 0,
        activeIntegrations: 0,
        dailyThroughput: 0,
        successRate: 100,
        costSavings: 0,
        roi: 0
      },
      performanceBreakdown: [],
      trendData: {
        throughput: [],
        successRate: [],
        processingTime: [],
        errorCount: []
      },
      realTimeMetrics: {
        activeIntegrations: 0,
        recordsProcessedToday: 0,
        systemHealth: 100,
        costSavingsToday: 0
      }
    }),
    startCleanupTimer: jest.fn(),
    stopCleanupTimer: jest.fn(),
  })),
}));
