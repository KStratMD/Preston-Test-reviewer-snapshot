/**
 * Data Profiling Service
 * Handles comprehensive data profiling and statistical analysis
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { FieldDefinition } from '../../interfaces';
import type {
  DataProfiling,
  FieldStatistics,
  ValueDistribution,
  QualityMetrics,
  DataPattern,
  ValidationRule
} from '../types/data-quality';
import { getRecordValues, normalizeRecords } from '../../../utils/dataRecord';

@injectable()
export class DataProfilingService {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Profile data across all fields
   */
  async profileData(data: unknown[], schema: FieldDefinition[]): Promise<DataProfiling[]> {
    this.logger.info('Starting data profiling', {
      recordCount: data.length,
      fieldCount: schema.length
    });

    const profilingResults: DataProfiling[] = [];

    const normalizedRecords = normalizeRecords(data);

    for (const field of schema) {
      const fieldData = getRecordValues(normalizedRecords, field.name);

      const statistics = this.calculateFieldStatistics(fieldData, field.type);
      const distribution = this.calculateValueDistribution(fieldData);
      const quality = this.calculateQualityMetrics(fieldData, field);
      const patterns = this.identifyDataPatterns(fieldData, field.type);

      profilingResults.push({
        field: field.name,
        dataType: field.type,
        statistics,
        distribution,
        quality,
        patterns
      });
    }

    this.logger.info('Data profiling completed', {
      fieldsProfiled: profilingResults.length
    });

    return profilingResults;
  }

  /**
   * Calculate statistical metrics for a field
   */
  private calculateFieldStatistics(fieldData: unknown[], dataType: string): FieldStatistics {
    const count = fieldData.length;
    const nullCount = fieldData.filter(value => value === null || value === undefined).length;
    const nonNullData = fieldData.filter(value => value !== null && value !== undefined);

    const statistics: FieldStatistics = {
      count,
      nullCount,
      uniqueCount: new Set(nonNullData).size,
      distinctCount: new Set(nonNullData).size
    };

    if (dataType === 'string' || dataType === 'text') {
      const lengths = nonNullData.map(value => String(value).length);
      statistics.minLength = Math.min(...lengths);
      statistics.maxLength = Math.max(...lengths);
      statistics.avgLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
    }

    if (dataType === 'number' || dataType === 'currency') {
      const numbers = nonNullData.map(value => Number(value)).filter(num => !isNaN(num));
      if (numbers.length > 0) {
        statistics.min = Math.min(...numbers);
        statistics.max = Math.max(...numbers);
        statistics.mean = numbers.reduce((sum, num) => sum + num, 0) / numbers.length;
        statistics.median = this.calculateMedian(numbers);
        statistics.stdDev = this.calculateStandardDeviation(numbers, statistics.mean!);
      }
    }

    return statistics;
  }

  /**
   * Analyze value distribution
   */
  private calculateValueDistribution(fieldData: unknown[]): ValueDistribution {
    const nonNullData = fieldData.filter(value => value !== null && value !== undefined);
    const valueCounts = new Map<string, number>();

    nonNullData.forEach(value => {
      const stringValue = String(value);
      valueCounts.set(stringValue, (valueCounts.get(stringValue) || 0) + 1);
    });

    const topValues = Array.from(valueCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({
        value,
        count,
        percentage: count / nonNullData.length
      }));

    const uniqueValues = valueCounts.size;

    return {
      topValues,
      nullPercentage: (fieldData.length - nonNullData.length) / fieldData.length,
      uniquenessRatio: uniqueValues / Math.max(nonNullData.length, 1),
      entropyScore: this.calculateEntropy(Array.from(valueCounts.values()), nonNullData.length)
    };
  }

  /**
   * Calculate quality metrics for field
   */
  calculateQualityMetrics(
    fieldData: unknown[],
    field: FieldDefinition,
    validationRules?: ValidationRule[]
  ): QualityMetrics {
    const totalCount = fieldData.length;
    const nonNullData = fieldData.filter(value => value !== null && value !== undefined);

    // Completeness: percentage of non-null values
    const completeness = nonNullData.length / totalCount;

    // Uniqueness: ratio of unique values (for fields that should be unique)
    const uniqueValues = new Set(nonNullData).size;
    const uniqueness = field.name.toLowerCase().includes('id')
      ? uniqueValues / Math.max(nonNullData.length, 1)
      : 1.0; // Not applicable for most fields

    // Validity: percentage of values that match expected format
    const validity = this.calculateFieldValidity(nonNullData, field, validationRules);

    // Consistency: measure of format consistency
    const consistency = this.calculateFieldConsistency(nonNullData, field.type);

    // Accuracy: placeholder (would require external validation)
    const accuracy = 0.95; // Default assumption

    // Conformity: adherence to business rules
    const conformity = this.calculateFieldConformity(nonNullData, field);

    const overallScore = (completeness + uniqueness + validity + consistency + accuracy + conformity) / 6;

    return {
      completeness,
      uniqueness,
      validity,
      consistency,
      accuracy,
      conformity,
      overallScore
    };
  }

  /**
   * Identify data patterns
   */
  private identifyDataPatterns(fieldData: unknown[], dataType: string): DataPattern[] {
    const patterns: DataPattern[] = [];
    const nonNullData = fieldData.filter(value => value !== null && value !== undefined);

    if (dataType === 'string' || dataType === 'text') {
      // Format patterns
      const formatPattern = this.identifyFormatPattern(nonNullData);
      if (formatPattern) {
        patterns.push(formatPattern);
      }

      // Length patterns
      const lengthPattern = this.identifyLengthPattern(nonNullData);
      if (lengthPattern) {
        patterns.push(lengthPattern);
      }
    }

    if (dataType === 'number' || dataType === 'currency') {
      // Range patterns
      const rangePattern = this.identifyRangePattern(nonNullData);
      if (rangePattern) {
        patterns.push(rangePattern);
      }
    }

    return patterns;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private calculateMedian(numbers: number[]): number {
    const sorted = numbers.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private calculateStandardDeviation(numbers: number[], mean: number): number {
    const squaredDiffs = numbers.map(num => Math.pow(num - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / numbers.length;
    return Math.sqrt(avgSquaredDiff);
  }

  private calculateEntropy(frequencies: number[], total: number): number {
    return frequencies.reduce((entropy, freq) => {
      const probability = freq / total;
      return entropy - (probability * Math.log2(probability));
    }, 0);
  }

  private calculateFieldValidity(
    fieldData: unknown[],
    field: FieldDefinition,
    rules?: ValidationRule[]
  ): number {
    if (!rules || rules.length === 0) return 1.0;

    let validCount = 0;
    fieldData.forEach(value => {
      const isValid = rules.every(rule => this.validateValue(value, rule));
      if (isValid) validCount++;
    });

    return fieldData.length > 0 ? validCount / fieldData.length : 1.0;
  }

  private calculateFieldConsistency(fieldData: unknown[], fieldType: string): number {
    if (fieldData.length <= 1) return 1.0;

    // For strings, check format consistency
    if (fieldType === 'string' || fieldType === 'text') {
      const formats = new Set();
      fieldData.forEach(value => {
        const format = this.extractFormat(String(value));
        formats.add(format);
      });

      // More consistent if fewer format variations
      return Math.max(0, 1 - (formats.size - 1) / fieldData.length);
    }

    return 1.0; // Default for other types
  }

  private calculateFieldConformity(fieldData: unknown[], field: FieldDefinition): number {
    // Placeholder for business rule conformity
    return 0.95; // Default assumption
  }

  private identifyFormatPattern(fieldData: unknown[]): DataPattern | null {
    const formats = new Map<string, number>();

    fieldData.forEach(value => {
      const format = this.extractFormat(String(value));
      formats.set(format, (formats.get(format) || 0) + 1);
    });

    const dominantFormat = Array.from(formats.entries())
      .sort((a, b) => b[1] - a[1])[0];

    if (dominantFormat && dominantFormat[1] / fieldData.length > 0.8) {
      return {
        type: 'format',
        description: `Dominant format pattern: ${dominantFormat[0]}`,
        confidence: dominantFormat[1] / fieldData.length,
        examples: fieldData.slice(0, 3).map(String),
        frequency: dominantFormat[1]
      };
    }

    return null;
  }

  private identifyLengthPattern(fieldData: unknown[]): DataPattern | null {
    const lengths = fieldData.map(value => String(value).length);
    const avgLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
    const consistentLength = lengths.filter(len => Math.abs(len - avgLength) <= 2).length;

    if (consistentLength / fieldData.length > 0.8) {
      return {
        type: 'format',
        description: `Consistent length pattern around ${Math.round(avgLength)} characters`,
        confidence: consistentLength / fieldData.length,
        examples: fieldData.slice(0, 3).map(String),
        frequency: consistentLength
      };
    }

    return null;
  }

  private identifyRangePattern(fieldData: unknown[]): DataPattern | null {
    const numbers = fieldData.map(value => Number(value)).filter(num => !isNaN(num));
    if (numbers.length === 0) return null;

    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const range = max - min;

    // Check if values are clustered in a specific range
    const midpoint = (min + max) / 2;
    const clustered = numbers.filter(num => Math.abs(num - midpoint) <= range * 0.3).length;

    if (clustered / numbers.length > 0.8) {
      return {
        type: 'range',
        description: `Values clustered in range ${min.toFixed(2)} - ${max.toFixed(2)}`,
        confidence: clustered / numbers.length,
        examples: numbers.slice(0, 3).map(String),
        frequency: clustered
      };
    }

    return null;
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

  private extractFormat(value: string): string {
    return value
      .replace(/\d/g, 'D')
      .replace(/[a-zA-Z]/g, 'A')
      .replace(/[^DA-]/g, 'S');
  }
}
