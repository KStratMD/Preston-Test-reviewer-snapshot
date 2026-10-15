import { FieldMappingAgent } from './services/ai/orchestrator/agents/FieldMappingAgent';
import { ProviderRegistry } from './services/ai/ProviderRegistry';
import { Logger } from './utils/Logger';

describe('FieldMappingAgent - sampleData handling', () => {
  const logger = new Logger('FieldMappingAgentTest');
  const providerRegistry = new ProviderRegistry(logger);
  const agent = new FieldMappingAgent(logger, providerRegistry as any);

  const baseContext = {
    sessionId: 'test-session',
    userId: 'tester',
    sourceSystem: 'TestSource',
    targetSystem: 'TestTarget',
    confidenceThreshold: 0.5,
    maxExecutionTime: 2000
  } as const;

  it('accepts sampleData as plain records', async () => {
    const input = {
      sourceFields: [{ name: 'Email', type: 'string' }],
      targetFields: [{ name: 'Email', type: 'string' }],
      sampleData: [{ Email: 'user@example.org' }]
    };

    const result = await agent.execute(baseContext as any, input);
    expect(result.success).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('accepts sampleData as { sourceValues: {...} } records', async () => {
    const input = {
      sourceFields: [{ name: 'Email', type: 'string' }],
      targetFields: [{ name: 'Email', type: 'string' }],
      sampleData: [{ sourceValues: { Email: 'user@example.org' } }]
    };

    const result = await agent.execute(baseContext as any, input);
    expect(result.success).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('ignores malformed sampleData entries without crashing', async () => {
    const input: any = {
      sourceFields: [{ name: 'Email', type: 'string' }],
      targetFields: [{ name: 'Email', type: 'string' }],
      sampleData: [
        null,
        42,
        'unexpected',
        { Email: 'first@example.org', context: { invalid: true } },
        { sourceValues: 'bad-shape', expectedTarget: 99, context: false },
        { sourceValues: { Email: 'user@example.org' }, context: 'valid context' }
      ]
    };

    const result = await agent.execute(baseContext as any, input);
    expect(result.success).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('falls back to direct transformation when validation rule type is unsupported', () => {
    const normalizeValidationRule = Reflect.get(agent, 'normalizeValidationRule') as
      | ((rule: unknown, index: number) => { transformation: { type: string } })
      | undefined;

    expect(normalizeValidationRule).toBeDefined();

    const normalized = normalizeValidationRule!.call(agent, {
      sourceFields: ['Email'],
      targetFields: ['Email'],
      transformation: { type: 'totally_invalid', customFunction: 'noop' }
    }, 0);

    expect(normalized.transformation).toEqual({ type: 'direct' });
  });
});
