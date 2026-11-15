import { AIProviderConfigService } from '../../../../src/utils/ai/AIProviderConfigService';
import { CloudAIProvider } from '../../../../src/utils/ai/CloudAIProvider';
import { LocalLLMProvider } from '../../../../src/utils/ai/LocalLLMProvider';
import { RuleBasedProvider } from '../../../../src/utils/ai/RuleBasedProvider';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}));

const fs = require('fs') as jest.Mocked<typeof import('fs')>;

const createLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
});

const instantiate = () => new AIProviderConfigService(createLogger() as any, 'config');

describe('AIProviderConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates default rule-based config when file is missing', () => {
    fs.existsSync
      .mockReturnValueOnce(false) // directory
      .mockReturnValueOnce(false); // config file

    const service = instantiate();
    expect(service.getConfig()).toEqual({ mode: 'rule-based' });
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();

    const provider = service.getProvider(createLogger() as any);
    expect(provider).toBeInstanceOf(RuleBasedProvider);
  });

  it('falls back to rule-based when config JSON is invalid', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('not-json');

    const logger = createLogger();
    const service = new AIProviderConfigService(logger as any, 'config');
    expect(service.getConfig()).toEqual({ mode: 'rule-based' });
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to load AI provider config; defaulting to rule-based',
      expect.any(Object)
    );
  });

  it('persists new config and resolves correct provider instance', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ mode: 'rule-based' }));

    const service = instantiate();
    service.setConfig({ mode: 'local-llm', local: { baseUrl: 'http://localhost:1234', model: 'local' } });
    expect(fs.writeFileSync).toHaveBeenCalled();

    const localProvider = service.getProvider(createLogger() as any);
    expect(localProvider).toBeInstanceOf(LocalLLMProvider);

    service.setConfig({ mode: 'cloud-api', cloud: { model: 'gpt-4o-mini' } });
    const cloudProvider = service.getProvider(createLogger() as any);
    expect(cloudProvider).toBeInstanceOf(CloudAIProvider);
  });
});
