/**
 * Quality Scoring Service
 * Handles quality assessment and scoring
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { FieldDefinition, QualityStandard, QualityIssue } from '../../interfaces';
import type { DataProfiling, QualityValidation } from '../types/data-quality';
import { getRecordValue, getRecordValues, normalizeRecords } from '../../../utils/dataRecord';

export interface QualityAssessmentResult {
  overallScore: number;
  fieldScores: Record<string, number>;
  issues: QualityIssue[];
}

@injectable()
export class QualityScoringService {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Calculate comprehensive quality scores
   */
  async calculateQualityScores(
    profilingResults: DataProfiling[],
    standards?: QualityStandard[]
  ): Promise<QualityAssessmentResult> {
    this.logger.info('Calculating quality scores', {
      fieldCount: profilingResults.length,
      standardsCount: standards?.length || 0
    });

    const fieldScores: Record<string, number> = {};
    const issues: QualityIssue[] = [];

    let totalScore = 0;
    let fieldCount = 0;

    for (const profiling of profilingResults) {
      const score = profiling.quality.overallScore;
      fieldScores[profiling.field] = score;
      totalScore += score;
      fieldCount++;

      // Assess completeness
      if (profiling.quality.completeness < 0.9) {
        issues.push({
          field: profiling.field,
          severity: profiling.quality.completeness < 0.8 ? 'high' : 'medium',
          type: 'completeness',
          message: `Field has ${((1 - profiling.quality.completeness) * 100).toFixed(1)}% missing values`,
          suggestion: 'Review data collection process or implement default values'
        });
      }

      // Assess validity
      if (profiling.quality.validity < 0.9) {
        issues.push({
          field: profiling.field,
          severity: profiling.quality.validity < 0.8 ? 'high' : 'medium',
          type: 'validity',
          message: `Field has ${((1 - profiling.quality.validity) * 100).toFixed(1)}% invalid values`,
          suggestion: 'Implement data validation rules and cleansing procedures'
        });
      }

      // Assess consistency
      if (profiling.quality.consistency < 0.8) {
        issues.push({
          field: profiling.field,
          severity: 'medium',
          type: 'consistency',
          message: 'Field shows inconsistent formatting patterns',
          suggestion: 'Standardize data entry formats and validation rules'
        });
      }
    }

    const overallScore = fieldCount > 0 ? totalScore / fieldCount : 0;

    this.logger.info('Quality scoring completed', {
      overallScore: (overallScore * 100).toFixed(1) + '%',
      issuesFound: issues.length
    });

    return { overallScore, fieldScores, issues };
  }

  /**
   * Assess data completeness
   */
  assessDataCompleteness(data: unknown[], schema: FieldDefinition[]): number {
    let totalCompleteness = 0;
    const normalizedRecords = normalizeRecords(data);
    const totalRecords = normalizedRecords.length;

    for (const field of schema) {
      const fieldValues = normalizedRecords.map(record => getRecordValue(record, field.name));
      const nonNullCount = fieldValues.filter(value => value !== null && value !== undefined && value !== '').length;
      const completeness = totalRecords > 0 ? nonNullCount / totalRecords : 0;
      totalCompleteness += completeness;
    }

    return schema.length > 0 ? totalCompleteness / schema.length : 0;
  }

  /**
   * Assess data uniqueness
   */
  assessDataUniqueness(data: unknown[], schema: FieldDefinition[]): number {
    let totalUniqueness = 0;
    let applicableFields = 0;
    const normalizedRecords = normalizeRecords(data);

    for (const field of schema) {
      // Only assess uniqueness for ID fields
      if (field.name.toLowerCase().includes('id')) {
        const fieldData = normalizedRecords
          .map(record => getRecordValue(record, field.name))
          .filter(value => value !== null && value !== undefined && value !== '');
        const uniqueValues = new Set(fieldData).size;
        const uniqueness = uniqueValues / Math.max(fieldData.length, 1);
        totalUniqueness += uniqueness;
        applicableFields++;
      }
    }

    return applicableFields > 0 ? totalUniqueness / applicableFields : 1.0;
  }

  /**
   * Assess data validity
   */
  assessDataValidity(validationResults: QualityValidation[]): number {
    let totalValidity = 0;

    for (const validation of validationResults) {
      totalValidity += validation.overallScore;
    }

    return validationResults.length > 0 ? totalValidity / validationResults.length : 1.0;
  }

  /**
   * Assess data consistency
   */
  assessDataConsistency(profilingResults: DataProfiling[]): number {
    let totalConsistency = 0;

    for (const profiling of profilingResults) {
      totalConsistency += profiling.quality.consistency;
    }

    return profilingResults.length > 0 ? totalConsistency / profilingResults.length : 1.0;
  }

  /**
   * Assess data accuracy (placeholder)
   */
  assessDataAccuracy(data: unknown[], standards?: QualityStandard[]): number {
    // Placeholder - would require external validation
    return 0.95;
  }

  /**
   * Assess data timeliness
   */
  assessDataTimeliness(data: unknown[], schema: FieldDefinition[]): number {
    // Check for date fields and assess freshness
    const dateFields = schema.filter(field =>
      field.type === 'date' || field.type === 'datetime' || field.name.toLowerCase().includes('date')
    );

    if (dateFields.length === 0) {
      return 1.0; // Not applicable
    }

    let totalTimeliness = 0;
    let assessedFields = 0;
    const normalizedRecords = normalizeRecords(data);

    for (const field of dateFields) {
      const fieldData = getRecordValues(normalizedRecords, field.name);

      if (fieldData.length > 0) {
        // Check if dates are recent (within last year)
        const now = new Date();
        const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

        const recentCount = fieldData.filter(value => {
          try {
            const date = new Date(value as string);
            return date >= oneYearAgo;
          } catch {
            return false;
          }
        }).length;

        totalTimeliness += recentCount / fieldData.length;
        assessedFields++;
      }
    }

    return assessedFields > 0 ? totalTimeliness / assessedFields : 1.0;
  }
}
