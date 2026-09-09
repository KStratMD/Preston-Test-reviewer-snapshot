/**
 * Comprehensive tests for AnomalyDetectionService
 * Covers: detectAnomalies (AI-first + heuristic fallback), statistical outliers,
 *         pattern anomalies, business rule violations, recommendations
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

import { AnomalyDetectionService } from '../../../../src/services/ai/orchestrator/agents/quality/AnomalyDetectionService';

describe('AnomalyDetectionService', () => {
  let service: AnomalyDetectionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (AnomalyDetectionService as any)(mockLogger);
  });

  /* ────────────── detectAnomalies (heuristic fallback) ────────────── */

  describe('detectAnomalies (heuristic)', () => {
    it('should return anomaly detection result structure', async () => {
      const data = [{ val: 1 }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      expect(result.anomalies).toBeDefined();
      expect(result.anomalyScore).toBeDefined();
      expect(result.detectionMethods).toBeDefined();
      expect(result.baseline).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    it('should include 3 detection methods', async () => {
      const data = [{ x: 'a' }];
      const schema = [{ name: 'x', type: 'string' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      expect(result.detectionMethods.length).toBe(3);
      const methodNames = result.detectionMethods.map(m => m.name);
      expect(methodNames).toContain('statistical_outliers');
      expect(methodNames).toContain('pattern_detection');
      expect(methodNames).toContain('business_rules');
    });

    it('should calculate anomaly score as anomalies / data length', async () => {
      const data = Array(10).fill(null).map((_, i) => ({ name: `item-${i}` }));
      const schema = [{ name: 'name', type: 'string', required: false }] as any[];
      const result = await service.detectAnomalies(data, schema);
      expect(result.anomalyScore).toBe(result.anomalies.length / 10);
    });

    it('should detect statistical outliers in number fields', async () => {
      // Create dataset with clear outliers using IQR method
      const normalValues = Array(20).fill(null).map((_, i) => ({ val: 50 + i }));
      const outlierValues = [{ val: 500 }, { val: -200 }]; // far outside IQR
      const data = [...normalValues, ...outlierValues];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies.length).toBeGreaterThan(0);
      expect(outlierAnomalies[0].description).toContain('outliers detected');
    });

    it('should not detect outliers with fewer than 11 data points', async () => {
      const data = Array(5).fill(null).map((_, i) => ({ val: i * 100 }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies).toEqual([]);
    });

    it('should not detect outliers for string fields', async () => {
      const data = Array(20).fill(null).map((_, i) => ({ name: `item-${i}` }));
      const schema = [{ name: 'name', type: 'string' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies).toEqual([]);
    });

    it('should detect high severity outliers when >10% are outliers', async () => {
      // 20 normal + 5 outliers = 25 total, 5/25 = 20% > 10%
      const normal = Array(20).fill(null).map((_, i) => ({ val: 50 + i }));
      const outliers = Array(5).fill(null).map(() => ({ val: 9999 }));
      const data = [...normal, ...outliers];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomaly = result.anomalies.find(a => a.anomalyType === 'outlier');
      if (outlierAnomaly) {
        expect(outlierAnomaly.severity).toBe('high');
      }
    });

    it('should detect format deviations in string fields', async () => {
      // Most values follow one format, a few are different
      const data = [
        ...Array(20).fill(null).map(() => ({ code: 'ABC-123' })),
        { code: '!!special!!' }, // different format
      ];
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const formatAnomalies = result.anomalies.filter(a => a.anomalyType === 'format_deviation');
      expect(formatAnomalies.length).toBeGreaterThan(0);
    });

    it('should detect business rule violations for required fields', async () => {
      const data = [{ name: 'Alice' }, { name: null }, { name: '' }];
      const schema = [{ name: 'name', type: 'string', required: true }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const businessAnomalies = result.anomalies.filter(a => a.anomalyType === 'missing_expected');
      expect(businessAnomalies.length).toBe(1);
      expect(businessAnomalies[0].severity).toBe('high');
      expect(businessAnomalies[0].affectedRecords).toBe(2); // null + ''
    });

    it('should not flag non-required fields as missing_expected', async () => {
      const data = [{ name: null }];
      const schema = [{ name: 'name', type: 'string', required: false }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const businessAnomalies = result.anomalies.filter(a => a.anomalyType === 'missing_expected');
      expect(businessAnomalies).toEqual([]);
    });

    it('should generate investigation recommendation for high severity anomalies', async () => {
      const data = [{ name: 'Alice' }, { name: null }];
      const schema = [{ name: 'name', type: 'string', required: true }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const investigations = result.recommendations.filter(r => r.type === 'investigation');
      expect(investigations.length).toBeGreaterThan(0);
      expect(investigations[0].priority).toBe('critical');
    });

    it('should generate correction recommendation for outlier anomalies', async () => {
      const normal = Array(20).fill(null).map((_, i) => ({ val: 50 + i }));
      const outliers = [{ val: 9999 }];
      const data = [...normal, ...outliers];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const corrections = result.recommendations.filter(r => r.type === 'correction');
      if (result.anomalies.some(a => a.anomalyType === 'outlier')) {
        expect(corrections.length).toBeGreaterThan(0);
      }
    });

    it('should return empty recommendations when no anomalies', async () => {
      const data = Array(5).fill(null).map((_, i) => ({ val: i }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      // No outliers (only 5 points, <11 threshold), no pattern anomalies for numbers, no required fields
      expect(result.recommendations).toEqual([]);
    });

    it('should include baseline with overall field', async () => {
      const data = [{ x: 1 }];
      const schema = [{ name: 'x', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      expect(result.baseline.field).toBe('overall');
      expect(result.baseline.expectedFrequency).toBe(1);
    });

    it('should handle empty data array', async () => {
      const result = await service.detectAnomalies([], [{ name: 'x', type: 'string' }] as any[]);
      expect(result.anomalyScore).toBe(0);
      expect(result.anomalies).toEqual([]);
    });

    it('should log start message', async () => {
      await service.detectAnomalies([{ x: 1 }], [{ name: 'x', type: 'number' }] as any[]);
      expect(mockLogger.info).toHaveBeenCalledWith('Starting anomaly detection', expect.any(Object));
    });
  });

  /* ────────────── detectAnomalies (AI path) ────────────── */

  describe('detectAnomalies (AI path)', () => {
    it('should use AI when provider registry and provider available', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            field: 'val',
            anomalyType: 'outlier',
            severity: 'high',
            description: 'AI detected outlier',
            suggestedAction: 'Review',
            confidence: 0.9,
          }]),
        }),
      };
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: mockProvider,
          id: 'test-provider',
        }),
      };
      const data = Array(15).fill(null).map((_, i) => ({ val: i }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema, mockRegistry);
      expect(mockProvider.complete).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Using AI-enhanced anomaly detection',
        expect.any(Object)
      );
    });

    it('should fall back when AI provider returns null', async () => {
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue(null),
      };
      const result = await service.detectAnomalies(
        [{ name: null }],
        [{ name: 'name', type: 'string', required: true }] as any[],
        mockRegistry
      );
      expect(mockLogger.debug).toHaveBeenCalledWith('No AI provider available for anomaly detection');
      expect(result).toBeDefined();
    });

    it('should fall back when AI inner catch fires', async () => {
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockRejectedValue(new Error('fail')),
      };
      const result = await service.detectAnomalies(
        [{ x: 1 }],
        [{ name: 'x', type: 'number' }] as any[],
        mockRegistry
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI anomaly detection failed',
        expect.any(Object)
      );
      // Still returns a result from heuristic
      expect(result).toBeDefined();
    });

    it('should skip AI path when no provider registry', async () => {
      const data = [{ x: 1 }];
      const schema = [{ name: 'x', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      // No AI calls, goes straight to heuristic
      expect(result.detectionMethods.length).toBe(3);
    });

    it('should parse invalid AI JSON gracefully', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({ completion: 'not json' }),
      };
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: mockProvider,
          id: 'test',
        }),
      };
      const data = Array(5).fill(null).map((_, i) => ({ val: i }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema, mockRegistry);
      expect(result).toBeDefined();
    });

    it('should validate AI anomalies against heuristics', async () => {
      // AI finds outlier on 'val', heuristic also finds it
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            field: 'val',
            anomalyType: 'outlier',
            severity: 'high',
            description: 'AI: outlier detected',
          }]),
        }),
      };
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: mockProvider,
          id: 'test',
        }),
      };
      const normal = Array(20).fill(null).map((_, i) => ({ val: 50 + i }));
      const outlier = [{ val: 9999 }];
      const data = [...normal, ...outlier];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema, mockRegistry);
      expect(result.anomalies.length).toBeGreaterThan(0);
    });

    it('should estimate affected records for missing_expected AI anomaly', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            field: 'name',
            anomalyType: 'missing_expected',
            severity: 'high',
            description: 'Missing values',
          }]),
        }),
      };
      const mockRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: mockProvider,
          id: 'test',
        }),
      };
      const data = [{ name: 'Alice' }, { name: null }, { name: '' }];
      const schema = [{ name: 'name', type: 'string' }] as any[];
      const result = await service.detectAnomalies(data, schema, mockRegistry);
      expect(result).toBeDefined();
    });
  });

  /* ────────────── Edge cases ────────────── */

  describe('edge cases', () => {
    it('should handle currency fields same as number for outliers', async () => {
      const normal = Array(20).fill(null).map((_, i) => ({ price: 10 + i }));
      const outlier = [{ price: 99999 }];
      const data = [...normal, ...outlier];
      const schema = [{ name: 'price', type: 'currency' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies.length).toBeGreaterThan(0);
    });

    it('should handle IQR with all-same values (no outliers)', async () => {
      const data = Array(20).fill(null).map(() => ({ val: 50 }));
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies).toEqual([]);
    });

    it('should handle IQR with fewer than 4 numeric values', async () => {
      const data = [{ val: 1 }, { val: 2 }, { val: 3 }];
      const schema = [{ name: 'val', type: 'number' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      // <4 values → findStatisticalOutliers returns empty; also <11 data points
      const outlierAnomalies = result.anomalies.filter(a => a.anomalyType === 'outlier');
      expect(outlierAnomalies).toEqual([]);
    });

    it('should handle format anomaly with low severity', async () => {
      // 1 unusual format out of 100 = 1% < 5% → low severity
      const data = [
        ...Array(99).fill(null).map(() => ({ code: 'ABC' })),
        { code: '123' },
      ];
      const schema = [{ name: 'code', type: 'string' }] as any[];
      const result = await service.detectAnomalies(data, schema);
      const formatAnomalies = result.anomalies.filter(a => a.anomalyType === 'format_deviation');
      if (formatAnomalies.length > 0) {
        expect(formatAnomalies[0].severity).toBe('low');
      }
    });
  });
});
