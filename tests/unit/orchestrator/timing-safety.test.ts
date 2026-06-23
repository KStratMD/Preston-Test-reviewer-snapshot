import { MultiAgentOrchestrator } from '../../../src/services/ai/orchestrator/MultiAgentOrchestrator';

describe('MultiAgentOrchestrator timing safety', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };

  const costService = {
    getSessionCost: jest.fn().mockResolvedValue(0),
    getProviderBreakdown: jest.fn().mockResolvedValue({}),
    getTokenUsage: jest.fn().mockResolvedValue({ total: 0, byProvider: {} })
  };

  const reasoningEngine = {
    startTrace: jest.fn().mockResolvedValue(undefined),
    getTrace: jest.fn().mockResolvedValue({ sessionId: 'existing-trace' }),
    getNextStepNumber: jest.fn().mockReturnValue(1),
    recordStep: jest.fn().mockResolvedValue(undefined),
    completeTrace: jest.fn().mockResolvedValue(undefined),
    getSteps: jest.fn().mockResolvedValue([])
  };

  const governanceService = {
    validateInput: jest.fn().mockResolvedValue({ approved: true, flags: [] }),
    validateOutput: jest.fn().mockResolvedValue({ approved: true, flags: [] })
  };

  const auditService = {
    logOrchestratorExecution: jest.fn().mockResolvedValue(undefined),
    logOrchestratorError: jest.fn().mockResolvedValue(undefined)
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('clamps reasoning-step execution time to zero when the wall clock moves backwards', async () => {
    const agent = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        confidence: 0.9,
        reasoning: 'ok',
        executionTime: 5,
        data: { ok: true }
      })
    };

    const agentRegistry = {
      getAgent: jest.fn().mockReturnValue(agent),
      listAgents: jest.fn().mockReturnValue(['agent-a'])
    };

    const orchestrator = new MultiAgentOrchestrator(
      logger as any,
      agentRegistry as any,
      reasoningEngine as any,
      governanceService as any,
      auditService as any,
      costService as any
    );

    const times = [1000, 900];
    jest.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 900);

    const result = await orchestrator.executeAgent(
      'agent-a',
      {
        sessionId: 'timing-safe-orchestrator',
        sourceSystem: 'test',
        targetSystem: 'test'
      },
      {}
    );

    expect(result.success).toBe(true);
    expect(reasoningEngine.recordStep).toHaveBeenCalledWith(
      'timing-safe-orchestrator',
      expect.objectContaining({
        executionTime: 0
      })
    );
  });
});
