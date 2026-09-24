/**
 * Data Quality Agent - Advanced anomaly detection and quality assessment
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 *
 * REFACTORED: Orchestrator pattern - delegates to specialized services
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../inversify/types';
import { logger, type Logger } from '../../../../utils/Logger';
import { BaseAgent, type BaseAgentConfig } from '../BaseAgent';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema,
  DataQualityInput,
  DataQualityOutput,
  QualityStandard,
  QualityRule,
  DataAnomaly,
  QualityRecommendation,
  CleansingSuggestion,
  FieldDefinition,
  BusinessRule,
  QualityIssue
} from '../interfaces';
import type {
  QualityProfile,
  QualityBaseline,
  QualityThresholds,
  QualityTrend,
  DataPattern,
  AnomalyDetectionResult,
  AnomalyMethod,
  AnomalyBaseline,
  SeasonalPattern,
  AnomalyRecommendation,
  QualityValidation,
  ValidationRule,
  ValidationResult,
  ValidationSample,
  DataProfiling,
  FieldStatistics,
  ValueDistribution,
  QualityMetrics
} from './types/data-quality';
import { DataProfilingService } from './quality/DataProfilingService';
import { AnomalyDetectionService } from './quality/AnomalyDetectionService';
import { QualityScoringService } from './quality/QualityScoringService';
import { CleansingRecommender } from './quality/CleansingRecommender';

@injectable()
export class DataQualityAgent extends BaseAgent {
  private qualityProfiles = new Map<string, QualityProfile>();
  private validationRules = new Map<string, ValidationRule[]>();
  private anomalyBaselines = new Map<string, AnomalyBaseline>();
  private providerRegistry: unknown;
  private semanticEngine: unknown;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject('ProviderRegistry') providerRegistry: unknown,
    @inject(TYPES.SemanticAnalysisEngine) semanticEngine: unknown,
    @inject(TYPES.DataProfilingService) private profilingService: DataProfilingService,
    @inject(TYPES.AnomalyDetectionService) private anomalyService: AnomalyDetectionService,
    @inject(TYPES.QualityScoringService) private scoringService: QualityScoringService,
    @inject(TYPES.CleansingRecommender) private cleansingRecommender: CleansingRecommender
  ) {
    const config: BaseAgentConfig = {
      name: 'DataQualityAgent',
      version: '1.0.0',
      capabilities: [
        'data_profiling',
        'anomaly_detection',
        'quality_assessment',
        'validation_rules',
        'cleansing_suggestions',
        'trend_analysis'
      ],
      dependencies: [],
      maxExecutionTime: 45000,
      confidenceThreshold: 0.5
    };

    super(config, logger);
    this.providerRegistry = providerRegistry;
    this.semanticEngine = semanticEngine;
    this.initializeQualityFramework();

    this.logger.info('Data Quality Agent initialized with AI integration', {
      hasProviderRegistry: !!this.providerRegistry,
      hasSemanticEngine: !!this.semanticEngine,
      hasProfilingService: !!this.profilingService,
      hasAnomalyService: !!this.anomalyService,
      hasScoringService: !!this.scoringService,
      hasCleansingRecommender: !!this.cleansingRecommender
    });
  }

  protected async executeInternal(
    context: AgentExecutionContext,
    input: DataQualityInput
  ): Promise<AgentResult> {
    try {
      this.logger.info('Data quality agent execution started', {
        sessionId: context.sessionId,
        dataRecords: input.data.length,
        schemaFields: input.schema.length
      });

      // Step 1: Data Profiling (delegated to service)
      const profilingResults = await this.profilingService.profileData(input.data, input.schema);

      // Step 2: Quality Assessment (delegated to service)
      const qualityAssessment = await this.scoringService.calculateQualityScores(
        profilingResults,
        input.qualityStandards
      );

      // Step 3: Anomaly Detection (delegated to service)
      const anomalyResults = await this.anomalyService.detectAnomalies(
        input.data,
        input.schema,
        this.providerRegistry
      );

      // Step 4: Validation Rules Execution (orchestrator-level)
      const validationResults = await this.executeValidationRules(input);

      // Step 5: Generate Recommendations (delegated to service)
      const recommendations = await this.cleansingRecommender.generateQualityRecommendations(
        qualityAssessment,
        anomalyResults,
        validationResults
      );

      // Step 6: Cleansing Suggestions (delegated to service)
      const cleansingSuggestions = await this.cleansingRecommender.generateCleansingSuggestions(
        qualityAssessment,
        anomalyResults
      );

      const output: DataQualityOutput = {
        overallScore: qualityAssessment.overallScore,
        fieldScores: qualityAssessment.fieldScores,
        issues: qualityAssessment.issues,
        anomalies: anomalyResults.anomalies,
        recommendations,
        cleansingSuggestions
      };

      const confidence = this.calculateConfidence([
        { factor: 'data_volume', value: Math.min(input.data.length / 1000, 1), weight: 0.2 },
        { factor: 'quality_score', value: qualityAssessment.overallScore, weight: 0.3 },
        { factor: 'anomaly_confidence', value: anomalyResults.anomalyScore, weight: 0.2 },
        { factor: 'validation_completeness', value: validationResults.length > 0 ? 0.9 : 0.5, weight: 0.3 }
      ]);

      const reasoning = this.mergeReasoning([
        `Analyzed ${input.data.length} records across ${input.schema.length} fields`,
        `Overall data quality score: ${(qualityAssessment.overallScore * 100).toFixed(1)}%`,
        `Detected ${anomalyResults.anomalies.length} anomalies using ${anomalyResults.detectionMethods.length} methods`,
        `Generated ${recommendations.length} recommendations and ${cleansingSuggestions.length} cleansing suggestions`
      ]);

      return this.createSuccessResult(output, confidence, reasoning);

    } catch (error) {
      this.logger.error('Data quality agent execution failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return this.createErrorResult(
        `Data quality analysis failed: ${this.formatError(error)}`,
        ['Check data format and schema definitions', 'Verify data accessibility', 'Review quality standards']
      );
    }
  }

  protected async validateInputInternal(input: DataQualityInput): Promise<boolean> {
    if (!input.data || !Array.isArray(input.data) || input.data.length === 0) {
      return false;
    }

    if (!input.schema || !Array.isArray(input.schema) || input.schema.length === 0) {
      return false;
    }

    // Validate schema definitions
    for (const field of input.schema) {
      if (!field.name || typeof field.name !== 'string') {
        return false;
      }
      if (!field.type || typeof field.type !== 'string') {
        return false;
      }
    }

    return true;
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { type: 'object' },
            minItems: 1
          },
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                required: { type: 'boolean' }
              },
              required: ['name', 'type']
            }
          },
          qualityStandards: {
            type: 'array',
            items: { type: 'object' }
          },
          businessRules: {
            type: 'array',
            items: { type: 'object' }
          }
        },
        required: ['data', 'schema']
      },
      outputSchema: {
        type: 'object',
        properties: {
          overallScore: { type: 'number', minimum: 0, maximum: 1 },
          fieldScores: {
            type: 'object',
            additionalProperties: { type: 'number' }
          },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                severity: { type: 'string' },
                type: { type: 'string' },
                message: { type: 'string' },
                suggestion: { type: 'string' }
              }
            }
          },
          anomalies: {
            type: 'array',
            items: { type: 'object' }
          },
          recommendations: {
            type: 'array',
            items: { type: 'object' }
          },
          cleansingSuggestions: {
            type: 'array',
            items: { type: 'object' }
          }
        },
        required: ['overallScore', 'fieldScores', 'issues', 'anomalies', 'recommendations', 'cleansingSuggestions']
      },
      capabilities: this.capabilities,
      resourceRequirements: {
        maxMemory: 1024,
        maxExecutionTime: 45000
      }
    };
  }

  // ============================================================================
  // Orchestrator-Level Methods (Framework Initialization & Validation Execution)
  // ============================================================================

  private initializeQualityFramework(): void {
    this.initializeDefaultValidationRules();
    this.initializeQualityStandards();

    this.logger.info('Data quality framework initialized', {
      validationRules: this.validationRules.size,
      qualityProfiles: this.qualityProfiles.size
    });
  }

  private initializeDefaultValidationRules(): void {
    this.addValidationRule('email', {
      id: 'email_format',
      name: 'Email Format Validation',
      description: 'Validates email address format',
      type: 'format',
      expression: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
      severity: 'error',
      enabled: true
    });

    this.addValidationRule('phone', {
      id: 'phone_format',
      name: 'Phone Format Validation',
      description: 'Validates phone number format',
      type: 'format',
      expression: '^\\+?[1-9]\\d{1,14}$',
      severity: 'warning',
      enabled: true
    });

    this.addValidationRule('number', {
      id: 'numeric_range',
      name: 'Numeric Range Validation',
      description: 'Validates numeric values are within reasonable range',
      type: 'range',
      expression: 'value >= -999999999 && value <= 999999999',
      severity: 'warning',
      enabled: true
    });

    this.addValidationRule('date', {
      id: 'date_validity',
      name: 'Date Validity Check',
      description: 'Validates date values are valid dates',
      type: 'format',
      expression: 'isValidDate(value)',
      severity: 'error',
      enabled: true
    });

    this.addValidationRule('*', {
      id: 'required_field',
      name: 'Required Field Validation',
      description: 'Validates required fields are not null/empty',
      type: 'business',
      expression: 'value != null && value !== ""',
      severity: 'error',
      enabled: true
    });
  }

  private initializeQualityStandards(): void {
    const defaultThresholds: QualityThresholds = {
      completeness: { warning: 0.9, critical: 0.8 },
      uniqueness: { warning: 0.95, critical: 0.9 },
      validity: { warning: 0.95, critical: 0.9 },
      consistency: { warning: 0.9, critical: 0.8 },
      accuracy: { warning: 0.95, critical: 0.9 }
    };

    const commonFields = ['email', 'phone', 'name', 'address', 'date', 'amount'];
    commonFields.forEach(fieldType => {
      this.createQualityProfile(fieldType, defaultThresholds);
    });
  }

  private addValidationRule(fieldType: string, rule: ValidationRule): void {
    if (!this.validationRules.has(fieldType)) {
      this.validationRules.set(fieldType, []);
    }
    this.validationRules.get(fieldType)!.push(rule);
  }

  private createQualityProfile(fieldName: string, thresholds: QualityThresholds): void {
    const profile: QualityProfile = {
      field: fieldName,
      baseline: {
        completeness: 1.0,
        uniqueness: 1.0,
        validity: 1.0,
        consistency: 1.0,
        accuracy: 1.0,
        timeliness: 1.0,
        sampleSize: 0,
        lastUpdated: new Date()
      },
      thresholds,
      trends: [],
      patterns: []
    };

    this.qualityProfiles.set(fieldName, profile);
  }

  private async executeValidationRules(input: DataQualityInput): Promise<QualityValidation[]> {
    const validationResults: QualityValidation[] = [];

    for (const field of input.schema) {
      const fieldRules = this.getValidationRulesForField(field);
      const results: ValidationResult[] = [];

      for (const rule of fieldRules) {
        if (!rule.enabled) continue;

        const result = await this.executeValidationRule(rule, input.data, field.name);
        results.push(result);
      }

      const overallScore = results.length > 0
        ? results.reduce((sum, r) => sum + (r.passed ? 1 : 0), 0) / results.length
        : 1.0;

      validationResults.push({
        field: field.name,
        validationRules: fieldRules,
        results,
        overallScore
      });
    }

    return validationResults;
  }

  private getValidationRulesForField(field: FieldDefinition): ValidationRule[] {
    const rules: ValidationRule[] = [];

    const typeRules = this.validationRules.get(field.type) || [];
    rules.push(...typeRules);

    const universalRules = this.validationRules.get('*') || [];
    rules.push(...universalRules);

    return rules;
  }

  private async executeValidationRule(
    rule: ValidationRule,
    data: unknown[],
    fieldName: string
  ): Promise<ValidationResult> {
    let violationCount = 0;
    const samples: ValidationSample[] = [];

    data.forEach((record, index) => {
      const value = (record as Record<string, unknown>)[fieldName];
      const passed = this.validateValue(value, rule);

      if (!passed) {
        violationCount++;
        if (samples.length < 10) {
          samples.push({
            value,
            index,
            context: { record: record }
          });
        }
      }
    });

    const violationPercentage = data.length > 0 ? violationCount / data.length : 0;

    return {
      ruleId: rule.id,
      passed: violationCount === 0,
      violationCount,
      violationPercentage,
      samples,
      recommendation: this.generateValidationRecommendation(rule, violationPercentage)
    };
  }

  private validateValue(value: unknown, rule: ValidationRule): boolean {
    try {
      switch (rule.type) {
        case 'format':
          return new RegExp(rule.expression).test(String(value));
        case 'range':
          return this.evaluateRangeExpression(value, rule.expression);
        case 'business':
          return this.evaluateBusinessRule(value, rule.expression);
        default:
          return true;
      }
    } catch {
      return false;
    }
  }

  private evaluateRangeExpression(value: unknown, expression: string): boolean {
    const numValue = Number(value);
    if (isNaN(numValue)) return false;
    return numValue >= -999999999 && numValue <= 999999999;
  }

  private evaluateBusinessRule(value: unknown, expression: string): boolean {
    if (expression.includes('value != null')) {
      return value !== null && value !== undefined;
    }
    if (expression.includes('value !== ""')) {
      return value !== '';
    }
    return true;
  }

  private generateValidationRecommendation(rule: ValidationRule, violationPercentage: number): string {
    if (violationPercentage === 0) {
      return 'All values pass validation';
    } else if (violationPercentage < 0.05) {
      return 'Minor validation issues - review specific cases';
    } else if (violationPercentage < 0.2) {
      return 'Moderate validation issues - implement data cleansing';
    } else {
      return 'Significant validation issues - review data collection process';
    }
  }
}

// Re-export types for backward compatibility
export type {
  QualityProfile,
  QualityBaseline,
  QualityThresholds,
  QualityTrend,
  DataPattern,
  AnomalyDetectionResult,
  AnomalyMethod,
  AnomalyBaseline,
  SeasonalPattern,
  AnomalyRecommendation,
  QualityValidation,
  ValidationRule,
  ValidationResult,
  ValidationSample,
  DataProfiling,
  FieldStatistics,
  ValueDistribution,
  QualityMetrics
};
