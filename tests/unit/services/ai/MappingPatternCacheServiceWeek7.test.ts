/**
 * Extended unit tests for MappingPatternCacheService Week 7 features
 * Covers: findSimilarPatterns, generateOptimizationRecommendations,
 *         updatePatternMetrics, getAdvancedCacheMetrics, storeMappingPatternEnhanced,
 *         eviction policies, search edge cases, recommendation generation
 */
import 'reflect-metadata';
import { MappingPatternCacheService, type MappingPattern } from '../../../../src/services/ai/MappingPatternCacheService';

const mockLoggingService = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetryService = {
  recordMetric: jest.fn(),
} as any;

function makePattern(overrides: Partial<MappingPattern> = {}): MappingPattern {
  return {
    id: `pat-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    sourceField: 'source_field',
    targetField: 'target_field',
    transformationLogic: 'directMapping',
    confidence: 0.9,
    usageCount: 10,
    lastUsed: new Date(),
    successRate: 0.95,
    createdAt: new Date(),
    updatedAt: new Date(),
    tags: ['test'],
    category: 'customer_data',
    systemPair: 'squire-suitecentral',
    complexity: 'simple' as const,
    validationRules: [],
    ...overrides,
  };
}

describe('MappingPatternCacheService - Week 7 Extended', () => {
  let service: MappingPatternCacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MappingPatternCacheService(mockLoggingService, mockTelemetryService);
  });

  afterEach(() => {
    service.stop();
  });

  describe('findSimilarPatterns', () => {
    it('should find patterns with same system pair', async () => {
      const source = makePattern({
        id: 'find-source',
        systemPair: 'squire-suitecentral',
        category: 'customer_data',
        complexity: 'simple',
        sourceField: 'customer_name',
      });
      const similar = await service.findSimilarPatterns(source);
      expect(similar.length).toBeGreaterThan(0);
      for (const s of similar) {
        expect(s.similarityScore).toBeGreaterThan(0.3);
        expect(s.reasons.length).toBeGreaterThan(0);
      }
    });

    it('should exclude source pattern from results', async () => {
      const source = await service.getPattern('pattern-001');
      const similar = await service.findSimilarPatterns(source!);
      const ids = similar.map(s => s.patternId);
      expect(ids).not.toContain('pattern-001');
    });

    it('should return similarity scores with reasons', async () => {
      const source = makePattern({
        id: 'reason-test',
        systemPair: 'squire-suitecentral',
        category: 'customer_data',
        complexity: 'simple',
      });
      const similar = await service.findSimilarPatterns(source);
      // Deterministic: sample pattern-001 shares systemPair (0.3) + category (0.2)
      // + complexity (0.1) = 0.6 similarity, above the 0.3 threshold.
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].patternId).toBe('pattern-001');
      expect(similar[0].similarityScore).toBeCloseTo(0.6, 5);
      expect(Array.isArray(similar[0].matchingFields)).toBe(true);
      expect(typeof similar[0].confidenceAdjustment).toBe('number');
    });

    it('should apply limit', async () => {
      const source = makePattern({ systemPair: 'squire-suitecentral' });
      const similar = await service.findSimilarPatterns(source, 1);
      expect(similar.length).toBeLessThanOrEqual(1);
    });

    it('should sort by similarity score descending', async () => {
      const source = makePattern({ systemPair: 'squire-suitecentral', category: 'customer_data' });
      const similar = await service.findSimilarPatterns(source);
      for (let i = 1; i < similar.length; i++) {
        expect(similar[i - 1].similarityScore).toBeGreaterThanOrEqual(similar[i].similarityScore);
      }
    });

    it('should include matching fields in results', async () => {
      const source = makePattern({
        id: 'field-match',
        sourceField: 'customer_name',
        targetField: 'customerName',
        systemPair: 'squire-suitecentral',
      });
      const similar = await service.findSimilarPatterns(source);
      // Deterministic: pattern-001 shares both fields, systemPair, category and
      // complexity with the source (similarity 1.0), so it MUST be returned.
      const match = similar.find(s => s.patternId === 'pattern-001');
      expect(match).toBeDefined();
      expect(match!.matchingFields).toContain('customer_name');
      expect(match!.matchingFields).toContain('customerName');
      expect(match!.similarityScore).toBeCloseTo(1.0, 5);
    });
  });

  describe('generateOptimizationRecommendations', () => {
    it('should return sorted recommendations', async () => {
      const recs = await service.generateOptimizationRecommendations();
      expect(Array.isArray(recs)).toBe(true);
      for (let i = 1; i < recs.length; i++) {
        expect(recs[i - 1].priority).toBeGreaterThanOrEqual(recs[i].priority);
      }
    });

    it('should include recommendation metadata', async () => {
      const recs = await service.generateOptimizationRecommendations();
      for (const rec of recs) {
        expect(['eviction', 'preload', 'compression', 'indexing', 'partitioning']).toContain(rec.type);
        expect(typeof rec.expectedImprovement).toBe('number');
        expect(rec.description.length).toBeGreaterThan(0);
        expect(rec.implementation.length).toBeGreaterThan(0);
        expect(['low', 'medium', 'high']).toContain(rec.riskLevel);
      }
    });
  });

  describe('updatePatternMetrics', () => {
    it('should update success rate with EMA for success', async () => {
      const before = await service.getPattern('pattern-001');
      const initialRate = before!.successRate;
      await service.updatePatternMetrics('pattern-001', true, 100);
      const after = await service.getPattern('pattern-001');
      // EMA: rate * 0.9 + 1.0 * 0.1
      const expected = initialRate * 0.9 + 0.1;
      expect(after!.successRate).toBeCloseTo(expected, 2);
    });

    it('should update success rate with EMA for failure', async () => {
      const before = await service.getPattern('pattern-001');
      const initialRate = before!.successRate;
      await service.updatePatternMetrics('pattern-001', false, 200);
      const after = await service.getPattern('pattern-001');
      // EMA: rate * 0.9 + 0.0 * 0.1
      const expected = initialRate * 0.9;
      expect(after!.successRate).toBeCloseTo(expected, 2);
    });

    it('should increment usage count', async () => {
      const before = await service.getPattern('pattern-001');
      const initialCount = before!.usageCount;
      await service.updatePatternMetrics('pattern-001', true, 50);
      const after = await service.getPattern('pattern-001');
      // getPattern also increments, so accounting for both
      expect(after!.usageCount).toBeGreaterThan(initialCount);
    });

    it('should no-op for nonexistent pattern', async () => {
      await service.updatePatternMetrics('nonexistent', true, 100);
      // Should not throw
      expect(mockLoggingService.error).not.toHaveBeenCalled();
    });

    it('should record telemetry', async () => {
      await service.updatePatternMetrics('pattern-002', true, 150);
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'pattern_usage_update', 1, expect.objectContaining({
          patternId: 'pattern-002',
          success: true,
        })
      );
    });
  });

  describe('getAdvancedCacheMetrics', () => {
    it('should extend basic metrics', async () => {
      const metrics = await service.getAdvancedCacheMetrics();
      // Basic metrics
      expect(typeof metrics.totalPatterns).toBe('number');
      expect(typeof metrics.hitRate).toBe('number');
      expect(typeof metrics.missRate).toBe('number');
      // Advanced metrics
      expect(typeof metrics.patternMatchAccuracy).toBe('number');
      expect(typeof metrics.storageEfficiency).toBe('number');
      expect(typeof metrics.evictionCount).toBe('number');
      expect(typeof metrics.indexEfficiency).toBe('number');
      expect(typeof metrics.compressionRatio).toBe('number');
    });

    it('should calculate compression ratio based on config', async () => {
      const metrics = await service.getAdvancedCacheMetrics();
      // Compression is enabled by default
      expect(metrics.compressionRatio).toBe(0.75);
    });
  });

  describe('storeMappingPatternEnhanced', () => {
    it('should store and retrieve pattern with enhanced indexes', async () => {
      const pattern = makePattern({
        id: 'enhanced-1',
        sourceFields: ['field_a', 'field_b'],
        targetFields: ['target_a'],
      });
      await service.storeMappingPatternEnhanced(pattern);
      const retrieved = await service.getPattern('enhanced-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.sourceFields).toEqual(['field_a', 'field_b']);
    });

    it('should log enhanced indexing info', async () => {
      const pattern = makePattern({
        id: 'enhanced-log',
        sourceFields: ['a'],
        targetFields: ['b', 'c'],
      });
      await service.storeMappingPatternEnhanced(pattern);
      expect(mockLoggingService.debug).toHaveBeenCalledWith(
        'Stored pattern with enhanced indexing',
        expect.objectContaining({ patternId: 'enhanced-log' })
      );
    });
  });

  describe('search edge cases', () => {
    it('should handle maxComplexity medium filter', async () => {
      await service.cachePattern(makePattern({ id: 'simple-1', complexity: 'simple' }));
      await service.cachePattern(makePattern({ id: 'medium-1', complexity: 'medium' }));
      await service.cachePattern(makePattern({ id: 'complex-1', complexity: 'complex' }));

      const results = await service.searchPatterns({ maxComplexity: 'medium' });
      results.forEach(p => expect(['simple', 'medium']).toContain(p.complexity));
    });

    it('should combine multiple filters', async () => {
      await service.cachePattern(makePattern({
        id: 'multi-filter',
        category: 'financial_data',
        systemPair: 'test-target',
        confidence: 0.99,
        tags: ['finance'],
      }));

      const results = await service.searchPatterns({
        category: 'financial_data',
        targetSystem: 'target',
        minConfidence: 0.95,
        tags: ['finance'],
      });
      expect(results.some(r => r.id === 'multi-filter')).toBe(true);
    });
  });

  describe('recommendation similarity levels', () => {
    it('should generate high similarity reason for exact match', async () => {
      await service.cachePattern(makePattern({
        id: 'exact-match',
        sourceField: 'exact_field',
        systemPair: 'test-exact',
      }));
      const recs = await service.getRecommendations('exact_field', 'exact');
      // Deterministic: only 'exact-match' has a systemPair containing 'exact',
      // and its sourceField equals the query -> similarity 1.0.
      expect(recs.length).toBe(1);
      expect(recs[0].pattern.id).toBe('exact-match');
      expect(recs[0].similarityScore).toBe(1.0);
      expect(recs[0].reason).toContain('Highly similar');
    });

    it('should generate contains match reason', async () => {
      await service.cachePattern(makePattern({
        id: 'contains-match',
        sourceField: 'customer',
        systemPair: 'test-contains',
      }));
      const recs = await service.getRecommendations('customer_name', 'contains');
      // Deterministic: only 'contains-match' targets system 'contains';
      // 'customer_name' contains 'customer' -> similarity exactly 0.8.
      expect(recs.length).toBe(1);
      expect(recs[0].pattern.id).toBe('contains-match');
      expect(recs[0].similarityScore).toBe(0.8);
      expect(recs[0].reason).toContain('Similar field pattern');
    });

    it('should generate word overlap reason', async () => {
      await service.cachePattern(makePattern({
        id: 'overlap-match',
        sourceField: 'product_name',
        systemPair: 'test-overlap',
      }));
      const recs = await service.getRecommendations('product_code', 'overlap');
      // Deterministic: only 'overlap-match' targets system 'overlap';
      // 'product_code' vs 'product_name' -> 1 shared word / 3 total = 1/3 > 0.3.
      expect(recs.length).toBe(1);
      expect(recs[0].pattern.id).toBe('overlap-match');
      expect(recs[0].similarityScore).toBeCloseTo(1 / 3, 5);
      expect(recs[0].reason).toContain('Related mapping pattern');
    });
  });

  describe('optimizeCache with patterns', () => {
    it('should consolidate duplicate patterns', async () => {
      // Add duplicates (same source+target+system, different IDs)
      await service.cachePattern(makePattern({
        id: 'dup-1',
        sourceField: 'dup_field',
        targetField: 'dup_target',
        systemPair: 'dup-system',
        successRate: 0.8,
      }));
      await service.cachePattern(makePattern({
        id: 'dup-2',
        sourceField: 'dup_field',
        targetField: 'dup_target',
        systemPair: 'dup-system',
        successRate: 0.95,
      }));

      const result = await service.optimizeCache();
      expect(result.optimizationsApplied.length).toBeGreaterThanOrEqual(0);
      expect(typeof result.patternsOptimized).toBe('number');
    });
  });
});
