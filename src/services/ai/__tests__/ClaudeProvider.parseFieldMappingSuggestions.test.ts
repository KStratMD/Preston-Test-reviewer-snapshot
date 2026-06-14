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

function createProvider() {
  return new ClaudeProvider(createMockLogger() as never, {
    apiKey: 'test-key',
    model: 'claude-3-5-sonnet-20241022',
    baseURL: 'https://api.anthropic.com/v1',
  }, mockOutboundGovernance);
}

function responseWithSuggestions(suggestions: unknown[]) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({ suggestions }) }],
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

describe('ClaudeProvider.parseFieldMappingSuggestions confidence handling', () => {
  // Confidence-filter contract: only s.confidence == null or s.confidence >= 70 pass.
  // Regression guard for the prior `!s.confidence` bug, which let confidence: 0 through.
  it('filters out confidence: 0 (does not treat 0 as missing)', () => {
    const provider = createProvider();
    const response = responseWithSuggestions([
      { sourceField: 'a', targetField: 'A', confidence: 0 },
    ]);

    const result = (provider as any).parseFieldMappingSuggestions(response, ['a']);

    expect(result).toEqual([]);
  });

  it('keeps suggestions with no confidence field (null/undefined bypasses gate)', () => {
    const provider = createProvider();
    const response = responseWithSuggestions([
      { sourceField: 'a', targetField: 'A' },
    ]);

    const result = (provider as any).parseFieldMappingSuggestions(response, ['a']);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sourceField: 'a', targetField: 'A' });
    expect(result[0].confidence).toBeUndefined();
  });

  // Map-projection contract: confidence is preserved as-is, not coerced.
  // Regression guard for the prior `s.confidence || undefined` bug, which would have
  // dropped any falsy numeric value (only reachable if the >=70 filter ever lowers).
  it('preserves numeric confidence in the mapped output', () => {
    const provider = createProvider();
    const response = responseWithSuggestions([
      { sourceField: 'a', targetField: 'A', confidence: 75 },
    ]);

    const result = (provider as any).parseFieldMappingSuggestions(response, ['a']);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(75);
  });
});
