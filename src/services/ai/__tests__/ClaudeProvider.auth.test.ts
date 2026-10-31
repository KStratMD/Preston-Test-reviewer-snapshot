import { ClaudeProvider } from '../providers/ClaudeProvider';

function createMockLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
    fatal: jest.fn(),
    trace: jest.fn(),
    silent: jest.fn(),
    level: 'info',
  };
}

const mockOutboundGovernance = {
  validateAIProviderRequest: jest.fn(),
} as any;

describe('ClaudeProvider auth headers', () => {
  it('uses x-api-key for direct Anthropic endpoints in auto mode', () => {
    const provider = new ClaudeProvider(createMockLogger() as never, {
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'https://api.anthropic.com/v1',
    }, mockOutboundGovernance);

    const headers = (provider as any).buildHeaders();

    expect(headers['x-api-key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('uses bearer auth for non-Anthropic endpoints in auto mode', () => {
    const provider = new ClaudeProvider(createMockLogger() as never, {
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'http://localhost:8000/v1',
    }, mockOutboundGovernance);

    const headers = (provider as any).buildHeaders();

    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('respects explicit anthropic auth mode for custom endpoints', () => {
    const provider = new ClaudeProvider(createMockLogger() as never, {
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'https://gateway.example.com/v1',
      authMode: 'anthropic',
    }, mockOutboundGovernance);

    const headers = (provider as any).buildHeaders();

    expect(headers['x-api-key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('respects explicit bearer auth mode for Anthropic endpoints', () => {
    const provider = new ClaudeProvider(createMockLogger() as never, {
      apiKey: 'test-key',
      model: 'claude-3-5-sonnet-20241022',
      baseURL: 'https://api.anthropic.com/v1',
      authMode: 'bearer',
    }, mockOutboundGovernance);

    const headers = (provider as any).buildHeaders();

    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['x-api-key']).toBeUndefined();
  });
});
