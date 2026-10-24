/**
 * Comprehensive tests for CleansingRecommender
 * Covers: generateCleansingSuggestions, generateQualityRecommendations,
 *         suggestCompletionMethods, suggestDeduplicationStrategies,
 *         suggestStandardization, suggestValidationRules, prioritizeRecommendations
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/utils/Logger', () => ({
  logger: mockLogger,
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { CleansingRecommender } from '../../../../src/services/ai/orchestrator/agents/quality/CleansingRecommender';

describe('CleansingRecommender', () => {
  let service: CleansingRecommender;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (CleansingRecommender as any)(mockLogger);
  });

  /* ────────────── generateCleansingSuggestions ────────────── */

  describe('generateCleansingSuggestions', () => {
    it('should return empty for no issues and no anomalies', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const anomalies = { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result).toEqual([]);
    });

    it('should suggest validate for completeness issues', async () => {
      const quality = {
        overallScore: 0.8,
        fieldScores: {},
        issues: [{ field: 'email', type: 'completeness', severity: 'medium', message: '', suggestion: '' }],
      };
      const anomalies = { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result.length).toBe(1);
      expect(result[0].operation).toBe('validate');
      expect(result[0].field).toBe('email');
      expect(result[0].automatable).toBe(true);
      expect(result[0].riskLevel).toBe('low');
    });

    it('should suggest standardize for validity issues', async () => {
      const quality = {
        overallScore: 0.8,
        fieldScores: {},
        issues: [{ field: 'phone', type: 'validity', severity: 'high', message: '', suggestion: '' }],
      };
      const anomalies = { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result[0].operation).toBe('standardize');
      expect(result[0].riskLevel).toBe('medium');
    });

    it('should suggest format for consistency issues', async () => {
      const quality = {
        overallScore: 0.8,
        fieldScores: {},
        issues: [{ field: 'status', type: 'consistency', severity: 'medium', message: '', suggestion: '' }],
      };
      const anomalies = { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result[0].operation).toBe('format');
      expect(result[0].riskLevel).toBe('low');
    });

    it('should suggest validate for outlier anomalies', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const anomalies = {
        anomalies: [{ field: 'val', anomalyType: 'outlier', severity: 'high' as const, description: '', affectedRecords: 1, suggestedAction: '' }],
        anomalyScore: 0.1,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result[0].operation).toBe('validate');
      expect(result[0].automatable).toBe(false);
      expect(result[0].riskLevel).toBe('high');
    });

    it('should suggest enrich for missing_expected anomalies', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const anomalies = {
        anomalies: [{ field: 'name', anomalyType: 'missing_expected', severity: 'high' as const, description: '', affectedRecords: 5, suggestedAction: '' }],
        anomalyScore: 0.1,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result[0].operation).toBe('enrich');
      expect(result[0].riskLevel).toBe('medium');
    });

    it('should suggest standardize for format_deviation anomalies', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const anomalies = {
        anomalies: [{ field: 'code', anomalyType: 'format_deviation', severity: 'low' as const, description: '', affectedRecords: 2, suggestedAction: '' }],
        anomalyScore: 0.1,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result[0].operation).toBe('standardize');
      expect(result[0].riskLevel).toBe('low');
    });

    it('should combine suggestions from issues and anomalies', async () => {
      const quality = {
        overallScore: 0.7,
        fieldScores: {},
        issues: [
          { field: 'email', type: 'completeness', severity: 'medium', message: '', suggestion: '' },
          { field: 'phone', type: 'validity', severity: 'high', message: '', suggestion: '' },
        ],
      };
      const anomalies = {
        anomalies: [{ field: 'val', anomalyType: 'outlier', severity: 'high' as const, description: '', affectedRecords: 1, suggestedAction: '' }],
        anomalyScore: 0.1,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const result = await service.generateCleansingSuggestions(quality, anomalies);
      expect(result.length).toBe(3);
    });

    it('should log start and completion', async () => {
      await service.generateCleansingSuggestions(
        { overallScore: 1.0, fieldScores: {}, issues: [] },
        { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Generating cleansing suggestions', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Cleansing suggestions generated', expect.any(Object));
    });
  });

  /* ────────────── generateQualityRecommendations ────────────── */

  describe('generateQualityRecommendations', () => {
    const emptyAnomalies = { anomalies: [], anomalyScore: 0, detectionMethods: [], baseline: {} as any, recommendations: [] };

    it('should recommend data cleaning when overall score < 0.8', async () => {
      const quality = { overallScore: 0.6, fieldScores: {}, issues: [] };
      const result = await service.generateQualityRecommendations(quality, emptyAnomalies, []);
      const cleaning = result.filter(r => r.category === 'data_cleaning');
      expect(cleaning.length).toBe(1);
      expect(cleaning[0].priority).toBe('high');
    });

    it('should not recommend data cleaning when score >= 0.8', async () => {
      const quality = { overallScore: 0.9, fieldScores: {}, issues: [] };
      const result = await service.generateQualityRecommendations(quality, emptyAnomalies, []);
      const cleaning = result.filter(r => r.description.includes('below acceptable'));
      expect(cleaning).toEqual([]);
    });

    it('should recommend for high severity anomalies', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const anomalies = {
        anomalies: [{ field: 'x', anomalyType: 'outlier', severity: 'high' as const, description: '', affectedRecords: 1, suggestedAction: '' }],
        anomalyScore: 0.1,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const result = await service.generateQualityRecommendations(quality, anomalies, []);
      expect(result.some(r => r.description.includes('high-severity'))).toBe(true);
    });

    it('should not recommend for non-high severity anomalies only', async () => {
      const anomalies = {
        anomalies: [{ field: 'x', anomalyType: 'format_deviation', severity: 'low' as const, description: '', affectedRecords: 1, suggestedAction: '' }],
        anomalyScore: 0.01,
        detectionMethods: [],
        baseline: {} as any,
        recommendations: [],
      };
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const result = await service.generateQualityRecommendations(quality, anomalies, []);
      const highSevRecs = result.filter(r => r.description.includes('high-severity'));
      expect(highSevRecs).toEqual([]);
    });

    it('should recommend for failed validations', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const validations = [
        { field: 'x', validationRules: [], results: [], overallScore: 0.7 },
      ] as any[];
      const result = await service.generateQualityRecommendations(quality, emptyAnomalies, validations);
      const valRecs = result.filter(r => r.category === 'validation_rules');
      expect(valRecs.length).toBe(1);
      expect(valRecs[0].priority).toBe('medium');
    });

    it('should not recommend when validations pass', async () => {
      const quality = { overallScore: 1.0, fieldScores: {}, issues: [] };
      const validations = [{ field: 'x', overallScore: 0.95 }] as any[];
      const result = await service.generateQualityRecommendations(quality, emptyAnomalies, validations);
      const valRecs = result.filter(r => r.category === 'validation_rules');
      expect(valRecs).toEqual([]);
    });
  });

  /* ────────────── suggestCompletionMethods ────────────── */

  describe('suggestCompletionMethods', () => {
    it('should suggest removal for low missing percentage (<10%)', () => {
      const methods = service.suggestCompletionMethods('field', 0.05);
      expect(methods).toContain('Remove records with missing values');
      expect(methods).toContain('Impute with mean/median/mode');
    });

    it('should suggest imputation for moderate missing (<30%)', () => {
      const methods = service.suggestCompletionMethods('field', 0.2);
      expect(methods).toContain('Impute with mean/median/mode');
      expect(methods).toContain('Forward/backward fill');
      expect(methods).not.toContain('Remove records with missing values');
    });

    it('should suggest ML and source for high missing (>30%)', () => {
      const methods = service.suggestCompletionMethods('field', 0.5);
      expect(methods).toContain('Use ML model for imputation');
      expect(methods).toContain('Request data from source systems');
      expect(methods).not.toContain('Impute with mean/median/mode');
    });

    it('should always include ML and source suggestions', () => {
      const methods = service.suggestCompletionMethods('field', 0.01);
      expect(methods).toContain('Use ML model for imputation');
      expect(methods).toContain('Request data from source systems');
    });
  });

  /* ────────────── suggestDeduplicationStrategies ────────────── */

  describe('suggestDeduplicationStrategies', () => {
    it('should always include exact match', () => {
      const strategies = service.suggestDeduplicationStrategies('field', 0.01);
      expect(strategies[0]).toBe('Exact match deduplication');
    });

    it('should suggest fuzzy matching for high duplicate percentage', () => {
      const strategies = service.suggestDeduplicationStrategies('field', 0.1);
      expect(strategies).toContain('Fuzzy matching with similarity threshold');
      expect(strategies).toContain('Entity resolution using ML');
    });

    it('should not suggest fuzzy matching for low duplicate percentage', () => {
      const strategies = service.suggestDeduplicationStrategies('field', 0.02);
      expect(strategies).not.toContain('Fuzzy matching with similarity threshold');
    });

    it('should always include keep recent and merge strategies', () => {
      const strategies = service.suggestDeduplicationStrategies('field', 0.01);
      expect(strategies).toContain('Keep most recent record');
      expect(strategies).toContain('Merge duplicate records');
    });
  });

  /* ────────────── suggestStandardization ────────────── */

  describe('suggestStandardization', () => {
    it('should always include canonical format and regex', () => {
      const approaches = service.suggestStandardization('field', 1);
      expect(approaches).toContain('Define canonical format');
      expect(approaches).toContain('Apply regex-based transformations');
    });

    it('should suggest NLP for many format variations', () => {
      const approaches = service.suggestStandardization('field', 5);
      expect(approaches).toContain('Use NLP for format normalization');
      expect(approaches).toContain('Implement format validation at input');
    });

    it('should not suggest NLP for few format variations', () => {
      const approaches = service.suggestStandardization('field', 2);
      expect(approaches).not.toContain('Use NLP for format normalization');
    });

    it('should always include lookup table', () => {
      const approaches = service.suggestStandardization('field', 1);
      expect(approaches).toContain('Create lookup table for mappings');
    });
  });

  /* ────────────── suggestValidationRules ────────────── */

  describe('suggestValidationRules', () => {
    it('should suggest string rules for string type', () => {
      const rules = service.suggestValidationRules('name', 'string', 0.1);
      expect(rules).toContain('Format validation (regex)');
      expect(rules).toContain('Length constraints');
      expect(rules).toContain('Character set validation');
    });

    it('should suggest string rules for text type', () => {
      const rules = service.suggestValidationRules('bio', 'text', 0.1);
      expect(rules).toContain('Format validation (regex)');
    });

    it('should suggest number rules for number type', () => {
      const rules = service.suggestValidationRules('amount', 'number', 0.1);
      expect(rules).toContain('Range validation');
      expect(rules).toContain('Precision validation');
      expect(rules).toContain('Sign validation (positive/negative)');
    });

    it('should suggest number rules for currency type', () => {
      const rules = service.suggestValidationRules('price', 'currency', 0.1);
      expect(rules).toContain('Range validation');
    });

    it('should suggest date rules for date type', () => {
      const rules = service.suggestValidationRules('created', 'date', 0.1);
      expect(rules).toContain('Date format validation');
      expect(rules).toContain('Date range validation');
      expect(rules).toContain('Future/past date constraints');
    });

    it('should suggest date rules for datetime type', () => {
      const rules = service.suggestValidationRules('ts', 'datetime', 0.1);
      expect(rules).toContain('Date format validation');
    });

    it('should suggest email rules', () => {
      const rules = service.suggestValidationRules('email', 'email', 0.1);
      expect(rules).toContain('Email format validation');
      expect(rules).toContain('Domain whitelist/blacklist');
    });

    it('should suggest phone rules', () => {
      const rules = service.suggestValidationRules('phone', 'phone', 0.1);
      expect(rules).toContain('Phone format validation');
      expect(rules).toContain('Country code validation');
    });

    it('should add monitoring for high invalid percentage', () => {
      const rules = service.suggestValidationRules('x', 'string', 0.3);
      expect(rules).toContain('Implement input validation');
      expect(rules).toContain('Add data quality monitoring');
    });

    it('should not add monitoring for low invalid percentage', () => {
      const rules = service.suggestValidationRules('x', 'string', 0.1);
      expect(rules).not.toContain('Implement input validation');
    });
  });

  /* ────────────── prioritizeRecommendations ────────────── */

  describe('prioritizeRecommendations', () => {
    it('should sort high priority first', () => {
      const recs = [
        { priority: 'low' as const, category: 'a', description: 'low', estimatedImpact: '', implementationEffort: 'low' as const },
        { priority: 'high' as const, category: 'b', description: 'high', estimatedImpact: '', implementationEffort: 'low' as const },
        { priority: 'medium' as const, category: 'c', description: 'med', estimatedImpact: '', implementationEffort: 'low' as const },
      ];
      const sorted = service.prioritizeRecommendations(recs);
      expect(sorted[0].priority).toBe('high');
      expect(sorted[1].priority).toBe('medium');
      expect(sorted[2].priority).toBe('low');
    });

    it('should sort by effort when priority is equal (low effort first)', () => {
      const recs = [
        { priority: 'high' as const, category: 'a', description: 'high-effort', estimatedImpact: '', implementationEffort: 'high' as const },
        { priority: 'high' as const, category: 'b', description: 'low-effort', estimatedImpact: '', implementationEffort: 'low' as const },
      ];
      const sorted = service.prioritizeRecommendations(recs);
      expect(sorted[0].implementationEffort).toBe('low');
      expect(sorted[1].implementationEffort).toBe('high');
    });

    it('should handle empty array', () => {
      expect(service.prioritizeRecommendations([])).toEqual([]);
    });
  });
});
