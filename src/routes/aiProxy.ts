/**
 * AI Proxy Routes - Secure server-side AI provider access
 * Implements ADR-001: Server-Side Secret Management
 * Implements ADR-003: Unified Telemetry Schema
 * Implements ADR-014: Canonical AI Router Family (PR 1B)
 *
 * Refactored: Oct 27, 2025 - Phase 2 God Class Elimination
 * Consolidated: PR 1B - All direct-family routes migrated here
 *
 * Sub-router inventory (12 total):
 *   Original 6: Provider, Mapping, Agent, BusinessIntelligence, Quality, MCP
 *   Migrated 6: MetricsNLQ, Dashboard, NaturalLanguage, Phase2, PredictiveConnector, Workflow
 *   Absorbed 1: ProviderConfig (from aiProvider.ts)
 */

import { Router } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { ProviderRegistry } from '../services/ai/ProviderRegistry';
import { UnifiedTelemetryService } from '../services/UnifiedTelemetryService';
import { CostTrackingService } from '../services/ai/CostTrackingService';
import rateLimit from 'express-rate-limit';

// AI Proxy utility modules
// (Provider initialization moved to inversify.config.ts to fix race condition)

// Week 5 Multi-Agent Orchestrator imports
import type { MultiAgentOrchestrator } from '../services/ai/orchestrator/MultiAgentOrchestrator';
import { AgentRegistry } from '../services/ai/orchestrator/AgentRegistry';
import { GovernanceService } from '../services/ai/orchestrator/GovernanceService';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import { ModelCatalogService } from '../services/ai/ModelCatalogService';
import { BusinessIntelligenceAgent } from '../services/ai/orchestrator/agents/BusinessIntelligenceAgent';
import type { SyncCentralOrchestrator } from '../services/sync/SyncCentralOrchestrator';
import type { SyncCentralService } from '../services/SyncCentralService';
import type { MCPAggregatorService } from '../services/mcp/MCPAggregatorService';
import type { MCPPolicyService } from '../services/mcp/MCPPolicyService';
import { isMCPGatewayEnabled } from '../config/runtimeFlags';

// PR 1B: Migrated service imports for newly-absorbed routers
import { AINaturalLanguageService } from '../services/AINaturalLanguageService';
import { AIDataQualityService } from '../services/AIDataQualityService';
import { AIBusinessIntelligenceService } from '../services/AIBusinessIntelligenceService';
import type { DocumentationKnowledgeBase } from '../services/help/DocumentationKnowledgeBase';
import { AIWorkflowIntelligenceService } from '../services/AIWorkflowIntelligenceService';
import { AIPredictiveConnectorService } from '../services/AIPredictiveConnectorService';
import { AIProviderConfigService, type StoredAIConfig } from '../utils/ai/AIProviderConfigService';
import { ROIAnalysisService } from '../services/ai/orchestrator/agents/intelligence/ROIAnalysisService';
import { asyncHandler } from '../middleware/asyncHandler';

// Sub-routers — original 6 (Phase 2 refactoring)
import { createProviderRouter } from './ai-proxy/ProviderRouter';
import { createMappingRouter } from './ai-proxy/MappingRouter';
import { createAgentRouter } from './ai-proxy/AgentRouter';
import { createBusinessIntelligenceRouter } from './ai-proxy/BusinessIntelligenceRouter';
import { createQualityRouter } from './ai-proxy/QualityRouter';
import { createMCPRouter } from './ai-proxy/MCPRouter';

// Sub-routers — migrated 6 (PR 1B consolidation)
import { createMetricsNLQRouter } from './ai-proxy/MetricsNLQRouter';
import { createDashboardRouter } from './ai-proxy/DashboardRouter';
import { createNaturalLanguageRouter } from './ai-proxy/NaturalLanguageRouter';
import { createPhase2Router } from './ai-proxy/Phase2Router';
import { createPredictiveConnectorRouter } from './ai-proxy/PredictiveConnectorRouter';
import { createWorkflowRouter } from './ai-proxy/WorkflowRouter';
import {
  createLegacyBusinessIntelligenceRouter,
  createLegacyDataQualityRouter,
  createLegacyFieldMappingRouter,
} from './ai-proxy/LegacyCompatibilityRouter';
import { aiMappingRouter } from './aiMapping';
import { qualityRouter as legacyQualityRouter } from './quality';

// Governance middleware (PR 1B)
import { createGovernanceMiddleware } from '../middleware/governanceMiddleware';

// Rate limiting for AI endpoints
const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many AI requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export async function createAIProxyRouter(options?: {
  knowledgeBase?: DocumentationKnowledgeBase;
}): Promise<Router> {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);
  const telemetry = container.get<UnifiedTelemetryService>(TYPES.UnifiedTelemetryService);
  const costTracking = await container.getAsync<CostTrackingService>(TYPES.CostTrackingService);

  // Resolve provider registry from DI (providers already initialized during DI setup)
  const registry = container.get<ProviderRegistry>(TYPES.ProviderRegistry);

  // Resolve orchestrator stack from DI
  const orchestrator = await container.getAsync<MultiAgentOrchestrator>(TYPES.MultiAgentOrchestrator);
  const agentRegistry = container.get<AgentRegistry>(TYPES.AgentRegistry);
  const governanceService = container.get<GovernanceService>(TYPES.GovernanceService);
  const modelCatalog = container.get<ModelCatalogService>(TYPES.ModelCatalogService);
  const businessIntelligenceAgent = container.get<BusinessIntelligenceAgent>(BusinessIntelligenceAgent);
  const syncOrchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const auditService = container.isBound(TYPES.AuditService)
    ? container.get<AuditService>(TYPES.AuditService)
    : undefined;

  const gatewayEnabled = isMCPGatewayEnabled();
  const aggregatorService = gatewayEnabled && container.isBound(TYPES.MCPAggregatorService)
    ? container.get<MCPAggregatorService>(TYPES.MCPAggregatorService)
    : undefined;
  const policyService = gatewayEnabled && container.isBound(TYPES.MCPPolicyService)
    ? container.get<MCPPolicyService>(TYPES.MCPPolicyService)
    : undefined;

  // PR 1B: Resolve services for newly-migrated routers
  const workflowIntelligenceService = container.get<AIWorkflowIntelligenceService>(TYPES.AIWorkflowIntelligenceService);
  const predictiveConnectorService = container.get<AIPredictiveConnectorService>(TYPES.AIPredictiveConnectorService);
  const naturalLanguageService = new AINaturalLanguageService(options?.knowledgeBase);
  const legacyDataQualityService = new AIDataQualityService();
  const legacyBusinessIntelligenceService = new AIBusinessIntelligenceService(
    container.get<ROIAnalysisService>(TYPES.ROIAnalysisService)
  );

  // Apply rate limiting to all AI routes
  router.use(aiRateLimit);

  // PR 1B: Apply centralized governance middleware.
  // auditOnly=false — all requests are policy-gated (POST endpoints send data to LLMs).
  const governanceMiddleware = createGovernanceMiddleware({
    governanceService,
    logger,
    auditOnly: false,
  });
  router.use(governanceMiddleware);

  // ===== MOUNT SUB-ROUTERS (Phase 2 Refactoring) =====

  // Legacy direct-family compatibility handlers. These run behind the proxy
  // governance middleware and only cover retired paths with no exact canonical
  // proxy equivalent.
  const legacyAuth: import('express').RequestHandler = (_req, _res, next) => next();
  router.use('/field-mapping', createLegacyFieldMappingRouter(legacyAuth));
  router.use('/data-quality', createLegacyDataQualityRouter(legacyDataQualityService, legacyAuth));
  router.use('/business-intelligence', createLegacyBusinessIntelligenceRouter(legacyBusinessIntelligenceService, legacyAuth));

  // Provider Router: Provider status, model management, provider testing (7 endpoints)
  const providerRouter = await createProviderRouter({
    logger,
    registry,
    modelCatalog
  });
  router.use('/', providerRouter);

  // Mapping Router: Field mapping suggestions, transformations, validations (6 endpoints)
  const mappingRouter = await createMappingRouter({
    logger,
    telemetry,
    costTracking,
    governanceService,
    orchestrator
  });
  router.use('/', mappingRouter);

  // Agent Router: Multi-agent orchestration, single agent execution (6 endpoints)
  const agentRouter = await createAgentRouter({
    logger,
    telemetry,
    costTracking,
    governanceService,
    orchestrator,
    agentRegistry
  });
  router.use('/', agentRouter);

  // Business Intelligence Router: BI analysis, compliance, ROI (4 endpoints)
  const businessIntelligenceRouter = await createBusinessIntelligenceRouter({
    logger,
    telemetry,
    governanceService,
    businessIntelligenceAgent
  });
  router.use('/', businessIntelligenceRouter);

  // Quality Router: Telemetry, data quality, provider testing (3 endpoints)
  const proxyQualityRouter = await createQualityRouter({
    logger,
    telemetry,
    registry,
    governanceService
  });
  router.use('/', proxyQualityRouter);

  // MCP Router: Native MCP-compatible tools/list + tools/call interface (2 HTTP endpoints, 3 JSON-RPC methods)
  const mcpRouter = await createMCPRouter({
    logger,
    governanceService,
    orchestrator,
    syncOrchestrator,
    syncService,
    aggregatorService,
    policyService,
    auditService,
    costTrackingService: costTracking,
  });
  router.use('/mcp', mcpRouter);

  // ===== MOUNT MIGRATED SUB-ROUTERS (PR 1B Consolidation) =====

  // Metrics & NLQ Router: Cross-module metrics, NLQ, anomalies (6 endpoints)
  router.use('/', createMetricsNLQRouter());

  // Dashboard Router: AI dashboard overview + service testing (2 endpoints)
  router.use('/dashboard', createDashboardRouter({ logger }));

  // Natural Language Router: NL config, troubleshoot, docs, explain (4 endpoints)
  router.use('/natural-language', createNaturalLanguageRouter({ logger, naturalLanguageService }));

  // Phase 2 Router: SyncCentral health + supplier risk scoring (8 endpoints)
  router.use('/', createPhase2Router());

  // Predictive Connector Router: Recommendations, predictions, pathway optimization (4 endpoints)
  router.use('/predictive-connectors', createPredictiveConnectorRouter({ logger, predictiveConnectorService }));

  // Workflow Router: Workflow analysis, predictions, optimization (3 endpoints)
  router.use('/workflow-intelligence', createWorkflowRouter({ logger, workflowIntelligenceService }));

  // Legacy /api/ai/mapping/* and /api/ai/quality/* demo endpoints now live
  // behind the governed proxy boundary for redirect compatibility.
  router.use('/mapping', aiMappingRouter);
  router.use('/quality', legacyQualityRouter);

  // ===== ABSORBED PROVIDER CONFIG (from aiProvider.ts) =====

  const cfgService = new AIProviderConfigService(logger, container.get(TYPES.ConfigDirectory));

  router.get('/provider-config', asyncHandler(async (_req, res): Promise<void> => {
    const cfg = cfgService.getConfig();
    void res.json({ success: true, config: cfg });
  }));

  router.put('/provider-config', asyncHandler(async (req, res): Promise<void> => {
    const body = req.body || {};
    const mode = body.mode as StoredAIConfig['mode'];
    if (!['rule-based', 'cloud-api', 'local-llm'].includes(String(mode))) {
      res.status(400).json({ success: false, error: 'Invalid mode' });
      return;
    }
    const cfg: StoredAIConfig = { mode, cloud: body.cloud || {}, local: body.local || {} };
    cfgService.setConfig(cfg);
    void res.json({ success: true, config: cfg });
  }));

  router.post('/provider-config/test', asyncHandler(async (_req, res): Promise<void> => {
    const provider = cfgService.getProvider(logger);
    const result = await provider.testConnection();
    void res.json({ success: result.ok, message: result.message });
  }));

  logger.info('AI Proxy router initialized with 12 sub-routers + provider-config (PR 1B consolidated)', {
    subRouters: [
      'ProviderRouter', 'MappingRouter', 'AgentRouter', 'BusinessIntelligenceRouter', 'QualityRouter', 'MCPRouter',
      'MetricsNLQRouter', 'DashboardRouter', 'NaturalLanguageRouter', 'Phase2Router', 'PredictiveConnectorRouter', 'WorkflowRouter',
    ],
    governanceMiddleware: 'enabled',
    refactoringPhase: '2 + PR-1B',
  });

  return router;
}
