/**
 * Data Quality Agent Type Definitions
 * Extracted from DataQualityAgent.ts for better organization
 */

import type { FieldDefinition, DataAnomaly, QualityRecommendation } from '../../../interfaces';

// ============================================================================
// Quality Profile Types
// ============================================================================

export interface QualityProfile {
  field: string;
  baseline: QualityBaseline;
  thresholds: QualityThresholds;
  trends: QualityTrend[];
  patterns: DataPattern[];
}

export interface QualityBaseline {
  completeness: number;
  uniqueness: number;
  validity: number;
  consistency: number;
  accuracy: number;
  timeliness: number;
  sampleSize: number;
  lastUpdated: Date;
}

export interface QualityThresholds {
  completeness: { warning: number; critical: number };
  uniqueness: { warning: number; critical: number };
  validity: { warning: number; critical: number };
  consistency: { warning: number; critical: number };
  accuracy: { warning: number; critical: number };
}

export interface QualityTrend {
  date: Date;
  metric: string;
  value: number;
  trend: 'improving' | 'stable' | 'declining';
}

export interface DataPattern {
  type: 'format' | 'range' | 'frequency' | 'correlation' | 'seasonal';
  description: string;
  confidence: number;
  examples: string[];
  frequency: number;
}

// ============================================================================
// Anomaly Detection Types
// ============================================================================

export interface AnomalyDetectionResult {
  anomalies: DataAnomaly[];
  anomalyScore: number;
  detectionMethods: AnomalyMethod[];
  baseline: AnomalyBaseline;
  recommendations: AnomalyRecommendation[];
}

export interface AnomalyMethod {
  name: string;
  description: string;
  anomaliesFound: number;
  confidence: number;
  parameters: Record<string, unknown>;
}

export interface AnomalyBaseline {
  field: string;
  expectedRange: { min: number; max: number };
  expectedFormats: string[];
  expectedFrequency: number;
  seasonalPatterns: SeasonalPattern[];
}

export interface SeasonalPattern {
  pattern: 'daily' | 'weekly' | 'monthly' | 'yearly';
  strength: number;
  description: string;
}

export interface AnomalyRecommendation {
  type: 'investigation' | 'correction' | 'monitoring' | 'prevention';
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  action: string;
  estimatedEffort: 'low' | 'medium' | 'high';
}

// ============================================================================
// Validation Types
// ============================================================================

export interface QualityValidation {
  field: string;
  validationRules: ValidationRule[];
  results: ValidationResult[];
  overallScore: number;
}

export interface ValidationRule {
  id: string;
  name: string;
  description: string;
  type: 'format' | 'range' | 'business' | 'referential' | 'custom';
  expression: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  enabled: boolean;
}

export interface ValidationResult {
  ruleId: string;
  passed: boolean;
  violationCount: number;
  violationPercentage: number;
  samples: ValidationSample[];
  recommendation: string;
}

export interface ValidationSample {
  value: unknown;
  index: number;
  context?: Record<string, unknown>;
}

// ============================================================================
// Data Profiling Types
// ============================================================================

export interface DataProfiling {
  field: string;
  dataType: string;
  statistics: FieldStatistics;
  distribution: ValueDistribution;
  quality: QualityMetrics;
  patterns: DataPattern[];
}

export interface FieldStatistics {
  count: number;
  nullCount: number;
  uniqueCount: number;
  distinctCount: number;
  minLength?: number;
  maxLength?: number;
  avgLength?: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  stdDev?: number;
}

export interface ValueDistribution {
  topValues: { value: unknown; count: number; percentage: number }[];
  nullPercentage: number;
  uniquenessRatio: number;
  entropyScore: number;
}

export interface QualityMetrics {
  completeness: number;
  uniqueness: number;
  validity: number;
  consistency: number;
  accuracy: number;
  conformity: number;
  overallScore: number;
}
