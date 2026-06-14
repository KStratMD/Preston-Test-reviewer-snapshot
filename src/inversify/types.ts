const TYPES = {
  Logger: Symbol.for('Logger'),
  ConfigurationService: Symbol.for('ConfigurationService'),
  IntegrationService: Symbol.for('IntegrationService'),
  AuthService: Symbol.for('AuthService'),
  ConfigDirectory: Symbol.for('ConfigDirectory'),
  TransformationEngine: Symbol.for('TransformationEngine'),
  SecretManager: Symbol.for('SecretManager'),
  SecureCredentialManager: Symbol.for('SecureCredentialManager'),
  SecureConfigurationService: Symbol.for('SecureConfigurationService'),
  CredentialMetadataStore: Symbol.for('CredentialMetadataStore'),
  RBACService: Symbol.for('RBACService'),
  SecurityMonitor: Symbol.for('SecurityMonitor'),
  ObservabilityService: Symbol.for('ObservabilityService'),
  QueueService: Symbol.for('QueueService'),
  BatchProcessingService: Symbol.for('BatchProcessingService'),
  ConfigurationVersioningService: Symbol.for('ConfigurationVersioningService'),
  SecretRotationService: Symbol.for('SecretRotationService'),
  DistributedTracingService: Symbol.for('DistributedTracingService'),
  DatabaseService: Symbol.for('DatabaseService'),
  IntegrationJobRepository: Symbol.for('IntegrationJobRepository'),
  AuditLogRepository: Symbol.for('AuditLogRepository'),
  OAuth2Service: Symbol.for('OAuth2Service'),
  ApiKeyService: Symbol.for('ApiKeyService'),
  AuthenticationMiddleware: Symbol.for('AuthenticationMiddleware'),
  PerformanceMonitor: Symbol.for('PerformanceMonitor'),
  CacheService: Symbol.for('CacheService'),
  AIFieldMappingService: Symbol.for('AIFieldMappingService'),
  SemanticAnalyzer: Symbol.for('SemanticAnalyzer'),
  NetSuiteSchemaIntelligence: Symbol.for('NetSuiteSchemaIntelligence'),
  PatternRecognizer: Symbol.for('PatternRecognizer'),
  TrainingDataRepository: Symbol.for('TrainingDataRepository'),
  SquireConnector: Symbol.for('SquireConnector'),
  SuiteCentralConnector: Symbol.for('SuiteCentralConnector'),
  NetSuiteConnector: Symbol.for('NetSuiteConnector'),
  StripeConnector: Symbol.for('StripeConnector'),
  PayPalConnector: Symbol.for('PayPalConnector'),
  AdyenConnector: Symbol.for('AdyenConnector'),
  ShopifyConnector: Symbol.for('ShopifyConnector'),
  ShipStationConnector: Symbol.for('ShipStationConnector'),
  HubSpotConnector: Symbol.for('HubSpotConnector'),
  SuiteCentralConnectorFactory: Symbol.for('SuiteCentralConnectorFactory'),
  TelemetryStore: Symbol.for('TelemetryStore'),
  TelemetryAggregator: Symbol.for('TelemetryAggregator'),
  TelemetryService: Symbol.for('TelemetryService'),
  DLQService: Symbol.for('DLQService'),
  DataMigrationAccelerator: Symbol.for('DataMigrationAccelerator'),
  SuiteCentralConfigService: Symbol.for('SuiteCentralConfigService'),
  SuiteCentralMonitoringService: Symbol.for('SuiteCentralMonitoringService'),
  SuiteCentralConnectorProd: Symbol.for('SuiteCentralConnectorProd'),
  // New integration services
  ConnectorManager: Symbol.for('ConnectorManager'),
  IntegrationStatusManager: Symbol.for('IntegrationStatusManager'),
  IntegrationExecutor: Symbol.for('IntegrationExecutor'),
  IntegrationOrchestrator: Symbol.for('IntegrationOrchestrator'),
  SagaOrchestrator: Symbol.for('SagaOrchestrator'),
  // SuiteCentral feature services
  PaymentCentralService: Symbol.for('PaymentCentralService'),
  PaymentCentralRuntime: Symbol.for('PaymentCentralRuntime'),
  SupplierCentralService: Symbol.for('SupplierCentralService'),
  InstallerCentralService: Symbol.for('InstallerCentralService'),
  PayoutCentralService: Symbol.for('PayoutCentralService'),
  SyncCentralService: Symbol.for('SyncCentralService'),
  FinanceCentralService: Symbol.for('FinanceCentralService'),
  InventoryCentralService: Symbol.for('InventoryCentralService'),
  ServiceCentralService: Symbol.for('ServiceCentralService'),
  CustomerCentralService: Symbol.for('CustomerCentralService'),
  QualityCentralService: Symbol.for('QualityCentralService'),
  ContractCentralService: Symbol.for('ContractCentralService'),
  PortalCentralService: Symbol.for('PortalCentralService'),
  WorkflowCentralService: Symbol.for('WorkflowCentralService'),
  SyncCentralOrchestrator: Symbol.for('SyncCentralOrchestrator'),
  AutomationLibrariesService: Symbol.for('AutomationLibrariesService'),
  // New AI services (Week 1 Task 2)
  ProviderRegistry: Symbol.for('ProviderRegistry'),
  OpenAIProvider: Symbol.for('OpenAIProvider'),
  ClaudeProvider: Symbol.for('ClaudeProvider'),
  GrokProvider: Symbol.for('GrokProvider'),
  GeminiProvider: Symbol.for('GeminiProvider'),
  LMStudioProvider: Symbol.for('LMStudioProvider'),
  OpenRouterProvider: Symbol.for('OpenRouterProvider'),
  // Unified telemetry (Week 1 Task 3)
  UnifiedTelemetryService: Symbol.for('UnifiedTelemetryService'),
  // Week 2 AI Services - Real AI MVP
  CostTrackingService: Symbol.for('CostTrackingService'),
  ABTestingService: Symbol.for('ABTestingService'),
  MockLLMProvider: Symbol.for('MockLLMProvider'),
  // Week 5 Orchestrator & Agents
  MultiAgentOrchestrator: Symbol.for('MultiAgentOrchestrator'),
  AgentRegistry: Symbol.for('AgentRegistry'),
  GovernanceService: Symbol.for('GovernanceService'),
  OutboundGovernanceService: Symbol.for('OutboundGovernanceService'),
  ApprovalQueueRepository: Symbol.for('ApprovalQueueRepository'),
  ApprovalQueueService: Symbol.for('ApprovalQueueService'),
  // PR 3B: HITL approval-queue wiring — resume worker + handler registry.
  ApprovalResumeRegistry: Symbol.for('ApprovalResumeRegistry'),
  ApprovalResumeWorker: Symbol.for('ApprovalResumeWorker'),
  ReasoningTraceEngine: Symbol.for('ReasoningTraceEngine'),
  AuditService: Symbol.for('AuditService'),
  // Phase 1 Secure AI Services
  SecureAIService: Symbol.for('SecureAIService'),
  SecureAIController: Symbol.for('SecureAIController'),
  // Phase 1 Backend Persistence
  MappingPersistenceService: Symbol.for('MappingPersistenceService'),
  MappingPersistenceController: Symbol.for('MappingPersistenceController'),
  // AI Configuration Services
  AIConfigurationService: Symbol.for('AIConfigurationService'),
  AIConfigurationBridge: Symbol.for('AIConfigurationBridge'),
  ModelCatalogService: Symbol.for('ModelCatalogService'),
  // Universal Translator - Week 1-2 (LLM Integration Foundation)
  SemanticAnalysisEngine: Symbol.for('SemanticAnalysisEngine'),
  // Business Intelligence Agent Services (Phase 2)
  MetricsCalculationService: Symbol.for('MetricsCalculationService'),
  ROIAnalysisService: Symbol.for('ROIAnalysisService'),
  ForecastingService: Symbol.for('ForecastingService'),
  InsightsGeneratorService: Symbol.for('InsightsGeneratorService'),
  // Process Optimization Agent Services
  BottleneckAnalysisService: Symbol.for('BottleneckAnalysisService'),
  PerformanceMetricsService: Symbol.for('PerformanceMetricsService'),
  CostBenefitAnalyzer: Symbol.for('CostBenefitAnalyzer'),
  RiskAssessmentService: Symbol.for('RiskAssessmentService'),
  OptimizationRecommender: Symbol.for('OptimizationRecommender'),
  // Data Quality Agent Services
  DataProfilingService: Symbol.for('DataProfilingService'),
  AnomalyDetectionService: Symbol.for('AnomalyDetectionService'),
  QualityScoringService: Symbol.for('QualityScoringService'),
  CleansingRecommender: Symbol.for('CleansingRecommender'),
  // Phase 3: AI Service Dependencies
  LoggingService: Symbol.for('LoggingService'),
  PredictiveAnalyticsService: Symbol.for('PredictiveAnalyticsService'),
  ProactiveIssueDetectionService: Symbol.for('ProactiveIssueDetectionService'),
  PerformanceOptimizationService: Symbol.for('PerformanceOptimizationService'),
  MappingPatternCacheService: Symbol.for('MappingPatternCacheService'),
  AIWorkflowIntelligenceService: Symbol.for('AIWorkflowIntelligenceService'),
  AIPredictiveConnectorService: Symbol.for('AIPredictiveConnectorService'),
  DemoModeService: Symbol.for('DemoModeService'),
  UserSettingsService: Symbol.for('UserSettingsService'),
  // Security Services (DLP/NER)
  DLPService: Symbol.for('DLPService'),
  NERService: Symbol.for('NERService'),
  // Reasoning Trace Service
  ReasoningTraceService: Symbol.for('ReasoningTraceService'),
  // Connector Credential Management
  ConnectorCredentialService: Symbol.for('ConnectorCredentialService'),
  Database: Symbol.for('Database'),
  // AI Field Mapping Validation Services
  UnmappableFieldDetectionService: Symbol.for('UnmappableFieldDetectionService'),
  AccuracyEnhancementService: Symbol.for('AccuracyEnhancementService'),
  // NetSuite MCP Integration (Phase 2-3)
  NetSuiteMCPSchemaAdapter: Symbol.for('NetSuiteMCPSchemaAdapter'),
  MCPKnowledgeProvider: Symbol.for('MCPKnowledgeProvider'),
  MCPFieldMappingEnhancer: Symbol.for('MCPFieldMappingEnhancer'),
  MCPABTestService: Symbol.for('MCPABTestService'),
  MCPUserSettingsService: Symbol.for('MCPUserSettingsService'),
  NetSuiteOfficialMcpClient: Symbol.for('NetSuiteOfficialMcpClient'),
  BusinessCentralMcpClient: Symbol.for('BusinessCentralMcpClient'),
  MCPAggregatorService: Symbol.for('MCPAggregatorService'),
  MCPPolicyService: Symbol.for('MCPPolicyService'),
  MCPTokenProvider: Symbol.for('MCPTokenProvider'),
  // Autonomous Decision Engine
  AutonomousDecisionEngine: Symbol.for('AutonomousDecisionEngine'),
  // Active Learning
  GoldenDatasetService: Symbol.for('GoldenDatasetService'),
  ActiveLearningService: Symbol.for('ActiveLearningService'),
  // Phase 4: AI Agents
  DunningAgent: Symbol.for('DunningAgent'),
  DocumentParsingAgent: Symbol.for('DocumentParsingAgent'),
  VendorOnboardingAgent: Symbol.for('VendorOnboardingAgent'),
  // Phase 1 AI-Enhanced SuiteCentral 2.0
  ModuleMetricsAggregator: Symbol.for('ModuleMetricsAggregator'),
  NLQCapabilityRegistry: Symbol.for('NLQCapabilityRegistry'),
  NLQueryOrchestrator: Symbol.for('NLQueryOrchestrator'),
  // Phase 2 AI-Enhanced SuiteCentral 2.0
  SyncCentralHealthPredictor: Symbol.for('SyncCentralHealthPredictor'),
  SupplierRiskScoringService: Symbol.for('SupplierRiskScoringService'),
  // Phase 3: Enterprise Reliability (Grand Unified Strategy 2026)
  SchemaRegistryService: Symbol.for('SchemaRegistryService'),
  // Phase 4: Intelligence (Grand Unified Strategy 2026)
  NLActionGateService: Symbol.for('NLActionGateService'),
  PredictiveOperationsService: Symbol.for('PredictiveOperationsService'),
  // MDM Persistence
  MDMRepository: Symbol.for('MDMRepository'),
  // Reasoning Trace Persistence
  ReasoningTraceRepository: Symbol.for('ReasoningTraceRepository'),
  // Phase 6: Golden Record MDM
  EntityMatchingService: Symbol.for('EntityMatchingService'),
  SurvivorshipRuleEngine: Symbol.for('SurvivorshipRuleEngine'),
  GoldenRecordService: Symbol.for('GoldenRecordService'),
  MDMFeedbackService: Symbol.for('MDMFeedbackService'),
  // PR 10a: Embedded ERP Surface Contract
  EmbeddedSessionRepository: Symbol.for('EmbeddedSessionRepository'),
  EmbeddedServiceTokenRepository: Symbol.for('EmbeddedServiceTokenRepository'),
  EmbeddedRetentionJob: Symbol.for('EmbeddedRetentionJob'),
  // PR 17a: Sync Error AI Assist
  TenantConfigurationRepository: Symbol.for('TenantConfigurationRepository'),
  // C3: lazy provider so sync-bound consumers (GovernanceService) can resolve
  // the async-bound TenantConfigurationRepository without forcing the rest of
  // the AI orchestrator stack onto an async chain. See inversify.config.ts for
  // the `toProvider` binding and GovernanceService.getPostureForTenant for the
  // single per-request `await this.tenantConfigProvider()` call site.
  TenantConfigurationRepositoryProvider: Symbol.for('TenantConfigurationRepositoryProvider'),
  SyncErrorAssistRepository: Symbol.for('SyncErrorAssistRepository'),
  SyncErrorAssistMetrics: Symbol.for('SyncErrorAssistMetrics'),
  SyncErrorAssistService: Symbol.for('SyncErrorAssistService'),
  SyncErrorAssistDailyJob: Symbol.for('SyncErrorAssistDailyJob'),
  SyncErrorAssistOperatorService: Symbol.for('SyncErrorAssistOperatorService'),
  // PR 6 (operator-promotion): FinanceCentral durable approval state
  FinanceCentralRepository: Symbol.for('FinanceCentralRepository'),
  FinanceCentralOperatorService: Symbol.for('FinanceCentralOperatorService'),
  // Tenant kill-switch (PR-A)
  TenantLifecycleRepository: Symbol.for('TenantLifecycleRepository'),
  TenantLifecycleService: Symbol.for('TenantLifecycleService'),
  // WorkflowCentral operator-promotion (T4 symbols; bindings in T6)
  WorkflowEngineService: Symbol.for('WorkflowEngineService'),
  WorkflowCentralRepository: Symbol.for('WorkflowCentralRepository'),
  WorkflowCentralOperatorService: Symbol.for('WorkflowCentralOperatorService'),
  // WorkflowCentral governance-without-hosting-data (Phase 1; ADR-019)
  WorkflowPayloadResolver: Symbol.for('WorkflowPayloadResolver'),
  WorkflowPayloadCache: Symbol.for('WorkflowPayloadCache'),
  // C1: ephemeral-payload retention reaper (proactive sweep, complements lazy expiry)
  WorkflowPayloadRetentionJob: Symbol.for('WorkflowPayloadRetentionJob'),
  // PR 14: Prebuilt Governed Flow Templates (narrow scope — FlowExecutor + 1 sample).
  FlowExecutor: Symbol.for('FlowExecutor'),
  // PR 21: Cost Transparency Dashboard
  CostTransparencyRepository: Symbol.for('CostTransparencyRepository'),
  CostTransparencyService: Symbol.for('CostTransparencyService'),
  CostTransparencyDailyJob: Symbol.for('CostTransparencyDailyJob'),
  // PR 11: Reconciliation Center (durable exceptions + scheduled checks)
  ReconciliationExceptionRepository: Symbol.for('ReconciliationExceptionRepository'),
  ReconciliationScheduleRepository: Symbol.for('ReconciliationScheduleRepository'),
  ReconcilerRegistry: Symbol.for('ReconcilerRegistry'),
  ReconciliationCenterService: Symbol.for('ReconciliationCenterService'),
  ReconciliationScheduleJob: Symbol.for('ReconciliationScheduleJob'),
  // PR 12: Record-Level Lineage
  LineageRepository: Symbol.for('LineageRepository'),
  LineageRecorder: Symbol.for('LineageRecorder'),
  LineageQueryService: Symbol.for('LineageQueryService'),
  OwnershipResolver: Symbol.for('OwnershipResolver'),
  // PR 13b Stage B: OwnershipResumeHandler — default handler for ownership_write approvals.
  OwnershipResumeHandler: Symbol.for('OwnershipResumeHandler'),
  // PR 13c-2 Task 3: EncryptionService binding (existing global singleton from
  // src/services/security/EncryptionService.ts). Bound via `toConstantValue` to
  // the exported `encryptionService` instance so consumers share the same key
  // and AAD as AI-provider API-key encryption.
  EncryptionService: Symbol.for('EncryptionService'),
};

export { TYPES };
