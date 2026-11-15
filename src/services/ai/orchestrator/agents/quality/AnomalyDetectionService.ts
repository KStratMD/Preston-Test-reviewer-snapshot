/**
 * Anomaly Detection Service
 * Handles AI-enhanced and heuristic anomaly detection
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { FieldDefinition, DataAnomaly } from '../../interfaces';
import type {
  AnomalyDetectionResult,
  AnomalyMethod,
  AnomalyBaseline,
  AnomalyRecommendation,
  DataProfiling
} from '../types/data-quality';
import { getRecordValue, getRecordValues, normalizeRecords } from '../../../utils/dataRecord';

@injectable()
export class AnomalyDetectionService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {}

  /**
   * Detect anomalies using AI-first approach with heuristic fallback
   */
  async detectAnomalies(
    data: unknown[],
    schema: FieldDefinition[],
    providerRegistry?: unknown
  ): Promise<AnomalyDetectionResult> {
    this.logger.info('Starting anomaly detection', {
      recordCount: data.length,
      fieldCount: schema.length
    });

    // AI-FIRST APPROACH: Try AI-enhanced anomaly detection
    if (providerRegistry) {
      try {
        const aiResult = await this.detectAnomaliesWithAI(data, schema, providerRegistry);
        if (aiResult) {
          this.logger.info('Using AI-enhanced anomaly detection', {
            anomaliesFound: aiResult.anomalies.length,
            methods: aiResult.detectionMethods.length
          });
          return aiResult;
        }
      } catch (error) {
        this.logger.warn('AI anomaly detection unavailable, using heuristic fallback', {
          error: String(error)
        });
      }
    }

    // FALLBACK: Use heuristic methods
    return this.detectAnomaliesHeuristic(data, schema);
  }

  /**
   * Heuristic-based anomaly detection
   */
  private async detectAnomaliesHeuristic(
    data: unknown[],
    schema: FieldDefinition[]
  ): Promise<AnomalyDetectionResult> {
    const anomalies: DataAnomaly[] = [];
    const detectionMethods: AnomalyMethod[] = [];

    // Method 1: Statistical outlier detection
    const statisticalMethod = await this.detectStatisticalOutliers(data, schema);
    detectionMethods.push(statisticalMethod.method);
    anomalies.push(...statisticalMethod.anomalies);

    // Method 2: Pattern-based anomaly detection
    const patternMethod = await this.detectPatternAnomalies(data, schema);
    detectionMethods.push(patternMethod.method);
    anomalies.push(...patternMethod.anomalies);

    // Method 3: Business rule violations
    const businessMethod = await this.detectBusinessRuleViolations(data, schema);
    detectionMethods.push(businessMethod.method);
    anomalies.push(...businessMethod.anomalies);

    // Calculate anomaly score
    const anomalyScore = anomalies.length / Math.max(data.length, 1);

    // Generate baseline
    const baseline: AnomalyBaseline = {
      field: 'overall',
      expectedRange: { min: 0, max: 100 },
      expectedFormats: [],
      expectedFrequency: data.length,
      seasonalPatterns: []
    };

    // Generate recommendations
    const recommendations = this.generateAnomalyRecommendations(anomalies, detectionMethods);

    return {
      anomalies,
      anomalyScore,
      detectionMethods,
      baseline,
      recommendations
    };
  }

  /**
   * AI-Enhanced Anomaly Detection
   */
  async detectAnomaliesWithAI(
    data: unknown[],
    schema: FieldDefinition[],
    providerRegistry: unknown
  ): Promise<AnomalyDetectionResult | null> {
    try {
      // Check if AI provider available
      const providerResult = await (providerRegistry as any).getAvailableProvider();
      if (!providerResult) {
        this.logger.debug('No AI provider available for anomaly detection');
        return null;
      }

      const { provider, id: providerId } = providerResult;

      // Prepare data sample for AI analysis
      const sampleSize = Math.min(data.length, 100);
      const dataSample = data.slice(0, sampleSize);

      // Build AI prompt
      const prompt = this.buildAnomalyDetectionPrompt(dataSample, schema);

      // Call AI provider
      const aiResponse = await provider.complete({
        prompt,
        maxTokens: 1500,
        temperature: 0.3,
        stopSequences: []
      });

      // Parse AI response
      const aiAnomalies = this.parseAIAnomalyResponse(aiResponse.completion, schema);

      // Validate with heuristics
      const heuristicValidation = await this.validateAIAnomaliesWithHeuristics(
        aiAnomalies,
        data,
        schema
      );

      // Generate baseline
      const baseline: AnomalyBaseline = {
        field: 'overall',
        expectedRange: { min: 0, max: 100 },
        expectedFormats: [],
        expectedFrequency: data.length,
        seasonalPatterns: []
      };

      // Calculate anomaly score
      const anomalyScore = heuristicValidation.validatedAnomalies.length / Math.max(data.length, 1);

      // Create AI method metadata
      const aiMethod: AnomalyMethod = {
        name: 'ai_semantic_analysis',
        description: 'AI-powered semantic anomaly detection with contextual understanding',
        anomaliesFound: heuristicValidation.validatedAnomalies.length,
        confidence: 0.85,
        parameters: {
          provider: providerId,
          sampleSize,
          aiConfidence: heuristicValidation.avgConfidence,
          heuristicValidation: true
        }
      };

      const recommendations = this.generateAnomalyRecommendations(
        heuristicValidation.validatedAnomalies,
        [aiMethod, ...heuristicValidation.heuristicMethods]
      );

      return {
        anomalies: heuristicValidation.validatedAnomalies,
        anomalyScore,
        detectionMethods: [aiMethod, ...heuristicValidation.heuristicMethods],
        baseline,
        recommendations
      };

    } catch (error) {
      this.logger.error('AI anomaly detection failed', { error: String(error) });
      return null;
    }
  }

  // ============================================================================
  // Heuristic Detection Methods
  // ============================================================================

  private async detectStatisticalOutliers(
    data: unknown[],
    schema: FieldDefinition[]
  ): Promise<{ method: AnomalyMethod; anomalies: DataAnomaly[] }> {
    const anomalies: DataAnomaly[] = [];
    let totalOutliers = 0;
    const normalizedRecords = normalizeRecords(data);

    for (const field of schema) {
      if (field.type === 'number' || field.type === 'currency') {
        const fieldData = getRecordValues(normalizedRecords, field.name)
          .filter(value => value !== '')
          .map(value => Number(value))
          .filter(num => !isNaN(num));

        if (fieldData.length > 10) {
          const outliers = this.findStatisticalOutliers(fieldData);

          if (outliers.length > 0) {
            anomalies.push({
              field: field.name,
              anomalyType: 'outlier',
              severity: outliers.length > fieldData.length * 0.1 ? 'high' : 'medium',
              description: `${outliers.length} statistical outliers detected`,
              affectedRecords: outliers.length,
              suggestedAction: 'Review outlier values for data entry errors or legitimate exceptions'
            });
            totalOutliers += outliers.length;
          }
        }
      }
    }

    const method: AnomalyMethod = {
      name: 'statistical_outliers',
      description: 'Detects outliers using IQR method',
      anomaliesFound: totalOutliers,
      confidence: 0.8,
      parameters: { method: 'IQR', multiplier: 1.5 }
    };

    return { method, anomalies };
  }

  private async detectPatternAnomalies(
    data: unknown[],
    schema: FieldDefinition[]
  ): Promise<{ method: AnomalyMethod; anomalies: DataAnomaly[] }> {
    const anomalies: DataAnomaly[] = [];
    let totalAnomalies = 0;
    const normalizedRecords = normalizeRecords(data);

    for (const field of schema) {
      const fieldData = getRecordValues(normalizedRecords, field.name);

      const formatAnomalies = this.detectFormatAnomalies(fieldData, field);
      anomalies.push(...formatAnomalies);
      totalAnomalies += formatAnomalies.length;
    }

    const method: AnomalyMethod = {
      name: 'pattern_detection',
      description: 'Detects pattern and format anomalies',
      anomaliesFound: totalAnomalies,
      confidence: 0.7,
      parameters: { patterns: ['format', 'length', 'character_set'] }
    };

    return { method, anomalies };
  }

  private async detectBusinessRuleViolations(
    data: unknown[],
    schema: FieldDefinition[]
  ): Promise<{ method: AnomalyMethod; anomalies: DataAnomaly[] }> {
    const anomalies: DataAnomaly[] = [];
    let totalViolations = 0;
    const normalizedRecords = normalizeRecords(data);

    for (const field of schema) {
      if (field.required) {
        const nullCount = normalizedRecords.reduce((count, record) => {
          const value = getRecordValue(record, field.name);
          return count + ((value === null || value === undefined || value === '') ? 1 : 0);
        }, 0);

        if (nullCount > 0) {
          anomalies.push({
            field: field.name,
            anomalyType: 'missing_expected',
            severity: 'high',
            description: `Required field has ${nullCount} missing values`,
            affectedRecords: nullCount,
            suggestedAction: 'Implement data validation to prevent missing required values'
          });
          totalViolations += nullCount;
        }
      }
    }

    const method: AnomalyMethod = {
      name: 'business_rules',
      description: 'Detects business rule violations',
      anomaliesFound: totalViolations,
      confidence: 0.9,
      parameters: { rules: ['required_fields', 'referential_integrity'] }
    };

    return { method, anomalies };
  }

  // ============================================================================
  // AI Helper Methods
  // ============================================================================

  private buildAnomalyDetectionPrompt(dataSample: unknown[], schema: FieldDefinition[]): string {
    const schemaDescription = schema.map(field =>
      `${field.name} (${field.type})${field.required ? ' [REQUIRED]' : ''}: ${field.description || 'No description'}`
    ).join('\n');

    const sampleDataJson = JSON.stringify(dataSample.slice(0, 10), null, 2);

    return `You are a data quality expert analyzing a dataset for anomalies.

**Schema:**
${schemaDescription}

**Sample Data (first 10 records):**
${sampleDataJson}

**Task:** Analyze the sample data and identify potential anomalies or data quality issues. For each anomaly:
1. Specify the field name
2. Describe the anomaly type (outlier, missing_expected, format_deviation, inconsistent_pattern, business_rule_violation)
3. Assess severity (low, medium, high)
4. Provide a clear description
5. Suggest corrective action

**Format your response as a JSON array:**
[
  {
    "field": "field_name",
    "anomalyType": "type",
    "severity": "low|medium|high",
    "description": "Clear description of the issue",
    "suggestedAction": "Recommended corrective action",
    "confidence": 0.8
  }
]

Respond ONLY with the JSON array. No additional text.`;
  }

  private parseAIAnomalyResponse(aiResponse: string, schema: FieldDefinition[]): DataAnomaly[] {
    try {
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn('AI response does not contain valid JSON array');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter(item => item.field && item.anomalyType)
        .map(item => ({
          field: item.field,
          anomalyType: item.anomalyType,
          severity: item.severity || 'medium',
          description: item.description || 'Anomaly detected by AI',
          affectedRecords: 1,
          suggestedAction: item.suggestedAction || 'Review data quality',
          aiConfidence: item.confidence || 0.7
        }));

    } catch (error) {
      this.logger.error('Failed to parse AI anomaly response', { error: String(error) });
      return [];
    }
  }

  private async validateAIAnomaliesWithHeuristics(
    aiAnomalies: DataAnomaly[],
    data: unknown[],
    schema: FieldDefinition[]
  ): Promise<{
    validatedAnomalies: DataAnomaly[];
    avgConfidence: number;
    heuristicMethods: AnomalyMethod[];
  }> {
    const validatedAnomalies: DataAnomaly[] = [];
    const heuristicMethods: AnomalyMethod[] = [];

    // Run heuristic methods
    const statisticalMethod = await this.detectStatisticalOutliers(data, schema);
    const patternMethod = await this.detectPatternAnomalies(data, schema);
    const businessMethod = await this.detectBusinessRuleViolations(data, schema);

    heuristicMethods.push(statisticalMethod.method, patternMethod.method, businessMethod.method);

    // Combine anomalies
    const allHeuristicAnomalies = [
      ...statisticalMethod.anomalies,
      ...patternMethod.anomalies,
      ...businessMethod.anomalies
    ];

    // Validate AI anomalies
    for (const aiAnomaly of aiAnomalies) {
      const heuristicConfirmation = allHeuristicAnomalies.find(
        ha => ha.field === aiAnomaly.field && ha.anomalyType === aiAnomaly.anomalyType
      );

      if (heuristicConfirmation) {
        validatedAnomalies.push({
          ...aiAnomaly,
          affectedRecords: heuristicConfirmation.affectedRecords,
          confidence: 0.9
        });
      } else {
        validatedAnomalies.push({
          ...aiAnomaly,
          affectedRecords: this.estimateAffectedRecords(aiAnomaly, data),
          confidence: 0.7
        });
      }
    }

    // Add heuristic-only anomalies
    for (const heuristicAnomaly of allHeuristicAnomalies) {
      const alreadyIncluded = validatedAnomalies.some(
        va => va.field === heuristicAnomaly.field && va.anomalyType === heuristicAnomaly.anomalyType
      );

      if (!alreadyIncluded) {
        validatedAnomalies.push({
          ...heuristicAnomaly,
          confidence: 0.75
        });
      }
    }

    const avgConfidence = validatedAnomalies.length > 0
      ? validatedAnomalies.reduce((sum, a) => sum + (a.confidence || 0.7), 0) / validatedAnomalies.length
      : 0.8;

    return {
      validatedAnomalies,
      avgConfidence,
      heuristicMethods
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private findStatisticalOutliers(data: number[]): number[] {
    if (data.length < 4) return [];

    const sorted = [...data].sort((a, b) => a - b);
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);

    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;

    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    return data.filter(value => value < lowerBound || value > upperBound);
  }

  private detectFormatAnomalies(fieldData: unknown[], field: FieldDefinition): DataAnomaly[] {
    const anomalies: DataAnomaly[] = [];
    const formats = new Map<string, number>();

    fieldData.forEach(value => {
      const format = this.extractFormat(String(value));
      formats.set(format, (formats.get(format) || 0) + 1);
    });

    const totalCount = fieldData.length;
    const minorFormats = Array.from(formats.entries())
      .filter(([format, count]) => count / totalCount < 0.1 && count < 5);

    if (minorFormats.length > 0) {
      const affectedRecords = minorFormats.reduce((sum, [, count]) => sum + count, 0);

      anomalies.push({
        field: field.name,
        anomalyType: 'format_deviation',
        severity: affectedRecords > totalCount * 0.05 ? 'medium' : 'low',
        description: `${minorFormats.length} unusual format patterns detected`,
        affectedRecords,
        suggestedAction: 'Review data entry processes and standardize formats'
      });
    }

    return anomalies;
  }

  private estimateAffectedRecords(anomaly: DataAnomaly, data: unknown[]): number {
    try {
      const normalizedRecords = normalizeRecords(data);
      const fieldData = normalizedRecords.map(record => getRecordValue(record, anomaly.field));

      if (anomaly.anomalyType === 'missing_expected') {
        return fieldData.filter(value => value === null || value === undefined || value === '').length;
      } else if (anomaly.anomalyType === 'outlier') {
        const numbers = fieldData
          .filter(v => typeof v === 'number' && !isNaN(v as number)) as number[];
        const outliers = this.findStatisticalOutliers(numbers);
        return outliers.length;
      } else {
        return Math.max(1, Math.floor(normalizedRecords.length * 0.05));
      }
    } catch {
      return 1;
    }
  }

  private generateAnomalyRecommendations(
    anomalies: DataAnomaly[],
    methods: AnomalyMethod[]
  ): AnomalyRecommendation[] {
    const recommendations: AnomalyRecommendation[] = [];

    const highSeverityAnomalies = anomalies.filter(a => a.severity === 'high');
    if (highSeverityAnomalies.length > 0) {
      recommendations.push({
        type: 'investigation',
        priority: 'critical',
        description: 'Investigate high-severity anomalies immediately',
        action: 'Review data sources and collection processes',
        estimatedEffort: 'high'
      });
    }

    const outlierAnomalies = anomalies.filter(a => a.anomalyType === 'outlier');
    if (outlierAnomalies.length > 0) {
      recommendations.push({
        type: 'correction',
        priority: 'medium',
        description: 'Review statistical outliers for data accuracy',
        action: 'Validate outlier values against source systems',
        estimatedEffort: 'medium'
      });
    }

    return recommendations;
  }

  private extractFormat(value: string): string {
    return value
      .replace(/\d/g, 'D')
      .replace(/[a-zA-Z]/g, 'A')
      .replace(/[^DA-]/g, 'S');
  }
}
