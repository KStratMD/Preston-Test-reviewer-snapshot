/**
 * AIDataQualityService Tests
 * Tests for AI-powered data quality analysis and validation
 */

import { AIDataQualityService } from '../../../src/services/AIDataQualityService';

describe('AIDataQualityService', () => {
  let service: AIDataQualityService;

  beforeEach(() => {
    service = new AIDataQualityService();
  });

  describe('analyzeDataQuality', () => {
    it('should return analysis with all required fields', async () => {
      const record = { name: 'John Doe', email: 'john@example.com' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      expect(result.record).toEqual(record);
      expect(result.issues).toBeInstanceOf(Array);
      expect(result.overallScore).toBeDefined();
      expect(result.recommendations).toBeInstanceOf(Array);
      expect(result.patterns).toBeInstanceOf(Array);
    });

    it('should give high score for clean data', async () => {
      const record = {
        name: 'John Doe',
        email: 'john@example.com',
        phone: '1234567890',
      };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      expect(result.overallScore).toBeGreaterThan(80);
    });

    it('should detect issues and lower score', async () => {
      const record = {
        name: '',
        email: 'invalid-email',
        phone: 'not-a-phone',
      };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.overallScore).toBeLessThan(100);
    });
  });

  describe('format validation', () => {
    it('should detect invalid email format', async () => {
      const record = { email: 'not-an-email' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const emailIssue = result.issues.find(i => i.field === 'email' && i.issue === 'format');
      expect(emailIssue).toBeDefined();
      expect(emailIssue?.severity).toBe('high');
      expect(emailIssue?.suggestion).toContain('format');
    });

    it('should accept valid email format', async () => {
      const record = { email: 'valid@example.com' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const emailIssue = result.issues.find(i => i.field === 'email' && i.issue === 'format');
      expect(emailIssue).toBeUndefined();
    });

    it('should detect invalid phone format', async () => {
      const record = { phone: 'abc-not-phone' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const phoneIssue = result.issues.find(i => i.field === 'phone' && i.issue === 'format');
      expect(phoneIssue).toBeDefined();
      expect(phoneIssue?.severity).toBe('high');
    });

    it('should accept valid phone format', async () => {
      const record = { phone: '1234567890' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const phoneIssue = result.issues.find(i => i.field === 'phone' && i.issue === 'format');
      expect(phoneIssue).toBeUndefined();
    });

    it('should detect invalid date format', async () => {
      const record = { created_date: '01/15/2024' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const dateIssue = result.issues.find(i => i.field === 'created_date' && i.issue === 'format');
      expect(dateIssue).toBeDefined();
    });

    it('should accept valid date format', async () => {
      const record = { created_date: '2024-01-15' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const dateIssue = result.issues.find(i => i.field === 'created_date' && i.issue === 'format');
      expect(dateIssue).toBeUndefined();
    });

    it('should detect invalid currency format', async () => {
      const record = { amount: '$1,234.56' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const currencyIssue = result.issues.find(i => i.field === 'amount' && i.issue === 'format');
      expect(currencyIssue).toBeDefined();
    });

    it('should accept valid currency format', async () => {
      const record = { amount: '1234.56' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const currencyIssue = result.issues.find(i => i.field === 'amount' && i.issue === 'format');
      expect(currencyIssue).toBeUndefined();
    });

    it('should detect invalid zipcode format', async () => {
      const record = { zipcode: 'ABC123' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const zipIssue = result.issues.find(i => i.field === 'zipcode' && i.issue === 'format');
      expect(zipIssue).toBeDefined();
    });

    it('should accept valid zipcode formats', async () => {
      const record5 = { zipcode: '12345' };
      const record9 = { zipcode: '12345-6789' };

      const result5 = await service.analyzeDataQuality(record5, 'salesforce');
      const result9 = await service.analyzeDataQuality(record9, 'salesforce');

      expect(result5.issues.find(i => i.field === 'zipcode' && i.issue === 'format')).toBeUndefined();
      expect(result9.issues.find(i => i.field === 'zipcode' && i.issue === 'format')).toBeUndefined();
    });

    it('should not check format for non-string values', async () => {
      const record = { email: null, phone: 123 };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const formatIssues = result.issues.filter(i => i.issue === 'format');
      expect(formatIssues.length).toBe(0);
    });
  });

  describe('missing data detection', () => {
    it('should detect missing required customer fields', async () => {
      const record = { name: '', customer_id: '123' };

      const result = await service.analyzeDataQuality(record, 'customer');

      const missingIssue = result.issues.find(i => i.field === 'name' && i.issue === 'missing');
      expect(missingIssue).toBeDefined();
      expect(missingIssue?.severity).toBe('critical');
    });

    it('should detect whitespace-only as missing', async () => {
      const record = { name: '   ' };

      const result = await service.analyzeDataQuality(record, 'customer');

      const missingIssue = result.issues.find(i => i.issue === 'missing');
      expect(missingIssue).toBeDefined();
    });

    it('should not flag non-required fields as missing', async () => {
      const record = { optional_field: '' };

      const result = await service.analyzeDataQuality(record, 'customer');

      const missingIssue = result.issues.find(i => i.field === 'optional_field' && i.issue === 'missing');
      expect(missingIssue).toBeUndefined();
    });
  });

  describe('duplicate detection', () => {
    it('should detect repeated patterns in strings', async () => {
      const record = { name: 'JohnJohnJohn' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const duplicateIssue = result.issues.find(i => i.issue === 'duplicate');
      expect(duplicateIssue).toBeDefined();
      expect(duplicateIssue?.autoFixable).toBe(true);
    });

    it('should not flag non-repeated strings', async () => {
      const record = { name: 'John Doe' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const duplicateIssue = result.issues.find(i => i.field === 'name' && i.issue === 'duplicate');
      expect(duplicateIssue).toBeUndefined();
    });

    it('should ignore short repeated patterns', async () => {
      const record = { code: 'AA' }; // Short repeat should be ignored

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const duplicateIssue = result.issues.find(i => i.field === 'code' && i.issue === 'duplicate');
      expect(duplicateIssue).toBeUndefined();
    });
  });

  describe('business rule validation', () => {
    it('should detect end date before start date', async () => {
      const record = {
        start_date: '2024-12-31',
        end_date: '2024-01-01',
      };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const inconsistentIssue = result.issues.find(i => i.field === 'end_date' && i.issue === 'inconsistent');
      expect(inconsistentIssue).toBeDefined();
      expect(inconsistentIssue?.severity).toBe('high');
    });

    it('should accept valid date ranges', async () => {
      const record = {
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const dateIssue = result.issues.find(i => i.field === 'end_date' && i.issue === 'inconsistent');
      expect(dateIssue).toBeUndefined();
    });

    it('should not flag zero quantity when confidence is at threshold', async () => {
      // Zero quantity has confidence of 0.7 which doesn't pass > 0.7 filter
      const record = { quantity: 0 };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      // Issue is generated but filtered out due to confidence threshold
      const quantityIssue = result.issues.find(i => i.field === 'quantity' && i.issue === 'inconsistent');
      expect(quantityIssue).toBeUndefined();
    });
  });

  describe('anomaly detection', () => {
    it('should detect negative prices as anomaly', async () => {
      const record = { price: -100 };

      // Set up baseline for the field
      (service as any).anomalyBaselines.set('salesforce.price', {
        mean: 50,
        stdDev: 20,
        min: 0,
        max: 200,
      });

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const anomalyIssues = result.issues.filter(i => i.field === 'price' && i.issue === 'anomaly');
      expect(anomalyIssues.length).toBeGreaterThan(0);
      // Should detect either statistical anomaly or negative price anomaly
      const hasNegativeOrStatistical = anomalyIssues.some(i =>
        i.description.includes('Negative price') || i.description.includes('Unusual value')
      );
      expect(hasNegativeOrStatistical).toBe(true);
    });

    it('should detect statistical anomalies', async () => {
      const record = { amount: 1000 };

      // Set baseline where 1000 is an outlier
      (service as any).anomalyBaselines.set('salesforce.amount', {
        mean: 50,
        stdDev: 10,
        min: 0,
        max: 100,
      });

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const anomalyIssue = result.issues.find(i => i.field === 'amount' && i.issue === 'anomaly');
      expect(anomalyIssue).toBeDefined();
    });

    it('should not flag values within normal range', async () => {
      const record = { amount: 55 };

      (service as any).anomalyBaselines.set('salesforce.amount', {
        mean: 50,
        stdDev: 10,
        min: 0,
        max: 100,
      });

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const anomalyIssue = result.issues.find(i => i.field === 'amount' && i.issue === 'anomaly');
      expect(anomalyIssue).toBeUndefined();
    });
  });

  describe('quality score calculation', () => {
    it('should return 100 for records with no issues', async () => {
      const record = { custom_field: 'valid data' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      expect(result.overallScore).toBe(100);
    });

    it('should deduct more for critical issues', async () => {
      const record1 = { name: '' }; // Critical - missing required
      const record2 = { email: 'bad-email' }; // High - format issue

      const result1 = await service.analyzeDataQuality(record1, 'customer');
      const result2 = await service.analyzeDataQuality(record2, 'salesforce');

      // Critical issues should have larger impact
      expect(result1.overallScore).toBeLessThan(result2.overallScore);
    });

    it('should never go below 0', async () => {
      const record = {
        name: '',
        email: 'invalid',
        phone: 'invalid',
        date: 'invalid',
        amount: 'invalid',
      };

      const result = await service.analyzeDataQuality(record, 'customer');

      expect(result.overallScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('recommendations generation', () => {
    it('should recommend addressing critical issues first', async () => {
      const record = { name: '' };

      const result = await service.analyzeDataQuality(record, 'customer');

      const hasCriticalRecommendation = result.recommendations.some(r =>
        r.toLowerCase().includes('critical')
      );
      expect(hasCriticalRecommendation).toBe(true);
    });

    it('should recommend format standardization for format issues', async () => {
      const record = { email: 'invalid-format' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const hasFormatRecommendation = result.recommendations.some(r =>
        r.toLowerCase().includes('format')
      );
      expect(hasFormatRecommendation).toBe(true);
    });

    it('should recommend auto-fix when applicable', async () => {
      const record = { name: 'JohnJohnJohn' }; // Auto-fixable duplicate

      const result = await service.analyzeDataQuality(record, 'salesforce');

      const hasAutoFixRecommendation = result.recommendations.some(r =>
        r.toLowerCase().includes('auto-fix')
      );
      expect(hasAutoFixRecommendation).toBe(true);
    });
  });

  describe('generateCleansingRules', () => {
    it('should return array of cleansing rules', async () => {
      const data = [
        { phone: '(555) 123-4567' },
        { phone: '555-123-4567' },
        { phone: '+1-555-123-4567' },
      ];

      const rules = await service.generateCleansingRules(data, 'salesforce');

      expect(rules).toBeInstanceOf(Array);
    });

    it('should filter rules by confidence threshold', async () => {
      const data = [{ field: 'value' }];

      const rules = await service.generateCleansingRules(data, 'salesforce');

      // All returned rules should have confidence > 0.6
      rules.forEach(rule => {
        expect(rule.confidence).toBeGreaterThan(0.6);
      });
    });
  });

  describe('autoFixIssues', () => {
    it('should fix auto-fixable duplicate patterns', async () => {
      const record = { name: 'JohnJohnJohn' };
      const issues = [{
        field: 'name',
        issue: 'duplicate' as const,
        severity: 'medium' as const,
        description: 'Repeated pattern',
        suggestion: 'Remove repeat',
        confidence: 0.8,
        autoFixable: true,
      }];

      const fixed = await service.autoFixIssues(record, issues);

      expect(fixed.name).toBe('John');
    });

    it('should standardize phone format', async () => {
      const record = { phone: '(555) 123-4567' };
      const issues = [{
        field: 'phone',
        issue: 'format' as const,
        severity: 'medium' as const,
        description: 'Invalid format',
        suggestion: 'Use standard format',
        confidence: 0.9,
        autoFixable: true,
      }];

      const fixed = await service.autoFixIssues(record, issues);

      expect(fixed.phone).toBe('5551234567');
    });

    it('should standardize email format', async () => {
      const record = { email: '  JOHN@EXAMPLE.COM  ' };
      const issues = [{
        field: 'email',
        issue: 'format' as const,
        severity: 'medium' as const,
        description: 'Format issue',
        suggestion: 'Standardize',
        confidence: 0.9,
        autoFixable: true,
      }];

      const fixed = await service.autoFixIssues(record, issues);

      expect(fixed.email).toBe('john@example.com');
    });

    it('should skip non-auto-fixable issues', async () => {
      const record = { name: '' };
      const issues = [{
        field: 'name',
        issue: 'missing' as const,
        severity: 'critical' as const,
        description: 'Missing required',
        suggestion: 'Provide value',
        confidence: 0.95,
        autoFixable: false,
      }];

      const fixed = await service.autoFixIssues(record, issues);

      expect(fixed.name).toBe('');
    });

    it('should preserve non-affected fields', async () => {
      const record = { name: 'John', email: 'john@example.com', id: 123 };
      const issues = [{
        field: 'name',
        issue: 'format' as const,
        severity: 'low' as const,
        description: 'Minor issue',
        suggestion: 'Fix',
        confidence: 0.8,
        autoFixable: true,
      }];

      const fixed = await service.autoFixIssues(record, issues);

      expect(fixed.email).toBe('john@example.com');
      expect(fixed.id).toBe(123);
    });
  });

  describe('confidence threshold filtering', () => {
    it('should only report issues above 0.7 confidence', async () => {
      const record = { email: 'test@example.com' };

      const result = await service.analyzeDataQuality(record, 'salesforce');

      result.issues.forEach(issue => {
        expect(issue.confidence).toBeGreaterThan(0.7);
      });
    });
  });
});
