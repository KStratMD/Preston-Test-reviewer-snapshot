import { BaseAgent } from '../../../../src/services/ai/orchestrator/BaseAgent';
import type {
  AgentExecutionContext,
  AgentSchema
} from '../../../../src/services/ai/orchestrator/interfaces';

class TestAgent extends BaseAgent {
  constructor() {
    super(
      {
        name: 'TestAgent',
        version: '1.0.0',
        capabilities: ['test'],
        dependencies: []
      },
      {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      } as any
    );
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {},
      outputSchema: {},
      capabilities: ['test'],
      resourceRequirements: {}
    };
  }

  protected async executeInternal() {
    return this.createSuccessResult({ ok: true }, 0.9, 'done');
  }

  protected async validateInputInternal() {
    return true;
  }
}

describe('BaseAgent timing safety', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clamps execution time to zero when the wall clock moves backwards', async () => {
    const agent = new TestAgent();
    const times = [1100, 1000, 900];
    jest.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 900);

    const result = await agent.execute(
      {
        sessionId: 'timing-safe-agent',
        sourceSystem: 'test',
        targetSystem: 'test',
        confidenceThreshold: 0.5,
        maxExecutionTime: 1000
      } satisfies AgentExecutionContext,
      {}
    );

    expect(result.success).toBe(true);
    expect(result.executionTime).toBe(0);
  });
});
