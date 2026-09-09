/**
 * Mock DI Container for tests
 * Provides consistent mocking of the dependency injection container
 */

import { createMockLogger } from '../utils/testHelpers';
import { logger } from '../../utils/Logger';

// Create reusable mock instances
export const mockLogger = createMockLogger();

export const mockSecureCredentialManager = {
  storeCredentials: jest.fn(),
  getCredentials: jest.fn(),
  deleteCredentials: jest.fn(),
  listCredentials: jest.fn(),
  rotateCredentials: jest.fn(),
  getCredentialsNeedingRotation: jest.fn(),
  getCredentialMetadata: jest.fn(),
  validateCredentials: jest.fn(),
  encryptCredentials: jest.fn(),
  decryptCredentials: jest.fn(),
  auditAccess: jest.fn(),
  migrateFromEnvironment: jest.fn(),
};

export const mockSecureConfigService = {
  get: jest.fn(),
  set: jest.fn(),
  has: jest.fn(),
  delete: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  getAll: jest.fn(() => ({})),
};

export const mockSecretManager = {
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  deleteSecret: jest.fn(),
  listSecrets: jest.fn(),
  rotateSecret: jest.fn(),
};

export const mockPerformanceMonitor = {
  startMonitoring: jest.fn(),
  stopMonitoring: jest.fn(),
  getMetrics: jest.fn((): unknown[] => []),
  getAllMetrics: jest.fn((): unknown[] => []),
  getLatestMetrics: jest.fn((): unknown => null),
  getAlerts: jest.fn((): unknown[] => []),
  getRecentAlerts: jest.fn((): unknown[] => []),
  recordRequestStart: jest.fn(),
  recordRequestEnd: jest.fn(),
  recordIntegrationMetric: jest.fn(),
  reset: jest.fn(),
  shutdown: jest.fn(),
};

export const mockAdvancedCache = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
  clear: jest.fn(),
  has: jest.fn(),
  getStats: jest.fn(() => ({
    entryCount: 0,
    hitRate: 0,
    missRate: 0,
    evictions: 0,
  })),
  shutdown: jest.fn(),
};

// TYPES mock to match the actual symbols
export const mockTYPES = {
  Logger: Symbol('Logger'),
  SecureCredentialManager: Symbol('SecureCredentialManager'),
  SecureConfigurationService: Symbol('SecureConfigurationService'),
  SecretManager: Symbol('SecretManager'),
  PerformanceMonitor: Symbol('PerformanceMonitor'),
  AdvancedCache: Symbol('AdvancedCache'),
  AIFieldMappingService: Symbol('AIFieldMappingService'),
  TransformationEngine: Symbol('TransformationEngine'),
  AuthService: Symbol('AuthService'),
  UnifiedTelemetryService: Symbol('UnifiedTelemetryService'),
};

// Container mock with type-safe resolution
export const mockContainer = {
  get: jest.fn((type) => {
    const typeStr = type.toString();

    if (typeStr.includes('Logger')) return mockLogger;
    if (typeStr.includes('SecureCredentialManager')) return mockSecureCredentialManager;
    if (typeStr.includes('SecureConfigurationService')) return mockSecureConfigService;
    if (typeStr.includes('SecretManager')) return mockSecretManager;
    if (typeStr.includes('PerformanceMonitor')) return mockPerformanceMonitor;
    if (typeStr.includes('AdvancedCache')) return mockAdvancedCache;

    // Default fallback
    logger.warn(`Unknown DI type in test: ${typeStr}`);
    return {};
  }),

  bind: jest.fn(() => ({
    to: jest.fn(() => ({
      inSingletonScope: jest.fn(),
      inTransientScope: jest.fn(),
    })),
    toDynamicValue: jest.fn(() => ({
      inSingletonScope: jest.fn(),
      inTransientScope: jest.fn(),
    })),
  })),

  isBound: jest.fn(() => true),
  unbind: jest.fn(),
  rebind: jest.fn(),
};

// Reset function for test cleanup
export function resetMocks() {
  jest.clearAllMocks();

  // Reset mock implementations to defaults
  Object.values(mockSecureCredentialManager).forEach(mock => {
    if (jest.isMockFunction(mock)) {
      mock.mockReset();
    }
  });

  Object.values(mockSecureConfigService).forEach(mock => {
    if (jest.isMockFunction(mock)) {
      mock.mockReset();
    }
  });
}