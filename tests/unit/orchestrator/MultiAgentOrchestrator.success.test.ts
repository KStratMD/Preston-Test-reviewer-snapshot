import { MultiAgentOrchestrator } from '../../../src/services/ai/orchestrator/MultiAgentOrchestrator';
import type { AgentResult, AgentWorkflow } from '../../../src/services/ai/orchestrator/MultiAgentOrchestrator';

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

const orchestrator = new MultiAgentOrchestrator(
  logger as any,
  {} as any,
  {} as any,
  {} as any,
  {} as any,
  costService as any
);

const callDetermine = (
  results: Record<string, AgentResult>,
  workflow: AgentWorkflow
): boolean => (orchestrator as any).determineOverallSuccess(results, workflow);

describe('MultiAgentOrchestrator success criteria', () => {
  const baseResults: Record<string, AgentResult> = {
    a: { success: true, confidence: 0.9, reasoning: '', executionTime: 10 },
    b: { success: true, confidence: 0.8, reasoning: '', executionTime: 10 },
    c: { success: false, confidence: 0.4, reasoning: '', executionTime: 10 }
  };

  it('fails when default ratio not met', () => {
    const workflow: AgentWorkflow = {
      agents: ['a', 'b', 'c'],
      failureMode: 'continue',
      timeout: 10_000
    };

    expect(callDetermine(baseResults, workflow)).toBe(false);
  });

  it('respects custom minimum success ratio', () => {
    const workflow: AgentWorkflow = {
      agents: ['a', 'b', 'c'],
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: {
        minimumSuccessRatio: 0.5
      }
    };

    expect(callDetermine(baseResults, workflow)).toBe(true);
  });

  it('requires all agents when configured', () => {
    const workflow: AgentWorkflow = {
      agents: ['a', 'b', 'c'],
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: {
        requireAll: true
      }
    };

    expect(callDetermine(baseResults, workflow)).toBe(false);
  });

  it('enforces required agent list', () => {
    const workflow: AgentWorkflow = {
      agents: ['a', 'b', 'c'],
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: {
        requiredAgents: ['a', 'c']
      }
    };

    expect(callDetermine(baseResults, workflow)).toBe(false);
  });

  it('passes when required agents succeed', () => {
    const workflow: AgentWorkflow = {
      agents: ['a', 'b'],
      failureMode: 'continue',
      timeout: 10_000,
      successCriteria: {
        requiredAgents: ['a'], minimumSuccessRatio: 0.5
      }
    };

    const results = {
      a: { success: true, confidence: 0.9, reasoning: '', executionTime: 5 },
      b: { success: false, confidence: 0.1, reasoning: '', executionTime: 5 }
    };

    expect(callDetermine(results, workflow)).toBe(true);
  });
});

