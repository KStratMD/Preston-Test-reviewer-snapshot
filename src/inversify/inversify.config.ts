import 'reflect-metadata';
import { Container, type interfaces } from 'inversify';
import { TYPES } from './types';
import { ConfigurationService } from '../services/ConfigurationService';
import { IntegrationService } from '../services/IntegrationService';
import { AuthService } from '../services/AuthService';
import { Logger } from '../utils/Logger';
import { TransformationEngine } from '../services/TransformationEngine';
import { ServiceFactory } from '../factories/ServiceFactory';
import { SecureCredentialManager } from '../services/SecureCredentialManager';
import { SecureConfigurationService } from '../services/SecureConfigurationService';
import { InMemoryCredentialMetadataStore } from '../services/InMemoryCredentialMetadataStore';
import type { ICredentialMetadataStore } from '../interfaces/ICredentialMetadataStore';
import type { IConnector } from '../interfaces/IConnector';
import { env, mcpGatewayConfig } from '../config';
import type { ObservabilityConfig } from '../observability';
import { ObservabilityService } from '../observability';
// New integration services
import { ConnectorManager } from '../services/integration/ConnectorManager';
import { IntegrationStatusManager } from '../services/integration/IntegrationStatusManager';
// Week 2 AI Services
import { CostTrackingService } from '../services/ai/CostTrackingService';
import { ABTestingService } from '../services/ai/ABTestingService';
import { MockLLMProvider } from '../services/ai/providers/MockLLMProvider';
import { AIConfigurationService } from '../services/ai/AIConfigurationService';
import { AIConfigurationBridge } from '../services/ai/AIConfigurationBridge';
import { SecureAIService } from '../services/ai/SecureAIService';
import { IntegrationExecutor } from '../services/integration/IntegrationExecutor';
import { IntegrationOrchestrator } from '../services/integration/IntegrationOrchestrator';
import { SagaOrchestrator } from '../services/integration/SagaOrchestrator';
// Note: dynamic require of CacheService removed; cache is provided by ServiceFactory below
import { SquireConnector } from '../connectors/SquireConnector';
import { wrapWithDecorator } from '../connectors/wrapWithDecorator';
// PR-OP-2 (tenant kill switch): see DI wiring near end of file for binding
// details — kept the bindings adjacent to their explanatory comment, but the
// imports live up here with the rest of the service imports for consistency.
import { TenantLifecycleRepository } from '../services/tenants/TenantLifecycleRepository';
import { TenantLifecycleService } from '../services/tenants/TenantLifecycleService';
import {
  type ConnectorDeps,
  type ConnectorRegistration,
  getConnectorRegistration,
} from '../connectors/connectorRegistry';
// Direct connector imports for NetSuite/Shopify/ShipStation/HubSpot/SuiteCentral
// were removed in PR 6A-2 — the bindings below build their instances via
// `entry.factory(systemId, deps)`. Constructor knowledge for those connectors
// lives in `src/connectors/connectorRegistry.ts`. The audit gate
// `audit-status-claims --check-wired-connectors` rejects any `new XxxConnector(`
// reintroduced here for a registry-factory-wired class.
//
// SquireConnector and SuiteCentralConnectorProd have no factory closure (DI-only
// by design) so their `new` calls remain hand-rolled below.
import { TelemetryStore } from '../services/TelemetryStore';
import { TelemetryAggregator } from '../services/TelemetryAggregator';
import { TelemetryService } from '../services/TelemetryService';
import { DLQService } from '../services/DLQService';
import { DataMigrationAccelerator } from '../services/DataMigrationAccelerator';
import { SuiteCentralConfigService } from '../services/SuiteCentralConfigService';
import { SuiteCentralMonitoringService } from '../services/SuiteCentralMonitoringService';
import { SuiteCentralConnectorProd } from '../connectors/SuiteCentralConnectorProd';
// SuiteCentral feature services
import { PaymentCentralService } from '../services/PaymentCentralService';
import { SupplierCentralService } from '../services/SupplierCentralService';
import { InstallerCentralService } from '../services/InstallerCentralService';
import { FinanceCentralService } from '../services/FinanceCentralService';
import { InventoryCentralService } from '../services/InventoryCentralService';
import { ServiceCentralService } from '../services/ServiceCentralService';
import { CustomerCentralService } from '../services/CustomerCentralService';
import { QualityCentralService } from '../services/QualityCentralService';
import { ContractCentralService } from '../services/ContractCentralService';
import { PortalCentralService } from '../services/PortalCentralService';
import { WorkflowCentralService } from '../services/WorkflowCentralService';
import { PayoutCentralService } from '../services/PayoutCentralService';
import { SyncCentralService } from '../services/SyncCentralService';
import { SyncCentralOrchestrator } from '../services/sync/SyncCentralOrchestrator';
import { AutomationLibrariesService } from '../services/AutomationLibrariesService';
import { AIFieldMappingService } from '../services/ai/AIFieldMappingService';
import { TrainingDataRepository } from '../services/ai/TrainingDataRepository';
import { UnmappableFieldDetectionService } from '../services/ai/validation/UnmappableFieldDetectionService';
import { AccuracyEnhancementService } from '../services/ai/validation/AccuracyEnhancementService';
// New AI services (Week 1 Task 2)
import { ProviderRegistry } from '../services/ai/ProviderRegistry';
import { initializeProvidersWeek2 } from '../routes/ai-proxy/utils/provider-init';
import { OpenAIProvider } from '../services/ai/providers/OpenAIProvider';
import { ClaudeProvider } from '../services/ai/providers/ClaudeProvider';
import { GrokProvider } from '../services/ai/providers/GrokProvider';
import { GeminiProvider } from '../services/ai/providers/GeminiProvider';
import { LMStudioProvider } from '../services/ai/providers/LMStudioProvider';
import { OpenRouterProvider } from '../services/ai/providers/OpenRouterProvider';
import { normalizePositiveInteger } from '../services/ai/utils/openRouter';
import { resolveLMStudioBaseUrl } from '../services/ai/utils/lmstudio';
// Unified telemetry (Week 1 Task 3)
import { UnifiedTelemetryService } from '../services/UnifiedTelemetryService';
// Database service
import { DatabaseService } from '../database/DatabaseService';

import { DemoModeService } from '../services/DemoModeService';
import { UserSettingsService } from '../services/UserSettingsService';
// Week 5 Orchestrator imports
import { MultiAgentOrchestrator } from '../services/ai/orchestrator/MultiAgentOrchestrator';
import { AgentRegistry } from '../services/ai/orchestrator/AgentRegistry';
import { FieldMappingAgent } from '../services/ai/orchestrator/agents/FieldMappingAgent';
import { DataQualityAgent } from '../services/ai/orchestrator/agents/DataQualityAgent';
import { ProcessOptimizationAgent } from '../services/ai/orchestrator/agents/ProcessOptimizationAgent';
import { IntegrationStrategyAgent } from '../services/ai/orchestrator/agents/IntegrationStrategyAgent';
import { BusinessIntelligenceAgent } from '../services/ai/orchestrator/agents/BusinessIntelligenceAgent';
import { DunningAgent } from '../services/ai/orchestrator/agents/DunningAgent';
import { DocumentParsingAgent } from '../services/ai/orchestrator/agents/DocumentParsingAgent';
import { VendorOnboardingAgent } from '../services/ai/orchestrator/agents/VendorOnboardingAgent';
import { ReasoningTraceEngine } from '../services/ai/orchestrator/ReasoningTraceEngine';
import { GovernanceService } from '../services/ai/orchestrator/GovernanceService';
import { AuditService } from '../services/ai/orchestrator/AuditService';
import { ModelCatalogService } from '../services/ai/ModelCatalogService';
// Universal Translator - Week 1-2 (LLM Integration Foundation)
import { SemanticAnalysisEngine } from '../services/ai/SemanticAnalysisEngine';
// Business Intelligence Agent Services (Phase 2)
import { MetricsCalculationService } from '../services/ai/orchestrator/agents/intelligence/MetricsCalculationService';
import { ROIAnalysisService } from '../services/ai/orchestrator/agents/intelligence/ROIAnalysisService';
import { ForecastingService } from '../services/ai/orchestrator/agents/intelligence/ForecastingService';
import { InsightsGeneratorService } from '../services/ai/orchestrator/agents/intelligence/InsightsGeneratorService';
// Process Optimization Agent Services
import { BottleneckAnalysisService } from '../services/ai/orchestrator/agents/optimization/BottleneckAnalysisService';
import { PerformanceMetricsService } from '../services/ai/orchestrator/agents/optimization/PerformanceMetricsService';
import { CostBenefitAnalyzer } from '../services/ai/orchestrator/agents/optimization/CostBenefitAnalyzer';
import { RiskAssessmentService } from '../services/ai/orchestrator/agents/optimization/RiskAssessmentService';
import { OptimizationRecommender } from '../services/ai/orchestrator/agents/optimization/OptimizationRecommender';
// Data Quality Agent Services
import { DataProfilingService } from '../services/ai/orchestrator/agents/quality/DataProfilingService';
import { AnomalyDetectionService } from '../services/ai/orchestrator/agents/quality/AnomalyDetectionService';
import { QualityScoringService } from '../services/ai/orchestrator/agents/quality/QualityScoringService';
import { CleansingRecommender } from '../services/ai/orchestrator/agents/quality/CleansingRecommender';
// Phase 3: AI Workflow & Predictive Connector Dependencies
import { LoggingService } from '../services/ai/logging/LoggingService';
import { PredictiveAnalyticsService } from '../services/ai/PredictiveAnalyticsService';
import { ProactiveIssueDetectionService } from '../services/ai/ProactiveIssueDetectionService';
import { PerformanceOptimizationService } from '../services/ai/PerformanceOptimizationService';
import { MappingPatternCacheService } from '../services/ai/MappingPatternCacheService';
import { AIWorkflowIntelligenceService } from '../services/AIWorkflowIntelligenceService';
import { AIPredictiveConnectorService } from '../services/AIPredictiveConnectorService';
// Security Services (DLP/NER)
import { DLPService } from '../services/security/DLPService';
import { NERService } from '../services/security/NERService';
// Reasoning Trace Service
import { ReasoningTraceService } from '../services/ai/ReasoningTraceService';
// Connector Credential Management
import { ConnectorCredentialService } from '../services/ConnectorCredentialService';
import { ConnectorCredentialRouter } from '../routes/ConnectorCredentialRouter';
// NetSuite MCP Integration (Phase 2-3)
import { NetSuiteMCPSchemaAdapter } from '../services/netsuite/mcp/NetSuiteMCPSchemaAdapter';
import { MCPKnowledgeProvider } from '../services/ai/mcp/MCPKnowledgeProvider';
import { MCPFieldMappingEnhancer } from '../services/ai/mcp/MCPFieldMappingEnhancer';
import { MCPABTestService } from '../services/ai/mcp/MCPABTestService';
import { MCPUserSettingsService } from '../services/settings/MCPUserSettingsService';
import { NetSuiteOfficialMcpClient } from '../services/netsuite/mcp/NetSuiteOfficialMcpClient';
import { BusinessCentralMcpClient } from '../services/bc/mcp/BusinessCentralMcpClient';
import { MCPAggregatorService } from '../services/mcp/MCPAggregatorService';
import { MCPPolicyService } from '../services/mcp/MCPPolicyService';
import type { IMCPAdapter } from '../services/mcp/IMCPAdapter';
import type { IMCPTokenProvider } from '../services/mcp/IMCPTokenProvider';
import {
  OAuth2ClientCredentialsMCPTokenProvider,
  StaticMCPTokenProvider,
} from '../services/mcp/IMCPTokenProvider';
import {
  isNetSuiteMCPSchemaEnabled,
  isNetSuiteMCPAIContextEnabled,
  isMCPGatewayEnabled,
  isBusinessCentralMCPEnabled,
} from '../config/runtimeFlags';
// Authentication Configuration
import { configureAuthBindings } from './auth-bindings';
// Phase 1: AI-Enhanced SuiteCentral 2.0 Services
import { ModuleMetricsAggregator } from '../services/metrics/ModuleMetricsAggregator';
import { NLQCapabilityRegistry } from '../services/ai/NLQCapabilityRegistry';
import { NLQueryOrchestrator } from '../services/ai/NLQueryOrchestrator';
// Phase 2: AI-Enhanced SuiteCentral 2.0 Services (grouped with Phase 1 for maintainability)
import { SyncCentralHealthPredictor } from '../services/ai/SyncCentralHealthPredictor';
import { SupplierRiskScoringService } from '../services/ai/SupplierRiskScoringService';
// Phase 3: Enterprise Reliability (Grand Unified Strategy 2026)
import { SchemaRegistryService } from '../services/sync/SchemaRegistryService';

const container = new Container();


// Core logger binding
container.bind<Logger>(TYPES.Logger).toDynamicValue(() => new Logger('IntegrationHub')).inSingletonScope();

container.bind<UserSettingsService>(TYPES.UserSettingsService).to(UserSettingsService).inSingletonScope();
container.bind<string>(TYPES.ConfigDirectory).toConstantValue(env.CONFIG_DIR);
container.bind<DatabaseService>(TYPES.DatabaseService).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const dbService = new DatabaseService(logger);
  await dbService.initialize();
  return dbService;
}).inSingletonScope();
container.bind<DemoModeService>(TYPES.DemoModeService).to(DemoModeService).inSingletonScope();
// Security Services (DLP/NER)
container.bind<DLPService>(TYPES.DLPService).to(DLPService).inSingletonScope();
container.bind<NERService>(TYPES.NERService).to(NERService).inSingletonScope();
// Reasoning Trace Service
container.bind<ReasoningTraceService>(TYPES.ReasoningTraceService).to(ReasoningTraceService).inSingletonScope();
// Connector Credential Management
container.bind<ConnectorCredentialService>(TYPES.ConnectorCredentialService).to(ConnectorCredentialService).inSingletonScope();
container.bind<ConnectorCredentialRouter>(ConnectorCredentialRouter).toSelf().inSingletonScope();
container.bind<ConfigurationService>(TYPES.ConfigurationService).to(ConfigurationService).inSingletonScope();
container.bind<IntegrationService>(TYPES.IntegrationService).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const transformationEngine = context.container.get<TransformationEngine>(TYPES.TransformationEngine);
  const configService = context.container.get<ConfigurationService>(TYPES.ConfigurationService);
  const authService = context.container.get<AuthService>(TYPES.AuthService);
  const observabilityService = context.container.isBound(TYPES.ObservabilityService)
    ? context.container.get<ObservabilityService>(TYPES.ObservabilityService)
    : undefined;
  const outboundGovernance = context.container.isBound(TYPES.OutboundGovernanceService)
    ? context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService)
    : undefined;
  const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
  const auditService = context.container.get<AuditService>(TYPES.AuditService);
  const approvalQueueService = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
  return new IntegrationService(logger, transformationEngine, configService, authService, observabilityService, outboundGovernance, ownershipResolver, auditService, approvalQueueService);
}).inSingletonScope();

// AI services (Week 1 Task 2)
container.bind<OpenAIProvider>(TYPES.OpenAIProvider).to(OpenAIProvider).inSingletonScope();
container.bind<ClaudeProvider>(TYPES.ClaudeProvider).to(ClaudeProvider).inSingletonScope();
container.bind<AIFieldMappingService>(TYPES.AIFieldMappingService).to(AIFieldMappingService).inSingletonScope();
container.bind<TrainingDataRepository>(TYPES.TrainingDataRepository).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  // Provide explicit options to avoid Inversify trying to resolve an Object parameter
  return new TrainingDataRepository(logger, {});
}).inSingletonScope();
container.bind<UnmappableFieldDetectionService>(TYPES.UnmappableFieldDetectionService).toDynamicValue(() => {
  // Constructor creates its own SemanticValidator, no parameters needed
  return new UnmappableFieldDetectionService();
}).inSingletonScope();
container.bind<AccuracyEnhancementService>(TYPES.AccuracyEnhancementService).toDynamicValue(() => {
  // Constructor has optional dependencies (schema discovery, schema validation, knowledge base)
  // Creates defaults when not provided
  return new AccuracyEnhancementService();
}).inSingletonScope();
container.bind<AuthService>(TYPES.AuthService).to(AuthService).inSingletonScope();
container.bind<TransformationEngine>(TYPES.TransformationEngine).to(TransformationEngine).inSingletonScope();

// Bind SecretManager using factory with proper DI
container.bind(TYPES.SecretManager).toDynamicValue(async (context) => {
  const SecretManagerClass = await ServiceFactory.createSecretManager();
  const logger = context.container.get(TYPES.Logger);
  return new SecretManagerClass(logger);
}).inSingletonScope();

container.bind<SecureCredentialManager>(TYPES.SecureCredentialManager).to(SecureCredentialManager).inSingletonScope();
container
  .bind<SecureConfigurationService>(TYPES.SecureConfigurationService)
  .to(SecureConfigurationService)
  .inSingletonScope();
container
  .bind<ICredentialMetadataStore>(TYPES.CredentialMetadataStore)
  .to(InMemoryCredentialMetadataStore)
  .inSingletonScope();

// Bind CacheService using factory
container.bind(TYPES.CacheService).toDynamicValue(async (context: interfaces.Context) => {
  const CacheServiceClass = await ServiceFactory.createCacheService();
  if (CacheServiceClass) {
    return context.container.resolve(CacheServiceClass);
  }

  return ServiceFactory.createNoOpCacheService();
}).inSingletonScope();
// Connector DI bindings (PR 6A-2): use the registry's per-entry `factory`
// closure to construct instances. Constructor knowledge for these connectors
// lives in `src/connectors/connectorRegistry.ts`; this file only owns the DI
// concerns (TYPES symbol, dependency resolution from the container, and
// `wrapWithDecorator` for demo-mode-aware behavior).
//
// Squire and SuiteCentralConnectorProd remain hand-rolled below — those two
// connectors have no factory closure (DI-only by design, not reachable through
// `ConnectorManager.createConnector()`). The wiring-drift audit gate exempts
// them from the "no `new` outside the registry" rule for that reason.

/**
 * Resolve the registry factory for a DI-bound connector. Throws if the entry
 * is missing or has no factory closure — both indicate a registry/DI drift
 * that should fail container construction loudly rather than silently bind a
 * `null` connector.
 */
function registryFactoryFor(key: string): NonNullable<ConnectorRegistration['factory']> {
  const entry = getConnectorRegistration(key);
  if (!entry?.factory) {
    throw new Error(
      `inversify.config.ts: connector registry has no factory closure for key '${key}' ` +
        `(every DI binding for a registry-factory-wired connector must call entry.factory(); ` +
        `see PR 6A-2 / ADR-015).`,
    );
  }
  return entry.factory;
}

function buildConnectorDeps(context: interfaces.Context): ConnectorDeps {
  return {
    logger: context.container.get<Logger>(TYPES.Logger),
    authService: context.container.get<AuthService>(TYPES.AuthService),
    outboundGovernance: context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService),
  };
}

container
  .bind<IConnector>(TYPES.SquireConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const auth = context.container.get<AuthService>(TYPES.AuthService);
    // Squire has no registry factory (DI-only). Hand-rolled here intentionally.
    return wrapWithDecorator(new SquireConnector('Squire', 'squire', logger, auth), logger);
  })
  .inSingletonScope();

container
  .bind<IConnector>(TYPES.SuiteCentralConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const deps = buildConnectorDeps(context);
    return wrapWithDecorator(registryFactoryFor('suitecentral')('suitecentral', deps), deps.logger);
  })
  .inSingletonScope();

container
  .bind<IConnector>(TYPES.NetSuiteConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const deps = buildConnectorDeps(context);
    return wrapWithDecorator(registryFactoryFor('netsuite')('netsuite', deps), deps.logger);
  })
  .inSingletonScope();

container
  .bind<IConnector>(TYPES.ShopifyConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const deps = buildConnectorDeps(context);
    return wrapWithDecorator(registryFactoryFor('shopify')('shopify', deps), deps.logger);
  })
  .inSingletonScope();

container
  .bind<IConnector>(TYPES.ShipStationConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const deps = buildConnectorDeps(context);
    // ShipStation factory ignores its first arg (auth resolved in initialize());
    // pass 'shipstation' for symmetry with the other DI bindings.
    return wrapWithDecorator(registryFactoryFor('shipstation')('shipstation', deps), deps.logger);
  })
  .inSingletonScope();

container
  .bind<IConnector>(TYPES.HubSpotConnector)
  .toDynamicValue((context: interfaces.Context) => {
    const deps = buildConnectorDeps(context);
    // HubSpot factory ignores its first arg (auth resolved in initialize());
    // pass 'hubspot' for symmetry with the other DI bindings.
    return wrapWithDecorator(registryFactoryFor('hubspot')('hubspot', deps), deps.logger);
  })
  .inSingletonScope();

// Payment processor connectors temporarily disabled for demo
// container
//   .bind<IConnector>(TYPES.StripeConnector)
//   .toDynamicValue((context: interfaces.Context) => {
//     const logger = context.container.get<Logger>(TYPES.Logger);
//     const auth = context.container.get<AuthService>(TYPES.AuthService);
//     return new StripeConnector('Stripe', 'stripe', logger, auth);
//   })
//   .inSingletonScope();

// container
//   .bind<IConnector>(TYPES.PayPalConnector)
//   .toDynamicValue((context: interfaces.Context) => {
//     const logger = context.container.get<Logger>(TYPES.Logger);
//     return new PayPalConnector('PayPal', 'paypal', logger);
//   })
//   .inSingletonScope();

// container
//   .bind<IConnector>(TYPES.AdyenConnector)
//   .toDynamicValue((context: interfaces.Context) => {
//     const logger = context.container.get<Logger>(TYPES.Logger);
//     return new AdyenConnector('Adyen', 'adyen', logger);
//   })
//   .inSingletonScope();

// Bind ObservabilityService with default settings
const observabilityConfig: ObservabilityConfig = {
  tracing: {
    enabled: true,
    serviceName: 'integration-hub',
    samplingRate: 1.0,
  },
  logging: {
    level: (env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
    format: 'text',
    transports: ['console'],
  },
  metrics: {
    enabled: false,
  },
};
container
  .bind<ObservabilityService>(TYPES.ObservabilityService)
  .toConstantValue(new ObservabilityService(observabilityConfig));

// Bind telemetry services
container.bind<TelemetryStore>(TYPES.TelemetryStore).to(TelemetryStore).inSingletonScope();
container.bind<TelemetryAggregator>(TYPES.TelemetryAggregator).to(TelemetryAggregator).inSingletonScope();
container.bind<TelemetryService>(TYPES.TelemetryService).to(TelemetryService).inSingletonScope();

// Bind unified telemetry service (Week 1 Task 3)
container.bind<UnifiedTelemetryService>(TYPES.UnifiedTelemetryService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new UnifiedTelemetryService(logger);
}).inSingletonScope();

container.bind<DLQService>(TYPES.DLQService).to(DLQService).inSingletonScope();
container.bind<DataMigrationAccelerator>(TYPES.DataMigrationAccelerator).to(DataMigrationAccelerator).inSingletonScope();

// Bind SuiteCentral production services
container.bind<SuiteCentralConfigService>(TYPES.SuiteCentralConfigService).to(SuiteCentralConfigService).inSingletonScope();
container.bind<SuiteCentralMonitoringService>(TYPES.SuiteCentralMonitoringService).to(SuiteCentralMonitoringService).inSingletonScope();

// Bind SuiteCentral feature services
container.bind<PaymentCentralService>(TYPES.PaymentCentralService).to(PaymentCentralService).inSingletonScope();
container.bind<SupplierCentralService>(TYPES.SupplierCentralService).to(SupplierCentralService).inSingletonScope();
container.bind<InstallerCentralService>(TYPES.InstallerCentralService).to(InstallerCentralService).inSingletonScope();
container.bind<PayoutCentralService>(TYPES.PayoutCentralService).to(PayoutCentralService).inSingletonScope();
container.bind<SyncCentralService>(TYPES.SyncCentralService).to(SyncCentralService).inSingletonScope();
container.bind<FinanceCentralService>(TYPES.FinanceCentralService).to(FinanceCentralService).inSingletonScope();
container.bind<InventoryCentralService>(TYPES.InventoryCentralService).to(InventoryCentralService).inSingletonScope();
container.bind<ServiceCentralService>(TYPES.ServiceCentralService).to(ServiceCentralService).inSingletonScope();
container.bind<CustomerCentralService>(TYPES.CustomerCentralService).to(CustomerCentralService).inSingletonScope();
container.bind<QualityCentralService>(TYPES.QualityCentralService).to(QualityCentralService).inSingletonScope();
container.bind<ContractCentralService>(TYPES.ContractCentralService).to(ContractCentralService).inSingletonScope();
container.bind<PortalCentralService>(TYPES.PortalCentralService).to(PortalCentralService).inSingletonScope();
// WorkflowCentralService binding moved to the T6 section below (requires
// WorkflowEngineService + WorkflowCentralRepository imports at line ~1258).
container.bind<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
  // SchemaRegistryService is optional — orchestrator works without it.
  // Use isBound() so real activation/configuration errors still surface.
  const schemaRegistry = context.container.isBound(TYPES.SchemaRegistryService)
    ? context.container.get<SchemaRegistryService>(TYPES.SchemaRegistryService)
    : undefined;
  const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
  const auditService = context.container.get<AuditService>(TYPES.AuditService);
  const approvalQueueService = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
  return new SyncCentralOrchestrator(logger, connectorManager, schemaRegistry, ownershipResolver, auditService, approvalQueueService);
}).inSingletonScope();
container.bind<AutomationLibrariesService>(TYPES.AutomationLibrariesService).to(AutomationLibrariesService).inSingletonScope();

// Bind AI services - Already bound above on line 74

// Bind new AI provider services (Week 1 Task 2)
container.bind<ProviderRegistry>(TYPES.ProviderRegistry).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const registry = new ProviderRegistry(logger);
  // Provider initialization deferred to onActivation hook (after all bindings complete)
  return registry;
}).inSingletonScope().onActivation((context: interfaces.Context, registry: ProviderRegistry) => {
  // Initialize providers AFTER all bindings are complete
  // This ensures Grok, Gemini, LMStudio bindings (defined below) are available
  // when initializeProvidersWeek2 checks container.isBound()
  const logger = context.container.get<Logger>(TYPES.Logger);
  initializeProvidersWeek2(registry, logger);
  return registry;
});

// OpenAI Provider - only bind if API key is available
if (process.env.OPENAI_API_KEY) {
  container.bind<OpenAIProvider>(TYPES.OpenAIProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    const rawModel = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    // Normalize the legacy 'gpt-4' alias to gpt-4o, matching the other init
    // paths (initializeProvidersWeek2, SecureAIService.setupProviders).
    const normalizedModel = rawModel === 'gpt-4' ? 'gpt-4o' : rawModel;
    return new OpenAIProvider(logger, {
      apiKey: process.env.OPENAI_API_KEY!,
      model: normalizedModel,
      baseURL: process.env.OPENAI_BASE_URL,
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.1')
    }, outboundGovernance);
  }).inSingletonScope();
}

// Claude Provider - only bind if API key is available
if (process.env.ANTHROPIC_API_KEY) {
  container.bind<ClaudeProvider>(TYPES.ClaudeProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new ClaudeProvider(logger, {
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      baseURL: process.env.ANTHROPIC_BASE_URL,
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '2000'),
      temperature: parseFloat(process.env.ANTHROPIC_TEMPERATURE || '0.1'),
      authMode: process.env.ANTHROPIC_AUTH_MODE as 'auto' | 'anthropic' | 'bearer' | undefined
    }, outboundGovernance);
  }).inSingletonScope();
}

// Model Catalog Service (dynamic model listing & runtime switching)
container.bind<ModelCatalogService>(TYPES.ModelCatalogService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  // Use try/catch because providers may not be bound if keys missing
  let openai: OpenAIProvider | undefined;
  let claude: ClaudeProvider | undefined;
  const registry = context.container.isBound(TYPES.ProviderRegistry) ? context.container.get<ProviderRegistry>(TYPES.ProviderRegistry) : undefined;
  try { openai = context.container.isBound(TYPES.OpenAIProvider) ? context.container.get<OpenAIProvider>(TYPES.OpenAIProvider) : undefined; } catch { /* provider optional */ }
  try { claude = context.container.isBound(TYPES.ClaudeProvider) ? context.container.get<ClaudeProvider>(TYPES.ClaudeProvider) : undefined; } catch { /* provider optional */ }
  return new ModelCatalogService(logger, openai, claude, registry);
}).inSingletonScope();

// Grok Provider - conditional binding (supports alternate env var XAI_GROK_API_KEY for flexibility)
const GROK_KEY = process.env.GROK_API_KEY || process.env.XAI_GROK_API_KEY;
if (GROK_KEY) {
  container.bind<GrokProvider>(TYPES.GrokProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new GrokProvider(logger, {
      apiKey: GROK_KEY!,
      model: process.env.GROK_MODEL || 'grok-beta',
      baseURL: process.env.GROK_BASE_URL,
      maxTokens: parseInt(process.env.GROK_MAX_TOKENS || '1500'),
      temperature: parseFloat(process.env.GROK_TEMPERATURE || '0.2')
    }, outboundGovernance);
  }).inSingletonScope();
}

// Gemini Provider - conditional binding
if (process.env.GEMINI_API_KEY) {
  container.bind<GeminiProvider>(TYPES.GeminiProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new GeminiProvider(logger, {
      apiKey: process.env.GEMINI_API_KEY!,
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      baseURL: process.env.GEMINI_BASE_URL,
      maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '2000'),
      temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.25')
    }, outboundGovernance);
  }).inSingletonScope();
}

// LMStudio Provider - bind if explicit base URL or any non-production NODE_ENV
if (process.env.LMSTUDIO_BASE_URL?.trim() || process.env.NODE_ENV !== 'production') {
  container.bind<LMStudioProvider>(TYPES.LMStudioProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new LMStudioProvider(logger, {
      baseURL: resolveLMStudioBaseUrl(process.env.LMSTUDIO_BASE_URL),
      model: process.env.LMSTUDIO_MODEL || 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
      apiKey: process.env.LMSTUDIO_API_KEY,
      maxTokens: parseInt(process.env.LMSTUDIO_MAX_TOKENS || '1000'),
      temperature: parseFloat(process.env.LMSTUDIO_TEMPERATURE || '0.3'),
      timeout: normalizePositiveInteger(process.env.LMSTUDIO_TIMEOUT, 120000) ?? 120000
    }, outboundGovernance);
  }).inSingletonScope();
}

// OpenRouter Provider - conditional binding
if (process.env.OPENROUTER_API_KEY) {
  container.bind<OpenRouterProvider>(TYPES.OpenRouterProvider).toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new OpenRouterProvider(logger, {
      apiKey: process.env.OPENROUTER_API_KEY!,
      model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
      baseURL: process.env.OPENROUTER_BASE_URL,
      maxTokens: normalizePositiveInteger(process.env.OPENROUTER_MAX_TOKENS, 2000) ?? 2000,
      temperature: parseFloat(process.env.OPENROUTER_TEMPERATURE || '0.1'),
      siteUrl: process.env.OPENROUTER_SITE_URL,
      siteName: process.env.OPENROUTER_SITE_NAME || 'SuiteCentral',
      timeout: normalizePositiveInteger(process.env.OPENROUTER_TIMEOUT, 30000) ?? 30000
    }, outboundGovernance);
  }).inSingletonScope();
}

// Bind production SuiteCentral connector
container
  .bind<IConnector>(TYPES.SuiteCentralConnectorProd)
  .toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new SuiteCentralConnectorProd('suitecentral-prod', logger);
  });

// Bind new integration services using factory functions
container.bind<ConnectorManager>(TYPES.ConnectorManager).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const authService = context.container.get<AuthService>(TYPES.AuthService);
  const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
  return new ConnectorManager(logger, authService, outboundGovernance);
}).inSingletonScope();

container.bind<IntegrationStatusManager>(TYPES.IntegrationStatusManager).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new IntegrationStatusManager(logger);
}).inSingletonScope();

container.bind<IntegrationExecutor>(TYPES.IntegrationExecutor).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const transformationEngine = context.container.get<TransformationEngine>(TYPES.TransformationEngine);
  const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
  const statusManager = context.container.get<IntegrationStatusManager>(TYPES.IntegrationStatusManager);
  const observabilityService = context.container.get<ObservabilityService>(TYPES.ObservabilityService);
  const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
  const auditService = context.container.get<AuditService>(TYPES.AuditService);
  const approvalQueueService = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
  return new IntegrationExecutor(logger, transformationEngine, connectorManager, statusManager, observabilityService, ownershipResolver, auditService, approvalQueueService);
}).inSingletonScope();

container.bind<IntegrationOrchestrator>(TYPES.IntegrationOrchestrator).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const configService = context.container.get<ConfigurationService>(TYPES.ConfigurationService);
  const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
  const statusManager = context.container.get<IntegrationStatusManager>(TYPES.IntegrationStatusManager);
  // IntegrationExecutor is async-bound (transitively depends on OwnershipResolver → DatabaseService)
  const executor = await context.container.getAsync<IntegrationExecutor>(TYPES.IntegrationExecutor);
  const observabilityService = context.container.get<ObservabilityService>(TYPES.ObservabilityService);
  return new IntegrationOrchestrator(logger, configService, connectorManager, statusManager, executor, observabilityService);
}).inSingletonScope();

// Saga Orchestrator for distributed transactions
container.bind<SagaOrchestrator>(TYPES.SagaOrchestrator).toDynamicValue(async (context: interfaces.Context) => {
  const database = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new SagaOrchestrator(database, logger);
}).inSingletonScope();

// Week 2 AI Services Bindings

// Cost Tracking Service
container.bind<CostTrackingService>(TYPES.CostTrackingService).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const telemetry = context.container.get<UnifiedTelemetryService>(TYPES.UnifiedTelemetryService);
  const database = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
  return new CostTrackingService(logger, telemetry, database);
}).inSingletonScope();

// A/B Testing Service
container.bind<ABTestingService>(TYPES.ABTestingService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const telemetry = context.container.get<UnifiedTelemetryService>(TYPES.UnifiedTelemetryService);
  return new ABTestingService(logger, telemetry);
}).inSingletonScope();

// Mock LLM Provider Factory - Creates different mock providers as needed
container.bind<MockLLMProvider>(TYPES.MockLLMProvider).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new MockLLMProvider(logger, {
    providerId: 'mock-openai',
    name: 'Mock OpenAI Provider',
    version: '1.0.0',
    simulatedLatency: 800,
    simulatedCostPerToken: 0.00002,
    simulatedAccuracy: 0.87,
    failureRate: 0.02 // 2% failure rate for resilience testing
  });
}).inSingletonScope();

// AI Configuration Service
container.bind<AIConfigurationService>(TYPES.AIConfigurationService).to(AIConfigurationService).inSingletonScope();
container.bind<AIConfigurationBridge>(TYPES.AIConfigurationBridge).to(AIConfigurationBridge).inSingletonScope();

// Secure AI Service (handles provider keys and registration)
container.bind<SecureAIService>(TYPES.SecureAIService).to(SecureAIService).inSingletonScope();

// Universal Translator - Week 1-2: Semantic Analysis Engine
container.bind<SemanticAnalysisEngine>(TYPES.SemanticAnalysisEngine).to(SemanticAnalysisEngine).inSingletonScope();

// SuiteCentralConnectorFactory removed; use class binding above

// Week 5: Multi-Agent Orchestrator DI bindings
// Alias for string-based injections used in some orchestrator classes
container.bind<ProviderRegistry>('ProviderRegistry').toService(TYPES.ProviderRegistry);
container.bind<CostTrackingService>('CostTrackingService').toService(TYPES.CostTrackingService);

// Core orchestrator services
container
  .bind<ReasoningTraceEngine>(TYPES.ReasoningTraceEngine)
  .toDynamicValue(async (context: interfaces.Context) => {
    // Async factory — ReasoningTraceRepository now async-bound (its factory
    // awaits DatabaseService). A sync .get() here would return Promise<RTR>
    // and the engine would be constructed with a Promise instead of a repo.
    // PR 17b's SyncErrorAssistService injects this engine, and the
    // SyncErrorAssistDailyJob → Service → Engine chain is resolved via
    // getAsync from src/index.ts:256, which surfaces this cold-resolution path.
    const logger = context.container.get<Logger>(TYPES.Logger);
    const repo = context.container.isBound(TYPES.ReasoningTraceRepository)
      ? await context.container.getAsync<ReasoningTraceRepository>(TYPES.ReasoningTraceRepository)
      : undefined;
    return new ReasoningTraceEngine(logger, repo);
  })
  .inSingletonScope();
container.bind<ReasoningTraceEngine>('ReasoningTraceEngine').toService(TYPES.ReasoningTraceEngine);

// Commit 2: switched from manual toDynamicValue factory to decorator-based
// resolution so Inversify auto-wires both Logger and DLPService via the
// GovernanceService constructor's @inject() decorators. The old factory
// form would need to be updated by hand every time the constructor
// gains a new dependency.
container.bind<GovernanceService>(TYPES.GovernanceService).to(GovernanceService).inSingletonScope();
container.bind<GovernanceService>('GovernanceService').toService(TYPES.GovernanceService);

// PR 2A: Outbound DLP guard — scans payloads before they reach AI providers,
// connector writes, or audit-log persistence. Uses decorator-based resolution
// so Inversify auto-wires DLPService + Logger via @inject() decorators.
// The optional config parameter (approvalMode, maxPayloadBytes, strictMode)
// is NOT injected — callers pass it at construction time or accept defaults.
import { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';
container.bind<OutboundGovernanceService>(TYPES.OutboundGovernanceService).to(OutboundGovernanceService).inSingletonScope();

// PR 3A: HITL approval queue — schema + repository + service. PR 3B wires the
// mode flip, route catches, and resume worker; PR 3C adds the operator UI.
//
// Bindings use `toDynamicValue(async)` so the resolution chain is async
// end-to-end — `DatabaseService` is async-bound above (`toDynamicValue(async ...)`
// at L189), and the prior `.to()` form here only worked because by the time
// consumers resolved it, the async-bound transitive `DatabaseService` was
// already cached as a singleton. That was a fragile cold-start race; the
// async-end-to-end pattern removes it (matches FinanceCentralRepository at
// L1251 and SyncErrorAssistRepository at L1211 — Copilot R6 on PR #819).
// Consumers must resolve via `getAsync`.
import { ApprovalQueueRepository } from '../services/governance/ApprovalQueueRepository';
import { ApprovalQueueService } from '../services/governance/ApprovalQueueService';
import {
  ApprovalResumeRegistry,
  ApprovalResumeWorker,
} from '../services/governance/ApprovalResumeWorker';
container
  .bind<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new ApprovalQueueRepository(dbService);
  })
  .inSingletonScope();

// PR 3B: resume-worker registry is a plain singleton — no DB or async deps.
// The registry ships EMPTY in this PR; a follow-up PR will resolve the
// registry from the composition root and call `register()` for each
// concrete handler (NetSuite-resume, OpenAI-resume, etc.). The
// integration / unit tests prove the wiring contract works (handlers
// registered post-construction dispatch correctly). Spec §4 Q1 scope cut.
// Copilot R9 corrected an earlier comment that referenced a not-yet-shipped
// `registerApprovalResumeHandlers` hook.
// Copilot R1 (PR 13b) cluster-A4: the default 'ownership_write' handler must
// be registered when the registry is constructed, NOT as a side effect of
// resolving the OwnershipResumeHandler binding. The resume worker only
// resolves the registry — if the handler binding is never separately
// resolved, the fallback was missing in production, so any approved
// ownership row would dispatch to the no-handler "unhandled" path.
//
// Resolving the registry now eagerly resolves the handler (`getAsync` because
// the handler binding is async-bound) and calls `setDefault`. Both bindings
// are singletons, so subsequent resolutions of either return the cached
// instance with the default already in place.
container
  .bind<ApprovalResumeRegistry>(TYPES.ApprovalResumeRegistry)
  .toDynamicValue(async (context: interfaces.Context) => {
    const registry = new ApprovalResumeRegistry();
    const handler = await context.container.getAsync<OwnershipResumeHandler>(TYPES.OwnershipResumeHandler);
    registry.setDefault('ownership_write', handler);
    return registry;
  })
  .inSingletonScope();

// PR 3B: resume worker — depends on repo (async-bound) and the registry.
container
  .bind<ApprovalResumeWorker>(TYPES.ApprovalResumeWorker)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const repo = await context.container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);
    // Registry is now async-bound (PR 13b R1 cluster-A4) — its factory
    // eagerly resolves OwnershipResumeHandler and registers it as the
    // default 'ownership_write' fallback, so the resume worker MUST
    // resolve via getAsync. Previously this used sync `.get()` because
    // Registry was bound `.to(...)`.
    const registry = await context.container.getAsync<ApprovalResumeRegistry>(TYPES.ApprovalResumeRegistry);
    return new ApprovalResumeWorker(repo, registry, logger);
  })
  .inSingletonScope();

// PR 13c-2 Task 3: EncryptionService binding. Reuse the existing module-level
// singleton so the same key + AAD as AI-provider API-key encryption applies
// to queued WriteDescriptor args. `toConstantValue` instead of `to(...)` to
// avoid Inversify constructing a second instance with a fresh transient key
// when AI_CONFIG_ENCRYPTION_KEY is unset (development warning path).
import { encryptionService } from '../services/security/EncryptionService';
import type { EncryptionService } from '../services/security/EncryptionService';
container.bind<EncryptionService>(TYPES.EncryptionService).toConstantValue(encryptionService);

container
  .bind<ApprovalQueueService>(TYPES.ApprovalQueueService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const repo = await context.container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);
    const encryption = context.container.get<EncryptionService>(TYPES.EncryptionService);
    const service = new ApprovalQueueService(repo, logger, encryption);
    // PR 3B: wire the resume worker AFTER constructing the service to break
    // the potential circular dep. The worker depends on the repo (NOT the
    // service), so this is a clean acyclic resolution order.
    const worker = await context.container.getAsync<ApprovalResumeWorker>(TYPES.ApprovalResumeWorker);
    service.setResumeWorker(worker);
    return service;
  })
  .inSingletonScope();

import { AuditLogRepository } from '../database/repositories/AuditLogRepository';

container
  .bind<AuditService>(TYPES.AuditService)
  .toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const auditLogRepository = context.container.get<AuditLogRepository>(TYPES.AuditLogRepository);
    const outboundGovernance = context.container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    return new AuditService(logger, auditLogRepository, outboundGovernance);
  })
  .inSingletonScope();
container.bind<AuditService>('AuditService').toService(TYPES.AuditService);

// Business Intelligence Agent Services (Phase 2)
container.bind<MetricsCalculationService>(TYPES.MetricsCalculationService).to(MetricsCalculationService).inSingletonScope();
container.bind<ROIAnalysisService>(TYPES.ROIAnalysisService).to(ROIAnalysisService).inSingletonScope();
container.bind<ForecastingService>(TYPES.ForecastingService).to(ForecastingService).inSingletonScope();
container.bind<InsightsGeneratorService>(TYPES.InsightsGeneratorService).to(InsightsGeneratorService).inSingletonScope();

// Process Optimization Agent Services
container.bind<BottleneckAnalysisService>(TYPES.BottleneckAnalysisService).to(BottleneckAnalysisService).inSingletonScope();
container.bind<PerformanceMetricsService>(TYPES.PerformanceMetricsService).to(PerformanceMetricsService).inSingletonScope();
container.bind<CostBenefitAnalyzer>(TYPES.CostBenefitAnalyzer).to(CostBenefitAnalyzer).inSingletonScope();
container.bind<RiskAssessmentService>(TYPES.RiskAssessmentService).to(RiskAssessmentService).inSingletonScope();
container.bind<OptimizationRecommender>(TYPES.OptimizationRecommender).to(OptimizationRecommender).inSingletonScope();

// Data Quality Agent Services
container.bind<DataProfilingService>(TYPES.DataProfilingService).to(DataProfilingService).inSingletonScope();
container.bind<AnomalyDetectionService>(TYPES.AnomalyDetectionService).to(AnomalyDetectionService).inSingletonScope();
container.bind<QualityScoringService>(TYPES.QualityScoringService).to(QualityScoringService).inSingletonScope();
container.bind<CleansingRecommender>(TYPES.CleansingRecommender).to(CleansingRecommender).inSingletonScope();

// Phase 3: AI Workflow & Predictive Connector Dependencies
container.bind<LoggingService>(TYPES.LoggingService).to(LoggingService).inSingletonScope();

container.bind<PredictiveAnalyticsService>(TYPES.PredictiveAnalyticsService).to(PredictiveAnalyticsService).inSingletonScope();
container.bind<ProactiveIssueDetectionService>(TYPES.ProactiveIssueDetectionService).to(ProactiveIssueDetectionService).inSingletonScope();
container.bind<PerformanceOptimizationService>(TYPES.PerformanceOptimizationService).to(PerformanceOptimizationService).inSingletonScope();
container.bind<MappingPatternCacheService>(TYPES.MappingPatternCacheService).to(MappingPatternCacheService).inSingletonScope()
  .onActivation((_context, service) => { service.start(); return service; });
container.onDeactivation<MappingPatternCacheService>(TYPES.MappingPatternCacheService, service => { service.stop(); });

// Phase 3: Main AI Services (with DI dependencies)
container.bind<AIWorkflowIntelligenceService>(TYPES.AIWorkflowIntelligenceService).to(AIWorkflowIntelligenceService).inSingletonScope();
container.bind<AIPredictiveConnectorService>(TYPES.AIPredictiveConnectorService).to(AIPredictiveConnectorService).inSingletonScope();

// Autonomous Decision Engine
import { AutonomousDecisionEngine } from '../services/AutonomousDecisionEngine';
container.bind<AutonomousDecisionEngine>(TYPES.AutonomousDecisionEngine).to(AutonomousDecisionEngine).inSingletonScope();

// Active Learning
import { GoldenDatasetService } from '../services/ai/learning/GoldenDatasetService';
import { ActiveLearningService, ActiveLearningConfig } from '../services/ai/learning/ActiveLearningService';

container.bind<GoldenDatasetService>(TYPES.GoldenDatasetService).toDynamicValue(() => {
  return new GoldenDatasetService();
}).inSingletonScope();

const activeLearningConfig: ActiveLearningConfig = {
  minFeedbackForGoldenSet: 3,
  minApprovalRateForGoldenSet: 90,
  feedbackRetentionDays: 365,
  enableAutoGoldenSetPromotion: true
};
container.bind<ActiveLearningConfig>('ActiveLearningConfig').toConstantValue(activeLearningConfig);

container.bind<ActiveLearningService>(TYPES.ActiveLearningService).to(ActiveLearningService).inSingletonScope();

// NetSuite MCP Integration (Phase 2-3) - Conditional bindings based on feature flags
// Phase 2: Schema Discovery via MCP
if (isNetSuiteMCPSchemaEnabled()) {
  // NetSuiteMCPSchemaAdapter - High-level schema adapter with caching and fallback
  container
    .bind<NetSuiteMCPSchemaAdapter>(TYPES.NetSuiteMCPSchemaAdapter)
    .toDynamicValue((context: interfaces.Context) => {
      const logger = context.container.get<Logger>(TYPES.Logger);

      // NetSuite OAuth 1.0a credentials (shared with REST connector)
      const credentials = {
        accountId: process.env.NETSUITE_ACCOUNT_ID || '',
        consumerKey: process.env.NETSUITE_CONSUMER_KEY || '',
        consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || '',
        tokenId: process.env.NETSUITE_TOKEN_ID || '',
        tokenSecret: process.env.NETSUITE_TOKEN_SECRET || ''
      };

      // Create adapter (which creates MCP client internally)
      return new NetSuiteMCPSchemaAdapter(credentials, logger, {
        cacheEnabled: true,
        cacheTTL: 86400000, // 24 hours
        enableFallback: true
      });
    })
    .inSingletonScope();

  const logger = container.get<Logger>(TYPES.Logger);
  logger.info('NetSuite MCP schema discovery enabled', {
    featureFlag: 'ENABLE_NETSUITE_MCP_SCHEMA'
  });
}

// Phase 3: AI Context Enhancement via MCP
if (isNetSuiteMCPAIContextEnabled()) {
  // MCPKnowledgeProvider - Rich field context for AI enhancement
  container
    .bind<MCPKnowledgeProvider>(TYPES.MCPKnowledgeProvider)
    .toDynamicValue((context: interfaces.Context) => {
      const logger = context.container.get<Logger>(TYPES.Logger);
      const mcpAdapter = context.container.get<NetSuiteMCPSchemaAdapter>(TYPES.NetSuiteMCPSchemaAdapter);

      return new MCPKnowledgeProvider(mcpAdapter, logger);
    })
    .inSingletonScope();

  // MCPFieldMappingEnhancer - AI enhancement wrapper
  container
    .bind<MCPFieldMappingEnhancer>(TYPES.MCPFieldMappingEnhancer)
    .toDynamicValue((context: interfaces.Context) => {
      const logger = context.container.get<Logger>(TYPES.Logger);
      const mcpKnowledge = context.container.get<MCPKnowledgeProvider>(TYPES.MCPKnowledgeProvider);

      return new MCPFieldMappingEnhancer(mcpKnowledge, logger);
    })
    .inSingletonScope();

  const logger = container.get<Logger>(TYPES.Logger);
  logger.info('NetSuite MCP AI context enhancement enabled', {
    featureFlag: 'ENABLE_NETSUITE_MCP_AI_CONTEXT',
    expectedImprovement: '+3-4% accuracy'
  });
}

// Phase 3 Week 2: A/B Testing Service (always available for testing)
container
  .bind<MCPABTestService>(TYPES.MCPABTestService)
  .toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const userSettingsService = context.container.get<MCPUserSettingsService>(TYPES.MCPUserSettingsService);
    return new MCPABTestService(logger, userSettingsService);
  })
  .inSingletonScope();

// MCP User Settings Service (Phase 3 Week 3: User-scoped MCP preferences)
container
  .bind<MCPUserSettingsService>(TYPES.MCPUserSettingsService)
  .toDynamicValue((context: interfaces.Context) => {
    const dbService = context.container.get<DatabaseService>(TYPES.DatabaseService);
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new MCPUserSettingsService(dbService, logger);
  })
  .inSingletonScope();

// MCP Policy Service (env defaults + optional DB-backed tenant overrides)
container
  .bind<MCPPolicyService>(TYPES.MCPPolicyService)
  .toDynamicValue((context: interfaces.Context) => {
    const policyLogger = context.container.get<Logger>(TYPES.Logger);
    const dbService = context.container.get<DatabaseService>(TYPES.DatabaseService);
    return new MCPPolicyService(policyLogger, dbService, {
      allowlist: mcpGatewayConfig.policy.allowlist,
      denylist: mcpGatewayConfig.policy.denylist,
      disabledTenants: mcpGatewayConfig.policy.disabledTenants,
    });
  })
  .inSingletonScope();

// MCP Gateway (cross-ERP adapters + policy + aggregator)
if (isMCPGatewayEnabled()) {
  const logger = container.get<Logger>(TYPES.Logger);
  let hasNetSuiteAdapter = false;
  let hasBusinessCentralAdapter = false;

  if (mcpGatewayConfig.netsuite.endpoint) {
    if (!mcpGatewayConfig.netsuite.accessToken) {
      logger.warn('Skipping NetSuite MCP adapter binding: NETSUITE_MCP_ACCESS_TOKEN is not configured');
    } else {
      container
        .bind<NetSuiteOfficialMcpClient>(TYPES.NetSuiteOfficialMcpClient)
        .toDynamicValue((context: interfaces.Context) => {
          const adapterLogger = context.container.get<Logger>(TYPES.Logger);
          const tokenProvider: IMCPTokenProvider = new StaticMCPTokenProvider(
            'oauth2_pkce',
            mcpGatewayConfig.netsuite.accessToken || ''
          );

          return new NetSuiteOfficialMcpClient({
            endpoint: mcpGatewayConfig.netsuite.endpoint as string,
            tokenProvider,
            logger: adapterLogger,
            protocolVersion: '2025-06-18',
          });
        })
        .inSingletonScope();
      hasNetSuiteAdapter = true;
    }
  }

  if (isBusinessCentralMCPEnabled() && mcpGatewayConfig.businessCentral.endpoint) {
    const hasStaticToken = Boolean(mcpGatewayConfig.businessCentral.accessToken);
    const hasClientCredentials = Boolean(
      mcpGatewayConfig.businessCentral.tenantId &&
      mcpGatewayConfig.businessCentral.clientId &&
      mcpGatewayConfig.businessCentral.clientSecret
    );

    if (!hasStaticToken && !hasClientCredentials) {
      logger.warn(
        'Skipping Business Central MCP adapter binding: configure BC_MCP_ACCESS_TOKEN or BC_MCP_TENANT_ID + BC_MCP_CLIENT_ID + BC_MCP_CLIENT_SECRET'
      );
    } else {
      container
        .bind<BusinessCentralMcpClient>(TYPES.BusinessCentralMcpClient)
        .toDynamicValue((context: interfaces.Context) => {
          const adapterLogger = context.container.get<Logger>(TYPES.Logger);
          let tokenProvider: IMCPTokenProvider;

          if (mcpGatewayConfig.businessCentral.accessToken) {
            tokenProvider = new StaticMCPTokenProvider(
              'oauth2_client_credentials',
              mcpGatewayConfig.businessCentral.accessToken
            );
          } else {
            tokenProvider = new OAuth2ClientCredentialsMCPTokenProvider({
              tokenEndpoint: `https://login.microsoftonline.com/${mcpGatewayConfig.businessCentral.tenantId}/oauth2/v2.0/token`,
              clientId: mcpGatewayConfig.businessCentral.clientId || '',
              clientSecret: mcpGatewayConfig.businessCentral.clientSecret || '',
              scope: 'https://api.businesscentral.dynamics.com/.default',
            });
          }

          return new BusinessCentralMcpClient({
            endpoint: mcpGatewayConfig.businessCentral.endpoint as string,
            tokenProvider,
            logger: adapterLogger,
            mode: 'dynamic',
            enabled: true,
            protocolVersion: '2025-11-25',
          });
        })
        .inSingletonScope();
      hasBusinessCentralAdapter = true;
    }
  }

  container
    .bind<MCPAggregatorService>(TYPES.MCPAggregatorService)
    .toDynamicValue((context: interfaces.Context) => {
      const aggregatorLogger = context.container.get<Logger>(TYPES.Logger);
      const governanceService = context.container.get<GovernanceService>(TYPES.GovernanceService);
      const dlpService = context.container.get<DLPService>(TYPES.DLPService);
      const policyService = context.container.get<MCPPolicyService>(TYPES.MCPPolicyService);
      const auditService = context.container.get<AuditService>(TYPES.AuditService);

      const adapters: IMCPAdapter[] = [];
      if (context.container.isBound(TYPES.NetSuiteOfficialMcpClient)) {
        adapters.push(context.container.get<NetSuiteOfficialMcpClient>(TYPES.NetSuiteOfficialMcpClient));
      }
      if (context.container.isBound(TYPES.BusinessCentralMcpClient)) {
        adapters.push(context.container.get<BusinessCentralMcpClient>(TYPES.BusinessCentralMcpClient));
      }

      return new MCPAggregatorService(
        aggregatorLogger,
        governanceService,
        dlpService,
        policyService,
        auditService,
        adapters
      );
    })
    .inSingletonScope();

  logger.info('MCP gateway bindings initialized', {
    gatewayEnabled: true,
    netsuiteAdapter: hasNetSuiteAdapter,
    businessCentralAdapter: hasBusinessCentralAdapter,
  });
}

// Agent classes
container.bind(FieldMappingAgent).to(FieldMappingAgent).inSingletonScope();
container.bind(DataQualityAgent).to(DataQualityAgent).inSingletonScope();
container.bind(ProcessOptimizationAgent).to(ProcessOptimizationAgent).inSingletonScope();
container.bind(IntegrationStrategyAgent).to(IntegrationStrategyAgent).inSingletonScope();
container.bind(BusinessIntelligenceAgent).to(BusinessIntelligenceAgent).inSingletonScope();
container.bind(DunningAgent).toDynamicValue(() => new DunningAgent()).inSingletonScope();
container.bind(DocumentParsingAgent).toDynamicValue(() => new DocumentParsingAgent()).inSingletonScope();
container.bind(VendorOnboardingAgent).toDynamicValue(() => new VendorOnboardingAgent()).inSingletonScope();

// Agent registry pre-populated with agents
container
  .bind<AgentRegistry>(TYPES.AgentRegistry)
  .toDynamicValue((context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const registry = new AgentRegistry(logger);

    const fieldMapping = context.container.get(FieldMappingAgent);
    const dataQuality = context.container.get(DataQualityAgent);
    const processOptimization = context.container.get(ProcessOptimizationAgent);
    const integrationStrategy = context.container.get(IntegrationStrategyAgent);
    const businessIntelligence = context.container.get(BusinessIntelligenceAgent);
    const dunning = context.container.get(DunningAgent);
    const documentParsing = context.container.get(DocumentParsingAgent);
    const vendorOnboarding = context.container.get(VendorOnboardingAgent);

    registry.registerAgent('field-mapping', fieldMapping);
    registry.registerAgent('data-quality', dataQuality);
    registry.registerAgent('process-optimization', processOptimization);
    registry.registerAgent('integration-strategy', integrationStrategy);
    registry.registerAgent('business-intelligence', businessIntelligence);
    registry.registerAgent('dunning', dunning);
    registry.registerAgent('document-parsing', documentParsing);
    registry.registerAgent('vendor-onboarding', vendorOnboarding);

    return registry;
  })
  .inSingletonScope();
container.bind<AgentRegistry>('AgentRegistry').toService(TYPES.AgentRegistry);

// Orchestrator binding
container
  .bind<MultiAgentOrchestrator>(TYPES.MultiAgentOrchestrator)
  .to(MultiAgentOrchestrator)
  .inSingletonScope();
container.bind<MultiAgentOrchestrator>('MultiAgentOrchestrator').toService(TYPES.MultiAgentOrchestrator);

// Configure authentication bindings (OAuth2, API Keys, AuthenticationMiddleware)
configureAuthBindings(container);

// Module Metrics Aggregator - Cross-module KPI collection and anomaly detection
container.bind<ModuleMetricsAggregator>(TYPES.ModuleMetricsAggregator).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new ModuleMetricsAggregator(logger);
}).inSingletonScope();

// NLQ Capability Registry - Query pattern matching and permission gating
container.bind<NLQCapabilityRegistry>(TYPES.NLQCapabilityRegistry).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new NLQCapabilityRegistry(logger);
}).inSingletonScope();

// NL Query Orchestrator - Natural language query processing
// PR 6 R2 (Codex BM-2): factory is async because NLActionGateService is now
// async-bound. Consumers (MetricsNLQRouter) must resolve via getAsync.
container.bind<NLQueryOrchestrator>(TYPES.NLQueryOrchestrator).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const capabilityRegistry = context.container.get<NLQCapabilityRegistry>(TYPES.NLQCapabilityRegistry);
  const actionGate = context.container.isBound(TYPES.NLActionGateService)
    ? await context.container.getAsync<NLActionGateService>(TYPES.NLActionGateService)
    : undefined;
  return new NLQueryOrchestrator(logger, capabilityRegistry, actionGate);
}).inSingletonScope();


// SyncCentral Health Predictor - ML-based integration failure prediction
container.bind<SyncCentralHealthPredictor>(TYPES.SyncCentralHealthPredictor).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new SyncCentralHealthPredictor(logger);
}).inSingletonScope();

// Supplier Risk Scoring Service - Dynamic supplier risk assessment
container.bind<SupplierRiskScoringService>(TYPES.SupplierRiskScoringService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new SupplierRiskScoringService(logger);
}).inSingletonScope();

// Schema Registry Service - Enterprise reliability (Grand Unified Strategy 2026)
container.bind<SchemaRegistryService>(TYPES.SchemaRegistryService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new SchemaRegistryService(logger);
}).inSingletonScope();

// NL Action Gate Service - Human-in-the-Loop AI actions (Grand Unified Strategy 2026)
// PR 6 R2 (Codex BM-2): factory is async because FinanceCentralOperatorService
// is now async-bound. Consumers (NLActionGateRouter, NLQueryOrchestrator) must
// resolve via getAsync.
import { NLActionGateService } from '../services/ai/NLActionGateService';
container.bind<NLActionGateService>(TYPES.NLActionGateService).toDynamicValue(async (context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const paymentService = context.container.isBound(TYPES.PaymentCentralService)
    ? context.container.get<PaymentCentralService>(TYPES.PaymentCentralService)
    : undefined;
  const financeService = context.container.isBound(TYPES.FinanceCentralService)
    // PR 6 R4 (Copilot): FinanceCentralService now transitively depends on
    // the async-bound FinanceCentralOperatorService, so sync `.get` would
    // yield an unresolved Promise on cold start. Await via getAsync to keep
    // the DI chain consistently async, even though `financeService` is
    // currently unused in the NLActionGateService constructor.
    ? await context.container.getAsync<FinanceCentralService>(TYPES.FinanceCentralService)
    : undefined;
  const inventoryService = context.container.isBound(TYPES.InventoryCentralService)
    ? context.container.get<InventoryCentralService>(TYPES.InventoryCentralService)
    : undefined;
  const portalService = context.container.isBound(TYPES.PortalCentralService)
    ? context.container.get<PortalCentralService>(TYPES.PortalCentralService)
    : undefined;
  const supplierService = context.container.isBound(TYPES.SupplierCentralService)
    ? context.container.get<SupplierCentralService>(TYPES.SupplierCentralService)
    : undefined;
  const syncService = context.container.isBound(TYPES.SyncCentralService)
    ? context.container.get<SyncCentralService>(TYPES.SyncCentralService)
    : undefined;
  const secureAIService = context.container.isBound(TYPES.SecureAIService)
    ? context.container.get<SecureAIService>(TYPES.SecureAIService)
    : undefined;
  const financeOperatorService = context.container.isBound(TYPES.FinanceCentralOperatorService)
    ? await context.container.getAsync<FinanceCentralOperatorService>(TYPES.FinanceCentralOperatorService)
    : undefined;
  return new NLActionGateService(
    logger,
    paymentService,
    financeService,
    inventoryService,
    portalService,
    supplierService,
    syncService,
    secureAIService,
    financeOperatorService
  );
}).inSingletonScope();

// Predictive Operations Service - AI-powered forecasting (Grand Unified Strategy 2026)
import { PredictiveOperationsService } from '../services/ai/PredictiveOperationsService';
container.bind<PredictiveOperationsService>(TYPES.PredictiveOperationsService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  return new PredictiveOperationsService(logger);
}).inSingletonScope();

// MDM Repository (must bind before GoldenRecordService)
import { MDMRepository } from '../database/repositories/MDMRepository';
container.bind<MDMRepository>(TYPES.MDMRepository).toDynamicValue((context: interfaces.Context) => {
  const dbService = context.container.get<DatabaseService>(TYPES.DatabaseService);
  return new MDMRepository(dbService);
}).inSingletonScope();

// Reasoning Trace Repository (must bind before ReasoningTraceEngine)
import { ReasoningTraceRepository } from '../database/repositories/ReasoningTraceRepository';
container.bind<ReasoningTraceRepository>(TYPES.ReasoningTraceRepository).toDynamicValue(async (context: interfaces.Context) => {
  // Async factory — DatabaseService is async-bound (line 184). PR 17b's
  // SyncErrorAssistDailyJob resolves SyncErrorAssistService via getAsync,
  // which transitively resolves ReasoningTraceEngine, which now uses
  // getAsync to resolve THIS repo. Async chain must be consistent end-to-end.
  const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
  return new ReasoningTraceRepository(dbService);
}).inSingletonScope();

// Phase 6: Golden Record MDM Services
import { EntityMatchingService } from '../services/mdm/EntityMatchingService';
// Note: AIFieldMappingService already imported at top of file
container.bind<EntityMatchingService>(TYPES.EntityMatchingService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  // Optional AI services for enhanced matching
  const semanticEngine = context.container.isBound(TYPES.SemanticAnalysisEngine)
    ? context.container.get(TYPES.SemanticAnalysisEngine) : undefined;
  const fieldMappingService: AIFieldMappingService | undefined = context.container.isBound(TYPES.AIFieldMappingService)
    ? context.container.get<AIFieldMappingService>(TYPES.AIFieldMappingService) : undefined;
  return new EntityMatchingService(logger, semanticEngine, fieldMappingService);
}).inSingletonScope();

import { SurvivorshipRuleEngine } from '../services/mdm/SurvivorshipRuleEngine';
container.bind<SurvivorshipRuleEngine>(TYPES.SurvivorshipRuleEngine).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const mdmRepository = context.container.get<MDMRepository>(TYPES.MDMRepository);
  return new SurvivorshipRuleEngine(logger, mdmRepository);
}).inSingletonScope();

import { MDMFeedbackService } from '../services/mdm/MDMFeedbackService';
container.bind<MDMFeedbackService>(TYPES.MDMFeedbackService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const mdmRepository = context.container.get<MDMRepository>(TYPES.MDMRepository);
  return new MDMFeedbackService(logger, mdmRepository);
}).inSingletonScope();

import { GoldenRecordService } from '../services/mdm/GoldenRecordService';
container.bind<GoldenRecordService>(TYPES.GoldenRecordService).toDynamicValue((context: interfaces.Context) => {
  const logger = context.container.get<Logger>(TYPES.Logger);
  const entityMatcher = context.container.get<EntityMatchingService>(TYPES.EntityMatchingService);
  const survivorshipEngine = context.container.get<SurvivorshipRuleEngine>(TYPES.SurvivorshipRuleEngine);
  const feedbackService = context.container.get<MDMFeedbackService>(TYPES.MDMFeedbackService);
  const mdmRepository = context.container.get<MDMRepository>(TYPES.MDMRepository);
  return new GoldenRecordService(logger, entityMatcher, survivorshipEngine, feedbackService, mdmRepository);
}).inSingletonScope();


// PR 10a: Embedded ERP Surface Contract
import { EmbeddedSessionRepository } from '../services/embedded/EmbeddedSessionRepository';
import { EmbeddedServiceTokenRepository } from '../services/embedded/EmbeddedServiceTokenRepository';
import { EmbeddedRetentionJob } from '../services/embedded/EmbeddedRetentionJob';
container.bind<EmbeddedSessionRepository>(TYPES.EmbeddedSessionRepository).to(EmbeddedSessionRepository).inSingletonScope();
container.bind<EmbeddedServiceTokenRepository>(TYPES.EmbeddedServiceTokenRepository).to(EmbeddedServiceTokenRepository).inSingletonScope();
container.bind<EmbeddedRetentionJob>(TYPES.EmbeddedRetentionJob).to(EmbeddedRetentionJob).inSingletonScope();

// PR 17a: Sync Error AI Assist
import { TenantConfigurationRepository } from '../database/repositories/TenantConfigurationRepository';
import { SyncErrorAssistRepository } from '../services/syncErrorAssist/SyncErrorAssistRepository';
import { SyncErrorAssistService } from '../services/syncErrorAssist/SyncErrorAssistService';
import { SyncErrorAssistDailyJob } from '../services/syncErrorAssist/SyncErrorAssistDailyJob';
import { SyncErrorAssistMetrics } from '../services/syncErrorAssist/SyncErrorAssistMetrics';
import { SyncErrorAssistOperatorService } from '../services/syncErrorAssist/SyncErrorAssistOperatorService';
import { CostTransparencyRepository } from '../services/cost/CostTransparencyRepository';
import { CostTransparencyService } from '../services/cost/CostTransparencyService';
import { CostTransparencyDailyJob } from '../services/cost/CostTransparencyDailyJob';
import { ReconciliationExceptionRepository } from '../services/reconciliationCenter/ReconciliationExceptionRepository';
import { ReconciliationCenterService } from '../services/reconciliationCenter/ReconciliationCenterService';
import { ReconciliationScheduleJob } from '../services/reconciliationCenter/ReconciliationScheduleJob';
import { ReconciliationScheduleRepository } from '../services/reconciliationCenter/ReconciliationScheduleRepository';
import { ReconcilerRegistry } from '../services/reconciliationCenter/reconcilers/Reconciler';
import { NetSuiteBusinessCentralInvoiceReconciler } from '../services/reconciliationCenter/reconcilers/NetSuiteBusinessCentralInvoiceReconciler';
import { LineageRepository } from '../services/lineage/LineageRepository';
import { LineageRecorder } from '../services/lineage/LineageRecorder';
import { LineageQueryService } from '../services/lineage/LineageQueryService';
import { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import type { SecretManager } from '../services/SecretManager';

container.bind<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    // SecretManager is also async-bound (line ~229), so both DatabaseService
    // and SecretManager require getAsync. Logger is sync.
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const secretManager = await context.container.getAsync<SecretManager>(TYPES.SecretManager);
    const tcLogger = context.container.get<Logger>(TYPES.Logger);
    return new TenantConfigurationRepository(dbService, secretManager, tcLogger);
  })
  .inSingletonScope();

// C3: lazy provider for sync-bound consumers (GovernanceService) that need to
// resolve the async-bound TenantConfigurationRepository on demand. Avoids
// cascading the async-binding chain through MCPAggregatorService and
// MultiAgentOrchestrator (both inject GovernanceService transitively via the
// 'GovernanceService' string alias). The Provider returns a parameterless
// thunk that the consumer `await`s; TenantConfigurationRepository is bound as
// a singleton, so subsequent thunk invocations hand back the same instance.
// Cache strategy lives in the consumer (60s TTL — see
// GovernanceService.getPostureForTenant), not here.
//
// Typed as the narrow `TenantConfigurationProvider` (`() => Promise<...>`)
// re-exported by GovernanceService rather than the broader Inversify
// `interfaces.Provider<T>` so call sites can `await` the thunk once and get
// back the repository instance directly — no `as TenantConfigurationRepository`
// cast required.
import type { TenantConfigurationProvider } from '../services/ai/orchestrator/GovernanceService';
container
  .bind<TenantConfigurationProvider>(TYPES.TenantConfigurationRepositoryProvider)
  .toProvider<TenantConfigurationRepository>((context: interfaces.Context) => () =>
    context.container.getAsync<TenantConfigurationRepository>(
      TYPES.TenantConfigurationRepository,
    ),
  );

container.bind<SyncErrorAssistRepository>(TYPES.SyncErrorAssistRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    // Must await getAsync — DatabaseService is bound via toDynamicValue(async)
    // (line 184–189 above), so a bare get() returns Promise<DatabaseService>
    // and the repo would be constructed with a Promise instead of an instance.
    // This matches the established pattern (e.g., SagaOrchestrator at ~597,
    // CostTrackingService at ~605) for any repo/service depending on DB.
    // TenantConfigurationRepository is also async-bound; pass it through so
    // getActiveTenants() can route encrypted enabled-flag rows through the
    // decryption path (Codex P2 finding on PR #808).
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const tenantConfig = await context.container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
    return new SyncErrorAssistRepository(dbService, tenantConfig);
  })
  .inSingletonScope();

container.bind<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics)
  .to(SyncErrorAssistMetrics).inSingletonScope();

container.bind<SyncErrorAssistService>(TYPES.SyncErrorAssistService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const tenantConfig = await context.container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
    const repo = await context.container.getAsync<SyncErrorAssistRepository>(TYPES.SyncErrorAssistRepository);
    const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
    const providerRegistry = context.container.get<ProviderRegistry>(TYPES.ProviderRegistry);
    const traceEngine = await context.container.getAsync<ReasoningTraceEngine>(TYPES.ReasoningTraceEngine);
    const costTracking = await context.container.getAsync<CostTrackingService>(TYPES.CostTrackingService);
    const auditLog = context.container.get<AuditLogRepository>(TYPES.AuditLogRepository);
    const dlpService = context.container.get<DLPService>(TYPES.DLPService);
    const metrics = context.container.get<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics);
    const governanceService = context.container.get<GovernanceService>(TYPES.GovernanceService);
    const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    const auditService = context.container.get<AuditService>(TYPES.AuditService);
    const approvalQueueService = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
    return new SyncErrorAssistService(logger, tenantConfig, repo, connectorManager, providerRegistry, traceEngine, costTracking, auditLog, dlpService, metrics, governanceService, ownershipResolver, auditService, approvalQueueService);
  })
  .inSingletonScope();

container.bind<SyncErrorAssistDailyJob>(TYPES.SyncErrorAssistDailyJob)
  .to(SyncErrorAssistDailyJob).inSingletonScope();

container.bind<SyncErrorAssistOperatorService>(TYPES.SyncErrorAssistOperatorService)
  .to(SyncErrorAssistOperatorService).inSingletonScope();

// PR 21: Cost Transparency Dashboard
container.bind<CostTransparencyRepository>(TYPES.CostTransparencyRepository)
  .to(CostTransparencyRepository).inSingletonScope();

container.bind<CostTransparencyService>(TYPES.CostTransparencyService)
  .to(CostTransparencyService).inSingletonScope();

container.bind<CostTransparencyDailyJob>(TYPES.CostTransparencyDailyJob)
  .to(CostTransparencyDailyJob).inSingletonScope();

// PR 11: Reconciliation Center
// Bind as toDynamicValue(async) because DatabaseService is async-bound and a
// plain .to() chain risks injecting Promise<DatabaseService> into the repo
// ctor on any sync container.get() path. Mirrors the SagaOrchestrator /
// CostTrackingService / ReasoningTraceEngine pattern in this file — the
// only safe shape when a class transitively depends on DatabaseService.
container.bind<ReconciliationExceptionRepository>(TYPES.ReconciliationExceptionRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const databaseService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new ReconciliationExceptionRepository(databaseService);
  })
  .inSingletonScope();

container.bind<ReconciliationScheduleRepository>(TYPES.ReconciliationScheduleRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const databaseService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new ReconciliationScheduleRepository(databaseService);
  })
  .inSingletonScope();

// ReconcilerRegistry is sync-bound: ConnectorManager is sync-bound, so no async
// resolution is needed. The one shipped reconciler (NetSuite <-> Business Central
// invoices) is registered at bind time keyed by its handler_key.
container.bind<ReconcilerRegistry>(TYPES.ReconcilerRegistry)
  .toDynamicValue((context: interfaces.Context) => {
    const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
    const configurationService = context.container.get<ConfigurationService>(TYPES.ConfigurationService);
    const registry = new ReconcilerRegistry();
    registry.register(new NetSuiteBusinessCentralInvoiceReconciler(connectorManager, configurationService));
    return registry;
  })
  .inSingletonScope();

container.bind<ReconciliationCenterService>(TYPES.ReconciliationCenterService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const repo = await context.container.getAsync<ReconciliationExceptionRepository>(
      TYPES.ReconciliationExceptionRepository,
    );
    const scheduleRepo = await context.container.getAsync<ReconciliationScheduleRepository>(
      TYPES.ReconciliationScheduleRepository,
    );
    const registry = context.container.get<ReconcilerRegistry>(TYPES.ReconcilerRegistry);
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new ReconciliationCenterService(repo, scheduleRepo, registry, logger);
  })
  .inSingletonScope();

container.bind<ReconciliationScheduleJob>(TYPES.ReconciliationScheduleJob)
  .toDynamicValue(async (context: interfaces.Context) => {
    const service = await context.container.getAsync<ReconciliationCenterService>(
      TYPES.ReconciliationCenterService,
    );
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new ReconciliationScheduleJob(service, logger);
  })
  .inSingletonScope();

// PR 12: Record-Level Lineage
// LineageRepository transitively depends on DatabaseService (async-bound), so
// resolve via `toDynamicValue(async)` end-to-end — matches the Reconciliation
// Center / SagaOrchestrator / CostTrackingService pattern. A plain `.to()`
// chain would inject `Promise<DatabaseService>` on any sync container.get()
// path, breaking `dbService.getDatabase()` in the repo ctor on cold-start.
container.bind<LineageRepository>(TYPES.LineageRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const databaseService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new LineageRepository(databaseService);
  })
  .inSingletonScope();

container.bind<LineageRecorder>(TYPES.LineageRecorder)
  .toDynamicValue(async (context: interfaces.Context) => {
    const repo = await context.container.getAsync<LineageRepository>(TYPES.LineageRepository);
    return new LineageRecorder(repo);
  })
  .inSingletonScope();

container.bind<LineageQueryService>(TYPES.LineageQueryService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const repo = await context.container.getAsync<LineageRepository>(TYPES.LineageRepository);
    return new LineageQueryService(repo);
  })
  .inSingletonScope();

// PR 13b Stage B: OwnershipResumeHandler binding. The `setDefault` side
// effect previously lived here — Copilot R1 cluster-A4 moved it to the
// ApprovalResumeRegistry factory (line 747) so the default fallback is
// registered as part of constructing the registry, not as an opt-in
// side-effect of resolving the handler binding (which the resume worker
// never did).
import { OwnershipResumeHandler } from '../services/governance/handlers/OwnershipResumeHandler';
container.bind<OwnershipResumeHandler>(TYPES.OwnershipResumeHandler)
  .toDynamicValue(async (context: interfaces.Context) => {
    const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
    const auditService = context.container.get<AuditService>(TYPES.AuditService);
    // PR 13c-2 Task 3 + Task 4: encryption (decrypt persisted args), config
    // lookup (re-initialize the connector with per-tenant auth), and
    // OwnershipResolver (detectLoop on resume — approval may have arrived
    // long after enqueue and a reciprocal lineage chain may have formed).
    const encryption = context.container.get<EncryptionService>(TYPES.EncryptionService);
    const configService = context.container.get<ConfigurationService>(TYPES.ConfigurationService);
    // OwnershipResolver is async-bound (LineageQueryService → DatabaseService).
    const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    return new OwnershipResumeHandler(
      connectorManager,
      auditService,
      encryption,
      configService,
      ownershipResolver,
    );
  })
  .inSingletonScope();

// PR 13: OwnershipResolver — bound via toDynamicValue(async) because
// LineageQueryService is async-bound (transitively depends on
// DatabaseService). Per [[feedback-inversify-async-databaseservice-cascade]],
// `.to(...).inSingletonScope()` would inject `Promise<LineageQueryService>`
// and crash at first call with "findRecentReciprocalActivity is not a function".
container.bind<OwnershipResolver>(TYPES.OwnershipResolver)
  .toDynamicValue(async (context: interfaces.Context) => {
    const lineage = await context.container.getAsync<LineageQueryService>(TYPES.LineageQueryService);
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new OwnershipResolver(lineage, logger);
  })
  .inSingletonScope();

// PR 6 (operator-promotion): FinanceCentral durable approval state.
// Both FinanceCentralRepository and FinanceCentralOperatorService bind via
// `toDynamicValue(async)` so the resolution chain is async end-to-end (Codex
// R1 BM-2 + Copilot R2 #1). The prior `.to()` form on the operator service
// worked only because by the time consumers resolved it, the async-bound
// transitive DatabaseService was already cached as a singleton — a fragile
// assumption that broke on cold-start. Async resolution end-to-end removes
// the race entirely. Consumers (routes/financeCentral.ts, NLActionGateService
// factory, NLActionGateRouter) resolve via `getAsync`.
import { FinanceCentralRepository } from '../services/financeCentral/FinanceCentralRepository';
import { FinanceCentralOperatorService } from '../services/financeCentral/FinanceCentralOperatorService';

container.bind<FinanceCentralRepository>(TYPES.FinanceCentralRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new FinanceCentralRepository(dbService);
  })
  .inSingletonScope();

container.bind<FinanceCentralOperatorService>(TYPES.FinanceCentralOperatorService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const repo = await context.container.getAsync<FinanceCentralRepository>(TYPES.FinanceCentralRepository);
    const connectorManager = context.container.get<ConnectorManager>(TYPES.ConnectorManager);
    const auditLog = context.container.get<AuditLogRepository>(TYPES.AuditLogRepository);
    // Copilot R1 (PR 13b) cluster-A3: OwnershipResolver is bound via
    // `toDynamicValue(async)` (line 1461 above), so sync `.get()` here would
    // return a Promise<OwnershipResolver> that fails at first method call.
    // Mirror the existing `approvalQueueService` async resolution below.
    const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    const auditService = context.container.get<AuditService>(TYPES.AuditService);
    const approvalQueueService = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
    return new FinanceCentralOperatorService(logger, repo, connectorManager, auditLog, ownershipResolver, auditService, approvalQueueService);
  })
  .inSingletonScope();

// PR-OP-2 (tenant kill-switch): TenantLifecycle DI wiring.
// TenantLifecycleRepository takes Kysely<Database> directly (not DatabaseService),
// so the toDynamicValue(async) factory awaits DatabaseService then calls
// getDatabase() before passing the Kysely instance to the constructor.
// TenantLifecycleService is @injectable() and resolves its repo dependency
// via @inject(TYPES.TenantLifecycleRepository), so plain `.to()` suffices —
// Inversify walks the async-bound repo first, then constructs the service.
// (Imports for these symbols live at the top of the file with the rest.)

container.bind<TenantLifecycleRepository>(TYPES.TenantLifecycleRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    return new TenantLifecycleRepository(dbService.getDatabase());
  })
  .inSingletonScope();

container.bind<TenantLifecycleService>(TYPES.TenantLifecycleService)
  .to(TenantLifecycleService)
  .inSingletonScope();

// WorkflowCentral operator-promotion (T6 bindings).
// WorkflowEngineService is sync (no DB dep; pure in-memory state machine).
// WorkflowCentralRepository and WorkflowCentralOperatorService bind via
// toDynamicValue(async) for the same reason as FinanceCentral: cold-start
// safety when the transitive DatabaseService singleton is async-bound.
import { WorkflowEngineService } from '../services/workflowCentral/WorkflowEngineService';
import { WorkflowCentralRepository } from '../services/workflowCentral/WorkflowCentralRepository';
import { WorkflowCentralOperatorService } from '../services/workflowCentral/WorkflowCentralOperatorService';
import { WorkflowPayloadResolver } from '../services/workflowCentral/payload/WorkflowPayloadResolver';
import { WorkflowPayloadCache } from '../services/workflowCentral/payload/WorkflowPayloadCache';
import { WorkflowPayloadRetentionJob } from '../services/workflowCentral/WorkflowPayloadRetentionJob';
import { FlowExecutor } from '../flows/templates/FlowExecutor';

container.bind<WorkflowEngineService>(TYPES.WorkflowEngineService)
  .to(WorkflowEngineService)
  .inSingletonScope();

// Phase 1 governance-without-hosting-data bindings (ADR-019).
container.bind<WorkflowPayloadCache>(TYPES.WorkflowPayloadCache)
  .to(WorkflowPayloadCache)
  .inSingletonScope();

container.bind<WorkflowPayloadResolver>(TYPES.WorkflowPayloadResolver)
  .to(WorkflowPayloadResolver)
  .inSingletonScope();

container.bind<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository)
  .toDynamicValue(async (context: interfaces.Context) => {
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const logger = context.container.get<Logger>(TYPES.Logger);
    return new WorkflowCentralRepository(dbService, logger);
  })
  .inSingletonScope();

// C1: ephemeral-payload retention reaper. Inversify v6 resolves the async
// dependency chain (WorkflowCentralRepository is async-bound via
// toDynamicValue) automatically when the consumer is acquired via
// container.getAsync — same pattern as SyncErrorAssistDailyJob (~line 1290).
// Bare .to() works here because the call sites in src/index.ts use
// container.getAsync<WorkflowPayloadRetentionJob>(...) (see Server.start
// and Server.stop), not a synchronous .get().
container.bind<WorkflowPayloadRetentionJob>(TYPES.WorkflowPayloadRetentionJob)
  .to(WorkflowPayloadRetentionJob).inSingletonScope();

container.bind<WorkflowCentralOperatorService>(TYPES.WorkflowCentralOperatorService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const engine = context.container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    const repo = await context.container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
    const auditLog = context.container.get<AuditLogRepository>(TYPES.AuditLogRepository);
    const dbService = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const payloadResolver = context.container.get<WorkflowPayloadResolver>(TYPES.WorkflowPayloadResolver);
    // TenantConfigurationRepository is async-bound (line ~1192) — must getAsync
    // or the operator would be constructed with a Promise, not an instance.
    const tenantConfig = await context.container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
    return new WorkflowCentralOperatorService(logger, engine, repo, auditLog, dbService, payloadResolver, tenantConfig);
  })
  .inSingletonScope();

container.bind<WorkflowCentralService>(TYPES.WorkflowCentralService)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const engine = context.container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    const repo = await context.container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
    const db = await context.container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const auditLog = context.container.get<AuditLogRepository>(TYPES.AuditLogRepository);
    const dlpService = context.container.get<DLPService>(TYPES.DLPService);
    const governance = context.container.get<GovernanceService>(TYPES.GovernanceService);
    return new WorkflowCentralService(logger, engine, repo, db, auditLog, dlpService, governance);
  })
  .inSingletonScope();

// PR 14 + PR 13 + PR 13b: FlowExecutor — single runtime for governed flow templates.
// Constructor-injected dependencies: Logger, OutboundGovernanceService,
// ApprovalQueueService, OwnershipResolver (added in PR 13), AuditService
// (added in PR 13b for guardedWrite audit rows). Binding uses toDynamicValue(async)
// so async-bound deps (OwnershipResolver, AuditService) resolve correctly —
// Inversify v6 does NOT auto-await async-bound deps on sync `.to()` paths.
// Per [[feedback-inversify-async-databaseservice-cascade]] and Codex
// round 3 PR-13-spec review.
container.bind<FlowExecutor>(TYPES.FlowExecutor)
  .toDynamicValue(async (context: interfaces.Context) => {
    const logger = context.container.get<Logger>(TYPES.Logger);
    const outboundGovernance = await context.container.getAsync<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    const approvalQueue = await context.container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
    const ownershipResolver = await context.container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    const auditService = context.container.get<AuditService>(TYPES.AuditService);
    return new FlowExecutor(logger, outboundGovernance, approvalQueue, ownershipResolver, auditService);
  })
  .inSingletonScope();

export { container };
