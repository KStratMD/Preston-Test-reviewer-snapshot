/**
 * Agent Router - Multi-Agent Orchestration Endpoints
 * Handles agent workflows, single agent execution, and agent management
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import type { Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../../services/UnifiedTelemetryService';
import { CostTrackingService } from '../../services/ai/CostTrackingService';
import { GovernanceService } from '../../services/ai/orchestrator/GovernanceService';
import type { MultiAgentOrchestrator } from '../../services/ai/orchestrator/MultiAgentOrchestrator';
import { AgentRegistry } from '../../services/ai/orchestrator/AgentRegistry';
import { AgentExecutionContext, AgentType } from '../../services/ai/orchestrator/interfaces';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';
import { extractIdentityContext } from '../../services/governance/identityContext';

/**
 * Structural shape for the optional `context` object accepted on agent
 * orchestration / single-agent execution endpoints. The request body is
 * `unknown`, so we narrow it once at the boundary instead of casting at
 * each property access.
 */
interface AgentExecutionContextShape {
  sourceSystem?: string;
  targetSystem?: string;
  industry?: string;
  confidenceThreshold?: number;
  maxExecutionTime?: number;
}

// Plain-object guard: rejects null, primitives, arrays, and class
// instances (typeof Date === 'object', etc.) that would spread
// surprising keys into metadata. Returns an empty AgentExecutionContextShape
// otherwise.
function narrowContext(value: unknown): AgentExecutionContextShape {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return {};
  }
  return value as AgentExecutionContextShape;
}

// Range-validate confidenceThreshold: must be a finite number in [0, 1].
// Out-of-range or non-numeric values fall back to 0.5 rather than tripping
// BaseAgent.validateExecutionContext (which would surface as a 500).
function clampConfidenceThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return 0.5;
  return v;
}

// Range-validate maxExecutionTime: finite positive number capped at the
// maximum delay setTimeout supports (2^31 - 1 ms ≈ 24.8 days). Larger
// values trigger Node's TimeoutOverflowWarning and behave as if the
// timer fires immediately.
const MAX_TIMEOUT_MS = 2_147_483_647;
function clampMaxExecutionTime(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 30000;
  return Math.min(v, MAX_TIMEOUT_MS);
}

export interface AgentRouterDependencies {
  logger: Logger;
  telemetry: UnifiedTelemetryService;
  costTracking: CostTrackingService;
  governanceService: GovernanceService;
  orchestrator: MultiAgentOrchestrator;
  agentRegistry: AgentRegistry;
}

export async function createAgentRouter(deps: AgentRouterDependencies): Promise<Router> {
  const router = Router();
  const { logger, telemetry, costTracking, governanceService, orchestrator, agentRegistry } = deps;

  /**
   * POST /api/ai/orchestrate - Execute multi-agent workflow
   * Note: Temporarily disabled for Week 5 testing - requires full DI setup
   */
  router.post('/orchestrate', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    // C5: identity comes from verified sources only (req.auth / req.user /
    // req.tenantContext). Anonymous callers fall back to SYSTEM_IDENTITY.userId
    // (`'__system__'`) — not an attacker-supplied `x-user-id` header.
    const { userId } = extractIdentityContext(req);

    const {
      workflow,
      input,
      context = {},
      config = {}
    } = req.body;

    // Validate required fields
    if (!workflow || !input) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: workflow, input'
      });
    }

    try {
      // Create execution context — narrowContext rejects arrays/class
      // instances/null in addition to non-objects, so spread is safe.
      const ctx = narrowContext(context);
      const executionContext: AgentExecutionContext = {
        sessionId,
        userId,
        timestamp: new Date(),
        correlationId: req.headers['x-correlation-id'] as string || sessionId,
        metadata: {
          // Spread user-supplied context FIRST so the reserved keys
          // below always win — a malicious caller can't overwrite
          // `source` / `userAgent` for audit/telemetry purposes.
          ...ctx,
          source: 'ai-proxy',
          userAgent: req.headers['user-agent'],
        },
        // Defaults satisfy BaseAgent.validateExecutionContext. String/range
        // checks reject malformed inputs that would otherwise 500 there.
        sourceSystem: typeof ctx.sourceSystem === 'string' ? ctx.sourceSystem : 'ai-proxy',
        targetSystem: typeof ctx.targetSystem === 'string' ? ctx.targetSystem : 'ai-proxy',
        industry: typeof ctx.industry === 'string' ? ctx.industry : undefined,
        confidenceThreshold: clampConfidenceThreshold(ctx.confidenceThreshold),
        maxExecutionTime: clampMaxExecutionTime(ctx.maxExecutionTime)
      };

      // Governance pre-check to provide structured error response on violations
      try {
        const preCheck = await governanceService.validateInput(input, executionContext);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          // Record governance block telemetry
          await telemetry.recordGenericEvent('multi_agent_workflow_blocked', {
            sessionId,
            userId,
            workflowType: workflow?.type || 'ad-hoc',
            reason: preCheck.reason,
            riskLevel: preCheck.riskLevel,
            flags: preCheck.flags,
            ruleId
          }, userId, sessionId);

          logger.warn('Governance blocked workflow execution', {
            sessionId,
            reason: preCheck.reason,
            flags: preCheck.flags,
            riskLevel: preCheck.riskLevel,
            ruleId
          });

          return res.status(400).json({
            success: false,
            error: {
              type: 'governance_violation',
              ruleId,
              message: preCheck.reason || 'Blocked by governance policy'
            },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: {
              sessionId,
              timestamp: new Date().toISOString()
            }
          });
        }
      } catch (gerr) {
        // If governance check itself fails, proceed to orchestrator which will handle errors
        logger.error('Governance pre-check error', { sessionId, error: String(gerr) });
      }

      // Execute workflow
      const result = await orchestrator.executeWorkflow(executionContext, workflow, input);

      const duration = Date.now() - startTime;

      // Record telemetry
      await telemetry.recordGenericEvent('multi_agent_workflow_executed', {
        sessionId,
        userId,
        workflowType: workflow.type,
        agentCount: workflow.agents.length,
        duration,
        success: result.success,
        cost: result.cost
      }, userId, sessionId);

      logger.info('Multi-agent workflow executed', {
        sessionId,
        userId,
        workflowType: workflow.type,
        duration,
        success: result.success,
        agentCount: workflow.agents.length
      });

      // Serialize Map in orchestrator results for JSON response
      const serialized = {
        ...result,
        results: result.results instanceof Map ? Object.fromEntries(result.results) : result.results
      };

      res.json({
        success: true,
        result: serialized,
        metadata: {
          sessionId,
          duration,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.agents_orchestrate',
        resourceId: sessionId,
      })) return;
      const duration = Date.now() - startTime;

      await telemetry.recordGenericEvent('multi_agent_workflow_failed', {
        sessionId,
        userId,
        workflowType: workflow?.type || 'unknown',
        duration,
        error: String(error)
      }, userId, sessionId);

      logger.error('Multi-agent workflow failed', {
        sessionId,
        userId,
        error: String(error)
      });

      res.status(500).json({
        success: false,
        error: 'Workflow execution failed',
        sessionId,
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * GET /api/ai/orchestrate/:sessionId/status - Get workflow execution status
   * Note: Temporarily disabled for Week 5 testing
   */
  router.get('/orchestrate/:sessionId/status', asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const status = await orchestrator.getExecutionStatus(sessionId);
    if (!status) {
      return res.status(404).json({ success: false, error: 'Session not found or completed' });
    }
    res.json({ success: true, status, timestamp: new Date().toISOString() });
  }));

  /**
   * GET /api/ai/orchestrate/:sessionId/trace - Get detailed execution trace
   * Note: Temporarily disabled for Week 5 testing
   */
  router.get('/orchestrate/:sessionId/trace', asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const trace = await orchestrator.getExecutionTrace(sessionId);
    if (!trace) {
      return res.status(404).json({ success: false, error: 'Session not found or no trace available' });
    }
    res.json({ success: true, trace, timestamp: new Date().toISOString() });
  }));

  /**
   * GET /api/ai/agents - List available agents and their capabilities
   */
  router.get('/agents', asyncHandler(async (req: Request, res: Response) => {
    try {
      const agentIds = agentRegistry.listAgents();

      const agentsWithStatus = await Promise.all(
        agentIds.map(async (id) => {
          const health = await agentRegistry.getAgentHealth(id);
          return {
            id,
            type: id, // Using id as type for now
            health
          };
        })
      );

      res.json({
        success: true,
        agents: agentsWithStatus,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to list agents', { error: String(error) });

      res.status(500).json({
        success: false,
        error: 'Failed to list agents'
      });
    }
  }));

  /**
   * POST /api/ai/agents/:agentType - Execute single agent
   */
  router.post('/agents/:agentType', asyncHandler(async (req: Request, res: Response) => {
    const { agentType } = req.params;
    const startTime = Date.now();
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    // C5: identity from verified sources; see /orchestrate handler comment.
    const { userId } = extractIdentityContext(req);

    const { input, context = {} } = req.body;

    if (!input) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: input'
      });
    }

    try {
      // Validate agent type
      const validAgentTypes: AgentType[] = ['field-mapping', 'data-quality', 'process-optimization', 'integration-strategy', 'business-intelligence'];
      if (!validAgentTypes.includes(agentType as AgentType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid agent type. Must be one of: ${validAgentTypes.join(', ')}`
        });
      }

      // Get agent
      const agent = agentRegistry.getAgent(agentType);
      if (!agent) {
        return res.status(404).json({
          success: false,
          error: `Agent '${agentType}' not found`
        });
      }

      // Create execution context — narrowContext rejects arrays/class
      // instances/null, so spread is safe.
      const provided = narrowContext(context);
      const executionContext: AgentExecutionContext = {
        sessionId: executionId,
        userId,
        timestamp: new Date(),
        correlationId: req.headers['x-correlation-id'] as string || executionId,
        metadata: {
          // User context first so reserved keys below stay authoritative
          // (a malicious caller can't overwrite source / agentType /
          // userAgent for audit/telemetry).
          ...provided,
          source: 'ai-proxy-direct',
          agentType,
          userAgent: req.headers['user-agent'],
        },
        // Defaults satisfy BaseAgent.validateExecutionContext. String/range
        // checks reject malformed inputs that would otherwise 500 there.
        sourceSystem: typeof provided.sourceSystem === 'string' ? provided.sourceSystem : 'ai-proxy',
        targetSystem: typeof provided.targetSystem === 'string' ? provided.targetSystem : 'ai-proxy',
        industry: typeof provided.industry === 'string' ? provided.industry : undefined,
        confidenceThreshold: clampConfidenceThreshold(provided.confidenceThreshold),
        maxExecutionTime: clampMaxExecutionTime(provided.maxExecutionTime)
      };

      // Governance pre-check for single agent execution
      try {
        const preCheck = await governanceService.validateInput(input, executionContext);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          await telemetry.recordGenericEvent('single_agent_blocked', {
            agentType,
            executionId,
            userId,
            reason: preCheck.reason,
            riskLevel: preCheck.riskLevel,
            flags: preCheck.flags,
            ruleId
          }, userId, executionId);

          logger.warn('Governance blocked single agent execution', {
            agentType,
            executionId,
            reason: preCheck.reason,
            flags: preCheck.flags,
            riskLevel: preCheck.riskLevel,
            ruleId
          });

          return res.status(400).json({
            success: false,
            error: {
              type: 'governance_violation',
              ruleId,
              message: preCheck.reason || 'Blocked by governance policy'
            },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: {
              agentType,
              executionId,
              timestamp: new Date().toISOString()
            }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (single agent)', { executionId, agentType, error: String(gerr) });
      }

      // Execute agent
      const result = await agent.execute(executionContext, input);

      const duration = Date.now() - startTime;

      // Record telemetry
      await telemetry.recordGenericEvent('single_agent_executed', {
        agentType,
        executionId,
        userId,
        duration,
        success: result.success,
        confidence: result.confidence
      }, userId, executionId);

      logger.info('Single agent executed', {
        agentType,
        executionId,
        userId,
        duration,
        success: result.success,
        confidence: result.confidence
      });

      res.json({
        success: true,
        result,
        metadata: {
          agentType,
          executionId,
          duration,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: `ai_proxy.agent.${agentType}`,
        resourceId: executionId,
      })) return;
      const duration = Date.now() - startTime;

      await telemetry.recordGenericEvent('single_agent_failed', {
        agentType,
        executionId,
        userId,
        duration,
        error: String(error)
      }, userId, executionId);

      logger.error('Single agent execution failed', {
        agentType,
        executionId,
        userId,
        error: String(error)
      });

      res.status(500).json({
        success: false,
        error: 'Agent execution failed',
        agentType,
        executionId,
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * GET /api/ai/proxy/agents/costs - Get cost limits and recent usage snapshot
   */
  router.get('/agents/costs', asyncHandler(async (req: Request, res: Response) => {
    try {
      const limits = costTracking.getCostLimits();
      const stats = await costTracking.getUsageStatistics('day');

      res.json({
        success: true,
        costLimits: limits,
        usage: {
          timeframe: stats.timeframe,
          totalCost: stats.totalCost,
          totalRequests: stats.totalRequests,
          totalTokens: stats.totalTokens,
          totalSessions: stats.totalSessions,
          avgCostPerSession: stats.avgCostPerSession,
          avgCostPerRequest: stats.avgCostPerRequest
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get cost limits/usage', { error: String(error) });
      res.status(500).json({ success: false, error: 'Failed to get costs' });
    }
  }));

  return router;
}
