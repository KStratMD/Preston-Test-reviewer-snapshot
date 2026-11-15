import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { FieldDefinition } from './AIFieldMappingService';
import { DataRecord } from '../../types';

export interface DataPattern {
  type: 'email' | 'phone' | 'url' | 'date' | 'currency' | 'boolean' | 'number' | 'string' | 'enum' | 'json' | 'xml' | 'custom';
  confidence: number;
  examples: unknown[];
  statistics: PatternStatistics;
  validation?: ValidationRule;
}

export interface PatternStatistics {
  totalSamples: number;
  matchingPatterns: number;
  uniqueValues: number;
  nullValues: number;
  averageLength?: number;
  minLength?: number;
  maxLength?: number;
  commonValues?: { value: unknown; count: number; percentage: number }[];
}

export interface ValidationRule {
  regex?: string;
  minLength?: number;
  maxLength?: number;
  allowedValues?: unknown[];
  numericRange?: { min: number; max: number };
  dateRange?: { min: Date; max: Date };
}

export interface PatternMatch {
  targetField: string;
  confidence: number;
  explanation: string;
  transformationSuggested?: string;
  validationRequired?: boolean;
}

/**
 * Pattern Recognition Engine that analyzes data patterns to understand
 * field relationships and suggest appropriate transformations.
 */
@injectable()
export class PatternRecognizer {
  private logger: Logger;

  // Regular expressions for common patterns
  private readonly patterns = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    phone: {
      us: /^[\+]?1?[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}$/,
      international: /^\+?[1-9]\d{1,14}$/,
      simple: /^[\d\s\-\(\)\+\.]{7,20}$/,
    },
    url: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
    currency: {
      usd: /^\$?[\d,]+\.?\d{0,2}$/,
      general: /^[\$€£¥]?[\d,]+\.?\d{0,2}$/,
      numeric: /^\d+\.?\d{0,2}$/,
    },
    date: {
      iso: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/,
      us: /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
      european: /^\d{1,2}\.\d{1,2}\.\d{2,4}$/,
      timestamp: /^\d{10,13}$/,
    },
    boolean: /^(true|false|yes|no|y|n|1|0)$/i,
    json: /^\{.*\}$|^\[.*\]$/,
    xml: /^<.*>.*<\/.*>$/,
    guid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ipAddress: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    creditCard: /^\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}$/,
    ssn: /^\d{3}-?\d{2}-?\d{4}$/,
    zipCode: {
      us: /^\d{5}(-\d{4})?$/,
      canada: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i,
    },
  };

  // NetSuite-specific patterns
  private readonly netsuitePatterns = {
    internalId: /^\d+$/,
    customFieldId: /^custentity_\w+|custbody_\w+|custitem_\w+$/,
    externalId: /^[A-Za-z0-9_-]+$/,
    recordRef: /^\d+\|\w+$/,
  };

  constructor(
    @inject(TYPES.Logger) logger: Logger,
  ) {
    this.logger = logger;
  }

  /**
   * Analyze data patterns in sample values
   */
  async analyzeDataPattern(
    fieldName: string,
    sampleValues: unknown[],
    fieldDefinition?: FieldDefinition,
  ): Promise<DataPattern> {
    this.logger.debug('Analyzing data pattern', {
      fieldName,
      sampleCount: sampleValues.length,
      hasDefinition: !!fieldDefinition,
    });

    // Filter out null/undefined values for pattern analysis
    const validValues = sampleValues.filter(value => value != null && value !== '');
    const statistics = this.calculateStatistics(validValues, sampleValues.length);

    // Try to identify the pattern
    const patterns = await this.identifyPatterns(validValues, fieldName);
    const bestPattern = patterns.reduce((best, current) =>
      current.confidence > best.confidence ? current : best,
    );

    // Generate validation rules if applicable
    const validation = this.generateValidationRules(bestPattern, statistics, validValues);

    const result: DataPattern = {
      type: bestPattern.type,
      confidence: bestPattern.confidence,
      examples: validValues.slice(0, 5),
      statistics,
      validation,
    };

    this.logger.debug('Pattern analysis complete', {
      fieldName,
      detectedPattern: result.type,
      confidence: result.confidence,
    });

    return result;
  }

  /**
   * Find pattern matches between source data and target fields
   */
  async findPatternMatches(
    sourcePattern: DataPattern,
    targetFields: FieldDefinition[],
    context?: { recordType?: string; sourceSystem?: string },
  ): Promise<PatternMatch[]> {
    const matches: PatternMatch[] = [];

    for (const targetField of targetFields) {
      const match = this.evaluatePatternMatch(sourcePattern, targetField, context);
      if (match.confidence > 0.3) {
        matches.push(match);
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Suggest data transformations based on pattern analysis
   */
  suggestTransformations(
    sourcePattern: DataPattern,
    targetPattern: DataPattern,
  ): {
    transformationType: string;
    transformationRule: string;
    confidence: number;
    explanation: string;
  } {
    // Direct mapping - same patterns
    if (sourcePattern.type === targetPattern.type && sourcePattern.confidence > 0.8) {
      return {
        transformationType: 'direct',
        transformationRule: 'direct_copy',
        confidence: 0.95,
        explanation: 'Patterns match exactly, direct mapping recommended',
      };
    }

    // Format conversion
    if (this.canConvertFormats(sourcePattern.type, targetPattern.type)) {
      const transformation = this.getFormatConversion(sourcePattern.type, targetPattern.type);
      return {
        transformationType: 'calculation',
        transformationRule: transformation.rule,
        confidence: transformation.confidence,
        explanation: transformation.explanation,
      };
    }

    // String operations
    if (sourcePattern.type === 'string' && targetPattern.type === 'string') {
      return this.suggestStringTransformation(sourcePattern, targetPattern);
    }

    // Fallback
    return {
      transformationType: 'calculation',
      transformationRule: 'toString()',
      confidence: 0.4,
      explanation: 'Generic string conversion recommended',
    };
  }

  /**
   * Identify patterns in the data values
   */
  private async identifyPatterns(values: unknown[], fieldName: string): Promise<{ type: DataPattern['type']; confidence: number }[]> {
    const patterns: { type: DataPattern['type']; confidence: number }[] = [];

    if (values.length === 0) {
      return [{ type: 'string', confidence: 0.1 }];
    }

    // Convert all values to strings for pattern matching
    const stringValues = values.map(v => String(v).trim());

    // Test email pattern
    const emailMatches = stringValues.filter(v => this.patterns.email.test(v)).length;
    if (emailMatches > 0) {
      patterns.push({ type: 'email', confidence: emailMatches / values.length });
    }

    // Test phone patterns
    const phoneMatches = stringValues.filter(v =>
      this.patterns.phone.us.test(v) ||
      this.patterns.phone.international.test(v) ||
      this.patterns.phone.simple.test(v),
    ).length;
    if (phoneMatches > 0) {
      patterns.push({ type: 'phone', confidence: phoneMatches / values.length });
    }

    // Test URL pattern
    const urlMatches = stringValues.filter(v => this.patterns.url.test(v)).length;
    if (urlMatches > 0) {
      patterns.push({ type: 'url', confidence: urlMatches / values.length });
    }

    // Test currency patterns
    const currencyMatches = stringValues.filter(v =>
      this.patterns.currency.usd.test(v) ||
      this.patterns.currency.general.test(v) ||
      this.patterns.currency.numeric.test(v),
    ).length;
    if (currencyMatches > 0) {
      patterns.push({ type: 'currency', confidence: currencyMatches / values.length });
    }

    // Test date patterns
    const dateMatches = stringValues.filter(v => {
      const date = new Date(v);
      return !isNaN(date.getTime()) ||
             this.patterns.date.iso.test(v) ||
             this.patterns.date.us.test(v) ||
             this.patterns.date.european.test(v) ||
             this.patterns.date.timestamp.test(v);
    }).length;
    if (dateMatches > 0) {
      patterns.push({ type: 'date', confidence: dateMatches / values.length });
    }

    // Test boolean pattern
    const booleanMatches = stringValues.filter(v => this.patterns.boolean.test(v)).length;
    if (booleanMatches > 0) {
      patterns.push({ type: 'boolean', confidence: booleanMatches / values.length });
    }

    // Test numeric pattern
    const numericMatches = values.filter(v => typeof v === 'number' || !isNaN(Number(v))).length;
    if (numericMatches > 0) {
      patterns.push({ type: 'number', confidence: numericMatches / values.length });
    }

    // Test JSON pattern
    const jsonMatches = stringValues.filter(v => {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (jsonMatches > 0) {
      patterns.push({ type: 'json', confidence: jsonMatches / values.length });
    }

    // Test enum pattern (limited unique values)
    const uniqueValues = new Set(stringValues).size;
    const enumThreshold = Math.min(10, Math.max(2, Math.floor(values.length * 0.3)));
    if (uniqueValues <= enumThreshold && values.length > 5) {
      patterns.push({ type: 'enum', confidence: 1 - (uniqueValues / values.length) });
    }

    // Default to string if no specific pattern found
    if (patterns.length === 0) {
      patterns.push({ type: 'string', confidence: 0.8 });
    }

    return patterns;
  }

  /**
   * Calculate statistics for the data values
   */
  private calculateStatistics(validValues: unknown[], totalSamples: number): PatternStatistics {
    const stringValues = validValues.map(v => String(v));
    const uniqueValues = new Set(stringValues).size;
    const nullValues = totalSamples - validValues.length;

    const lengths = stringValues.map(v => v.length);
    const averageLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);

    // Calculate common values
    const valueCounts = new Map<string, number>();
    stringValues.forEach(value => {
      valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
    });

    const commonValues = Array.from(valueCounts.entries())
      .map(([value, count]) => ({
        value,
        count,
        percentage: (count / validValues.length) * 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalSamples,
      matchingPatterns: validValues.length,
      uniqueValues,
      nullValues,
      averageLength: isNaN(averageLength) ? undefined : Math.round(averageLength * 100) / 100,
      minLength: isNaN(minLength) ? undefined : minLength,
      maxLength: isNaN(maxLength) ? undefined : maxLength,
      commonValues,
    };
  }

  /**
   * Evaluate pattern match between source and target
   */
  private evaluatePatternMatch(
    sourcePattern: DataPattern,
    targetField: FieldDefinition,
    context?: { recordType?: string; sourceSystem?: string },
  ): PatternMatch {
    let confidence = 0;
    let explanation = '';
    let transformationSuggested = '';
    let validationRequired = false;

    // Direct type matching
    if (sourcePattern.type === targetField.type) {
      confidence = 0.9;
      explanation = `Pattern type matches field type: ${sourcePattern.type}`;
    }
    // Compatible type matching
    else if (this.areTypesCompatible(sourcePattern.type, targetField.type)) {
      confidence = 0.7;
      explanation = `Compatible types: ${sourcePattern.type} -> ${targetField.type}`;
      transformationSuggested = this.getTypeConversion(sourcePattern.type, targetField.type);
    }
    // Pattern-specific field name matching
    else if (this.matchesFieldNamePattern(sourcePattern.type, targetField.name)) {
      confidence = 0.8;
      explanation = `Field name suggests ${sourcePattern.type} pattern`;
    }

    // Length compatibility
    if (targetField.maxLength && sourcePattern.statistics.maxLength) {
      if (sourcePattern.statistics.maxLength > targetField.maxLength) {
        confidence *= 0.7;
        explanation += '; Length may exceed target field limit';
        validationRequired = true;
      }
    }

    // NetSuite-specific adjustments
    if (context?.recordType) {
      const netsuiteAdjustment = this.getNetSuiteSpecificAdjustment(
        sourcePattern,
        targetField,
        context.recordType,
      );
      confidence *= netsuiteAdjustment.factor;
      if (netsuiteAdjustment.explanation) {
        explanation += `; ${netsuiteAdjustment.explanation}`;
      }
    }

    return {
      targetField: targetField.name,
      confidence: Math.max(0, Math.min(1, confidence)),
      explanation,
      transformationSuggested: transformationSuggested || undefined,
      validationRequired,
    };
  }

  /**
   * Generate validation rules based on pattern analysis
   */
  private generateValidationRules(
    pattern: { type: DataPattern['type']; confidence: number },
    statistics: PatternStatistics,
    values: unknown[],
  ): ValidationRule | undefined {
    if (pattern.confidence < 0.7) return undefined;

    const rule: ValidationRule = {};

    switch (pattern.type) {
    case 'email':
      rule.regex = this.patterns.email.source;
      rule.maxLength = 254; // Standard email max length
      break;

    case 'phone':
      rule.regex = this.patterns.phone.simple.source;
      rule.minLength = 7;
      rule.maxLength = 20;
      break;

    case 'currency':
      if (statistics.minLength && statistics.maxLength) {
        rule.minLength = statistics.minLength;
        rule.maxLength = statistics.maxLength;
      }
      break;

    case 'enum':
      rule.allowedValues = Array.from(new Set(values.map(v => String(v))));
      break;

    case 'number':
      const numericValues = values.filter(v => !isNaN(Number(v))).map(v => Number(v));
      if (numericValues.length > 0) {
        rule.numericRange = {
          min: Math.min(...numericValues),
          max: Math.max(...numericValues),
        };
      }
      break;

    case 'date':
      const dateValues = values
        .map(v => new Date(v as any))
        .filter(d => !isNaN(d.getTime()));
      if (dateValues.length > 0) {
        rule.dateRange = {
          min: new Date(Math.min(...dateValues.map(d => d.getTime()))),
          max: new Date(Math.max(...dateValues.map(d => d.getTime()))),
        };
      }
      break;
    }

    return Object.keys(rule).length > 0 ? rule : undefined;
  }

  /**
   * Check if field name matches pattern type
   */
  private matchesFieldNamePattern(patternType: DataPattern['type'], fieldName: string): boolean {
    const name = fieldName.toLowerCase();

    const fieldPatterns: Record<string, string[]> = {
      email: ['email', 'mail', '@'],
      phone: ['phone', 'tel', 'mobile', 'cell'],
      currency: ['amount', 'price', 'cost', 'fee', 'total', '$'],
      date: ['date', 'time', 'created', 'updated', 'modified'],
      url: ['url', 'link', 'website', 'site'],
      boolean: ['flag', 'is', 'has', 'enabled', 'active'],
    };

    const patterns = fieldPatterns[patternType];
    return patterns ? patterns.some((pattern: string) => name.includes(pattern)) : false;
  }

  /**
   * Check if types are compatible for transformation
   */
  private areTypesCompatible(sourceType: DataPattern['type'], targetType: string): boolean {
    const compatibilityMatrix: Record<string, string[]> = {
      'string': ['email', 'phone', 'currency', 'date'],
      'number': ['currency', 'string'],
      'email': ['string'],
      'phone': ['string'],
      'currency': ['number', 'string'],
      'date': ['string'],
      'boolean': ['string', 'number'],
      'enum': ['string'],
    };

    return compatibilityMatrix[sourceType]?.includes(targetType) || false;
  }

  /**
   * Get type conversion suggestion
   */
  private getTypeConversion(sourceType: DataPattern['type'], targetType: string): string {
    const conversions: Record<string, Record<string, string>> = {
      'string': {
        'email': 'validateEmail',
        'phone': 'normalizePhone',
        'currency': 'parseCurrency',
        'date': 'parseDate',
      },
      'number': {
        'currency': 'formatCurrency',
        'string': 'toString',
      },
      'currency': {
        'number': 'parseFloat',
        'string': 'formatCurrency',
      },
      'date': {
        'string': 'formatDate',
      },
      'boolean': {
        'string': 'toString',
        'number': 'toNumber',
      },
    };

    return conversions[sourceType]?.[targetType] || 'convert';
  }

  /**
   * Check if formats can be converted
   */
  private canConvertFormats(sourceType: DataPattern['type'], targetType: DataPattern['type']): boolean {
    const convertiblePairs = [
      ['string', 'email'], ['string', 'phone'], ['string', 'currency'],
      ['number', 'currency'], ['number', 'string'],
      ['date', 'string'], ['boolean', 'string'],
    ];

    return convertiblePairs.some(([from, to]) =>
      (sourceType === from && targetType === to) ||
      (sourceType === to && targetType === from),
    );
  }

  /**
   * Get format conversion details
   */
  private getFormatConversion(sourceType: DataPattern['type'], targetType: DataPattern['type']): {
    rule: string;
    confidence: number;
    explanation: string;
  } {
    const conversions = {
      'string_to_email': {
        rule: 'validateAndNormalizeEmail(VALUE)',
        confidence: 0.8,
        explanation: 'Validate and normalize email format',
      },
      'string_to_phone': {
        rule: 'normalizePhoneNumber(VALUE)',
        confidence: 0.8,
        explanation: 'Normalize phone number format',
      },
      'number_to_currency': {
        rule: 'formatCurrency(VALUE)',
        confidence: 0.9,
        explanation: 'Format number as currency',
      },
      'date_to_string': {
        rule: 'formatDate(VALUE, "YYYY-MM-DD")',
        confidence: 0.9,
        explanation: 'Format date as string',
      },
    };

    const key = `${sourceType}_to_${targetType}` as keyof typeof conversions;
    return conversions[key] || {
      rule: `convert_${sourceType}_to_${targetType}(VALUE)`,
      confidence: 0.6,
      explanation: `Convert ${sourceType} to ${targetType}`,
    };
  }

  /**
   * Suggest string transformation
   */
  private suggestStringTransformation(
    sourcePattern: DataPattern,
    targetPattern: DataPattern,
  ): {
    transformationType: string;
    transformationRule: string;
    confidence: number;
    explanation: string;
  } {
    // If target is much shorter, suggest truncation
    if (targetPattern.statistics.maxLength && sourcePattern.statistics.maxLength &&
        targetPattern.statistics.maxLength < sourcePattern.statistics.maxLength * 0.5) {
      return {
        transformationType: 'calculation',
        transformationRule: `substring(VALUE, 0, ${targetPattern.statistics.maxLength})`,
        confidence: 0.8,
        explanation: 'Truncate to fit target field length',
      };
    }

    // If patterns suggest case conversion
    if (this.suggestsCaseConversion(sourcePattern, targetPattern)) {
      return {
        transformationType: 'calculation',
        transformationRule: 'toUpperCase(VALUE)',
        confidence: 0.7,
        explanation: 'Convert to uppercase for consistency',
      };
    }

    return {
      transformationType: 'direct',
      transformationRule: 'VALUE',
      confidence: 0.9,
      explanation: 'Direct string mapping',
    };
  }

  /**
   * Check if case conversion is suggested
   */
  private suggestsCaseConversion(sourcePattern: DataPattern, targetPattern: DataPattern): boolean {
    // Simple heuristic: if target has more uppercase examples
    const sourceUpper = sourcePattern.examples.filter(v =>
      typeof v === 'string' && v === v.toUpperCase(),
    ).length;
    const targetUpper = targetPattern.examples.filter(v =>
      typeof v === 'string' && v === v.toUpperCase(),
    ).length;

    return targetUpper > sourceUpper && targetPattern.examples.length > 2;
  }

  /**
   * Get NetSuite-specific pattern matching adjustments
   */
  private getNetSuiteSpecificAdjustment(
    sourcePattern: DataPattern,
    targetField: FieldDefinition,
    recordType: string,
  ): { factor: number; explanation?: string } {
    const fieldName = targetField.name.toLowerCase();

    // NetSuite ID fields
    if (fieldName.includes('id') && sourcePattern.type === 'string') {
      return { factor: 1.2, explanation: 'NetSuite ID field compatibility' };
    }

    // NetSuite custom fields
    if (fieldName.startsWith('custentity_') || fieldName.startsWith('custbody_')) {
      return { factor: 0.9, explanation: 'Custom field requires verification' };
    }

    // Record-specific adjustments
    if (recordType === 'customer' && fieldName === 'companyname' && sourcePattern.type === 'string') {
      return { factor: 1.3, explanation: 'Primary customer identifier' };
    }

    return { factor: 1.0 };
  }
}
