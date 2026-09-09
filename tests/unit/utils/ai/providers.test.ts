import { AIFieldMappingService } from '../../../../src/services/ai/AIFieldMappingService';
import { CloudAIProvider } from '../../../../src/utils/ai/CloudAIProvider';
import { LocalLLMProvider } from '../../../../src/utils/ai/LocalLLMProvider';
import { RuleBasedProvider } from '../../../../src/utils/ai/RuleBasedProvider';
import type { Logger } from '../../../../src/utils/Logger';

const createLogger = (): Logger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
});

describe('CloudAIProvider', () => {
  it('reports capabilities and connection status', async () => {
    const logger = createLogger();
    const provider = new CloudAIProvider(logger, { model: 'gpt-demo' });

    const capabilities = await provider.getCapabilities();
    expect(capabilities.features).toEqual([
      'Semantic analysis',
      'Confidence scoring',
      'Advanced transforms'
    ]);

    const suggestions = await provider.suggest('crm', 'erp', [{ id: 1, name: 'Sample' }]);
    expect(suggestions).toEqual([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
      { sourceField: 'name', targetField: 'name', transformationType: 'direct' }
    ]);

    const quality = await provider.assessQuality(suggestions);
    expect(quality).toEqual({ overallScore: 0.85, totalMappings: 2 });

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      message: "Cloud provider 'gpt-demo' reachable (demo)"
    });

    const withoutModel = new CloudAIProvider(logger);
    await expect(withoutModel.testConnection()).resolves.toEqual({
      ok: false,
      message: 'Cloud model not set'
    });
  });
});

describe('LocalLLMProvider', () => {
  it('provides offline capabilities and validates configuration', async () => {
    const logger = createLogger();
    const provider = new LocalLLMProvider(logger, { baseUrl: 'http://localhost:1234', model: 'local-model' });

    const capabilities = await provider.getCapabilities();
    expect(capabilities.features).toEqual(['Offline mappings']);

    const suggestions = await provider.suggest('crm', 'erp', [{ code: 'ABC' }]);
    expect(suggestions).toEqual([
      { sourceField: 'code', targetField: 'code', transformationType: 'direct' }
    ]);

    const quality = await provider.assessQuality(suggestions);
    expect(quality.totalMappings).toBe(1);

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      message: 'Local LLM at http://localhost:1234 (demo)'
    });

    const missingUrl = new LocalLLMProvider(logger);
    await expect(missingUrl.testConnection()).resolves.toEqual({
      ok: false,
      message: 'Local base URL not set'
    });
  });
});

describe('RuleBasedProvider', () => {
  it('delegates to AIFieldMappingService for suggestions', async () => {
    const logger = createLogger();
    const mappingSpy = jest
      .spyOn(AIFieldMappingService.prototype, 'suggestFieldMappings')
      .mockResolvedValue([
        { sourceField: 'firstName', targetField: 'firstName', transformationType: 'direct' as const }
      ]);

    const provider = new RuleBasedProvider(logger);
    const sample = [{ firstName: 'Ada', lastName: 'Lovelace' }];
    const suggestions = await provider.suggest('crm', 'erp', sample);

    expect(mappingSpy).toHaveBeenCalled();
    expect(suggestions).toEqual([
      { sourceField: 'firstName', targetField: 'firstName', transformationType: 'direct' }
    ]);

    await expect(provider.testConnection()).resolves.toEqual({
      ok: true,
      message: 'Rule-based provider ready'
    });

    mappingSpy.mockRestore();
  });
});
