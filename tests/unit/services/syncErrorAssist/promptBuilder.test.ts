import { buildPrompt } from '../../../../src/services/syncErrorAssist/promptBuilder';

describe('buildPrompt', () => {
  const errorRecord = {
    id: 'err-1',
    lastModified: '2026-05-01T10:00:00Z',
    error_message: 'Could not find item 1234',
    error_context: { item_id: '1234' },
  };

  it('produces a system message + user message', () => {
    const messages = buildPrompt(errorRecord, 'mid');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes the error message in the user prompt', () => {
    const messages = buildPrompt(errorRecord, 'mid');
    expect(messages[1].content).toContain('Could not find item 1234');
  });

  it('includes context as JSON in the user prompt', () => {
    const messages = buildPrompt(errorRecord, 'mid');
    expect(messages[1].content).toContain('"item_id": "1234"');
  });

  it('mentions the confidence threshold in the system prompt', () => {
    const messages = buildPrompt(errorRecord, 'high');
    expect(messages[0].content).toContain('high');
  });

  it('asks for structured JSON output', () => {
    const messages = buildPrompt(errorRecord, 'mid');
    expect(messages[0].content.toLowerCase()).toContain('json');
    expect(messages[0].content).toContain('confidence');
    expect(messages[0].content).toContain('suggestion_type');
  });
});
