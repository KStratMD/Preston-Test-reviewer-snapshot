/**
 * Multi-Agent Orchestrator - Core service for coordinating AI agents
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import { logger, type Logger } from '../../../utils/Logger';
import { uuidv4 } from '../../../utils/uuid';

import type {
  Agent,
  AgentExecutionContext,
  AgentResult,
  OrchestratorResult,
  ReasoningStep,
  GovernanceReport,
  CostBreakdown,
  AuditEntry
} from './interfaces';

import { AgentRegistry } from './AgentRegistry';
import { ReasoningTraceEngine } from './ReasoningTraceEngine';
import { GovernanceService } from './GovernanceService';
import { AuditService } from './AuditService';
import { CostTrackingService } from '../CostTrackingService';
import { getElapsedMs } from './timing';

/**
 * Workflow configuration for MultiAgentOrchestrator
 * Uses agent names (strings) which are resolved via AgentRegistry
 */
export interface AgentWorkflow {
  agents: string[];
  parallel?: boolean;
  failureMode: 'abort' | 'continue' | 'partial';
  timeout: number;
  dependencies?: AgentDependency[];
  successCriteria?: {
    minimumSuccessRatio?: number;
    requireAll?: boolean;
    requiredAgents?: string[];
  };
}

/**
 * Agent dependency definition for AgentWorkflow
 */
export interface AgentDependency {
  agent: string;
  dependsOn: string[];
  required: boolean;
}

/**
 * Orchestrator configuration for MultiAgentOrchestrator
 * Controls execution-level settings (reasoning trace, governance toggles, cost limits)
 */
export interface OrchestratorConfig {
  maxConcurrentAgents: number;
  defaultTimeout: number;
  enableReasoningTrace: boolean;
  enableGovernance: boolean;
  costLimits: {
    maxSessionCost: number;
    alertThreshold: number;
    hardLimit: number;
  };
  successCriteria: {
    minimumSuccessRatio: number;
    requireAllByDefault: boolean;
  };
}

@injectable()
export class MultiAgentOrchestrator {
  private activeSessions = new Map<string, OrchestratorSession>();
  private config: OrchestratorConfig;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject('AgentRegistry') private agentRegistry: AgentRegistry,
    @inject('ReasoningTraceEngine') private reasoningEngine: ReasoningTraceEngine,
    @inject('GovernanceService') private governanceService: GovernanceService,
    @inject('AuditService') private auditService: AuditService,
    @inject('CostTrackingService') private costService: CostTrackingService
  ) {
    this.config = {
      maxConcurrentAgents: 10,
      defaultTimeout: 30000, // 30 seconds
      enableReasoningTrace: true,
      enableGovernance: true,
      costLimits: {
        maxSessionCost: 0.30,
        alertThreshold: 0.20,
        hardLimit: 0.40
      },
      successCriteria: {
        minimumSuccessRatio: 0.75,
        requireAllByDefault: false
      }
    };
  }

  /**
   * Execute a workflow of agents with orchestration
   */
  async executeWorkflow(
    context: AgentExecutionContext,
    workflow: AgentWorkflow,
    input: unknown
  ): Promise<OrchestratorResult> {
    const sessionId = context.sessionId || uuidv4();
    const session = this.createSession(sessionId, context, workflow);
    let workflowError: unknown;

    // Start reasoning trace for the workflow
    if (this.config.enableReasoningTrace) {
      await this.reasoningEngine.startTrace(sessionId, {
        sourceSystem: context.sourceSystem || 'unknown',
        targetSystem: context.targetSystem || 'unknown',
        userId: context.userId,
        businessProcess: 'workflow',
      });
    }

    try {
      this.logger.info('Starting agent orchestration', {
        sessionId,
        agents: workflow.agents,
        parallel: workflow.parallel
      });

      // Governance pre-check
      if (this.config.enableGovernance) {
        const governanceCheck = await this.governanceService.validateInput(input, context);
        if (!governanceCheck.approved) {
          throw new Error(`Governance violation: ${governanceCheck.reason}`);
        }
        session.governance.complianceFlags.push(...governanceCheck.flags);
      }

      // Execute agents based on workflow configuration
      const dependencyMap = this.buildDependencyMap(workflow);
      const results = workflow.parallel
        ? await this.executeAgentsParallel(session, input, dependencyMap)
        : await this.executeAgentsSequential(session, input, dependencyMap);

      // Calculate overall confidence and metrics
      const overallConfidence = this.calculateOverallConfidence(results);
      const totalCost = await this.costService.getSessionCost(sessionId);

      // Final governance check
      const finalGovernance = await this.performFinalGovernanceCheck(session, results);

      const orchestratorResult: OrchestratorResult = {
        sessionId,
        success: this.determineOverallSuccess(results, workflow),
        results: new Map(Object.entries(results)),
        overallConfidence,
        reasoningTrace: session.reasoningTrace,
        totalExecutionTime: Date.now() - session.startTime,
        governance: finalGovernance,
        cost: {
          totalCost,
          providerCosts: await this.costService.getProviderBreakdown(sessionId),
          tokenUsage: (await this.costService.getTokenUsage(sessionId)).byProvider,
          estimatedMonthlyCost: totalCost * 30 * 24 // rough estimate
        }
      };

      // Create audit entry
      await this.auditService.logOrchestratorExecution({
        tenantId: context.tenantId,
        sessionId,
        userId: context.userId,
        agents: workflow.agents,
        success: orchestratorResult.success,
        cost: totalCost,
        executionTime: orchestratorResult.totalExecutionTime,
        governanceFlags: finalGovernance.complianceFlags
      });

      this.logger.info('Agent orchestration completed', {
        sessionId,
        success: orchestratorResult.success,
        confidence: overallConfidence,
        cost: totalCost,
        executionTime: orchestratorResult.totalExecutionTime
      });

      return orchestratorResult;

    } catch (error) {
      workflowError = error;
      this.logger.error('Agent orchestration failed', {
        sessionId,
        error: String(error),
        agents: workflow.agents
      });

      await this.auditService.logOrchestratorError({
        tenantId: context.tenantId,
        sessionId,
        error: String(error),
        agents: workflow.agents,
        userId: context.userId
      });

      throw error;
    } finally {
      if (this.config.enableReasoningTrace) {
        await this.reasoningEngine.completeTrace(
          sessionId,
          workflowError ? `Failed: ${workflowError}` : undefined,
          workflowError ? 'failed' : 'completed'
        );
      }
      this.cleanupSession(sessionId);
    }
  }

  /**
   * Execute a single agent
   */
  async executeAgent(
    agentName: string,
    context: AgentExecutionContext,
    input: unknown
  ): Promise<AgentResult> {
    const agent = this.agentRegistry.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const sessionId = context.sessionId || uuidv4();
    const startTime = Date.now();

    // Start reasoning trace for individual agent execution (skip if already started by executeWorkflow)
    let traceStartedHere = false;
    if (this.config.enableReasoningTrace) {
      const existingTrace = await this.reasoningEngine.getTrace(sessionId);
      traceStartedHere = !existingTrace;
    }
    if (traceStartedHere) {
      await this.reasoningEngine.startTrace(sessionId, {
        sourceSystem: context.sourceSystem || 'unknown',
        targetSystem: context.targetSystem || 'unknown',
        userId: context.userId,
        businessProcess: `agent:${agentName}`,
      });
    }

    try {
      // Cost check before execution
      const currentCost = await this.costService.getSessionCost(sessionId);
      if (currentCost >= this.config.costLimits.hardLimit) {
        throw new Error(`Session cost limit exceeded: $${currentCost}`);
      }

      // Governance check
      if (this.config.enableGovernance) {
        const governanceCheck = await this.governanceService.validateInput(input, context);
        if (!governanceCheck.approved) {
          throw new Error(`Governance violation: ${governanceCheck.reason}`);
        }
      }

      // Execute agent
      this.logger.info('Executing agent', { agent: agentName, sessionId });
      const result = await agent.execute(context, input);

      // Post-execution governance — three independent concerns, kept as
      // separate statements rather than mutually-exclusive branches so
      // each fires whenever its precondition holds (Copilot R6: the prior
      // `else if` shape silently dropped flags on flag-only posture paths
      // like `posture.allowPII=true` audit-only mode or
      // `posture.autoRedact=false` opt-out, leaving downstream
      // `executeWorkflow()` aggregation unable to see those compliance
      // flags).
      if (this.config.enableGovernance && result.data) {
        const outputCheck = await this.governanceService.validateOutput(result.data, context);

        // (1) Always surface every governance flag emitted, regardless of
        //     approval/redaction state. Includes the C3 flag-only paths:
        //     `output_pii_detected`, `output_pii_allowed_by_tenant`, etc.
        //     Merge (with dedup) into any pre-existing flags so we don't
        //     stomp on signals the agent itself set upstream (e.g.
        //     `BusinessIntelligenceAgent.checkGovernanceFlags(...)`,
        //     `BaseAgent` partial-success flags). Copilot R7.
        if (outputCheck.flags.length > 0) {
          const existing = result.governance_flags ?? [];
          result.governance_flags = Array.from(new Set([...existing, ...outputCheck.flags]));
        }

        // (2) Substitute the sanitized form when validateOutput populated
        //     redactedData on the approval path (C3 / Codex R1). Without
        //     this hand-off the `output_pii_auto_redacted` flag would lie:
        //     flag says redacted, response still contains PII.
        if (outputCheck.approved && outputCheck.redactedData !== undefined) {
          result.data = outputCheck.redactedData;
        }

        // (3) On rejection, attach the rejection reason to warnings (and
        //     keep flags from (1) intact for audit propagation).
        if (!outputCheck.approved) {
          result.warnings = result.warnings || [];
          result.warnings.push(`Governance concerns: ${outputCheck.reason}`);
        }
      }

      // Record reasoning step
      if (this.config.enableReasoningTrace) {
        const reasoningStep: ReasoningStep = {
          step: this.reasoningEngine.getNextStepNumber(sessionId),
          agent: agentName,
          action: 'execute',
          input,
          output: result.data,
          confidence: result.confidence,
          reasoning: result.reasoning,
          timestamp: new Date(),
          executionTime: getElapsedMs(startTime)
        };

        await this.reasoningEngine.recordStep(sessionId, reasoningStep);
      }

      this.logger.info('Agent execution completed', {
        agent: agentName,
        sessionId,
        success: result.success,
        confidence: result.confidence,
        executionTime: result.executionTime
      });

      if (traceStartedHere) {
        await this.reasoningEngine.completeTrace(sessionId);
      }

      return result;

    } catch (error) {
      this.logger.error('Agent execution failed', {
        agent: agentName,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      if (traceStartedHere) {
        await this.reasoningEngine.completeTrace(sessionId, `Agent failed: ${error}`, 'failed');
      }

      return {
        success: false,
        confidence: 0,
        reasoning: `Agent execution failed: ${error}`,
        errors: [String(error)],
        executionTime: getElapsedMs(startTime),
        hallucination_risk: 'high',
        governance_flags: ['execution_failure']
      };
    }
  }

  /**
   * Get orchestration session status
   */
  async getSessionStatus(sessionId: string): Promise<OrchestratorSession | null> {
    return this.activeSessions.get(sessionId) || null;
  }

  /**
   * Get reasoning trace for a session
   */
  async getReasoningTrace(sessionId: string): Promise<ReasoningStep[]> {
    return await this.reasoningEngine.getSteps(sessionId);
  }

  /**
   * Get session cost breakdown
   */
  async getSessionCost(sessionId: string): Promise<CostBreakdown> {
    const totalCost = await this.costService.getSessionCost(sessionId);
    return {
      totalCost,
      providerCosts: await this.costService.getProviderBreakdown(sessionId),
      tokenUsage: (await this.costService.getTokenUsage(sessionId)).byProvider,
      estimatedMonthlyCost: totalCost * 30 * 24
    };
  }

  /**
   * List available agents
   */
  getAvailableAgents(): string[] {
    return this.agentRegistry.listAgents();
  }

  /**
   * Update orchestrator configuration
   */
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Orchestrator configuration updated', { config: this.config });
  }

  // Private methods

  private createSession(
    sessionId: string,
    context: AgentExecutionContext,
    workflow: AgentWorkflow
  ): OrchestratorSession {
    const session: OrchestratorSession = {
      sessionId,
      context,
      workflow,
      startTime: Date.now(),
      reasoningTrace: [],
      governance: {
        piiDetected: false,
        confidentialityLevel: 'internal',
        complianceFlags: [],
        riskAssessment: 'low',
        auditTrail: []
      },
      results: {},
      status: 'running'
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  private async executeAgentsParallel(
    session: OrchestratorSession,
    input: unknown,
    dependencyMap: Map<string, AgentDependency>
  ): Promise<Record<string, AgentResult>> {
    const results: Record<string, AgentResult> = {};
    const executed = new Set<string>();
    const skipped = new Set<string>();
    const pending = new Set(session.workflow.agents);
    const totalAgents = session.workflow.agents.length;

    while (executed.size + skipped.size < totalAgents) {
      const ready: string[] = [];

      for (const agentName of session.workflow.agents) {
        if (!pending.has(agentName)) {
          continue;
        }

        const dependencyConfig = dependencyMap.get(agentName);
        if (!dependencyConfig || dependencyConfig.dependsOn.length === 0) {
          ready.push(agentName);
          continue;
        }

        let dependenciesPending = false;
        let dependencyFailed = false;

        for (const dependency of dependencyConfig.dependsOn) {
          if (!executed.has(dependency) && !skipped.has(dependency)) {
            dependenciesPending = true;
            break;
          }

          const dependencyResult = results[dependency];
          if (dependencyConfig.required && (!dependencyResult || !dependencyResult.success)) {
            dependencyFailed = true;
            break;
          }
        }

        if (dependencyFailed) {
          results[agentName] = {
            success: false,
            confidence: 0,
            reasoning: `Skipped because required dependency failed: ${dependencyConfig.dependsOn.join(', ')}`,
            errors: ['Dependency failure'],
            executionTime: 0
          };
          skipped.add(agentName);
          pending.delete(agentName);
          continue;
        }

        if (!dependenciesPending) {
          ready.push(agentName);
        }
      }

      if (ready.length === 0) {
        for (const agentName of pending) {
          results[agentName] = {
            success: false,
            confidence: 0,
            reasoning: 'Unable to execute due to unresolved dependencies',
            errors: ['Dependency resolution error'],
            executionTime: 0
          };
          skipped.add(agentName);
        }
        break;
      }

      const limit = Math.max(1, this.config.maxConcurrentAgents ?? 1);
      const batch = ready.slice(0, limit);
      await Promise.all(batch.map(async agentName => {
        try {
          const result = await this.executeAgent(agentName, session.context, input);
          results[agentName] = result;
        } catch (error) {
          results[agentName] = {
            success: false,
            confidence: 0,
            reasoning: `Parallel execution failed: ${error}`,
            errors: [String(error)],
            executionTime: 0
          };
        } finally {
          pending.delete(agentName);
          executed.add(agentName);
        }
      }));
    }

    return results;
  }

  private async executeAgentsSequential(
    session: OrchestratorSession,
    input: unknown,
    dependencyMap: Map<string, AgentDependency>
  ): Promise<Record<string, AgentResult>> {
    const results: Record<string, AgentResult> = {};
    let currentInput = input;

    for (const agentName of session.workflow.agents) {
      const dependencyConfig = dependencyMap.get(agentName);
      if (dependencyConfig && dependencyConfig.dependsOn.length > 0) {
        let missingDependency = false;
        let dependencyFailed = false;

        for (const dependency of dependencyConfig.dependsOn) {
          const dependencyResult = results[dependency];
          if (!dependencyResult) {
            missingDependency = true;
            break;
          }

          if (dependencyConfig.required && !dependencyResult.success) {
            dependencyFailed = true;
            break;
          }
        }

        if (missingDependency) {
          results[agentName] = {
            success: false,
            confidence: 0,
            reasoning: `Dependencies must execute before ${agentName}`,
            errors: ['Dependency order violation'],
            executionTime: 0
          };
          if (session.workflow.failureMode === 'abort') {
            break;
          }
          continue;
        }

        if (dependencyFailed) {
          results[agentName] = {
            success: false,
            confidence: 0,
            reasoning: `Skipped because required dependency failed: ${dependencyConfig.dependsOn.join(', ')}`,
            errors: ['Dependency failure'],
            executionTime: 0
          };
          if (session.workflow.failureMode === 'abort') {
            break;
          }
          continue;
        }
      }

      try {
        const result = await this.executeAgent(agentName, session.context, currentInput);
        results[agentName] = result;

        if (result.success && result.data) {
          currentInput = { ...(currentInput as any), previousResults: results };
        }

        if (!result.success && session.workflow.failureMode === 'abort') {
          break;
        }
      } catch (error) {
        results[agentName] = {
          success: false,
          confidence: 0,
          reasoning: `Sequential execution failed: ${error}`,
          errors: [String(error)],
          executionTime: 0
        };

        if (session.workflow.failureMode === 'abort') {
          break;
        }
      }
    }

    return results;
  }


  private calculateOverallConfidence(results: Record<string, AgentResult>): number {
    const confidences = Object.values(results)
      .filter(result => result.success)
      .map(result => result.confidence);

    if (confidences.length === 0) return 0;

    // Weighted average with penalty for failures
    const avgConfidence = confidences.reduce((sum, conf) => sum + conf, 0) / confidences.length;
    const successRate = confidences.length / Object.keys(results).length;

    return avgConfidence * successRate;
  }

  private determineOverallSuccess(
    results: Record<string, AgentResult>,
    workflow: AgentWorkflow
  ): boolean {
    const totalCount = Object.keys(results).length;
    if (totalCount === 0) {
      return false;
    }

    const successCount = Object.values(results).filter(result => result.success).length;
    const criteria = workflow.successCriteria ?? {};

    // Ensure required agents succeeded
    if (Array.isArray(criteria.requiredAgents) && criteria.requiredAgents.length > 0) {
      const requiredFailures = criteria.requiredAgents.filter(agentId => !results[agentId]?.success);
      if (requiredFailures.length > 0) {
        this.logger.warn('Required agents failed execution', {
          failedAgents: requiredFailures
        });
        return false;
      }
    }

    const requireAll = criteria.requireAll ?? this.config.successCriteria.requireAllByDefault;
    if (requireAll) {
      return successCount === totalCount;
    }

    const ratio = successCount / totalCount;
    const threshold = criteria.minimumSuccessRatio ?? this.config.successCriteria.minimumSuccessRatio;
    return ratio >= threshold;
  }

  private buildDependencyMap(workflow: AgentWorkflow): Map<string, AgentDependency> {
    const map = new Map<string, AgentDependency>();
    for (const dep of workflow.dependencies ?? []) {
      if (!dep || !dep.agent) continue;
      map.set(dep.agent, {
        agent: dep.agent,
        dependsOn: dep.dependsOn ?? [],
        required: dep.required ?? false
      });
    }
    return map;
  }

  private async performFinalGovernanceCheck(
    session: OrchestratorSession,
    results: Record<string, AgentResult>
  ): Promise<GovernanceReport> {
    const governance: GovernanceReport = { ...session.governance };

    // Aggregate governance flags from all agents
    Object.values(results).forEach(result => {
      if (result.governance_flags) {
        governance.complianceFlags.push(...result.governance_flags);
      }
    });

    // Assess overall risk based on results
    const highRiskResults = Object.values(results)
      .filter(result => result.hallucination_risk === 'high').length;

    if (highRiskResults > 0) {
      governance.riskAssessment = 'high';
    } else if (governance.complianceFlags.length > 0) {
      governance.riskAssessment = 'medium';
    }

    return governance;
  }

  /**
   * Get execution status for a session
   */
  async getExecutionStatus(sessionId: string): Promise<unknown | null> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      status: session.status,
      startTime: session.startTime,
      duration: Date.now() - session.startTime,
      completedAgents: Object.keys(session.results).length,
      totalAgents: session.workflow.agents.length,
      results: session.results
    };
  }

  /**
   * Get detailed execution trace for a session
   */
  async getExecutionTrace(sessionId: string): Promise<ReasoningStep[] | null> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return null;
    }

    return session.reasoningTrace;
  }

  private cleanupSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }
}

interface OrchestratorSession {
  sessionId: string;
  context: AgentExecutionContext;
  workflow: AgentWorkflow;
  startTime: number;
  reasoningTrace: ReasoningStep[];
  governance: GovernanceReport;
  results: Record<string, AgentResult>;
  status: 'running' | 'completed' | 'failed';
}
