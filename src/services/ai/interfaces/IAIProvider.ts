/**
 * Interface for AI/ML providers that can be plugged into the field mapping system.
 * This abstraction allows switching between different AI implementations
 * (rule-based, cloud APIs, local ML models) without changing core logic.
 */

export interface IAIProvider {
  readonly name: string;
  readonly version: string;
  readonly type: 'rule-based' | 'cloud-api' | 'local-ml' | 'hybrid';
  readonly isAvailable: boolean;
}

export interface ISemanticProvider extends IAIProvider {
  /**
   * Analyze semantic similarity between field names
   */
  analyzeSemanticSimilarity(
    sourceField: string,
    targetField: string,
    context?: SemanticContext
  ): Promise<SemanticSimilarityResult>;

  /**
   * Find semantic matches for a field across multiple candidates
   */
  findSemanticMatches(
    sourceField: string,
    candidateFields: string[],
    context?: SemanticContext
  ): Promise<SemanticMatch[]>;
}

export interface IPatternProvider extends IAIProvider {
  /**
   * Analyze data patterns in field values
   */
  analyzeFieldPattern(
    fieldName: string,
    sampleValues: unknown[],
    context?: PatternContext
  ): Promise<FieldPatternResult>;

  /**
   * Classify data type based on content analysis
   */
  classifyDataType(
    sampleValues: unknown[],
    context?: PatternContext
  ): Promise<DataTypeClassification>;
}

export interface INLPProvider extends IAIProvider {
  /**
   * Extract meaning and intent from field descriptions
   */
  analyzeFieldDescription(
    description: string,
    context?: NLPContext
  ): Promise<DescriptionAnalysisResult>;

  /**
   * Generate human-readable explanations for mappings
   */
  generateMappingExplanation(
    sourceField: string,
    targetField: string,
    confidence: number,
    context?: NLPContext
  ): Promise<string>;
}

export interface IMLProvider extends IAIProvider {
  /**
   * Train the model with new mapping examples
   */
  trainModel(
    trainingExamples: MLTrainingExample[],
    options?: MLTrainingOptions
  ): Promise<MLTrainingResult>;

  /**
   * Predict field mappings using trained model
   */
  predictMapping(
    sourceSchema: FieldSchema,
    targetSchema: FieldSchema,
    options?: MLPredictionOptions
  ): Promise<MLPredictionResult>;

  /**
   * Update model with user feedback
   */
  updateWithFeedback(
    mapping: FieldMapping,
    feedback: UserFeedback
  ): Promise<void>;

  /**
   * Get model performance metrics
   */
  getModelMetrics(): Promise<MLModelMetrics>;
}

// Supporting interfaces
export interface SemanticContext {
  sourceSystem?: string;
  targetSystem?: string;
  domain?: string;
  language?: string;
}

export interface SemanticSimilarityResult {
  similarity: number; // 0.0 to 1.0
  confidence: number; // 0.0 to 1.0
  explanation: string;
  matchType: 'exact' | 'partial' | 'synonym' | 'semantic' | 'contextual';
}

export interface SemanticMatch {
  field: string;
  similarity: number;
  confidence: number;
  explanation: string;
  matchType: string;
}

export interface PatternContext {
  fieldName?: string;
  fieldType?: string;
  sourceSystem?: string;
  recordType?: string;
}

export interface FieldPatternResult {
  pattern: string;
  confidence: number;
  examples: unknown[];
  statistics: PatternStatistics;
  validationRules?: ValidationRule[];
}

export interface PatternStatistics {
  totalSamples: number;
  matchingPatterns: number;
  uniqueValues: number;
  nullValues: number;
  distribution?: Record<string, number>;
}

export interface ValidationRule {
  type: string;
  rule: string;
  message: string;
}

export interface DataTypeClassification {
  primaryType: string;
  confidence: number;
  alternativeTypes: { type: string; confidence: number }[];
  format?: string;
  constraints?: Record<string, unknown>;
}

export interface NLPContext {
  language?: string;
  domain?: string;
  audience?: 'technical' | 'business' | 'end-user';
}

export interface DescriptionAnalysisResult {
  intent: string;
  keywords: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  businessContext: string[];
  technicalTerms: string[];
  confidence: number;
}

export interface MLTrainingExample {
  id: string;
  sourceField: FieldSchema;
  targetField: FieldSchema;
  mapping: FieldMapping;
  feedback: UserFeedback;
  context: MLContext;
  timestamp: Date;
}

export interface MLTrainingOptions {
  algorithm?: 'neural-network' | 'decision-tree' | 'random-forest' | 'svm';
  epochs?: number;
  batchSize?: number;
  validationSplit?: number;
  hyperparameters?: Record<string, unknown>;
}

export interface MLTrainingResult {
  success: boolean;
  modelId: string;
  accuracy: number;
  loss: number;
  metrics: MLModelMetrics;
  trainingTime: number;
  warnings: string[];
}

export interface MLPredictionOptions {
  confidenceThreshold?: number;
  maxSuggestions?: number;
  includeAlternatives?: boolean;
  context?: MLContext;
}

export interface MLPredictionResult {
  predictions: MLFieldMapping[];
  modelId: string;
  confidence: number;
  processingTime: number;
}

export interface MLFieldMapping {
  sourceField: string;
  targetField: string;
  confidence: number;
  explanation: string;
  alternatives: {
    field: string;
    confidence: number;
    explanation: string;
  }[];
  metadata: Record<string, unknown>;
}

export interface MLContext {
  sourceSystem: string;
  targetSystem: string;
  recordType: string;
  businessDomain?: string;
  userPreferences?: Record<string, unknown>;
}

export interface UserFeedback {
  accepted: boolean;
  alternativeChosen?: string;
  rating?: number; // 1-5 stars
  comments?: string;
  timestamp: Date;
}

export interface MLModelMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  confusionMatrix?: number[][];
  featureImportance?: Record<string, number>;
  trainingExamples: number;
  lastTraining: Date;
}

export interface FieldSchema {
  name: string;
  type: string;
  description?: string;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transformationType: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}
