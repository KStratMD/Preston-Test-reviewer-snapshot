import { RuleBasedProvider } from '../RuleBasedProvider';
import { Logger } from '../../../../utils/Logger';

describe('RuleBasedProvider', () => {
  let provider: RuleBasedProvider;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test');
    provider = new RuleBasedProvider(logger);
  });

  it('should be available', () => {
    expect(provider.isAvailable).toBe(true);
  });

  it('should have the correct mode', () => {
    expect(provider.mode).toBe('rule-based');
  });

  it('should return capabilities', async () => {
    const capabilities = await provider.getCapabilities();
    expect(capabilities.name).toBe('Rule-based Mapper');
    expect(capabilities.features).toEqual([
      'Semantic field analysis',
      'Pattern recognition',
      'Data type inference',
    ]);
  });

  it('should suggest mappings', async () => {
    const suggestions = await provider.suggest('source', 'target', [{ id: 1, name: 'test' }]);
        expect(suggestions).toEqual([
              { sourceField: 'id', targetField: 'id', transformationType: 'lookup' },      { sourceField: 'name', targetField: 'name', transformationType: 'direct' },
    ]);
  });

  it('should assess quality', async () => {
    const quality = await provider.assessQuality([
      { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
    ]);
    expect(quality.overallScore).toBe(0.9);
    expect(quality.totalMappings).toBe(1);
  });

  it('should test connection', async () => {
    const connection = await provider.testConnection();
    expect(connection.ok).toBe(true);
    expect(connection.message).toBe('Rule-based provider ready');
  });
});
