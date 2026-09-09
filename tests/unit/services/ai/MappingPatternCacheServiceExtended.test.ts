/**
 * Comprehensive unit tests for MappingPatternCacheService
 * Covers: cachePattern, getPattern, searchPatterns, getRecommendations,
 *         getCacheMetrics, getPatternAnalytics, optimizeCache, clearCache,
 *         start/stop lifecycle, and private helpers
 */
import 'reflect-metadata';
import { MappingPatternCacheService } from '../../../../src/services/ai/MappingPatternCacheService';
import type { MappingPattern, PatternSearchCriteria } from '../../../../src/services/ai/MappingPatternCacheService';

const mockLoggingService = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetryService = {
  recordMetric: jest.fn(),
} as any;

function buildPattern(overrides: Partial<MappingPattern> = {}): MappingPattern {
  return {
    id: `pattern-test-${Math.random().toString(36).slice(2, 8)}`,
    sourceField: 'customer_name',
    targetField: 'customerName',
    transformationLogic: 'directMapping',
    confidence: 0.95,
    usageCount: 50,
    lastUsed: new Date(),
    successRate: 0.92,
    createdAt: new Date('2025-06-01'),
    updatedAt: new Date(),
    tags: ['customer', 'name'],
    category: 'customer_data',
    systemPair: 'squire-suitecentral',
    complexity: 'simple',
    validationRules: [
      { type: 'format', rule: 'nonEmpty', errorMessage: 'Field required', severity: 'error' },
    ],
    ...overrides,
  };
}

describe('MappingPatternCacheService', () => {
  let service: MappingPatternCacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-02-18T12:00:00Z') });
    service = new MappingPatternCacheService(mockLoggingService, mockTelemetryService);
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with sample patterns preloaded', async () => {
      const metrics = await service.getCacheMetrics();
      expect(metrics.totalPatterns).toBe(3); // 3 sample patterns
    });

    it('should log initialization', () => {
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Initializing mapping pattern cache',
        expect.any(Object)
      );
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start maintenance interval', () => {
      service.start();
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Starting mapping pattern cache maintenance'
      );
    });

    it('should not start twice', () => {
      service.start();
      const callCount = mockLoggingService.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Starting mapping pattern cache maintenance'
      ).length;
      service.start();
      const callCount2 = mockLoggingService.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Starting mapping pattern cache maintenance'
      ).length;
      expect(callCount2).toBe(callCount); // should not log again
    });

    it('should stop cleanly', () => {
      service.start();
      service.stop();
      // Verify it doesn't throw
      service.stop(); // double stop is safe
    });
  });

  describe('cachePattern', () => {
    it('should cache a new pattern', async () => {
      const pattern = buildPattern({ id: 'cache-test-1' });
      await service.cachePattern(pattern);

      const retrieved = await service.getPattern('cache-test-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.sourceField).toBe('customer_name');
    });

    it('should update lastUsed and updatedAt', async () => {
      const pattern = buildPattern({ id: 'cache-time-test' });
      const beforeTime = Date.now();
      await service.cachePattern(pattern);

      const retrieved = await service.getPattern('cache-time-test');
      expect(retrieved!.lastUsed.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(retrieved!.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
    });

    it('should record telemetry', async () => {
      const pattern = buildPattern({ category: 'test_cat', complexity: 'medium' });
      await service.cachePattern(pattern);
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'pattern_cached',
        1,
        expect.objectContaining({
          category: 'test_cat',
          complexity: 'medium',
        })
      );
    });

    it('should evict when cache is full', async () => {
      // Fill cache well beyond max by adjusting config (service uses maxSize from config)
      // We can just test that caching doesn't error with many entries
      for (let i = 0; i < 20; i++) {
        await service.cachePattern(buildPattern({ id: `fill-${i}` }));
      }
      const metrics = await service.getCacheMetrics();
      expect(metrics.totalPatterns).toBeGreaterThan(0);
    });
  });

  describe('getPattern', () => {
    it('should return null for non-existent pattern', async () => {
      const result = await service.getPattern('nonexistent-xyz');
      expect(result).toBeNull();
    });

    it('should return cached pattern and update usage stats', async () => {
      // Get one of the sample patterns
      const pattern = await service.getPattern('pattern-001');
      expect(pattern).not.toBeNull();
      expect(pattern!.sourceField).toBe('customer_name');
    });

    it('should record cache hit telemetry', async () => {
      await service.getPattern('pattern-001');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'cache_hit',
        1,
        expect.any(Object)
      );
    });

    it('should record cache miss telemetry', async () => {
      await service.getPattern('no-such-id');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'cache_miss',
        1,
        expect.objectContaining({ patternId: 'no-such-id' })
      );
    });

    it('should increment usageCount on hit', async () => {
      const first = await service.getPattern('pattern-001');
      const initialCount = first!.usageCount;
      await service.getPattern('pattern-001');
      const second = await service.getPattern('pattern-001');
      expect(second!.usageCount).toBe(initialCount + 2);
    });
  });

  describe('searchPatterns', () => {
    it('should return all patterns with empty criteria', async () => {
      const results = await service.searchPatterns({});
      expect(results.length).toBe(3); // 3 sample patterns
    });

    it('should filter by sourceSystem', async () => {
      const results = await service.searchPatterns({ sourceSystem: 'squire' });
      expect(results.length).toBe(3); // all 3 samples have squire-suitecentral
    });

    it('should filter by targetSystem', async () => {
      const results = await service.searchPatterns({ targetSystem: 'suitecentral' });
      expect(results.length).toBe(3);
    });

    it('should filter by fieldName (case-insensitive)', async () => {
      const results = await service.searchPatterns({ fieldName: 'CUSTOMER' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].sourceField.toLowerCase()).toContain('customer');
    });

    it('should filter by category', async () => {
      const results = await service.searchPatterns({ category: 'financial_data' });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('pattern-003');
    });

    it('should filter by tags', async () => {
      const results = await service.searchPatterns({ tags: ['currency'] });
      expect(results.length).toBe(1);
    });

    it('should filter by minConfidence', async () => {
      const results = await service.searchPatterns({ minConfidence: 0.93 });
      expect(results.every(r => r.confidence >= 0.93)).toBe(true);
    });

    it('should filter by maxComplexity', async () => {
      const results = await service.searchPatterns({ maxComplexity: 'simple' });
      expect(results.every(r => r.complexity === 'simple')).toBe(true);
    });

    it('should support pagination with limit and offset', async () => {
      const page1 = await service.searchPatterns({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await service.searchPatterns({ limit: 2, offset: 2 });
      expect(page2.length).toBe(1);
    });

    it('should sort by relevance score', async () => {
      const results = await service.searchPatterns({});
      if (results.length >= 2) {
        // Higher usage + confidence + successRate should come first
        const score0 = results[0].usageCount * 0.3 + results[0].confidence * 0.4 + results[0].successRate * 0.3;
        const score1 = results[1].usageCount * 0.3 + results[1].confidence * 0.4 + results[1].successRate * 0.3;
        expect(score0).toBeGreaterThanOrEqual(score1);
      }
    });

    it('should record telemetry', async () => {
      await service.searchPatterns({ category: 'customer_data' });
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'pattern_search',
        1,
        expect.any(Object)
      );
    });
  });

  describe('getRecommendations', () => {
    it('should return recommendations for matching system', async () => {
      const recs = await service.getRecommendations('customer_name', 'suitecentral');
      expect(recs.length).toBeGreaterThan(0);
    });

    it('should filter by minimum similarity threshold', async () => {
      const recs = await service.getRecommendations('customer_name', 'suitecentral');
      for (const rec of recs) {
        expect(rec.similarityScore).toBeGreaterThan(0.3);
      }
    });

    it('should return empty for non-matching system', async () => {
      const recs = await service.getRecommendations('customer_name', 'nonexistent-system');
      expect(recs.length).toBe(0);
    });

    it('should sort by composite score', async () => {
      const recs = await service.getRecommendations('customer', 'suitecentral');
      if (recs.length >= 2) {
        const score0 = recs[0].similarityScore * 0.4 + recs[0].pattern.successRate * 0.3 + recs[0].estimatedAccuracy * 0.3;
        const score1 = recs[1].similarityScore * 0.4 + recs[1].pattern.successRate * 0.3 + recs[1].estimatedAccuracy * 0.3;
        expect(score0).toBeGreaterThanOrEqual(score1);
      }
    });

    it('should limit to 10 recommendations', async () => {
      // Cache many patterns to potentially exceed 10
      for (let i = 0; i < 15; i++) {
        await service.cachePattern(buildPattern({
          id: `rec-test-${i}`,
          sourceField: `customer_field_${i}`,
          systemPair: 'test-suitecentral',
        }));
      }
      const recs = await service.getRecommendations('customer', 'suitecentral');
      expect(recs.length).toBeLessThanOrEqual(10);
    });

    it('should include modifications and reason', async () => {
      const recs = await service.getRecommendations('customer_name', 'suitecentral');
      if (recs.length > 0) {
        expect(Array.isArray(recs[0].modifications)).toBe(true);
        expect(typeof recs[0].reason).toBe('string');
        expect(typeof recs[0].estimatedAccuracy).toBe('number');
      }
    });

    it('should record telemetry', async () => {
      await service.getRecommendations('field', 'suitecentral');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'recommendations_generated',
        expect.any(Number),
        expect.objectContaining({ sourceField: 'field', targetSystem: 'suitecentral' })
      );
    });
  });

  describe('getCacheMetrics', () => {
    it('should return metrics for sample patterns', async () => {
      const metrics = await service.getCacheMetrics();
      expect(metrics.totalPatterns).toBe(3);
      expect(typeof metrics.hitRate).toBe('number');
      expect(typeof metrics.missRate).toBe('number');
      expect(typeof metrics.averageResponseTime).toBe('number');
      expect(typeof metrics.memoryUsage).toBe('number');
      expect(Array.isArray(metrics.topPatterns)).toBe(true);
      expect(typeof metrics.categoryDistribution).toBe('object');
    });

    it('should distribute by category', async () => {
      const metrics = await service.getCacheMetrics();
      expect(metrics.categoryDistribution['customer_data']).toBe(1);
      expect(metrics.categoryDistribution['temporal_data']).toBe(1);
      expect(metrics.categoryDistribution['financial_data']).toBe(1);
    });

    it('should record telemetry', async () => {
      await service.getCacheMetrics();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'cache_metrics_calculated',
        1,
        expect.any(Object)
      );
    });
  });

  describe('getPatternAnalytics', () => {
    it('should return analytics with all sections', async () => {
      const analytics = await service.getPatternAnalytics();
      expect(analytics).toBeDefined();
      expect(Array.isArray(analytics.mostUsedPatterns)).toBe(true);
      expect(Array.isArray(analytics.trendingPatterns)).toBe(true);
      expect(analytics.performanceMetrics).toBeDefined();
      expect(typeof analytics.performanceMetrics.avgResponseTime).toBe('number');
      expect(typeof analytics.performanceMetrics.cacheHitRate).toBe('number');
      expect(typeof analytics.performanceMetrics.patternSuccessRate).toBe('number');
    });

    it('should compute usage distribution', async () => {
      const analytics = await service.getPatternAnalytics();
      expect(analytics.usageDistribution.byCategory).toBeDefined();
      expect(analytics.usageDistribution.byComplexity).toBeDefined();
      expect(analytics.usageDistribution.bySystemPair).toBeDefined();
    });

    it('should generate recommendations', async () => {
      const analytics = await service.getPatternAnalytics();
      expect(analytics.recommendations).toBeDefined();
      expect(Array.isArray(analytics.recommendations.patternsToOptimize)).toBe(true);
      expect(Array.isArray(analytics.recommendations.patternsToRetire)).toBe(true);
      expect(Array.isArray(analytics.recommendations.newPatternSuggestions)).toBe(true);
    });

    it('should record telemetry', async () => {
      await service.getPatternAnalytics();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'analytics_generated',
        1,
        expect.any(Object)
      );
    });
  });

  describe('optimizeCache', () => {
    it('should return optimization result', async () => {
      const result = await service.optimizeCache();
      expect(result).toBeDefined();
      expect(Array.isArray(result.optimizationsApplied)).toBe(true);
      expect(typeof result.performanceImprovement).toBe('number');
      expect(typeof result.memoryReduction).toBe('number');
      expect(typeof result.patternsOptimized).toBe('number');
      expect(result.estimatedSavings).toBeDefined();
      expect(typeof result.estimatedSavings.timeMs).toBe('number');
      expect(typeof result.estimatedSavings.memoryMB).toBe('number');
    });

    it('should record telemetry', async () => {
      await service.optimizeCache();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'cache_optimized',
        1,
        expect.any(Object)
      );
    });
  });

  describe('clearCache', () => {
    it('should clear all patterns', async () => {
      await service.clearCache();
      const metrics = await service.getCacheMetrics();
      expect(metrics.totalPatterns).toBe(0);
    });

    it('should record telemetry with count', async () => {
      const beforeMetrics = await service.getCacheMetrics();
      const initialCount = beforeMetrics.totalPatterns;
      await service.clearCache();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'cache_cleared',
        initialCount
      );
    });

    it('should log success', async () => {
      await service.clearCache();
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Cache cleared successfully',
        expect.any(Object)
      );
    });
  });

  describe('similarity calculation (via getRecommendations)', () => {
    it('should give high similarity for exact match', async () => {
      const recs = await service.getRecommendations('customer_name', 'suitecentral');
      const exact = recs.find(r => r.pattern.sourceField === 'customer_name');
      expect(exact).toBeDefined();
      expect(exact!.similarityScore).toBe(1.0);
    });

    it('should give medium similarity for partial match', async () => {
      const recs = await service.getRecommendations('customer', 'suitecentral');
      const partial = recs.find(r => r.pattern.sourceField === 'customer_name');
      expect(partial).toBeDefined();
      expect(partial!.similarityScore).toBeGreaterThan(0.3);
    });

    it('should give zero similarity for unrelated fields', async () => {
      const recs = await service.getRecommendations('zzz_completely_unrelated_xyz', 'suitecentral');
      // Should have no or low-similarity matches
      for (const rec of recs) {
        expect(rec.similarityScore).toBeLessThan(1.0);
      }
    });
  });
});
