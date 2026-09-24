/**
 * Feature Flags Route Tests
 * Session 12 - Testing feature flag management endpoints
 */

import request from 'supertest';
import express from 'express';

// Mock featureFlagService singleton before requiring the route
const mockGetAllFlags = jest.fn();
const mockGetFlagsByCategory = jest.fn();
const mockIsEnabled = jest.fn();
const mockGetFlag = jest.fn();
const mockUpdateFlag = jest.fn();
const mockToggleFlag = jest.fn();
const mockShouldRedirectStudioToEditor = jest.fn();
const mockShouldShowStudioDeprecationWarning = jest.fn();
const mockGetStudioDeprecationMessage = jest.fn();

jest.mock('../../../../src/services/FeatureFlagService', () => ({
  featureFlagService: {
    getAllFlags: mockGetAllFlags,
    getFlagsByCategory: mockGetFlagsByCategory,
    isEnabled: mockIsEnabled,
    getFlag: mockGetFlag,
    updateFlag: mockUpdateFlag,
    toggleFlag: mockToggleFlag,
    shouldRedirectStudioToEditor: mockShouldRedirectStudioToEditor,
    shouldShowStudioDeprecationWarning: mockShouldShowStudioDeprecationWarning,
    getStudioDeprecationMessage: mockGetStudioDeprecationMessage,
  },
}));

function createTestApp() {
  const app = express();
  app.use(express.json());

  const { createFeatureFlagsRouter } = require('../../../../src/routes/featureFlags');
  const router = createFeatureFlagsRouter();

  app.use('/api/feature-flags', router);
  return app;
}

describe('Feature Flags Route', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  describe('GET /api/feature-flags', () => {
    it('should return all feature flags', async () => {
      const mockFlags = [
        { key: 'ai-suggestions', enabled: true, category: 'ai', description: 'Enable AI suggestions' },
        { key: 'beta-features', enabled: false, category: 'experimental', description: 'Beta features' },
        { key: 'advanced-mapping', enabled: true, category: 'mapping', description: 'Advanced mapping' },
      ];

      mockGetAllFlags.mockReturnValue(mockFlags);

      const response = await request(app)
        .get('/api/feature-flags')
        .expect(200);

      expect(response.body.flags).toEqual(mockFlags);
      expect(response.body.flags).toHaveLength(3);
      expect(mockGetAllFlags).toHaveBeenCalled();
    });

    it('should return empty array when no flags exist', async () => {
      mockGetAllFlags.mockReturnValue([]);

      const response = await request(app)
        .get('/api/feature-flags')
        .expect(200);

      expect(response.body.flags).toEqual([]);
      expect(mockGetAllFlags).toHaveBeenCalled();
    });
  });

  describe('GET /api/feature-flags/category/:category', () => {
    it('should return flags for specific category', async () => {
      const mockFlags = [
        { key: 'ai-suggestions', enabled: true, category: 'ai', description: 'Enable AI suggestions' },
        { key: 'ai-validation', enabled: false, category: 'ai', description: 'AI validation' },
      ];

      mockGetFlagsByCategory.mockReturnValue(mockFlags);

      const response = await request(app)
        .get('/api/feature-flags/category/ai')
        .expect(200);

      expect(response.body.flags).toEqual(mockFlags);
      expect(response.body.category).toBe('ai');
      expect(mockGetFlagsByCategory).toHaveBeenCalledWith('ai');
    });

    it('should return empty array for category with no flags', async () => {
      mockGetFlagsByCategory.mockReturnValue([]);

      const response = await request(app)
        .get('/api/feature-flags/category/nonexistent')
        .expect(200);

      expect(response.body.flags).toEqual([]);
      expect(response.body.category).toBe('nonexistent');
      expect(mockGetFlagsByCategory).toHaveBeenCalledWith('nonexistent');
    });

    it('should handle experimental category', async () => {
      const mockFlags = [
        { key: 'beta-features', enabled: false, category: 'experimental', description: 'Beta features' },
      ];

      mockGetFlagsByCategory.mockReturnValue(mockFlags);

      const response = await request(app)
        .get('/api/feature-flags/category/experimental')
        .expect(200);

      expect(response.body.flags).toEqual(mockFlags);
      expect(response.body.category).toBe('experimental');
    });

    it('should handle mapping category', async () => {
      const mockFlags = [
        { key: 'advanced-mapping', enabled: true, category: 'mapping', description: 'Advanced mapping' },
      ];

      mockGetFlagsByCategory.mockReturnValue(mockFlags);

      const response = await request(app)
        .get('/api/feature-flags/category/mapping')
        .expect(200);

      expect(response.body.flags).toEqual(mockFlags);
      expect(response.body.category).toBe('mapping');
    });
  });

  describe('GET /api/feature-flags/:key', () => {
    it('should return flag details when flag exists', async () => {
      const mockFlag = {
        key: 'ai-suggestions',
        enabled: true,
        category: 'ai',
        description: 'Enable AI suggestions',
      };

      mockIsEnabled.mockReturnValue(true);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .get('/api/feature-flags/ai-suggestions')
        .expect(200);

      expect(response.body.key).toBe('ai-suggestions');
      expect(response.body.enabled).toBe(true);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockIsEnabled).toHaveBeenCalledWith('ai-suggestions');
      expect(mockGetFlag).toHaveBeenCalledWith('ai-suggestions');
    });

    it('should return disabled flag when flag does not exist', async () => {
      mockIsEnabled.mockReturnValue(false);
      mockGetFlag.mockReturnValue(null);

      const response = await request(app)
        .get('/api/feature-flags/nonexistent')
        .expect(200);

      expect(response.body.key).toBe('nonexistent');
      expect(response.body.enabled).toBe(false);
      expect(response.body.flag).toBe(null);
    });

    it('should handle disabled flag', async () => {
      const mockFlag = {
        key: 'beta-features',
        enabled: false,
        category: 'experimental',
        description: 'Beta features',
      };

      mockIsEnabled.mockReturnValue(false);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .get('/api/feature-flags/beta-features')
        .expect(200);

      expect(response.body.key).toBe('beta-features');
      expect(response.body.enabled).toBe(false);
      expect(response.body.flag).toEqual(mockFlag);
    });
  });

  describe('PUT /api/feature-flags/:key', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('should return 403 in production environment', async () => {
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .put('/api/feature-flags/ai-suggestions')
        .send({ enabled: true })
        .expect(403);

      expect(response.body.error).toBe('Feature flag updates are disabled in production');
      expect(mockUpdateFlag).not.toHaveBeenCalled();
    });

    it('should update flag in development environment', async () => {
      process.env.NODE_ENV = 'development';

      const mockFlag = {
        key: 'ai-suggestions',
        enabled: true,
        category: 'ai',
        description: 'Updated description',
      };

      mockUpdateFlag.mockReturnValue(undefined);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .put('/api/feature-flags/ai-suggestions')
        .send({ enabled: true, description: 'Updated description' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockUpdateFlag).toHaveBeenCalledWith('ai-suggestions', { enabled: true, description: 'Updated description' });
      expect(mockGetFlag).toHaveBeenCalledWith('ai-suggestions');
    });

    it('should update flag in test environment', async () => {
      process.env.NODE_ENV = 'test';

      const mockFlag = {
        key: 'beta-features',
        enabled: false,
        category: 'experimental',
        description: 'Beta features',
      };

      mockUpdateFlag.mockReturnValue(undefined);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .put('/api/feature-flags/beta-features')
        .send({ enabled: false })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockUpdateFlag).toHaveBeenCalledWith('beta-features', { enabled: false });
    });

    it('should handle update without description', async () => {
      process.env.NODE_ENV = 'development';

      const mockFlag = {
        key: 'test-flag',
        enabled: true,
        category: 'test',
        description: 'Test flag',
      };

      mockUpdateFlag.mockReturnValue(undefined);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .put('/api/feature-flags/test-flag')
        .send({ enabled: true })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockUpdateFlag).toHaveBeenCalledWith('test-flag', { enabled: true });
    });
  });

  describe('POST /api/feature-flags/:key/toggle', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('should return 403 in production environment', async () => {
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .post('/api/feature-flags/ai-suggestions/toggle')
        .expect(403);

      expect(response.body.error).toBe('Feature flag toggles are disabled in production');
      expect(mockToggleFlag).not.toHaveBeenCalled();
    });

    it('should toggle flag in development environment', async () => {
      process.env.NODE_ENV = 'development';

      const mockFlag = {
        key: 'ai-suggestions',
        enabled: false,
        category: 'ai',
        description: 'Enable AI suggestions',
      };

      mockToggleFlag.mockReturnValue(false);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .post('/api/feature-flags/ai-suggestions/toggle')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.key).toBe('ai-suggestions');
      expect(response.body.enabled).toBe(false);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockToggleFlag).toHaveBeenCalledWith('ai-suggestions');
    });

    it('should toggle flag in test environment', async () => {
      process.env.NODE_ENV = 'test';

      const mockFlag = {
        key: 'beta-features',
        enabled: true,
        category: 'experimental',
        description: 'Beta features',
      };

      mockToggleFlag.mockReturnValue(true);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .post('/api/feature-flags/beta-features/toggle')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.key).toBe('beta-features');
      expect(response.body.enabled).toBe(true);
      expect(response.body.flag).toEqual(mockFlag);
      expect(mockToggleFlag).toHaveBeenCalledWith('beta-features');
    });

    it('should toggle from enabled to disabled', async () => {
      process.env.NODE_ENV = 'development';

      const mockFlag = {
        key: 'advanced-mapping',
        enabled: false,
        category: 'mapping',
        description: 'Advanced mapping',
      };

      mockToggleFlag.mockReturnValue(false);
      mockGetFlag.mockReturnValue(mockFlag);

      const response = await request(app)
        .post('/api/feature-flags/advanced-mapping/toggle')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.key).toBe('advanced-mapping');
      expect(response.body.enabled).toBe(false);
      expect(response.body.flag).toEqual(mockFlag);
    });
  });

  describe('GET /api/feature-flags/studio/status', () => {
    it('should return studio status with redirect enabled', async () => {
      mockIsEnabled.mockImplementation((key: string) => {
        if (key === 'studioDeprecated') return true;
        if (key === 'enhancedFieldEditor') return true;
        return false;
      });
      mockShouldRedirectStudioToEditor.mockReturnValue(true);
      mockShouldShowStudioDeprecationWarning.mockReturnValue(false);
      mockGetStudioDeprecationMessage.mockReturnValue('');

      const response = await request(app)
        .get('/api/feature-flags/studio/status')
        .expect(200);

      expect(response.body.studioDeprecated).toBe(true);
      expect(response.body.enhancedEditor).toBe(true);
      expect(response.body.shouldRedirect).toBe(true);
      expect(response.body.showWarning).toBe(false);
      expect(response.body.deprecationMessage).toBe(null);
      expect(mockShouldRedirectStudioToEditor).toHaveBeenCalled();
      expect(mockShouldShowStudioDeprecationWarning).toHaveBeenCalled();
    });

    it('should return studio status with warning enabled', async () => {
      mockIsEnabled.mockImplementation((key: string) => {
        if (key === 'studioDeprecated') return true;
        if (key === 'enhancedFieldEditor') return false;
        return false;
      });
      mockShouldRedirectStudioToEditor.mockReturnValue(false);
      mockShouldShowStudioDeprecationWarning.mockReturnValue(true);
      mockGetStudioDeprecationMessage.mockReturnValue('Studio is deprecated. Please use the new editor.');

      const response = await request(app)
        .get('/api/feature-flags/studio/status')
        .expect(200);

      expect(response.body.studioDeprecated).toBe(true);
      expect(response.body.enhancedEditor).toBe(false);
      expect(response.body.shouldRedirect).toBe(false);
      expect(response.body.showWarning).toBe(true);
      expect(response.body.deprecationMessage).toBe('Studio is deprecated. Please use the new editor.');
    });

    it('should return studio status with no redirect or warning', async () => {
      mockIsEnabled.mockImplementation((key: string) => {
        if (key === 'studioDeprecated') return false;
        if (key === 'enhancedFieldEditor') return true;
        return false;
      });
      mockShouldRedirectStudioToEditor.mockReturnValue(false);
      mockShouldShowStudioDeprecationWarning.mockReturnValue(false);
      mockGetStudioDeprecationMessage.mockReturnValue('');

      const response = await request(app)
        .get('/api/feature-flags/studio/status')
        .expect(200);

      expect(response.body.studioDeprecated).toBe(false);
      expect(response.body.enhancedEditor).toBe(true);
      expect(response.body.shouldRedirect).toBe(false);
      expect(response.body.showWarning).toBe(false);
      expect(response.body.deprecationMessage).toBe(null);
    });

    it('should return studio status with both redirect and warning', async () => {
      mockIsEnabled.mockImplementation((key: string) => {
        if (key === 'studioDeprecated') return true;
        if (key === 'enhancedFieldEditor') return true;
        return false;
      });
      mockShouldRedirectStudioToEditor.mockReturnValue(true);
      mockShouldShowStudioDeprecationWarning.mockReturnValue(true);
      mockGetStudioDeprecationMessage.mockReturnValue('Studio will be removed soon.');

      const response = await request(app)
        .get('/api/feature-flags/studio/status')
        .expect(200);

      expect(response.body.studioDeprecated).toBe(true);
      expect(response.body.enhancedEditor).toBe(true);
      expect(response.body.shouldRedirect).toBe(true);
      expect(response.body.showWarning).toBe(true);
      expect(response.body.deprecationMessage).toBe('Studio will be removed soon.');
    });
  });
});
