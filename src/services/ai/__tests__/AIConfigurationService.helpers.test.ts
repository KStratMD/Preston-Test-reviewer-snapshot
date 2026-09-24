import { AIConfigurationService } from '../AIConfigurationService';
import type { DatabaseService } from '../../../database/DatabaseService';
import type {
  AIProviderConfig as AIProviderConfigSelectable,
  AITaskModelConfig as AITaskModelConfigSelectable,
} from '../../../database/types';

describe('AIConfigurationService helpers', () => {
  let service: AIConfigurationService;
  let originalDbType: string | undefined;
  let originalOpenAiKey: string | undefined;
  let originalOpenRouterKey: string | undefined;
  let originalGrokKey: string | undefined;
  let originalXaiGrokKey: string | undefined;

  beforeEach(() => {
    originalDbType = process.env.DB_TYPE;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    originalGrokKey = process.env.GROK_API_KEY;
    originalXaiGrokKey = process.env.XAI_GROK_API_KEY;

    const mockDbService: Partial<DatabaseService> = {
      getDatabase: () => ({}) as never,
    };

    service = new AIConfigurationService(mockDbService as DatabaseService, undefined as never);
  });

  afterEach(() => {
    if (originalDbType === undefined) {
      delete process.env.DB_TYPE;
    } else {
      process.env.DB_TYPE = originalDbType;
    }

    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }

    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }

    if (originalGrokKey === undefined) {
      delete process.env.GROK_API_KEY;
    } else {
      process.env.GROK_API_KEY = originalGrokKey;
    }

    if (originalXaiGrokKey === undefined) {
      delete process.env.XAI_GROK_API_KEY;
    } else {
      process.env.XAI_GROK_API_KEY = originalXaiGrokKey;
    }
  });

  it('converts nested booleans to 1/0 for sqlite', () => {
    process.env.DB_TYPE = 'sqlite';
    const input = {
      nested: {
        flag: true,
        items: [false, { deep: true }],
      },
    };

    const result = (service as any).convertNestedBooleans(input);

    expect(result).toEqual({
      nested: {
        flag: 1,
        items: [0, { deep: 1 }],
      },
    });
    expect(result).not.toBe(input);
  });

  it('leaves nested booleans untouched for postgres', () => {
    process.env.DB_TYPE = 'postgres';
    const input = { nested: { flag: true } };

    const result = (service as any).convertNestedBooleans(input);

    expect(result).toBe(input);
  });

  it('maps provider rows to strongly typed configurations with env fallback', async () => {
    process.env.DB_TYPE = 'postgres';
    process.env.OPENAI_API_KEY = 'env-fallback-key';

    const now = new Date('2025-01-15T12:34:56.000Z');
    const row = {
      id: 7,
      user_id: 42,
      organization_id: null,
      provider_type: 'OPENAI',
      provider_name: 'OpenAI',
      encrypted_api_key: null,
      endpoint_url: null,
      is_active: true,
      is_default: false,
      configuration: '{"model":"gpt-4o"}',
      created_at: now,
      updated_at: now,
    } as unknown as AIProviderConfigSelectable;

    const config = await (service as any).mapDbRowToProviderConfig(row);

    expect(config).toMatchObject({
      id: 7,
      userId: 42,
      providerType: 'openai',
      providerName: 'OpenAI',
      isActive: true,
      isDefault: false,
      configuration: { model: 'gpt-4o' },
      apiKey: 'env-fallback-key',
      hasApiKey: true,
    });
    expect(config.createdAt?.toISOString()).toBe(now.toISOString());
    expect(config.updatedAt?.toISOString()).toBe(now.toISOString());
  });

  it('maps task model rows and normalizes provider metadata', () => {
    process.env.DB_TYPE = 'sqlite';

    const created = new Date('2025-02-01T10:00:00.000Z');
    const updated = new Date('2025-02-02T11:00:00.000Z');

    const row = {
      id: 11,
      user_id: 9,
      organization_id: null,
      task_type: 'field_mapping',
      provider_config_id: 5,
      model_version: 'gpt-4o',
      model_parameters: '{"temperature":0.2,"maxTokens":500}',
      is_active: 1,
      priority: 3,
      created_at: created,
      updated_at: updated,
      provider_type: 'CLAUDE',
      provider_name: 'Anthropic Claude',
      encrypted_api_key: null,
      endpoint_url: 'https://example.com',
      provider_config: null,
    } as unknown as AITaskModelConfigSelectable;

    const config = (service as any).mapDbRowToTaskModelConfig(row);

    expect(config).toMatchObject({
      id: 11,
      userId: 9,
      taskType: 'field_mapping',
      providerConfigId: 5,
      modelVersion: 'gpt-4o',
      modelParameters: {
        temperature: 0.2,
        maxTokens: 500,
      },
      isActive: true,
      priority: 3,
      providerType: 'claude',
    });
    expect(config.createdAt?.toISOString()).toBe(created.toISOString());
    expect(config.updatedAt?.toISOString()).toBe(updated.toISOString());
  });

  it('normalizes OpenRouter aliases', () => {
    expect(service.normalizeProviderType('open-router')).toBe('openrouter');
    expect(service.normalizeProviderType('open_router')).toBe('openrouter');
    expect(service.normalizeProviderType('openrouter')).toBe('openrouter');
  });

  it('maps OpenRouter provider rows with env key fallback', async () => {
    process.env.DB_TYPE = 'postgres';
    process.env.OPENROUTER_API_KEY = 'sk-or-' + 'a'.repeat(48);

    const row = {
      id: 13,
      user_id: 42,
      organization_id: null,
      provider_type: 'OPENROUTER',
      provider_name: 'OpenRouter',
      encrypted_api_key: null,
      endpoint_url: 'https://openrouter.ai/api/v1',
      is_active: true,
      is_default: false,
      configuration: '{"model":"anthropic/claude-3.5-sonnet"}',
      created_at: new Date('2025-03-01T00:00:00.000Z'),
      updated_at: new Date('2025-03-01T00:00:00.000Z'),
    } as unknown as AIProviderConfigSelectable;

    const config = await (service as any).mapDbRowToProviderConfig(row);

    expect(config).toMatchObject({
      providerType: 'openrouter',
      providerName: 'OpenRouter',
      apiKey: 'sk-or-' + 'a'.repeat(48),
      hasApiKey: true,
      endpointUrl: 'https://openrouter.ai/api/v1',
      configuration: {
        model: 'anthropic/claude-3.5-sonnet',
      },
    });
  });

  it('uses XAI_GROK_API_KEY as a Grok env fallback', () => {
    delete process.env.GROK_API_KEY;
    process.env.XAI_GROK_API_KEY = 'xai-grok-env-key';

    expect((service as any).getEnvironmentApiKey('grok')).toBe('xai-grok-env-key');
  });
});
