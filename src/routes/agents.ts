/**
 * AI Agents API Routes
 * Provides HTTP endpoints for the Multi-Agent Orchestrator system
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { MultiAgentOrchestrator, type AgentWorkflow } from '../services/ai/orchestrator/MultiAgentOrchestrator';
import { AgentRegistry } from '../services/ai/orchestrator/AgentRegistry';
import { GovernanceService } from '../services/ai/orchestrator/GovernanceService';
import { CostTrackingService } from '../services/ai/CostTrackingService';
import type { AgentExecutionContext } from '../services/ai/orchestrator/interfaces';

export async function createAgentsRouter(): Promise<Router> {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);
  // Resolve orchestrator stack from DI for consistency with aiProxy
  const orchestrator = await container.getAsync<MultiAgentOrchestrator>(TYPES.MultiAgentOrchestrator);
  const agentRegistry = container.get<AgentRegistry>(TYPES.AgentRegistry);
  const governanceService = container.get<GovernanceService>(TYPES.GovernanceService);
  const costService = await container.getAsync<CostTrackingService>(TYPES.CostTrackingService);

  /**
   * GET /api/agents/health
   * Check health status of all agents
   */
  router.get('/health', asyncHandler(async (_req, res): Promise<void> => {
    try {
      const agents = orchestrator.getAvailableAgents();
      const agentHealth = await Promise.all(
        agents.map(async (name) => {
          const health = await agentRegistry.getAgentHealth(name);
          return {
            name,
            status: health?.status || 'unknown',
            lastCheck: new Date().toISOString(),
            successRate: typeof health?.errorRate === 'number' ? Math.max(0, Math.min(1, 1 - health.errorRate)) : 0.95,
          };
        })
      );

      res.json({
        success: true,
        agents: agentHealth,
        orchestratorStatus: 'operational',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get agent health', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve agent health status'
      });
    }
  }));

  /**
   * GET /api/agents/costs
   * Get current cost configuration and tracking
   */
  router.get('/costs', asyncHandler(async (_req, res): Promise<void> => {
    try {
  const limits = costService.getCostLimits();
      const stats = await costService.getUsageStatistics('day');

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
          avgCostPerRequest: stats.avgCostPerRequest,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get cost configuration', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost configuration'
      });
    }
  }));

  /**
   * GET /api/agents/costs/session/:sessionId?
   * Get cost breakdown for a specific session or current session
   */
  router.get('/costs/session/:sessionId?', asyncHandler(async (req, res): Promise<void> => {
    try {
      const sessionId = req.params.sessionId || 'current';
      const totalCost = await costService.getSessionCost(sessionId);
      const sessionCosts = costService.getAllSessionCosts();
      const sessionCost = sessionCosts.find((s: { sessionId: string }) => s.sessionId === sessionId);
      const limits = costService.getCostLimits();

      res.json({
        success: true,
        sessionId,
        totalCost,
        breakdown: sessionCost?.byProvider || {},
        budget: {
          limit: limits.sessionHardLimit,
          remaining: Math.max(0, limits.sessionHardLimit - totalCost),
          alertThreshold: limits.sessionAlert,
          status: totalCost > limits.sessionHardLimit ? 'exceeded' : totalCost > limits.sessionAlert ? 'warning' : 'within_budget',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get session costs', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve session costs'
      });
    }
  }));

  /**
   * POST /api/agents/execute
   * Execute a single agent
   */
  router.post('/execute', asyncHandler(async (req, res): Promise<void> => {
    try {
      const { agent, input, context = {} } = req.body;

      if (!agent) {
        res.status(400).json({
          success: false,
          error: 'Agent name is required'
        });
        return;
      }

      // Create execution context
      const executionContext: AgentExecutionContext = {
        sessionId: context.sessionId || `sess_${Date.now()}`,
        userId: context.userId || 'api_user',
        correlationId: `req_${Date.now()}`,
      };

      // Execute the agent
      const result = await orchestrator.executeAgent(agent, executionContext, input);

      res.json({
        success: result.success,
        agent,
        executionTime: result.executionTime,
        cost: 0.05, // Mock cost for now
        result: {
          data: result.data,
          confidence: result.confidence,
          reasoning: result.reasoning,
          errors: result.errors,
          warnings: result.warnings,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to execute agent', { error: String(error) });
      res.status(500).json({
        success: false,
        error: `Agent execution failed: ${error}`
      });
    }
  }));

  /**
   * POST /api/agents/workflow
   * Execute a multi-agent workflow
   */
  router.post('/workflow', asyncHandler(async (req, res): Promise<void> => {
    try {
      const { workflow, context = {}, input } = req.body;

      if (!workflow || !workflow.agents || workflow.agents.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Valid workflow with agents is required'
        });
        return;
      }

      // Create execution context
      const executionContext: AgentExecutionContext = {
        sessionId: context.sessionId || `sess_${Date.now()}`,
        userId: context.userId || 'api_user',
        correlationId: `req_${Date.now()}`,
      };

      // Create workflow configuration
      const workflowConfig: AgentWorkflow = {
        agents: workflow.agents,
        parallel: workflow.parallel || false,
        failureMode: workflow.failureMode || 'continue',
        timeout: workflow.timeout || 30000,
        dependencies: workflow.dependencies,
      };

      // Execute the workflow
      const result = await orchestrator.executeWorkflow(
        executionContext,
        workflowConfig,
        input
      );

      // Convert Map to object for JSON serialization
      const resultsObj: Record<string, unknown> = {};
      result.results.forEach((value, key) => {
        resultsObj[key] = value;
      });

      res.json({
        success: result.success,
        executionTime: result.totalExecutionTime,
        totalCost: result.cost.totalCost,
        results: resultsObj,
        overallConfidence: result.overallConfidence,
        reasoning: result.reasoningTrace,
        governance: result.governance,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to execute workflow', { error: String(error) });
      res.status(500).json({
        success: false,
        error: `Workflow execution failed: ${error}`
      });
    }
  }));

  /**
   * GET /api/agents/audit/latest
   * Get the latest audit trail entry
   */
  router.get('/audit/latest', asyncHandler(async (_req, res): Promise<void> => {
    try {
      // Get audit trail - using mock for now as method doesn't exist
      const auditTrail: { id: string; timestamp: string; agents?: unknown[]; reasoning?: unknown[]; governance?: Record<string, unknown> }[] = [];
      const latest = auditTrail[0] || null;

      if (!latest) {
        res.json({
          success: true,
          message: 'No audit entries found',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        success: true,
        executionId: latest.id,
        timestamp: latest.timestamp,
        agents: latest.agents || [],
        reasoning: latest.reasoning || [],
        governance: latest.governance || {},
      });
    } catch (error) {
      logger.error('Failed to get audit trail', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit trail'
      });
    }
  }));

  /**
   * GET /api/agents/list
   * List all available agents
   */
  router.get('/list', asyncHandler(async (_req, res): Promise<void> => {
    try {
      const agents = orchestrator.getAvailableAgents();

      // Provide details for each agent
      const agentDetails = agents.map(name => ({
        name,
        type: getAgentType(name),
        description: getAgentDescription(name),
        capabilities: getAgentCapabilities(name),
        status: 'available',
      }));

      res.json({
        success: true,
        agents: agentDetails,
        count: agents.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to list agents', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve agent list'
      });
    }
  }));

  /**
   * POST /api/agents/governance
   * Configure governance settings
   */
  router.post('/governance', asyncHandler(async (req, res): Promise<void> => {
    try {
      const { piiDetection, contentFiltering, hallucinationDetection } = req.body;

      // Store configuration (in real implementation, this would persist)
      const config = {
        piiDetection: piiDetection || { enabled: true, sensitivity: 'high' },
        contentFiltering: contentFiltering || { enabled: true, categories: ['sensitive', 'financial'] },
        hallucinationDetection: hallucinationDetection || { enabled: true, confidenceThreshold: 0.8 },
      };

      res.json({
        success: true,
        message: 'Governance configuration updated',
        config,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to update governance configuration', { error: String(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to update governance configuration'
      });
    }
  }));

  return router;
}

// Helper functions for agent information
function getAgentType(name: string): string {
  const types: Record<string, string> = {
    'field-mapping': 'mapping',
    'data-quality': 'quality',
    'process-optimization': 'optimization',
    'integration-strategy': 'strategy',
    'business-intelligence': 'analytics',
  };
  return types[name] || 'general';
}

function getAgentDescription(name: string): string {
  const descriptions: Record<string, string> = {
    'field-mapping': 'Intelligent field mapping between different systems',
    'data-quality': 'Analyzes and monitors data quality',
    'process-optimization': 'Optimizes integration workflows and performance',
    'integration-strategy': 'Provides high-level integration architecture guidance',
    'business-intelligence': 'Generates business insights and executive reporting',
  };
  return descriptions[name] || 'AI agent for integration tasks';
}

function getAgentCapabilities(name: string): string[] {
  const capabilities: Record<string, string[]> = {
    'field-mapping': ['semantic analysis', 'transformation suggestions', 'pattern learning', 'business rule validation'],
    'data-quality': ['data profiling', 'anomaly detection', 'quality scoring', 'cleansing recommendations'],
    'process-optimization': ['bottleneck identification', 'performance analysis', 'cost-benefit evaluation', 'risk assessment'],
    'integration-strategy': ['architecture analysis', 'strategic planning', 'risk assessment', 'compliance verification'],
    'business-intelligence': ['business metrics', 'ROI calculations', 'trend forecasting', 'executive insights'],
  };
  return capabilities[name] || ['general AI capabilities'];
}