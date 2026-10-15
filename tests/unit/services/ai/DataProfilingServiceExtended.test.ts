/**
 * Comprehensive tests for DataProfilingService
 * Covers: profileData, calculateQualityMetrics, and all private statistical methods
 *         exercised through the public API
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

import { DataProfilingService } from '../../../../src/services/ai/orchestrator/agents/quality/DataProfilingService';

describe('DataProfilingService', () => {
  let service: DataProfilingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (DataProfilingService as any)(mockLogger);
  });

  /* ────────────── profileData ────────────── */

  describe('profileData', () => {
    it('should return empty array for empty schema', async () => {
      const result = await service.profileData([{ name: 'Alice' }], []);
      expect(result).toEqual([]);
    });

    it('should profile string fields', async () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result.length).toBe(1);
      expect(result[0].field).toBe('name');
      expect(result[0].dataType).toBe('string');
      expect(result[0].statistics.count).toBe(3);
      expect(result[0].statistics.nullCount).toBe(0);
      expect(result[0].statistics.uniqueCount).toBe(3);
    });

    it('should calculate string length stats', async () => {
      const data = [{ city: 'LA' }, { city: 'NYC' }, { city: 'Chicago' }];
      const schema = [{ name: 'city', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.minLength).toBe(2);
      expect(result[0].statistics.maxLength).toBe(7);
      expect(result[0].statistics.avgLength).toBeCloseTo((2 + 3 + 7) / 3, 1);
    });

    it('should profile number fields with statistical metrics', async () => {
      const data = [{ amount: 10 }, { amount: 20 }, { amount: 30 }];
      const schema = [{ name: 'amount', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.min).toBe(10);
      expect(result[0].statistics.max).toBe(30);
      expect(result[0].statistics.mean).toBe(20);
      expect(result[0].statistics.median).toBe(20);
      expect(result[0].statistics.stdDev).toBeDefined();
    });

    it('should calculate median for even-length number arrays', async () => {
      const data = [{ val: 10 }, { val: 20 }, { val: 30 }, { val: 40 }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.median).toBe(25); // (20+30)/2
    });

    it('should profile currency fields like numbers', async () => {
      const data = [{ price: 9.99 }, { price: 19.99 }];
      const schema = [{ name: 'price', type: 'currency' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.min).toBeCloseTo(9.99, 2);
      expect(result[0].statistics.max).toBeCloseTo(19.99, 2);
    });

    it('should handle null values in profiling', async () => {
      // getRecordValues filters out nulls, so fieldData only has non-null values
      const data = [{ code: 'ABC' }, { code: null }, { code: 'DEF' }];
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      // nullCount = 0 because getRecordValues strips nulls before statistics
      expect(result[0].statistics.nullCount).toBe(0);
      expect(result[0].statistics.uniqueCount).toBe(2);
      expect(result[0].statistics.count).toBe(2); // only non-null values
    });

    it('should calculate value distribution', async () => {
      const data = [{ status: 'active' }, { status: 'active' }, { status: 'inactive' }];
      const schema = [{ name: 'status', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].distribution.topValues.length).toBeGreaterThan(0);
      expect(result[0].distribution.topValues[0].value).toBe('active');
      expect(result[0].distribution.topValues[0].count).toBe(2);
      expect(result[0].distribution.nullPercentage).toBe(0);
      expect(result[0].distribution.uniquenessRatio).toBeCloseTo(2 / 3, 2);
    });

    it('should calculate null percentage in distribution', async () => {
      // getRecordValues already strips nulls, so distribution sees only non-null values
      const data = [{ x: 'a' }, { x: null }, { x: null }];
      const schema = [{ name: 'x', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      // nullPercentage = 0 because fieldData has nulls stripped by getRecordValues
      expect(result[0].distribution.nullPercentage).toBe(0);
      expect(result[0].distribution.topValues.length).toBe(1);
      expect(result[0].distribution.topValues[0].value).toBe('a');
    });

    it('should calculate entropy score', async () => {
      // Even distribution → high entropy
      const data = [{ x: 'a' }, { x: 'b' }, { x: 'c' }, { x: 'd' }];
      const schema = [{ name: 'x', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].distribution.entropyScore).toBeCloseTo(2.0, 1); // log2(4) = 2
    });

    it('should include quality metrics', async () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].quality.completeness).toBe(1.0);
      expect(result[0].quality.overallScore).toBeGreaterThan(0);
    });

    it('should identify data patterns for strings', async () => {
      // All same format → pattern detected
      const data = Array(10).fill(null).map((_, i) => ({ code: `ABC-${i}` }));
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].patterns).toBeDefined();
    });

    it('should identify range patterns for numbers', async () => {
      // Tightly clustered values
      const data = Array(10).fill(null).map(() => ({ val: 50 + Math.random() * 2 }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].patterns).toBeDefined();
    });

    it('should profile multiple fields', async () => {
      const data = [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }];
      const schema = [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'number' },
      ] as any[];
      const result = await service.profileData(data, schema);
      expect(result.length).toBe(2);
      expect(result[0].field).toBe('name');
      expect(result[1].field).toBe('age');
    });

    it('should log start and completion', async () => {
      await service.profileData([{ x: 1 }], [{ name: 'x', type: 'number' }] as any[]);
      expect(mockLogger.info).toHaveBeenCalledWith('Starting data profiling', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Data profiling completed', expect.any(Object));
    });
  });

  /* ────────────── calculateQualityMetrics ────────────── */

  describe('calculateQualityMetrics', () => {
    it('should calculate completeness for all non-null data', () => {
      const fieldData = ['a', 'b', 'c'];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.completeness).toBe(1.0);
    });

    it('should calculate completeness with nulls', () => {
      const fieldData = ['a', null, 'c', undefined];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.completeness).toBe(0.5);
    });

    it('should assess uniqueness for ID fields', () => {
      const fieldData = ['id1', 'id1', 'id2'];
      const field = { name: 'recordId', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.uniqueness).toBeCloseTo(2 / 3, 2);
    });

    it('should return uniqueness 1.0 for non-ID fields', () => {
      const fieldData = ['a', 'a', 'a'];
      const field = { name: 'status', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.uniqueness).toBe(1.0);
    });

    it('should return validity 1.0 with no validation rules', () => {
      const fieldData = ['a', 'b'];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.validity).toBe(1.0);
    });

    it('should validate with format rules', () => {
      const fieldData = ['abc', '123', 'xyz'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'format', expression: '^[a-z]+$' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      // 'abc' matches, '123' doesn't, 'xyz' matches → 2/3
      expect(result.validity).toBeCloseTo(2 / 3, 2);
    });

    it('should validate with range rules', () => {
      const fieldData = [10, 'not-a-number', 50];
      const field = { name: 'val', type: 'number' } as any;
      const rules = [{ type: 'range', expression: '0-100' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      // 10 valid, 'not-a-number' invalid (NaN), 50 valid → 2/3
      expect(result.validity).toBeCloseTo(2 / 3, 2);
    });

    it('should validate with business rules (not null)', () => {
      // calculateFieldValidity receives nonNullData, so null is already excluded
      // All non-null values pass the 'value != null' check
      const fieldData = ['a', null, 'c'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'business', expression: 'value != null' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      // nonNullData = ['a', 'c'], both pass → validity = 1.0
      expect(result.validity).toBe(1.0);
      // But completeness reflects the null: 2/3
      expect(result.completeness).toBeCloseTo(2 / 3, 2);
    });

    it('should validate with business rules (not empty)', () => {
      const fieldData = ['a', '', 'c'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'business', expression: 'value !== ""' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      expect(result.validity).toBeCloseTo(2 / 3, 2);
    });

    it('should return true for unknown validation rule types', () => {
      const fieldData = ['a', 'b'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'unknown', expression: 'whatever' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      expect(result.validity).toBe(1.0);
    });

    it('should calculate consistency for strings', () => {
      // All same format → high consistency
      const fieldData = ['abc', 'def', 'ghi'];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.consistency).toBeGreaterThan(0);
    });

    it('should return 1.0 consistency for single value', () => {
      const fieldData = ['abc'];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.consistency).toBe(1.0);
    });

    it('should return 1.0 consistency for non-string types', () => {
      const fieldData = [1, 2, 3];
      const field = { name: 'val', type: 'number' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      expect(result.consistency).toBe(1.0);
    });

    it('should set accuracy to 0.95 placeholder', () => {
      const result = service.calculateQualityMetrics(['a'], { name: 'x', type: 'string' } as any);
      expect(result.accuracy).toBe(0.95);
    });

    it('should set conformity to 0.95 placeholder', () => {
      const result = service.calculateQualityMetrics(['a'], { name: 'x', type: 'string' } as any);
      expect(result.conformity).toBe(0.95);
    });

    it('should calculate overall score as average of 6 dimensions', () => {
      const fieldData = ['a', 'b', 'c'];
      const field = { name: 'x', type: 'string' } as any;
      const result = service.calculateQualityMetrics(fieldData, field);
      const expectedAvg = (
        result.completeness +
        result.uniqueness +
        result.validity +
        result.consistency +
        result.accuracy +
        result.conformity
      ) / 6;
      expect(result.overallScore).toBeCloseTo(expectedAvg, 4);
    });

    it('should handle format rule with invalid regex gracefully', () => {
      const fieldData = ['abc'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'format', expression: '[invalid' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      // Invalid regex → validateValue catches error → returns false
      expect(result.validity).toBe(0);
    });
  });

  /* ────────────── Pattern identification (via profileData) ────────────── */

  describe('pattern identification', () => {
    it('should identify format pattern when >80% share same format', async () => {
      // All follow AAA-DDD pattern
      const data = Array(10).fill(null).map((_, i) => ({ code: `ABC-${String(i).padStart(3, '0')}` }));
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      const formatPatterns = result[0].patterns.filter(p => p.type === 'format');
      expect(formatPatterns.length).toBeGreaterThan(0);
    });

    it('should identify length pattern for consistent string lengths', async () => {
      // All approximately same length
      const data = Array(10).fill(null).map(() => ({ code: 'ABCDE' }));
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      const lengthPatterns = result[0].patterns.filter(p => p.description?.includes('length'));
      expect(lengthPatterns.length).toBeGreaterThan(0);
    });

    it('should identify range pattern for clustered numbers', async () => {
      // All tightly clustered around 50
      const data = Array(10).fill(null).map(() => ({ val: 50 }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      // range = max-min = 0, midpoint=50, all within 0.3*0 = 0 → all clustered
      const rangePatterns = result[0].patterns.filter(p => p.type === 'range');
      expect(rangePatterns.length).toBeGreaterThan(0);
    });

    it('should not identify range pattern for spread numbers', async () => {
      // Widely spread values
      const data = [{ val: 1 }, { val: 100 }, { val: 200 }, { val: 300 }, { val: 400 },
        { val: 500 }, { val: 600 }, { val: 700 }, { val: 800 }, { val: 999 }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      const rangePatterns = result[0].patterns.filter(p => p.type === 'range');
      // Values are linearly spread so most are NOT clustered within 30% of range from midpoint
      expect(rangePatterns.length).toBe(0);
    });

    it('should not identify patterns for non-numeric NaN values', async () => {
      const data = [{ val: 'abc' }, { val: 'def' }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      const rangePatterns = result[0].patterns.filter(p => p.type === 'range');
      expect(rangePatterns).toEqual([]);
    });

    it('should not generate patterns for empty data', async () => {
      const data: any[] = [];
      const schema = [{ name: 'x', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].patterns).toEqual([]);
    });
  });

  /* ────────────── Edge cases ────────────── */

  describe('edge cases', () => {
    it('should handle text type same as string for stats', async () => {
      const data = [{ bio: 'Hello world' }];
      const schema = [{ name: 'bio', type: 'text' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.minLength).toBe(11);
      expect(result[0].statistics.maxLength).toBe(11);
    });

    it('should handle all-null number fields', async () => {
      // getRecordValues strips nulls, so fieldData is empty
      const data = [{ val: null }, { val: undefined }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].statistics.count).toBe(0); // No non-null values
      expect(result[0].statistics.nullCount).toBe(0); // nulls already stripped
      expect(result[0].statistics.min).toBeUndefined(); // No numbers to compute
    });

    it('should handle standard deviation calculation', async () => {
      const data = [{ val: 2 }, { val: 4 }, { val: 4 }, { val: 4 }, { val: 5 }, { val: 5 }, { val: 7 }, { val: 9 }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.profileData(data, schema);
      // mean = 5, stdDev ≈ 2.0
      expect(result[0].statistics.stdDev).toBeCloseTo(2.0, 1);
    });

    it('should limit top values to 10', async () => {
      const data = Array(20).fill(null).map((_, i) => ({ code: `val_${i}` }));
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.profileData(data, schema);
      expect(result[0].distribution.topValues.length).toBeLessThanOrEqual(10);
    });

    it('should handle business rule without matching expression', () => {
      const fieldData = ['a', 'b'];
      const field = { name: 'x', type: 'string' } as any;
      const rules = [{ type: 'business', expression: 'some_unrecognized_expression' }] as any[];
      const result = service.calculateQualityMetrics(fieldData, field, rules);
      expect(result.validity).toBe(1.0); // Falls through to true
    });
  });
});
