/**
 * Semantic Analysis Types for Universal Translator
 * 
 * Defines types for AI-powered semantic understanding of fields, schemas, and mappings.
 * These types support real LLM integration for intelligent field mapping and data translation.
 * 
 * @module semantic.types
 */

/**
 * Represents a field to be analyzed semantically
 */
export interface FieldDefinition {
  /** Field name/identifier */
  name: string;
  
  /** Data type (string, number, boolean, date, etc.) */
  type: string;
  
  /** Optional description or documentation */
  description?: string;
  
  /** Sample values for better semantic understanding */
  samples?: unknown[];

  /** Field constraints (required, unique, format, etc.) */
  constraints?: FieldConstraints;

  /** Metadata about the field */
  metadata?: Record<string, unknown>;
}

/**
 * Field constraints and validation rules
 */
export interface FieldConstraints {
  required?: boolean;
  unique?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string; // e.g., "email", "phone", "ssn", "date-iso8601"
  enum?: unknown[];
}

/**
 * Business context for semantic analysis
 */
export interface BusinessContext {
  /** Industry domain (healthcare, manufacturing, financial, retail, etc.) */
  industry?: string;
  
  /** Business process being integrated (order-to-cash, patient-management, etc.) */
  process?: string;
  
  /** Regulatory requirements (HIPAA, GDPR, SOX, etc.) */
  regulations?: string[];
  
  /** Source system type */
  sourceSystem?: string;
  
  /** Target system type */
  targetSystem?: string;
  
  /** Additional contextual information */
  description?: string;
}

/**
 * Request for semantic field analysis
 */
export interface FieldAnalysisRequest {
  /** Source field to analyze */
  sourceField: FieldDefinition;
  
  /** Potential target fields to map to */
  targetFields: FieldDefinition[];
  
  /** Business context for the analysis */
  context: BusinessContext;
  
  /** Sample data for validation */
  sampleData?: {
    source: unknown[];
    target?: unknown[];
  };
  
  /** Existing mappings to learn from */
  existingMappings?: ExistingMapping[];
}

/**
 * Existing mapping for pattern learning
 */
export interface ExistingMapping {
  sourceField: string;
  targetField: string;
  transformationType: string;
  success: boolean;
  feedback?: string;
}

/**
 * Result of semantic field analysis
 */
export interface SemanticAnalysis {
  /** Primary mapping recommendation */
  primaryMapping: FieldMappingRecommendation;
  
  /** Alternative mapping suggestions */
  alternativeMappings: FieldMappingRecommendation[];
  
  /** AI reasoning for the recommendations */
  reasoning: string;
  
  /** Overall confidence score (0-1) */
  confidence: number;
  
  /** Identified risks and concerns */
  risks: SemanticRisk[];
  
  /** Compliance and regulatory considerations */
  compliance: ComplianceConsideration[];
  
  /** Suggested transformation logic */
  transformation?: TransformationSuggestion;
  
  /** Cost and performance metadata */
  metadata: AnalysisMetadata;
}

/**
 * Field mapping recommendation with confidence
 */
export interface FieldMappingRecommendation {
  /** Target field being recommended */
  targetField: FieldDefinition;
  
  /** Confidence score for this mapping (0-1) */
  confidence: number;
  
  /** Semantic similarity score (0-1) */
  semanticSimilarity: number;
  
  /** Reasons supporting this mapping */
  reasons: string[];
  
  /** Type compatibility assessment */
  typeCompatibility: TypeCompatibility;
  
  /** Suggested transformation type */
  transformationType: TransformationType;
}

/**
 * Type compatibility assessment
 */
export interface TypeCompatibility {
  /** Are types compatible? */
  compatible: boolean;
  
  /** Confidence in compatibility (0-1) */
  confidence: number;
  
  /** Required conversion (if any) */
  conversionNeeded?: string;
  
  /** Potential data loss risk */
  dataLossRisk: 'none' | 'low' | 'medium' | 'high';
}

/**
 * Transformation types supported
 */
export type TransformationType = 
  | 'direct'           // Direct copy, no transformation
  | 'lookup'           // Value lookup/translation
  | 'calculation'      // Mathematical calculation
  | 'concatenation'    // Combine multiple fields
  | 'split'            // Split field into multiple
  | 'conditional'      // Conditional logic
  | 'formatting'       // Format conversion (date, phone, etc.)
  | 'encryption'       // Encrypt sensitive data
  | 'custom';          // Custom transformation logic

/**
 * Transformation suggestion from AI
 */
export interface TransformationSuggestion {
  /** Type of transformation */
  type: TransformationType;
  
  /** Detailed transformation logic */
  logic: string;
  
  /** Code example (if applicable) */
  example?: string;
  
  /** Configuration for the transformation */
  config?: Record<string, unknown>;
  
  /** Validation rules for transformed data */
  validation?: ValidationRule[];
}

/**
 * Validation rule for transformed data
 */
export interface ValidationRule {
  /** Rule type */
  type: 'required' | 'format' | 'range' | 'custom';
  
  /** Rule description */
  description: string;
  
  /** Validation expression */
  expression?: string;
  
  /** Error message if validation fails */
  errorMessage: string;
}

/**
 * Identified semantic risk
 */
export interface SemanticRisk {
  /** Risk severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  
  /** Risk category */
  category: 'data_loss' | 'pii_exposure' | 'compliance' | 'business_logic' | 'performance';
  
  /** Risk description */
  description: string;
  
  /** Fields affected */
  affectedFields: string[];
  
  /** Mitigation recommendations */
  mitigation: string[];
}

/**
 * Compliance consideration
 */
export interface ComplianceConsideration {
  /** Regulation name (HIPAA, GDPR, SOX, etc.) */
  regulation: string;
  
  /** Requirement description */
  requirement: string;
  
  /** Is this mapping compliant? */
  compliant: boolean;
  
  /** Actions needed for compliance */
  actionsNeeded: string[];
  
  /** Severity if not addressed */
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Analysis metadata (cost, performance, etc.)
 */
export interface AnalysisMetadata {
  /** LLM provider used */
  provider: string;
  
  /** Model used */
  model: string;
  
  /** Analysis timestamp */
  timestamp: Date;
  
  /** Response time in milliseconds */
  responseTime: number;
  
  /** Estimated cost in USD */
  cost: number;
  
  /** Tokens used (if applicable) */
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
  
  /** Version of analysis engine */
  version: string;
}

/**
 * Schema semantic analysis request
 */
export interface SchemaAnalysisRequest {
  /** Source schema to analyze */
  sourceSchema: SchemaDefinition;
  
  /** Target schema to map to */
  targetSchema: SchemaDefinition;
  
  /** Business context */
  context: BusinessContext;
  
  /** Sample records */
  sampleData?: {
    source: Record<string, unknown>[];
    target?: Record<string, unknown>[];
  };
}

/**
 * Schema definition
 */
export interface SchemaDefinition {
  /** Schema name */
  name: string;
  
  /** System type (Salesforce, NetSuite, etc.) */
  systemType: string;
  
  /** Entity/object name */
  entityName: string;
  
  /** Fields in the schema */
  fields: FieldDefinition[];
  
  /** Schema metadata */
  metadata?: {
    version?: string;
    description?: string;
    documentation?: string;
    [key: string]: unknown;
  };
}

/**
 * Complete schema mapping analysis
 */
export interface SchemaAnalysisResult {
  /** Individual field mappings */
  fieldMappings: SemanticAnalysis[];
  
  /** Overall schema compatibility */
  overallCompatibility: number;
  
  /** Unmapped source fields */
  unmappedSourceFields: FieldDefinition[];
  
  /** Unmapped target fields */
  unmappedTargetFields: FieldDefinition[];
  
  /** Recommended integration strategy */
  integrationStrategy: IntegrationStrategy;
  
  /** Schema-level risks */
  schemaRisks: SemanticRisk[];
  
  /** Overall analysis metadata */
  metadata: AnalysisMetadata;
}

/**
 * Integration strategy recommendation
 */
export interface IntegrationStrategy {
  /** Recommended sync mode */
  syncMode: 'realtime' | 'batch' | 'hybrid';
  
  /** Recommended sync frequency (for batch) */
  syncFrequency?: string;
  
  /** Error handling strategy */
  errorHandling: 'fail_fast' | 'continue_on_error' | 'retry';
  
  /** Data validation strategy */
  validation: 'strict' | 'relaxed' | 'custom';
  
  /** Performance optimization recommendations */
  optimizations: string[];
  
  /** Reasoning for the strategy */
  reasoning: string;
}

/**
 * Semantic similarity calculation request
 */
export interface SimilarityRequest {
  /** Text 1 to compare */
  text1: string;
  
  /** Text 2 to compare */
  text2: string;
  
  /** Context for comparison */
  context?: string;
  
  /** Use embeddings (if available) */
  useEmbeddings?: boolean;
}

/**
 * Semantic similarity result
 */
export interface SimilarityResult {
  /** Similarity score (0-1) */
  score: number;
  
  /** Method used (embeddings, llm_analysis, heuristic, calibrated_fallback) */
  method: 'embeddings' | 'llm_analysis' | 'heuristic' | 'calibrated_fallback';
  
  /** Explanation of similarity */
  explanation?: string;
  
  /** Confidence in the score */
  confidence: number;
}

/**
 * Prompt template for LLM requests
 */
export interface PromptTemplate {
  /** Template name */
  name: string;
  
  /** Template content with placeholders */
  template: string;
  
  /** Required variables */
  variables: string[];
  
  /** System message (if applicable) */
  systemMessage?: string;
  
  /** Temperature setting */
  temperature?: number;
  
  /** Max tokens */
  maxTokens?: number;
}

/**
 * LLM analysis options
 */
export interface LLMAnalysisOptions {
  /** Preferred provider (lmstudio, openai, claude, etc.) */
  provider?: string;
  
  /** Model to use */
  model?: string;
  
  /** Temperature (0-1, lower = more deterministic) */
  temperature?: number;
  
  /** Max tokens for response */
  maxTokens?: number;
  
  /** Stop sequences */
  stopSequences?: string[];
  
  /** Use caching (if available) */
  useCache?: boolean;
  
  /** Budget limit for this request (USD) */
  budgetLimit?: number;
  
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Confidence scoring factors
 */
export interface ConfidenceFactors {
  /** Semantic similarity contribution */
  semanticSimilarity: number;
  
  /** Type compatibility contribution */
  typeCompatibility: number;
  
  /** Business context alignment */
  contextAlignment: number;
  
  /** Historical pattern match */
  historicalMatch: number;
  
  /** Data sample validation */
  sampleValidation: number;
  
  /** Overall confidence (weighted average) */
  overall: number;
  
  /** Explanation of confidence calculation */
  explanation: string;
}
