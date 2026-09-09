/**
 * Comprehensive unit tests for AIConfigurationBridge
 * Covers: initialize, isConfiguredForFieldMapping, getActiveProvider,
 *         getTaskConfig, getFieldMappingStatus, refresh, clearCache
 */
import 'reflect-metadata';
import { AIConfigurationBridge } from '../../../../src/services/ai/AIConfigurationBridge';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeProviderConfig(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    providerName: 'OpenAI',
    providerType: 'openai',
    isDefault: true,
    isActive: true,
    apiKey: 'sk-test-key',
    ...overrides,
  };
}

function makeTaskConfig(overrides: Record<string, any> = {}) {
  return {
    taskModelConfigId: 10,
    providerConfigId: 1,
    providerType: 'openai',
    providerName: 'OpenAI',
    modelVersion: 'gpt-4o',
    modelParameters: { temperature: 0.3 },
    priority: 1,
    ...overrides,
  };
}

function makeMockAIConfigService(overrides: Record<string, any> = {}) {
  const defaultProvider = makeProviderConfig();
  const taskConfig = makeTaskConfig();
  return {
    getProviderConfigs: jest.fn().mockResolvedValue([defaultProvider]),
    getTaskModelConfig: jest.fn().mockResolvedValue(taskConfig),
    ...overrides,
  } as any;
}

describe('AIConfigurationBridge', () => {
  let bridge: AIConfigurationBridge;
  let mockAIConfig: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAIConfig = makeMockAIConfigService();
    bridge = new AIConfigurationBridge(mockLogger, mockAIConfig);
  });

  describe('initialize', () => {
    it('should fetch providers and task configs', async () => {
      await bridge.initialize(1);
      expect(mockAIConfig.getProviderConfigs).toHaveBeenCalledWith(1);
      expect(mockAIConfig.getTaskModelConfig).toHaveBeenCalledWith(1, 'field_mapping');
    });

    it('should log successful initialization', async () => {
      await bridge.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI Configuration Bridge initialized',
        expect.objectContaining({ activeProvider: 'OpenAI' })
      );
    });

    it('should use cached values on subsequent calls', async () => {
      await bridge.initialize(1);
      await bridge.initialize(1);
      // Should only call once due to cache
      expect(mockAIConfig.getProviderConfigs).toHaveBeenCalledTimes(1);
    });

    it('should handle no active provider', async () => {
      mockAIConfig.getProviderConfigs.mockResolvedValue([
        makeProviderConfig({ isDefault: false }),
      ]);
      await bridge.initialize();
      const provider = await bridge.getActiveProvider();
      expect(provider).toBeNull();
    });

    it('should throw on initialization error', async () => {
      mockAIConfig.getProviderConfigs.mockRejectedValue(new Error('DB error'));
      await expect(bridge.initialize()).rejects.toThrow('DB error');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('isConfiguredForFieldMapping', () => {
    it('should return true when task and provider exist', async () => {
      const result = await bridge.isConfiguredForFieldMapping();
      expect(result).toBe(true);
    });

    it('should return false when no task config', async () => {
      mockAIConfig.getTaskModelConfig.mockResolvedValue(null);
      const result = await bridge.isConfiguredForFieldMapping();
      expect(result).toBe(false);
    });

    it('should return false when task has no model version', async () => {
      mockAIConfig.getTaskModelConfig.mockResolvedValue(
        makeTaskConfig({ modelVersion: '' })
      );
      const result = await bridge.isConfiguredForFieldMapping();
      expect(result).toBe(false);
    });

    it('should return true when task has own provider (no default)', async () => {
      mockAIConfig.getProviderConfigs.mockResolvedValue([
        makeProviderConfig({ isDefault: false }),
      ]);
      mockAIConfig.getTaskModelConfig.mockResolvedValue(
        makeTaskConfig({ providerConfigId: 5 })
      );
      const result = await bridge.isConfiguredForFieldMapping();
      expect(result).toBe(true);
    });
  });

  describe('getActiveProvider', () => {
    it('should return the default active provider', async () => {
      const provider = await bridge.getActiveProvider();
      expect(provider).toBeDefined();
      expect(provider!.providerName).toBe('OpenAI');
    });

    it('should return null when no default active provider', async () => {
      mockAIConfig.getProviderConfigs.mockResolvedValue([]);
      const provider = await bridge.getActiveProvider();
      expect(provider).toBeNull();
    });
  });

  describe('getTaskConfig', () => {
    it('should return task config for field_mapping', async () => {
      await bridge.initialize();
      const config = await bridge.getTaskConfig('field_mapping');
      expect(config).toBeDefined();
      expect(config!.modelVersion).toBe('gpt-4o');
    });

    it('should return null for unknown task type', async () => {
      await bridge.initialize();
      const config = await bridge.getTaskConfig('unknown_task');
      expect(config).toBeNull();
    });
  });

  describe('getFieldMappingStatus', () => {
    it('should return configured status with provider info', async () => {
      const status = await bridge.getFieldMappingStatus();
      expect(status.configured).toBe(true);
      expect(status.activeProvider).toBeDefined();
      expect(status.fieldMappingTask).toBeDefined();
      expect(status.message).toContain('AI configured');
    });

    it('should return not-configured when no task', async () => {
      mockAIConfig.getTaskModelConfig.mockResolvedValue(null);
      const status = await bridge.getFieldMappingStatus();
      expect(status.configured).toBe(false);
      expect(status.message).toContain('not configured');
    });

    it('should return not-configured when no model version', async () => {
      mockAIConfig.getTaskModelConfig.mockResolvedValue(
        makeTaskConfig({ modelVersion: '' })
      );
      const status = await bridge.getFieldMappingStatus();
      expect(status.configured).toBe(false);
      expect(status.message).toContain('No model selected');
    });

    it('should prefer task-specific provider in message', async () => {
      mockAIConfig.getTaskModelConfig.mockResolvedValue(
        makeTaskConfig({ providerConfigId: 5, providerName: 'Claude' })
      );
      const status = await bridge.getFieldMappingStatus();
      expect(status.message).toContain('Claude');
    });

    it('should strip apiKey from response', async () => {
      const status = await bridge.getFieldMappingStatus();
      expect(status.fieldMappingTask!.apiKey).toBeUndefined();
    });

    it('should force refresh when requested', async () => {
      await bridge.getFieldMappingStatus();
      await bridge.getFieldMappingStatus(1, true);
      // Force refresh clears cache, so getProviderConfigs should be called again
      expect(mockAIConfig.getProviderConfigs).toHaveBeenCalledTimes(2);
    });
  });

  describe('refresh', () => {
    it('should invalidate cache and re-initialize', async () => {
      await bridge.initialize();
      await bridge.refresh();
      expect(mockAIConfig.getProviderConfigs).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached data', async () => {
      await bridge.initialize();
      bridge.clearCache();
      // After clear, next call should re-fetch
      await bridge.getActiveProvider();
      expect(mockAIConfig.getProviderConfigs).toHaveBeenCalledTimes(2);
    });
  });
});
