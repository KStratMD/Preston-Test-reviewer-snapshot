/**
 * Multi-Agent Orchestrator Interfaces
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

export interface AgentExecutionContext {
  sessionId: string;
  userId?: string;
  tenantId?: string;
  sourceSystem?: string;
  targetSystem?: string;
  businessProcess?: string;
  industry?: string;
  confidenceThreshold?: number;
  maxExecutionTime?: number;
  enableReasoningTrace?: boolean;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

export interface ReasoningStep {
  step: number;
  agent: string;
  action: string;
  input: unknown;
  output: unknown;
  confidence: number;
  reasoning: string;
  timestamp: Date;
  executionTime: number;
}

export interface AgentResult<T = any> {
  success: boolean;
  data?: T;
  confidence: number;
  reasoning: string;
  errors?: string[];
  warnings?: string[];
  executionTime: number;
  hallucination_risk?: 'low' | 'medium' | 'high';
  governance_flags?: string[];
}

export interface OrchestratorResult {
  sessionId: string;
  success: boolean;
  results: Map<string, AgentResult>;
  overallConfidence: number;
  reasoningTrace: ReasoningStep[];
  totalExecutionTime: number;
  governance: GovernanceReport;
  cost: CostBreakdown;
}

export interface GovernanceReport {
  piiDetected: boolean;
  confidentialityLevel: 'public' | 'internal' | 'confidential' | 'restricted';
  complianceFlags: string[];
  riskAssessment: 'low' | 'medium' | 'high';
  auditTrail: AuditEntry[];
}

export interface AuditEntry {
  timestamp: Date;
  agent: string;
  action: string;
  user?: string;
  ipAddress?: string;
  riskLevel: 'low' | 'medium' | 'high';
  details: Record<string, unknown>;
}

export interface CostBreakdown {
  totalCost: number;
  providerCosts: Record<string, number>;
  tokenUsage: Record<string, number>;
  estimatedMonthlyCost: number;
}

export interface Agent {
  readonly name: string;
  readonly version: string;
  readonly capabilities: string[];
  readonly dependencies: string[];

  execute(context: AgentExecutionContext, input: unknown): Promise<AgentResult>;
  validateInput(input: unknown): Promise<boolean>;
  getSchema(): AgentSchema;
}

export interface AgentSchema {
  inputSchema: unknown;
  outputSchema: unknown;
  capabilities: string[];
  resourceRequirements: {
    maxMemory?: number;
    maxExecutionTime?: number;
    requiredProviders?: string[];
  };
}

// Specific agent interfaces

export interface FieldMappingInput {
  sourceFields: FieldDefinition[];
  targetFields: FieldDefinition[];
  sampleData?: unknown[];
  existingMappings?: unknown[];
  validationRules?: unknown[];
}

export interface FieldMappingOutput {
  mappings: EnhancedFieldMapping[];
  qualityScore: number;
  recommendations: string[];
  alternatives: FieldMappingAlternative[];
}

export interface EnhancedFieldMapping {
  sourceField: string;
  targetField: string;
  confidence: number;
  transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional' | 'custom';
  transformationLogic?: string;
  validationRules?: string[];
  businessRule?: string;
  dataQualityImpact?: number;
  alternatives?: FieldMappingAlternative[];
  origin?: 'llm' | 'heuristic';
  providerId?: string;
}

export interface FieldMappingAlternative {
  targetField: string;
  confidence: number;
  transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional' | 'custom';
  explanation: string;
}

export interface DataQualityInput {
  data: unknown[];
  schema: FieldDefinition[];
  qualityStandards?: QualityStandard[];
  businessRules?: BusinessRule[];
}

export interface DataQualityOutput {
  overallScore: number;
  fieldScores: Record<string, number>;
  issues: QualityIssue[];
  anomalies: DataAnomaly[];
  recommendations: QualityRecommendation[];
  cleansingSuggestions: CleansingSuggestion[];
}

export interface QualityStandard {
  field: string;
  rules: QualityRule[];
  weight: number;
}

export interface QualityRule {
  type: 'completeness' | 'consistency' | 'accuracy' | 'validity' | 'uniqueness';
  threshold: number;
  description: string;
}

export interface DataAnomaly {
  field: string;
  anomalyType: 'outlier' | 'pattern_break' | 'format_deviation' | 'missing_expected';
  severity: 'low' | 'medium' | 'high';
  description: string;
  affectedRecords: number;
  suggestedAction: string;
  confidence?: number;
  aiConfidence?: number;
}

export interface QualityRecommendation {
  priority: 'low' | 'medium' | 'high';
  category: 'data_cleaning' | 'validation_rules' | 'process_improvement';
  description: string;
  estimatedImpact: string;
  implementationEffort: 'low' | 'medium' | 'high';
}

export interface CleansingSuggestion {
  field: string;
  operation: 'standardize' | 'deduplicate' | 'format' | 'validate' | 'enrich';
  description: string;
  automatable: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ProcessOptimizationInput {
  currentWorkflow: WorkflowStep[];
  performanceMetrics?: PerformanceMetric[];
  constraints?: Constraint[];
  objectives?: Objective[];
}

export interface ProcessOptimizationOutput {
  optimizedWorkflow: WorkflowStep[];
  improvements: ProcessImprovement[];
  bottlenecks: Bottleneck[];
  costSavings: CostSaving[];
  riskAssessment: ProcessRisk[];
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: 'manual' | 'automated' | 'hybrid';
  duration: number;
  resources: string[];
  dependencies: string[];
  failureRate?: number;
}

export interface ProcessImprovement {
  type: 'automation' | 'parallelization' | 'elimination' | 'optimization' | 'consolidation' | 'reordering';
  description: string;
  impact: {
    timeReduction: number;
    costReduction: number;
    qualityImprovement: number;
    riskReduction: number;
  };
  implementationComplexity: 'low' | 'medium' | 'high';
  prerequisites: string[];
}

export interface IntegrationStrategyInput {
  sourceSystemProfile: SystemProfile;
  targetSystemProfile: SystemProfile;
  businessRequirements: BusinessRequirement[];
  technicalConstraints?: TechnicalConstraint[];
  timeline?: TimelineConstraint;
}

export interface IntegrationStrategyOutput {
  recommendedApproach: IntegrationApproach;
  architectureOptions: ArchitectureOption[];
  riskAssessment: IntegrationRisk[];
  implementation: ImplementationPlan;
  alternatives: AlternativeStrategy[];
}

export interface SystemProfile {
  name: string;
  type: 'erp' | 'crm' | 'database' | 'api' | 'file' | 'other';
  version?: string;
  capabilities: string[];
  limitations: string[];
  apiSupport: APICapability[];
  dataVolume: DataVolumeProfile;
  securityLevel: 'basic' | 'standard' | 'high' | 'enterprise';
}

export interface BusinessRequirement {
  id: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  type: 'functional' | 'non_functional' | 'compliance' | 'performance';
  acceptanceCriteria: string[];
}

export interface FieldDefinition {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  sampleValues?: unknown[];
  constraints?: unknown;
}

export interface BusinessRule {
  id: string;
  description: string;
  condition: string;
  action: string;
  priority: number;
}

export interface QualityIssue {
  field: string;
  severity: 'low' | 'medium' | 'high';
  type: 'completeness' | 'consistency' | 'accuracy' | 'validity';
  message: string;
  suggestion: string;
}

export interface PerformanceMetric {
  name: string;
  currentValue: number;
  targetValue: number;
  unit: string;
  trend: 'improving' | 'declining' | 'stable';
}

export interface Constraint {
  type: 'time' | 'budget' | 'resource' | 'technical' | 'regulatory';
  description: string;
  severity: 'soft' | 'hard';
}

export interface Objective {
  name: string;
  description: string;
  measurable: boolean;
  priority: 'low' | 'medium' | 'high';
  successCriteria: string[];
}

export interface Bottleneck {
  step: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  rootCause: string;
  suggestedSolution: string;
  estimatedResolution: string;
  confidence?: number;
}

export interface CostSaving {
  category: 'time' | 'labor' | 'infrastructure' | 'maintenance';
  description: string;
  annualSaving: number;
  oneTimeCost: number;
  roi: number;
  confidence: number;
}

export interface ProcessRisk {
  type: 'operational' | 'technical' | 'business' | 'compliance';
  description: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
}

export interface IntegrationApproach {
  name: string;
  description: string;
  pattern: 'batch' | 'real_time' | 'hybrid' | 'event_driven' | 'api_first';
  complexity: 'low' | 'medium' | 'high';
  recommendationReason: string;
}

export interface ArchitectureOption {
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  estimatedCost: number;
  implementationTime: number;
  complexity: 'low' | 'medium' | 'high';
  scalability: 'low' | 'medium' | 'high';
}

export interface IntegrationRisk {
  category: 'data' | 'performance' | 'security' | 'compliance' | 'operational';
  description: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
  contingency: string;
}

export interface ImplementationPlan {
  phases: ImplementationPhase[];
  totalDuration: number;
  totalCost: number;
  criticalPath: string[];
  dependencies: PhaseDependency[];
}

export interface ImplementationPhase {
  name: string;
  description: string;
  duration: number;
  cost: number;
  deliverables: string[];
  risks: string[];
  resources: ResourceRequirement[];
}

export interface AlternativeStrategy {
  name: string;
  description: string;
  tradeoffs: string[];
  applicableWhen: string[];
  notRecommendedWhen: string[];
}

export interface APICapability {
  type: 'rest' | 'soap' | 'graphql' | 'rpc' | 'webhook';
  version?: string;
  authentication: string[];
  rateLimits?: RateLimit;
}

export interface DataVolumeProfile {
  recordCount: number;
  growthRate: number;
  peakLoad: number;
  dataTypes: string[];
}

export interface TechnicalConstraint {
  type: 'platform' | 'network' | 'security' | 'performance' | 'compliance';
  description: string;
  impact: 'low' | 'medium' | 'high';
}

export interface TimelineConstraint {
  deadline: Date;
  milestones: Milestone[];
  flexibility: 'rigid' | 'moderate' | 'flexible';
}

export interface PhaseDependency {
  fromPhase: string;
  toPhase: string;
  type: 'blocking' | 'preferred' | 'optional';
  description: string;
}

export interface ResourceRequirement {
  type: 'human' | 'infrastructure' | 'software' | 'hardware';
  description: string;
  quantity: number;
  duration: number;
  cost: number;
}

export interface RateLimit {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
}

export interface Milestone {
  name: string;
  date: Date;
  description: string;
  criticalPath: boolean;
}


export type AgentCapability =
  | 'field-mapping'
  | 'data-quality'
  | 'process-optimization'
  | 'integration-strategy'
  | 'semantic-analysis'
  | 'anomaly-detection'
  | 'rule-generation'
  | 'compliance-checking';

export type AgentType =
  | 'field-mapping'
  | 'data-quality'
  | 'process-optimization'
  | 'integration-strategy'
  | 'business-intelligence';
