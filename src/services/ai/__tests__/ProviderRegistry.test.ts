import { ProviderRegistry, type AIProvider, type MappingContext, type AISuggestion, type DataContext, type QualityAssessment } from '../ProviderRegistry';
import { Logger } from '../../../utils/Logger';

class StubProvider implements AIProvider {
  public readonly name = 'StubProvider';
  public readonly version = '1.0.0';

  constructor(private readonly healthFn: jest.Mock<Promise<{ ok: boolean; message?: string }>>) {}

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    return this.healthFn();
  }

  async generateMappingSuggestions(_context: MappingContext): Promise<AISuggestion[]> {
    return [];
  }

  async analyzeDataQuality(_data: Record<string, unknown>[], _context: DataContext): Promise<QualityAssessment> {
    return { overallScore: 1, issues: [], recommendations: [] };
  }
}

function createRegistry(): ProviderRegistry {
  const logger = new Logger('ProviderRegistryTest');
  return new ProviderRegistry(logger);
}

describe('ProviderRegistry', () => {
  it('caches provider health status between lookups', async () => {
    const healthSpy = jest.fn().mockResolvedValue({ ok: true, message: 'ok' });
    const registry = createRegistry();
    registry.register('stub', new StubProvider(healthSpy));

    await registry.getAvailableProvider('stub');
    await registry.getAvailableProvider('stub');

    expect(healthSpy).toHaveBeenCalledTimes(1);
  });
});
