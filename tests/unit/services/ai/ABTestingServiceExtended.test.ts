/**
 * Comprehensive unit tests for ABTestingService
 * Covers: assignVariant, recordTestResult, recordUserAcceptance,
 *         analyzeTest, getActiveTests, configureTest, getTestResults
 */
import 'reflect-metadata';
import { ABTestingService, type ABTestConfig, type ABTestResult } from '../../../../src/services/ai/ABTestingService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetry = {
  recordFeatureUsed: jest.fn().mockResolvedValue(undefined),
} as any;

function makeResult(overrides: Partial<ABTestResult> = {}): Omit<ABTestResult, 'timestamp'> {
  return {
    sessionId: `session-${Math.random().toString(36).substr(2, 5)}`,
    testId: 'ai-vs-heuristic-v1',
    variant: 'control',
    providerId: 'rule-based',
    suggestions: [
      { sourceField: 'name', targetField: 'Name', confidence: 0.9, reasoning: 'direct match' } as any,
    ],
    qualityMetrics: {
      avgConfidence: 0.85,
      suggestionsCount: 3,
      highConfidenceSuggestions: 2,
      processingTime: 150,
      cost: 0.01,
    },
    context: {
      sourceSystem: 'salesforce',
      targetSystem: 'netsuite',
      sourceFields: [],
      targetFields: [],
    } as any,
    ...overrides,
  };
}

describe('ABTestingService', () => {
  let service: ABTestingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ABTestingService(mockLogger, mockTelemetry);
  });

  describe('assignVariant', () => {
    it('should assign control or treatment based on session hash', () => {
      const result = service.assignVariant('test-session-1');
      expect(['control', 'treatment']).toContain(result.variant);
      expect(result.testId).toBe('ai-vs-heuristic-v1');
      expect(result.providerId).toBeDefined();
    });

    it('should return consistent assignments for same session ID', () => {
      const r1 = service.assignVariant('consistent-session');
      const r2 = service.assignVariant('consistent-session');
      expect(r1.variant).toBe(r2.variant);
      expect(r1.providerId).toBe(r2.providerId);
    });

    it('should fallback to control for disabled test', () => {
      service.configureTest({
        testId: 'disabled-test',
        name: 'Disabled',
        description: 'A disabled test',
        enabled: false,
        trafficSplit: { control: 50, treatment: 50 },
        providers: { control: 'rule-based', treatment: 'openai' },
        successMetrics: [],
        minimumSampleSize: 10,
      });
      const result = service.assignVariant('session-x', 'disabled-test');
      expect(result.variant).toBe('control');
      expect(result.testId).toBe('fallback');
    });

    it('should fallback to control for nonexistent test', () => {
      const result = service.assignVariant('session-x', 'nonexistent');
      expect(result.variant).toBe('control');
      expect(result.testId).toBe('fallback');
    });

    it('should use specific test when testId provided', () => {
      service.configureTest({
        testId: 'custom-test',
        name: 'Custom Test',
        description: 'A custom A/B test',
        enabled: true,
        trafficSplit: { control: 0, treatment: 100 },
        providers: { control: 'rule-based', treatment: 'claude' },
        successMetrics: ['acceptance_rate'],
        minimumSampleSize: 5,
      });
      const result = service.assignVariant('session-abc', 'custom-test');
      expect(result.variant).toBe('treatment');
      expect(result.providerId).toBe('claude');
      expect(result.testId).toBe('custom-test');
    });

    it('should assign all to control when split is 100/0', () => {
      service.configureTest({
        testId: 'all-control',
        name: 'All Control',
        description: 'Test with 100% control',
        enabled: true,
        trafficSplit: { control: 100, treatment: 0 },
        providers: { control: 'rule-based', treatment: 'openai' },
        successMetrics: [],
        minimumSampleSize: 10,
      });
      // Any session should get control
      for (let i = 0; i < 10; i++) {
        const result = service.assignVariant(`session-${i}`, 'all-control');
        expect(result.variant).toBe('control');
      }
    });

    it('should log variant assignment', () => {
      service.assignVariant('log-session');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'A/B test variant assigned',
        expect.objectContaining({
          sessionId: 'log-session',
          testId: 'ai-vs-heuristic-v1',
        })
      );
    });
  });

  describe('recordTestResult', () => {
    it('should record a test result', async () => {
      const result = makeResult({ sessionId: 'rec-1' });
      await service.recordTestResult(result);
      const results = service.getTestResults('ai-vs-heuristic-v1');
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe('rec-1');
      expect(results[0].timestamp).toBeInstanceOf(Date);
    });

    it('should record telemetry', async () => {
      await service.recordTestResult(makeResult({ variant: 'treatment', providerId: 'openai' }));
      expect(mockTelemetry.recordFeatureUsed).toHaveBeenCalledWith(
        'ab_test_treatment_openai',
        expect.any(String)
      );
    });

    it('should log result recording', async () => {
      await service.recordTestResult(makeResult({ sessionId: 'log-rec' }));
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'A/B test result recorded',
        expect.objectContaining({ sessionId: 'log-rec' })
      );
    });
  });

  describe('recordUserAcceptance', () => {
    it('should record acceptance for existing result', async () => {
      await service.recordTestResult(makeResult({
        sessionId: 'accept-session',
        testId: 'ai-vs-heuristic-v1',
      }));
      await service.recordUserAcceptance('accept-session', 'ai-vs-heuristic-v1', 3, 5);
      const results = service.getTestResults('ai-vs-heuristic-v1');
      const result = results.find(r => r.sessionId === 'accept-session');
      expect(result!.userAcceptance).toBeDefined();
      expect(result!.userAcceptance!.acceptedSuggestions).toBe(3);
      expect(result!.userAcceptance!.totalSuggestions).toBe(5);
      expect(result!.userAcceptance!.acceptanceRate).toBeCloseTo(0.6);
    });

    it('should warn when no matching result found', async () => {
      await service.recordUserAcceptance('nonexistent', 'ai-vs-heuristic-v1', 1, 1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No test result found for user acceptance',
        expect.objectContaining({ sessionId: 'nonexistent' })
      );
    });

    it('should handle zero total suggestions', async () => {
      await service.recordTestResult(makeResult({
        sessionId: 'zero-total',
        testId: 'ai-vs-heuristic-v1',
      }));
      await service.recordUserAcceptance('zero-total', 'ai-vs-heuristic-v1', 0, 0);
      const results = service.getTestResults('ai-vs-heuristic-v1');
      const result = results.find(r => r.sessionId === 'zero-total');
      expect(result!.userAcceptance!.acceptanceRate).toBe(0);
    });

    it('should record telemetry for acceptance', async () => {
      await service.recordTestResult(makeResult({
        sessionId: 'telem-accept',
        testId: 'ai-vs-heuristic-v1',
        variant: 'treatment',
      }));
      await service.recordUserAcceptance('telem-accept', 'ai-vs-heuristic-v1', 2, 4);
      expect(mockTelemetry.recordFeatureUsed).toHaveBeenCalledWith(
        'ab_test_acceptance_treatment',
        'telem-accept'
      );
    });
  });

  describe('analyzeTest', () => {
    it('should throw for nonexistent test', async () => {
      await expect(service.analyzeTest('nonexistent'))
        .rejects.toThrow('Test nonexistent not found');
    });

    it('should return insufficient_data with no results', async () => {
      const analysis = await service.analyzeTest('ai-vs-heuristic-v1');
      expect(analysis.status).toBe('insufficient_data');
      expect(analysis.sampleSizes.control).toBe(0);
      expect(analysis.sampleSizes.treatment).toBe(0);
    });

    it('should return zero metrics for empty results', async () => {
      const analysis = await service.analyzeTest('ai-vs-heuristic-v1');
      expect(analysis.results.control.avgAcceptanceRate).toBe(0);
      expect(analysis.results.control.avgConfidence).toBe(0);
      expect(analysis.results.treatment.avgAcceptanceRate).toBe(0);
    });

    it('should calculate metrics with results', async () => {
      // Add control results
      for (let i = 0; i < 15; i++) {
        const r = makeResult({
          sessionId: `ctrl-${i}`,
          variant: 'control',
          providerId: 'rule-based',
          qualityMetrics: {
            avgConfidence: 0.7,
            suggestionsCount: 3,
            highConfidenceSuggestions: 1,
            processingTime: 50,
            cost: 0,
          },
        });
        await service.recordTestResult(r);
        await service.recordUserAcceptance(`ctrl-${i}`, 'ai-vs-heuristic-v1', 2, 4);
      }

      // Add treatment results
      for (let i = 0; i < 15; i++) {
        const r = makeResult({
          sessionId: `treat-${i}`,
          variant: 'treatment',
          providerId: 'openai',
          qualityMetrics: {
            avgConfidence: 0.9,
            suggestionsCount: 5,
            highConfidenceSuggestions: 4,
            processingTime: 200,
            cost: 0.02,
          },
        });
        await service.recordTestResult(r);
        await service.recordUserAcceptance(`treat-${i}`, 'ai-vs-heuristic-v1', 4, 5);
      }

      const analysis = await service.analyzeTest('ai-vs-heuristic-v1');
      expect(analysis.sampleSizes.control).toBe(15);
      expect(analysis.sampleSizes.treatment).toBe(15);
      expect(analysis.results.control.avgConfidence).toBeCloseTo(0.7);
      expect(analysis.results.treatment.avgConfidence).toBeCloseTo(0.9);
      expect(analysis.results.treatment.avgAcceptanceRate).toBeGreaterThan(
        analysis.results.control.avgAcceptanceRate
      );
    });

    it('should determine winning variant', async () => {
      // Add enough data for significance
      for (let i = 0; i < 12; i++) {
        await service.recordTestResult(makeResult({
          sessionId: `w-ctrl-${i}`,
          variant: 'control',
          qualityMetrics: { avgConfidence: 0.6, suggestionsCount: 3, highConfidenceSuggestions: 1, processingTime: 50, cost: 0 },
        }));
        await service.recordUserAcceptance(`w-ctrl-${i}`, 'ai-vs-heuristic-v1', 1, 4);
      }
      for (let i = 0; i < 12; i++) {
        await service.recordTestResult(makeResult({
          sessionId: `w-treat-${i}`,
          variant: 'treatment',
          providerId: 'openai',
          qualityMetrics: { avgConfidence: 0.9, suggestionsCount: 5, highConfidenceSuggestions: 4, processingTime: 80, cost: 0.01 },
        }));
        await service.recordUserAcceptance(`w-treat-${i}`, 'ai-vs-heuristic-v1', 4, 5);
      }

      const analysis = await service.analyzeTest('ai-vs-heuristic-v1');
      expect(['control', 'treatment', 'inconclusive']).toContain(analysis.winningVariant);
      expect(analysis.recommendations.length).toBeGreaterThan(0);
    });

    it('should detect completed status when enough samples', async () => {
      // Need minimumSampleSize * 2 = 60 per variant for completed
      for (let i = 0; i < 61; i++) {
        await service.recordTestResult(makeResult({ sessionId: `c-ctrl-${i}`, variant: 'control' }));
        await service.recordTestResult(makeResult({ sessionId: `c-treat-${i}`, variant: 'treatment', providerId: 'openai' }));
      }

      const analysis = await service.analyzeTest('ai-vs-heuristic-v1');
      expect(analysis.status).toBe('completed');
    });
  });

  describe('getActiveTests', () => {
    it('should return default test', () => {
      const tests = service.getActiveTests();
      expect(tests.length).toBe(1);
      expect(tests[0].testId).toBe('ai-vs-heuristic-v1');
    });

    it('should include newly configured enabled tests', () => {
      service.configureTest({
        testId: 'new-test',
        name: 'New Test',
        description: 'Another test',
        enabled: true,
        trafficSplit: { control: 50, treatment: 50 },
        providers: { control: 'rule-based', treatment: 'claude' },
        successMetrics: [],
        minimumSampleSize: 10,
      });
      const tests = service.getActiveTests();
      expect(tests.length).toBe(2);
    });

    it('should exclude disabled tests', () => {
      service.configureTest({
        testId: 'disabled-test',
        name: 'Disabled',
        description: 'Disabled test',
        enabled: false,
        trafficSplit: { control: 50, treatment: 50 },
        providers: { control: 'rule-based', treatment: 'openai' },
        successMetrics: [],
        minimumSampleSize: 10,
      });
      const tests = service.getActiveTests();
      expect(tests.every(t => t.enabled)).toBe(true);
    });
  });

  describe('configureTest', () => {
    it('should add a new test', () => {
      service.configureTest({
        testId: 'configured-test',
        name: 'Configured',
        description: 'Configured test',
        enabled: true,
        trafficSplit: { control: 30, treatment: 70 },
        providers: { control: 'rule-based', treatment: 'claude' },
        successMetrics: ['acceptance_rate'],
        minimumSampleSize: 20,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'A/B test configured',
        expect.objectContaining({ testId: 'configured-test' })
      );
    });

    it('should update existing test', () => {
      service.configureTest({
        testId: 'ai-vs-heuristic-v1',
        name: 'Updated Test',
        description: 'Updated description',
        enabled: false,
        trafficSplit: { control: 80, treatment: 20 },
        providers: { control: 'rule-based', treatment: 'openai' },
        successMetrics: [],
        minimumSampleSize: 50,
      });
      const tests = service.getActiveTests();
      // Default test is now disabled
      expect(tests.find(t => t.testId === 'ai-vs-heuristic-v1')).toBeUndefined();
    });
  });

  describe('getTestResults', () => {
    it('should return empty array initially', () => {
      expect(service.getTestResults()).toEqual([]);
    });

    it('should filter by testId', async () => {
      await service.recordTestResult(makeResult({ testId: 'ai-vs-heuristic-v1', sessionId: 's1' }));
      await service.recordTestResult(makeResult({ testId: 'other-test', sessionId: 's2' }));
      const results = service.getTestResults('ai-vs-heuristic-v1');
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe('s1');
    });

    it('should return all results when no testId', async () => {
      await service.recordTestResult(makeResult({ testId: 'ai-vs-heuristic-v1', sessionId: 's1' }));
      await service.recordTestResult(makeResult({ testId: 'other', sessionId: 's2' }));
      const results = service.getTestResults();
      expect(results.length).toBe(2);
    });
  });
});
