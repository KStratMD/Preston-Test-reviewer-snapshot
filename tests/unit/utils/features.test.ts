/**
 * Features Utility Unit Tests
 * Tests for feature flag utilities
 */

// Mock runtimeFlags
jest.mock('../../../src/config/runtimeFlags', () => ({
  isDemoMode: jest.fn(),
}));

import { isDemo, isRedisDisabled, isBootDebug, isOtelEnabled, applyEnvDerivations } from '../../../src/utils/features';
import { isDemoMode } from '../../../src/config/runtimeFlags';

const mockIsDemoMode = isDemoMode as jest.MockedFunction<typeof isDemoMode>;

describe('features', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isDemo', () => {
    it('should return true when in demo mode', () => {
      mockIsDemoMode.mockReturnValue(true);
      
      expect(isDemo()).toBe(true);
    });

    it('should return false when not in demo mode', () => {
      mockIsDemoMode.mockReturnValue(false);
      
      expect(isDemo()).toBe(false);
    });
  });

  describe('isRedisDisabled', () => {
    it('should return true when DISABLE_REDIS is 1', () => {
      process.env.DISABLE_REDIS = '1';
      
      expect(isRedisDisabled()).toBe(true);
    });

    it('should return false when DISABLE_REDIS is not set', () => {
      delete process.env.DISABLE_REDIS;
      
      expect(isRedisDisabled()).toBe(false);
    });

    it('should return false when DISABLE_REDIS is 0', () => {
      process.env.DISABLE_REDIS = '0';
      
      expect(isRedisDisabled()).toBe(false);
    });
  });

  describe('isBootDebug', () => {
    it('should return true when BOOT_DEBUG is 1', () => {
      process.env.BOOT_DEBUG = '1';
      
      expect(isBootDebug()).toBe(true);
    });

    it('should return false when BOOT_DEBUG is not set', () => {
      delete process.env.BOOT_DEBUG;
      
      expect(isBootDebug()).toBe(false);
    });
  });

  describe('isOtelEnabled', () => {
    it('should return true when DEMO_NO_OTEL is not set', () => {
      delete process.env.DEMO_NO_OTEL;
      
      expect(isOtelEnabled()).toBe(true);
    });

    it('should return true when DEMO_NO_OTEL is 0', () => {
      process.env.DEMO_NO_OTEL = '0';
      
      expect(isOtelEnabled()).toBe(true);
    });

    it('should return false when DEMO_NO_OTEL is 1', () => {
      process.env.DEMO_NO_OTEL = '1';
      
      expect(isOtelEnabled()).toBe(false);
    });
  });

  describe('applyEnvDerivations', () => {
    it('should set DEMO_NO_OTEL when in demo mode', () => {
      mockIsDemoMode.mockReturnValue(true);
      delete process.env.DEMO_NO_OTEL;
      
      applyEnvDerivations();
      
      expect(process.env.DEMO_NO_OTEL).toBe('1');
    });

    it('should set DEMO_NO_OTEL when redis is disabled', () => {
      mockIsDemoMode.mockReturnValue(false);
      process.env.DISABLE_REDIS = '1';
      delete process.env.DEMO_NO_OTEL;
      
      applyEnvDerivations();
      
      expect(process.env.DEMO_NO_OTEL).toBe('1');
    });

    it('should not set DEMO_NO_OTEL when not in demo and redis enabled', () => {
      mockIsDemoMode.mockReturnValue(false);
      process.env.DISABLE_REDIS = '0';
      delete process.env.DEMO_NO_OTEL;
      
      applyEnvDerivations();
      
      expect(process.env.DEMO_NO_OTEL).toBeUndefined();
    });
  });
});
