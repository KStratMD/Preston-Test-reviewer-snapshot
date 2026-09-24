import { CloudAIProvider } from '../CloudAIProvider';
import { Logger } from '../../../../utils/Logger';

describe('CloudAIProvider', () => {
  let provider: CloudAIProvider;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test');
  });

  it('should be available', () => {
    provider = new CloudAIProvider(logger);
    expect(provider.isAvailable).toBe(true);
  });

  it('should have the correct mode', () => {
    provider = new CloudAIProvider(logger);
    expect(provider.mode).toBe('cloud-api');
  });

  it('should return capabilities', async () => {
    provider = new CloudAIProvider(logger);
    const capabilities = await provider.getCapabilities();
    expect(capabilities.name).toBe('Cloud AI Provider');
    expect(capabilities.features).toEqual([
      'Semantic field analysis',
      'Confidence scoring',
      'Advanced transformations',
    ]);
  });

  it('should suggest mappings', async () => {
    provider = new CloudAIProvider(logger);
    const suggestions = await provider.suggest('source', 'target', [{ id: 1, name: 'test' }]);
    expect(suggestions).toEqual([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
      { sourceField: 'name', targetField: 'name', transformationType: 'direct' },
    ]);
  });

  it('should assess quality', async () => {
    provider = new CloudAIProvider(logger);
    const quality = await provider.assessQuality([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
    ]);
    expect(quality.overallScore).toBe(0.85);
    expect(quality.totalMappings).toBe(1);
  });

  describe('testConnection', () => {
    it('should return true when model is set', async () => {
      provider = new CloudAIProvider(logger, { model: 'test-model' });
      const connection = await provider.testConnection();
      expect(connection.ok).toBe(true);
      expect(connection.message).toBe("Cloud provider 'test-model' reachable (demo)");
    });

    it('should return false when model is not set', async () => {
      provider = new CloudAIProvider(logger);
      const connection = await provider.testConnection();
      expect(connection.ok).toBe(false);
      expect(connection.message).toBe('Cloud model not set');
    });
  });
});
