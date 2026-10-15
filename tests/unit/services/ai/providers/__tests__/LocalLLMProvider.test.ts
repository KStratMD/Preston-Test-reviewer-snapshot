import { LocalLLMProvider } from '../LocalLLMProvider';
import { Logger } from '../../../../utils/Logger';

describe('LocalLLMProvider', () => {
  let provider: LocalLLMProvider;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test');
  });

  it('should be available', () => {
    provider = new LocalLLMProvider(logger);
    expect(provider.isAvailable).toBe(true);
  });

  it('should have the correct mode', () => {
    provider = new LocalLLMProvider(logger);
    expect(provider.mode).toBe('local-llm');
  });

  it('should return capabilities', async () => {
    provider = new LocalLLMProvider(logger);
    const capabilities = await provider.getCapabilities();
    expect(capabilities.name).toBe('Local LLM Provider');
    expect(capabilities.features).toEqual(['Offline mappings', 'Deterministic prompts (demo)']);
  });

  it('should suggest mappings', async () => {
    provider = new LocalLLMProvider(logger);
    const suggestions = await provider.suggest('source', 'target', [{ id: 1, name: 'test' }]);
    expect(suggestions).toEqual([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
      { sourceField: 'name', targetField: 'name', transformationType: 'direct' },
    ]);
  });

  it('should assess quality', async () => {
    provider = new LocalLLMProvider(logger);
    const quality = await provider.assessQuality([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
    ]);
    expect(quality.overallScore).toBe(0.8);
    expect(quality.totalMappings).toBe(1);
  });

  describe('testConnection', () => {
    it('should return true when baseUrl is set', async () => {
      provider = new LocalLLMProvider(logger, { baseUrl: 'http://localhost:8080' });
      const connection = await provider.testConnection();
      expect(connection.ok).toBe(true);
      expect(connection.message).toBe('Local LLM at http://localhost:8080 (demo)');
    });

    it('should return false when baseUrl is not set', async () => {
      provider = new LocalLLMProvider(logger);
      const connection = await provider.testConnection();
      expect(connection.ok).toBe(false);
      expect(connection.message).toBe('Local base URL not set');
    });
  });
});
