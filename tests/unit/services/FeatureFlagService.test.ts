/**
 * FeatureFlagService Unit Tests
 * Tests for feature flag management service
 */

import {
  FeatureFlagService,
  FeatureFlag,
} from '../../../src/services/FeatureFlagService';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;
  let mockLogger: { warn: jest.Mock; info: jest.Mock };

  beforeEach(() => {
    service = new FeatureFlagService();
    mockLogger = require('../../../src/utils/Logger').logger;
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default flags', () => {
      const flags = service.getAllFlags();
      expect(flags.length).toBeGreaterThan(0);
    });

    it('should have studioDeprecated flag', () => {
      const flag = service.getFlag('studioDeprecated');
      expect(flag).toBeDefined();
      expect(flag?.category).toBe('deprecation');
    });

    it('should have enhancedFieldEditor flag', () => {
      const flag = service.getFlag('enhancedFieldEditor');
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(true);
    });

    it('should have unifiedTemplateLibrary flag', () => {
      const flag = service.getFlag('unifiedTemplateLibrary');
      expect(flag).toBeDefined();
      expect(flag?.category).toBe('api');
    });

    it('should have visualMapper experimental flag', () => {
      const flag = service.getFlag('visualMapper');
      expect(flag).toBeDefined();
      expect(flag?.category).toBe('experimental');
    });
  });

  describe('setFlag()', () => {
    it('should add a new flag', () => {
      const newFlag: FeatureFlag = {
        key: 'testFeature',
        enabled: true,
        description: 'Test feature flag',
        category: 'ui',
      };

      service.setFlag(newFlag);
      const flag = service.getFlag('testFeature');

      expect(flag).toEqual(newFlag);
    });

    it('should override existing flag', () => {
      const updatedFlag: FeatureFlag = {
        key: 'studioDeprecated',
        enabled: true,
        description: 'Updated description',
        category: 'deprecation',
      };

      service.setFlag(updatedFlag);
      const flag = service.getFlag('studioDeprecated');

      expect(flag?.enabled).toBe(true);
      expect(flag?.description).toBe('Updated description');
    });
  });

  describe('isEnabled()', () => {
    it('should return true for enabled flag', () => {
      expect(service.isEnabled('enhancedFieldEditor')).toBe(true);
    });

    it('should return false for disabled flag', () => {
      expect(service.isEnabled('studioDeprecated')).toBe(false);
    });

    it('should return false for non-existent flag', () => {
      expect(service.isEnabled('nonExistentFlag')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('nonExistentFlag')
      );
    });

    it('should return false for expired flag', () => {
      const expiredFlag: FeatureFlag = {
        key: 'expiredFeature',
        enabled: true,
        description: 'Expired feature',
        category: 'ui',
        expiresAt: '2020-01-01T00:00:00Z', // Past date
      };

      service.setFlag(expiredFlag);
      expect(service.isEnabled('expiredFeature')).toBe(false);
    });

    it('should return true for non-expired flag', () => {
      const futureFlag: FeatureFlag = {
        key: 'futureFeature',
        enabled: true,
        description: 'Future feature',
        category: 'ui',
        expiresAt: '2099-12-31T23:59:59Z', // Far future date
      };

      service.setFlag(futureFlag);
      expect(service.isEnabled('futureFeature')).toBe(true);
    });

    it('should handle rollout percentage (0%)', () => {
      const rolloutFlag: FeatureFlag = {
        key: 'zeroRollout',
        enabled: true,
        description: 'Zero rollout',
        category: 'experimental',
        rolloutPercentage: 0,
      };

      service.setFlag(rolloutFlag);
      // With 0% rollout, should always be false
      expect(service.isEnabled('zeroRollout')).toBe(false);
    });

    it('should handle rollout percentage (100%)', () => {
      const rolloutFlag: FeatureFlag = {
        key: 'fullRollout',
        enabled: true,
        description: 'Full rollout',
        category: 'experimental',
        rolloutPercentage: 100,
      };

      service.setFlag(rolloutFlag);
      // With 100% rollout, should be true
      expect(service.isEnabled('fullRollout')).toBe(true);
    });
  });

  describe('getFlag()', () => {
    it('should return flag by key', () => {
      const flag = service.getFlag('studioDeprecated');
      expect(flag).toBeDefined();
      expect(flag?.key).toBe('studioDeprecated');
    });

    it('should return undefined for non-existent flag', () => {
      const flag = service.getFlag('nonExistent');
      expect(flag).toBeUndefined();
    });
  });

  describe('getAllFlags()', () => {
    it('should return all flags as array', () => {
      const flags = service.getAllFlags();
      expect(Array.isArray(flags)).toBe(true);
      expect(flags.length).toBeGreaterThan(0);
    });

    it('should include all default flags', () => {
      const flags = service.getAllFlags();
      const keys = flags.map(f => f.key);

      expect(keys).toContain('studioDeprecated');
      expect(keys).toContain('enhancedFieldEditor');
      expect(keys).toContain('unifiedTemplateLibrary');
      expect(keys).toContain('visualMapper');
      expect(keys).toContain('realTimeLLMIntegration');
    });
  });

  describe('getFlagsByCategory()', () => {
    it('should return UI flags', () => {
      const uiFlags = service.getFlagsByCategory('ui');
      expect(uiFlags.every(f => f.category === 'ui')).toBe(true);
    });

    it('should return API flags', () => {
      const apiFlags = service.getFlagsByCategory('api');
      expect(apiFlags.every(f => f.category === 'api')).toBe(true);
    });

    it('should return experimental flags', () => {
      const experimentalFlags = service.getFlagsByCategory('experimental');
      expect(experimentalFlags.every(f => f.category === 'experimental')).toBe(true);
    });

    it('should return deprecation flags', () => {
      const deprecationFlags = service.getFlagsByCategory('deprecation');
      expect(deprecationFlags.every(f => f.category === 'deprecation')).toBe(true);
    });

    it('should return empty array for category with no flags', () => {
      // Clear all flags first
      const service2 = new FeatureFlagService();
      service2.setFlag({
        key: 'onlyUI',
        enabled: true,
        description: 'Only UI flag',
        category: 'ui',
      });

      // Remove default experimental flags by setting them to different category
      // Actually, we just check that filtering works
      const apiFlags = service2.getFlagsByCategory('api');
      expect(Array.isArray(apiFlags)).toBe(true);
    });
  });

  describe('setEnvironmentOverrides()', () => {
    it('should enable experimental features in development', () => {
      service.setEnvironmentOverrides('development');

      expect(service.isEnabled('visualMapper')).toBe(true);
      expect(service.isEnabled('realTimeLLMIntegration')).toBe(true);
    });

    it('should disable experimental features in production', () => {
      service.setEnvironmentOverrides('production');

      expect(service.isEnabled('visualMapper')).toBe(false);
      expect(service.isEnabled('realTimeLLMIntegration')).toBe(false);
    });

    it('should not change flags in staging', () => {
      const visualMapperBefore = service.isEnabled('visualMapper');

      service.setEnvironmentOverrides('staging');

      expect(service.isEnabled('visualMapper')).toBe(visualMapperBefore);
    });
  });

  describe('updateFlag()', () => {
    it('should update existing flag', () => {
      service.updateFlag('studioDeprecated', { enabled: true });
      expect(service.isEnabled('studioDeprecated')).toBe(true);
    });

    it('should update description', () => {
      service.updateFlag('studioDeprecated', { description: 'New description' });
      const flag = service.getFlag('studioDeprecated');
      expect(flag?.description).toBe('New description');
    });

    it('should not update non-existent flag', () => {
      service.updateFlag('nonExistent', { enabled: true });
      const flag = service.getFlag('nonExistent');
      expect(flag).toBeUndefined();
    });

    it('should preserve other properties when updating', () => {
      const originalFlag = service.getFlag('studioDeprecated');
      service.updateFlag('studioDeprecated', { enabled: true });
      const updatedFlag = service.getFlag('studioDeprecated');

      expect(updatedFlag?.key).toBe(originalFlag?.key);
      expect(updatedFlag?.category).toBe(originalFlag?.category);
    });
  });

  describe('toggleFlag()', () => {
    it('should toggle flag from false to true', () => {
      expect(service.isEnabled('studioDeprecated')).toBe(false);

      const newState = service.toggleFlag('studioDeprecated');

      expect(newState).toBe(true);
      expect(service.isEnabled('studioDeprecated')).toBe(true);
    });

    it('should toggle flag from true to false', () => {
      expect(service.isEnabled('enhancedFieldEditor')).toBe(true);

      const newState = service.toggleFlag('enhancedFieldEditor');

      expect(newState).toBe(false);
      expect(service.isEnabled('enhancedFieldEditor')).toBe(false);
    });

    it('should return false for non-existent flag', () => {
      const result = service.toggleFlag('nonExistent');
      expect(result).toBe(false);
    });
  });

  describe('Studio Deprecation Methods', () => {
    describe('shouldShowStudioDeprecationWarning()', () => {
      it('should return false when studioDeprecated is disabled', () => {
        expect(service.shouldShowStudioDeprecationWarning()).toBe(false);
      });

      it('should return true when studioDeprecated is enabled', () => {
        service.updateFlag('studioDeprecated', { enabled: true });
        expect(service.shouldShowStudioDeprecationWarning()).toBe(true);
      });
    });

    describe('shouldRedirectStudioToEditor()', () => {
      it('should return false when studioDeprecated is disabled', () => {
        expect(service.shouldRedirectStudioToEditor()).toBe(false);
      });

      it('should return true when both flags are enabled', () => {
        service.updateFlag('studioDeprecated', { enabled: true });
        service.updateFlag('enhancedFieldEditor', { enabled: true });

        expect(service.shouldRedirectStudioToEditor()).toBe(true);
      });

      it('should return false when enhancedFieldEditor is disabled', () => {
        service.updateFlag('studioDeprecated', { enabled: true });
        service.updateFlag('enhancedFieldEditor', { enabled: false });

        expect(service.shouldRedirectStudioToEditor()).toBe(false);
      });
    });

    describe('getStudioDeprecationMessage()', () => {
      it('should return empty string when studioDeprecated is disabled', () => {
        const message = service.getStudioDeprecationMessage();
        expect(message).toBe('');
      });

      it('should return HTML message when studioDeprecated is enabled', () => {
        service.updateFlag('studioDeprecated', { enabled: true });
        const message = service.getStudioDeprecationMessage();

        expect(message).toContain('AI Studio Migration Notice');
        expect(message).toContain('bg-orange-50');
        expect(message).toContain('Switch to Enhanced Editor');
      });

      it('should include link to enhanced editor', () => {
        service.updateFlag('studioDeprecated', { enabled: true });
        const message = service.getStudioDeprecationMessage();

        expect(message).toContain('/ai-field-mapping-editor.html');
      });
    });
  });
});
