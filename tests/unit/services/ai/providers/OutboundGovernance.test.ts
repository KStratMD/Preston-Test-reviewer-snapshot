import type { Logger } from 'src/utils/Logger';
import { OpenAIProvider } from 'src/services/ai/providers/OpenAIProvider';
import { ClaudeProvider } from 'src/services/ai/providers/ClaudeProvider';
import { OpenRouterProvider } from 'src/services/ai/providers/OpenRouterProvider';
import { LMStudioProvider } from 'src/services/ai/providers/LMStudioProvider';
import { GeminiProvider } from 'src/services/ai/providers/GeminiProvider';
import { GrokProvider } from 'src/services/ai/providers/GrokProvider';
import { OutboundGovernanceService } from 'src/services/governance/OutboundGovernanceService';
import type { IdentityContext } from 'src/services/governance/identityContext';
import { GovernanceBlockedError, PendingApprovalError } from 'src/services/governance/OutboundGovernanceErrors';

describe('Outbound Governance Enforcement', () => {
  let mockLogger: jest.Mocked<Logger>;
  let mockGovernance: jest.Mocked<OutboundGovernanceService>;
  let mockFetch: jest.Mock;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    } as any;

    mockGovernance = {
      validateAIProviderRequest: jest.fn()
    } as any;

    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ choices: [{ message: { content: 'Hi' } }] }),
      text: () => Promise.resolve('')
    });
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const providerCases = [
    {
      name: 'OpenAI',
      create: () => new OpenAIProvider(mockLogger, { apiKey: 'test-key', model: 'gpt-4o' }, mockGovernance),
      invoke: (provider: OpenAIProvider, ctx?: IdentityContext) => provider.chat([{ role: 'user', content: 'user@example.com' }], undefined, ctx),
      response: { choices: [{ message: { content: 'Hi' } }] }
    },
    {
      name: 'Claude',
      create: () => new ClaudeProvider(mockLogger, { apiKey: 'test-key', model: 'claude-3-5-sonnet-20241022' }, mockGovernance),
      invoke: (provider: ClaudeProvider, ctx?: IdentityContext) => provider.chat([{ role: 'user', content: 'user@example.com' }], undefined, ctx),
      response: {
        content: [{ type: 'text', text: 'Hi' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    },
    {
      name: 'OpenRouter',
      create: () => new OpenRouterProvider(mockLogger, { apiKey: 'test-key', model: 'anthropic/claude-3.5-sonnet' }, mockGovernance),
      invoke: (provider: OpenRouterProvider, ctx?: IdentityContext) => provider.chat([{ role: 'user', content: 'user@example.com' }], undefined, ctx),
      response: {
        choices: [{ message: { content: 'Hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    },
    {
      name: 'LMStudio',
      create: () => new LMStudioProvider(mockLogger, { baseURL: 'http://127.0.0.1:1234', model: 'local-model' }, mockGovernance),
      invoke: (provider: LMStudioProvider, ctx?: IdentityContext) => provider.chat([{ role: 'user', content: 'user@example.com' }], undefined, ctx),
      response: {
        choices: [{ message: { content: 'Hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    },
    {
      name: 'Gemini',
      create: () => new GeminiProvider(mockLogger, { apiKey: 'test-key', model: 'gemini-1.5-flash' }, mockGovernance),
      invoke: (provider: GeminiProvider, ctx?: IdentityContext) => provider.suggest('source', 'target', [{ email: 'user@example.com' }], ctx),
      response: {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: '{"suggestions":[{"sourceField":"email","targetField":"email","transformationType":"direct"}]}' }]
          },
          finishReason: 'STOP',
          index: 0,
          safetyRatings: []
        }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
      }
    },
    {
      name: 'Grok',
      create: () => new GrokProvider(mockLogger, { apiKey: 'test-key', model: 'grok-beta' }, mockGovernance),
      invoke: (provider: GrokProvider, ctx?: IdentityContext) => provider.suggest('source', 'target', [{ email: 'user@example.com' }], ctx),
      response: {
        id: 'grok-test',
        choices: [{ message: { content: '{"suggestions":[{"sourceField":"email","targetField":"email","transformationType":"direct"}]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    }
  ] as const;

  it('requires outbound governance for provider construction', () => {
    expect(() => new OpenAIProvider(mockLogger, {
      apiKey: 'test-key',
      model: 'gpt-4o'
    }, undefined as unknown as OutboundGovernanceService)).toThrow('OutboundGovernanceService is required');
  });

  it.each(providerCases)('uses redacted payload for approved $name requests', async ({ create, invoke, response }) => {
    const redactedPayload = {
      model: 'redacted-model',
      messages: [{ role: 'user', content: '[REDACTED]' }]
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(response),
      text: () => Promise.resolve('')
    });
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: true,
      approvalRequired: false,
      redactedPayload,
      findings: ['email'],
      riskLevel: 'low',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false }
    });

    await invoke(create() as never);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual(redactedPayload);
  });

  it.each(providerCases)('passes explicit identity context to outbound governance for $name requests', async ({ create, invoke, response }) => {
    const identity: IdentityContext = { tenantId: 'tenant-test', userId: 'user-test' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(response),
      text: () => Promise.resolve('')
    });
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: true,
      approvalRequired: false,
      redactedPayload: undefined,
      findings: [],
      riskLevel: 'none',
      auditMetadata: { scanDurationMs: 1, findingsCount: 0, redacted: false, blocked: false }
    });

    await invoke(create() as never, identity);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(mockGovernance.validateAIProviderRequest.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-test',
        userId: 'user-test',
        destination: 'ai_provider',
        operationType: 'execute',
      }),
    );
  });

  it.each(providerCases)('passes explicit identity context before blocking denied $name requests', async ({ create, invoke }) => {
    const identity: IdentityContext = { tenantId: 'tenant-denied', userId: 'user-denied' };
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: false,
      approvalRequired: false,
      redactedPayload: { redacted: true },
      findings: ['ssn'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: true }
    });

    await expect(invoke(create() as never, identity)).rejects.toThrow(GovernanceBlockedError);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(mockGovernance.validateAIProviderRequest.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-denied',
        userId: 'user-denied',
        destination: 'ai_provider',
        operationType: 'execute',
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(providerCases)('passes explicit identity context before queuing pending-approval $name requests', async ({ create, invoke }) => {
    const identity: IdentityContext = { tenantId: 'tenant-pending', userId: 'user-pending' };
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: false,
      approvalRequired: true,
      redactedPayload: { redacted: true },
      findings: ['ssn'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false }
    });

    await expect(invoke(create() as never, identity)).rejects.toThrow(PendingApprovalError);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(mockGovernance.validateAIProviderRequest.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-pending',
        userId: 'user-pending',
        destination: 'ai_provider',
        operationType: 'execute',
      }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(providerCases)('blocks denied $name requests before fetch', async ({ create, invoke }) => {
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: false,
      approvalRequired: false,
      redactedPayload: { redacted: true },
      findings: ['ssn'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: true }
    });

    await expect(invoke(create() as never)).rejects.toThrow(GovernanceBlockedError);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(providerCases)('throws pending approval for queued $name requests before fetch', async ({ create, invoke }) => {
    mockGovernance.validateAIProviderRequest.mockResolvedValue({
      approved: false,
      approvalRequired: true,
      redactedPayload: { redacted: true },
      findings: ['ssn'],
      riskLevel: 'high',
      auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false }
    });

    await expect(invoke(create() as never)).rejects.toThrow(PendingApprovalError);

    expect(mockGovernance.validateAIProviderRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('normalizes the legacy gpt-4 alias to gpt-4o at the construction chokepoint', () => {
    const provider = new OpenAIProvider(mockLogger, { apiKey: 'k', model: 'gpt-4' }, mockGovernance);
    expect(provider.getModel()).toBe('gpt-4o');
    // Current model strings pass through unchanged.
    const current = new OpenAIProvider(mockLogger, { apiKey: 'k', model: 'gpt-5.4-mini' }, mockGovernance);
    expect(current.getModel()).toBe('gpt-5.4-mini');
  });
});
