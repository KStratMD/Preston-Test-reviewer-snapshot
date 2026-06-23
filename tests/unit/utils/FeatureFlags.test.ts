/**
 * Feature Flags Unit Tests
 * Tests for feature flag service
 */

// Mock dependencies
jest.mock('../../../src/config/env', () => ({
  env: {
    FEATURE_NEW_INTEGRATION_STRATEGY: undefined,
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { FeatureFlags, withFeatureFlag, withFeatureFlagAsync } from '../../../src/utils/FeatureFlags';
import { logger } from '../../../src/utils/Logger';
import { env } from '../../../src/config/env';

describe('FeatureFlags', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isEnabled', () => {
    it('should return false for disabled flag by default', () => {
      (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = undefined;
      
      const result = FeatureFlags.isEnabled('NEW_INTEGRATION_STRATEGY');
      
      expect(result).toBe(false);
    });

    it('should return true when flag is enabled via env', () => {
      (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = true;
      
      const result = FeatureFlags.isEnabled('NEW_INTEGRATION_STRATEGY');
      
      expect(result).toBe(true);
    });

    it('should return false for unknown flag and log warning', () => {
      const result = FeatureFlags.isEnabled('UNKNOWN_FLAG' as any);
      
      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        'Unknown feature flag requested',
        expect.objectContaining({ flagName: 'UNKNOWN_FLAG' })
      );
    });

    it('should log debug when flag is checked', () => {
      (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = undefined;
      
      FeatureFlags.isEnabled('NEW_INTEGRATION_STRATEGY');
      
      expect(logger.debug).toHaveBeenCalledWith(
        'Feature flag checked',
        expect.objectContaining({
          flag: 'NEW_INTEGRATION_STRATEGY',
        })
      );
    });
  });

  describe('getAllFlags', () => {
    it('should return all flags with their state', () => {
      (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = true;
      
      const result = FeatureFlags.getAllFlags();
      
      expect(result).toHaveProperty('NEW_INTEGRATION_STRATEGY');
      expect(result.NEW_INTEGRATION_STRATEGY).toBe(true);
    });
  });

  describe('getMetadata', () => {
    it('should return metadata for known flag', () => {
      const result = FeatureFlags.getMetadata('NEW_INTEGRATION_STRATEGY');
      
      expect(result).toBeDefined();
      expect(result?.name).toBe('NEW_INTEGRATION_STRATEGY');
      expect(result?.description).toBeTruthy();
      expect(result?.envVar).toBe('FEATURE_NEW_INTEGRATION_STRATEGY');
    });

    it('should return undefined for unknown flag', () => {
      const result = FeatureFlags.getMetadata('UNKNOWN_FLAG' as any);
      
      expect(result).toBeUndefined();
    });
  });

  describe('getAllMetadata', () => {
    it('should return array of all metadata', () => {
      const result = FeatureFlags.getAllMetadata();
      
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('description');
    });
  });

  describe('logCurrentState', () => {
    it('should log current state without throwing', () => {
      (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = false;
      
      expect(() => FeatureFlags.logCurrentState()).not.toThrow();
      expect(logger.info).toHaveBeenCalledWith(
        'Feature flags state',
        expect.objectContaining({ total: expect.any(Number) })
      );
    });
  });
});

describe('withFeatureFlag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should execute whenEnabled when flag is enabled', () => {
    (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = true;
    
    const whenEnabled = jest.fn().mockReturnValue('enabled');
    const whenDisabled = jest.fn().mockReturnValue('disabled');
    
    const result = withFeatureFlag('NEW_INTEGRATION_STRATEGY', whenEnabled, whenDisabled);
    
    expect(result).toBe('enabled');
    expect(whenEnabled).toHaveBeenCalled();
    expect(whenDisabled).not.toHaveBeenCalled();
  });

  it('should execute whenDisabled when flag is disabled', () => {
    (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = false;
    
    const whenEnabled = jest.fn().mockReturnValue('enabled');
    const whenDisabled = jest.fn().mockReturnValue('disabled');
    
    const result = withFeatureFlag('NEW_INTEGRATION_STRATEGY', whenEnabled, whenDisabled);
    
    expect(result).toBe('disabled');
    expect(whenDisabled).toHaveBeenCalled();
    expect(whenEnabled).not.toHaveBeenCalled();
  });
});

describe('withFeatureFlagAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should execute whenEnabled async when flag is enabled', async () => {
    (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = true;
    
    const whenEnabled = jest.fn().mockResolvedValue('enabled');
    const whenDisabled = jest.fn().mockResolvedValue('disabled');
    
    const result = await withFeatureFlagAsync('NEW_INTEGRATION_STRATEGY', whenEnabled, whenDisabled);
    
    expect(result).toBe('enabled');
    expect(whenEnabled).toHaveBeenCalled();
    expect(whenDisabled).not.toHaveBeenCalled();
  });

  it('should execute whenDisabled async when flag is disabled', async () => {
    (env as any).FEATURE_NEW_INTEGRATION_STRATEGY = false;
    
    const whenEnabled = jest.fn().mockResolvedValue('enabled');
    const whenDisabled = jest.fn().mockResolvedValue('disabled');
    
    const result = await withFeatureFlagAsync('NEW_INTEGRATION_STRATEGY', whenEnabled, whenDisabled);
    
    expect(result).toBe('disabled');
    expect(whenDisabled).toHaveBeenCalled();
    expect(whenEnabled).not.toHaveBeenCalled();
  });
});
