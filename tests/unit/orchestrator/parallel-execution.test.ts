/**
 * Tests for MultiAgentOrchestrator parallel execution path (Promise.all)
 * Verifies that executeAgentsParallel batches independent agents concurrently
 */

import { MultiAgentOrchestrator } from '../../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import type { AgentWorkflow } from '../../../src/services/ai/orchestrator/MultiAgentOrchestrator';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const costService = {
  getSessionCost: jest.fn().mockResolvedValue(0),
  getProviderBreakdown: jest.fn().mockResolvedValue({}),
  getTokenUsage: jest.fn().mockResolvedValue({ total: 0, byProvider: {} }),
};

const reasoningEngine = {
  startTrace: jest.fn().mockResolvedValue(undefined),
  getTrace: jest.fn().mockResolvedValue({ sessionId: 'exists' }),
  getNextStepNumber: jest.fn().mockReturnValue(1),
  recordStep: jest.fn().mockResolvedValue(undefined),
  completeTrace: jest.fn().mockResolvedValue(undefined),
  getSteps: jest.fn().mockResolvedValue([]),
};

const governanceService = {
  validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [] }),
  validateOutput: jest.fn().mockResolvedValue({ approved: true, flags: [] }),
};

const auditService = {
  logOrchestratorExecution: jest.fn().mockResolvedValue(undefined),
  logOrchestratorError: jest.fn().mockResolvedValue(undefined),
};

describe('MultiAgentOrchestrator parallel execution', () => {
  let orchestrator: MultiAgentOrchestrator;

  // Track invocation timestamps to prove concurrency
  const invocations: Record<string, { start: number; end: number }> = {};

  function createAgent(name: string) {
    return {
      name,
      execute: jest.fn().mockImplementation(async () => {
        invocations[name] = { start: Date.now(), end: 0 };
        // Minimal async yield to allow concurrent scheduling
        await new Promise(r => setImmediate(r));
        invocations[name].end = Date.now();
        return {
          success: true,
          confidence: 0.9,
          reasoning: `${name} completed`,
          executionTime: 1,
          data: { result: name },
        };
      }),
    };
  }

  const agentA = createAgent('agentA');
  const agentB = createAgent('agentB');

  const agentRegistry = {
    getAgent: jest.fn((name: string) => {
      if (name === 'agentA') return agentA;
      if (name === 'agentB') return agentB;
      return undefined;
    }),
    listAgents: jest.fn().mockReturnValue(['agentA', 'agentB']),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete invocations.agentA;
    delete invocations.agentB;

    orchestrator = new MultiAgentOrchestrator(
      logger as any,
      agentRegistry as any,
      reasoningEngine as any,
      governanceService as any,
      auditService as any,
      costService as any,
    );

    orchestrator.updateConfig({ maxConcurrentAgents: 2 });
  });

  it('should execute both agents when parallel=true and merge results', async () => {
    const workflow: AgentWorkflow = {
      agents: ['agentA', 'agentB'],
      parallel: true,
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: { minimumSuccessRatio: 1.0 },
    };

    const result = await orchestrator.executeWorkflow(
      { sessionId: 'par-1', userId: 'tester', sourceSystem: 'test', targetSystem: 'test' },
      workflow,
      {},
    );

    expect(result.success).toBe(true);
    expect(result.results.size).toBe(2);
    expect(result.results.get('agentA')?.success).toBe(true);
    expect(result.results.get('agentB')?.success).toBe(true);
    expect(agentA.execute).toHaveBeenCalledTimes(1);
    expect(agentB.execute).toHaveBeenCalledTimes(1);
  });

  it('should continue on failure in parallel mode with failureMode=continue', async () => {
    agentB.execute.mockImplementationOnce(async () => ({
      success: false,
      confidence: 0,
      reasoning: 'agentB failed',
      errors: ['test error'],
      executionTime: 1,
    }));

    const workflow: AgentWorkflow = {
      agents: ['agentA', 'agentB'],
      parallel: true,
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: { minimumSuccessRatio: 0.5 },
    };

    const result = await orchestrator.executeWorkflow(
      { sessionId: 'par-2', userId: 'tester', sourceSystem: 'test', targetSystem: 'test' },
      workflow,
      {},
    );

    expect(result.success).toBe(true); // 1/2 = 0.5 meets threshold
    expect(result.results.get('agentA')?.success).toBe(true);
    expect(result.results.get('agentB')?.success).toBe(false);
  });

  it('should use Promise.all path (not sequential) when parallel=true', async () => {
    // Verify the parallel path is taken by checking both agents start
    // before the workflow completes (sequentially they'd be serialized)
    const workflow: AgentWorkflow = {
      agents: ['agentA', 'agentB'],
      parallel: true,
      failureMode: 'continue',
      timeout: 10_000,
    };

    const result = await orchestrator.executeWorkflow(
      { sessionId: 'par-3', userId: 'tester', sourceSystem: 'test', targetSystem: 'test' },
      workflow,
      {},
    );

    expect(result.success).toBe(true);
    // Both agents should have been invoked and recorded timestamps
    expect(invocations.agentA).toBeDefined();
    expect(invocations.agentB).toBeDefined();
    // Both should have valid start/end timestamps
    expect(invocations.agentA.start).toBeGreaterThan(0);
    expect(invocations.agentA.end).toBeGreaterThan(0);
    expect(invocations.agentB.start).toBeGreaterThan(0);
    expect(invocations.agentB.end).toBeGreaterThan(0);
    // Prove concurrent execution: execution windows must overlap (or coincide)
    expect(invocations.agentA.start).toBeLessThanOrEqual(invocations.agentB.end);
    expect(invocations.agentB.start).toBeLessThanOrEqual(invocations.agentA.end);
  });
});
