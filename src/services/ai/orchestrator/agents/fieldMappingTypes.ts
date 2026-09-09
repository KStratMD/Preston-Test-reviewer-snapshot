import type { FieldMappingAlternative, FieldDefinition } from '../interfaces';

export interface TransformationRule {
  type: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional' | 'custom';
  expression?: string;
  lookupTable?: Record<string, string>;
  conditions?: ConditionalRule[];
  customFunction?: string;
}

export interface ConditionalRule {
  condition: string;
  trueValue: string;
  falseValue: string;
}

export interface SchemaConstraint {
  field: string;
  type: 'required' | 'unique' | 'format' | 'range' | 'custom';
  rule: string;
  description: string;
}

export interface SchemaRelationship {
  fromField: string;
  toField: string;
  relationship: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  required: boolean;
}

export interface CustomField {
  id: string;
  name: string;
  type: string;
  system: string;
  description?: string;
  validValues?: string[];
}

export interface SystemSchema {
  systemName: string;
  systemType?: string;
  version?: string;
  fields: FieldDefinition[];
  relationships: SchemaRelationship[];
  constraints: SchemaConstraint[];
  customFields: CustomField[];
}

export interface MappingPattern {
  name: string;
  description: string;
  sourcePattern: string;
  targetPattern: string;
  confidence: number;
  usageCount: number;
}

export interface IndustryContext {
  industry: string;
  regulations: string[];
  standards: string[];
  commonPatterns: MappingPattern[];
}

export interface BusinessRule {
  id: string;
  name: string;
  description: string;
  sourceFields: string[];
  targetFields: string[];
  transformation: TransformationRule;
  priority: number;
  active: boolean;
}

export interface ExistingMapping {
  sourceField: string;
  targetField: string;
  transformation: TransformationRule;
  confidence: number;
  lastUsed: Date;
  userFeedback: 'positive' | 'negative' | 'neutral';
}

export interface DataSample {
  sourceValues: Record<string, unknown>;
  expectedTarget?: Record<string, unknown>;
  context?: string;
}

export interface QualityMetrics {
  semanticSimilarity: number;
  dataTypeCompatibility: number;
  businessLogicAlignment: number;
  historicalSuccess: number;
  riskAssessment: 'low' | 'medium' | 'high';
}

export interface MappingSuggestion {
  sourceField: string;
  targetField: string;
  confidence: number;
  reasoning: string[];
  transformation: TransformationRule;
  alternatives: FieldMappingAlternative[];
  qualityMetrics: QualityMetrics;
  origin: 'llm' | 'heuristic';
  providerId?: string;
  // Multi-field mapping support (e.g., firstName + lastName → fullName)
  sourceFields?: string[]; // Array of source field names when multiple fields map to one
  isMultiField?: boolean; // Flag indicating this is a multi-field mapping
}

export interface MappingContext {
  sourceSchema: SystemSchema;
  targetSchema: SystemSchema;
  businessRules: BusinessRule[];
  industryContext?: IndustryContext;
  existingMappings?: ExistingMapping[];
  sampleData?: DataSample[];
  preferredProviderId?: string;
  datasetId?: string;
}
