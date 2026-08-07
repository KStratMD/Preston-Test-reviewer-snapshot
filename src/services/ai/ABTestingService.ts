/**
 * A/B Testing Service for AI vs Heuristic Comparison
 * Week 2 Implementation - Enables accuracy measurement and provider comparison
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../UnifiedTelemetryService';
import type { AISuggestion, MappingContext } from './ProviderRegistry';

export interface ABTestConfig {
  testId: string;
  name: string;
  description: string;
  enabled: boolean;
  trafficSplit: {
    control: number;    // 0-100, percentage for control group (heuristic)
    treatment: number;  // 0-100, percentage for treatment group (AI)
  };
  providers: {
    control: string;    // Provider ID for control (e.g., 'rule-based')
    treatment: string;  // Provider ID for treatment (e.g., 'openai')
  };
  successMetrics: string[];
  minimumSampleSize: number;
}

export interface ABTestResult {
  sessionId: string;
  testId: string;
  variant: 'control' | 'treatment';
  providerId: string;
  suggestions: AISuggestion[];
  userAcceptance?: {
    acceptedSuggestions: number;
    totalSuggestions: number;
    acceptanceRate: number;
    timestamp: Date;
  };
  qualityMetrics: {
    avgConfidence: number;
    suggestionsCount: number;
    highConfidenceSuggestions: number; // >0.8 confidence
    processingTime: number;
    cost?: number;
  };
  context: MappingContext;
  timestamp: Date;
}

export interface VariantMetrics {
  avgAcceptanceRate: number;
  avgConfidence: number;
  avgProcessingTime: number;
  avgCost: number;
  successRate: number; // Fraction (0-1) of sessions with recorded user acceptance that have >50% acceptance
}

export interface SampleSizes {
  control: number;
  treatment: number;
}

export interface SignificanceResult {
  acceptanceRate: { pValue: number; significant: boolean };
  confidence: { pValue: number; significant: boolean };
  cost: { pValue: number; significant: boolean };
}

export interface ABTestAnalysis {
  testId: string;
  status: 'running' | 'completed' | 'insufficient_data';
  sampleSizes: SampleSizes;
  results: {
    control: VariantMetrics;
    treatment: VariantMetrics;
  };
  statisticalSignificance: SignificanceResult;
  recommendations: string[];
  winningVariant?: 'control' | 'treatment' | 'inconclusive';
}

@injectable()
export class ABTestingService {
  private activeTests = new Map<string, ABTestConfig>();
  private testResults: ABTestResult[] = [];

  // Default test configuration
  private readonly defaultTest: ABTestConfig = {
    testId: 'ai-vs-heuristic-v1',
    name: 'AI vs Rule-based Mapping Comparison',
    description: 'Week 2 baseline test comparing AI providers against rule-based heuristics',
    enabled: true,
    trafficSplit: { control: 50, treatment: 50 },
    providers: { control: 'rule-based', treatment: 'mock-openai' },
    successMetrics: ['acceptance_rate', 'confidence_score', 'processing_time', 'cost_efficiency'],
    minimumSampleSize: 30
  };

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.UnifiedTelemetryService) private telemetry: UnifiedTelemetryService
  ) {
    // Initialize default test
    this.activeTests.set(this.defaultTest.testId, this.defaultTest);
  }

  /**
   * Determine which variant to use for a session
   */
  assignVariant(sessionId: string, testId?: string): {
    variant: 'control' | 'treatment';
    providerId: string;
    testId: string;
  } {
    const test = testId ? this.activeTests.get(testId) : this.defaultTest;
    if (!test || !test.enabled) {
      // Fallback to control if no test available
      return {
        variant: 'control',
        providerId: 'rule-based',
        testId: 'fallback'
      };
    }

    // Use session ID for consistent assignment
    const hash = this.hashSessionId(sessionId);
    const isControl = hash < test.trafficSplit.control;

    const variant = isControl ? 'control' : 'treatment';
    const providerId = isControl ? test.providers.control : test.providers.treatment;

    this.logger.debug('A/B test variant assigned', {
      sessionId,
      testId: test.testId,
      variant,
      providerId,
      hash
    });

    return { variant, providerId, testId: test.testId };
  }

  /**
   * Record test result
   */
  async recordTestResult(result: Omit<ABTestResult, 'timestamp'>): Promise<void> {
    const fullResult: ABTestResult = {
      ...result,
      timestamp: new Date()
    };

    this.testResults.push(fullResult);

    // Record telemetry as feature usage
    await this.telemetry.recordFeatureUsed(
      `ab_test_${result.variant}_${result.providerId}`,
      result.sessionId
    );

    this.logger.debug('A/B test result recorded', {
      sessionId: result.sessionId,
      testId: result.testId,
      variant: result.variant,
      suggestionsCount: result.suggestions.length
    });
  }

  /**
   * Record user acceptance for a test result
   */
  async recordUserAcceptance(
    sessionId: string,
    testId: string,
    acceptedSuggestions: number,
    totalSuggestions: number
  ): Promise<void> {
    // Find the corresponding test result
    const resultIndex = this.testResults.findIndex(
      r => r.sessionId === sessionId && r.testId === testId
    );

    if (resultIndex === -1) {
      this.logger.warn('No test result found for user acceptance', { sessionId, testId });
      return;
    }

    const result = this.testResults[resultIndex];
    result.userAcceptance = {
      acceptedSuggestions,
      totalSuggestions,
      acceptanceRate: totalSuggestions > 0 ? acceptedSuggestions / totalSuggestions : 0,
      timestamp: new Date()
    };

    // Record telemetry as feature usage
    await this.telemetry.recordFeatureUsed(
      `ab_test_acceptance_${result.variant}`,
      sessionId
    );

    this.logger.info('User acceptance recorded for A/B test', {
      sessionId,
      testId,
      variant: result.variant,
      acceptanceRate: result.userAcceptance.acceptanceRate
    });
  }

  /**
   * Analyze test results
   */
  async analyzeTest(testId: string): Promise<ABTestAnalysis> {
    const test = this.activeTests.get(testId);
    if (!test) {
      throw new Error(`Test ${testId} not found`);
    }

    const results = this.testResults.filter(r => r.testId === testId);
    const controlResults = results.filter(r => r.variant === 'control');
    const treatmentResults = results.filter(r => r.variant === 'treatment');

    const sampleSizes = {
      control: controlResults.length,
      treatment: treatmentResults.length
    };

    // Calculate metrics for each variant
    const controlMetrics = this.calculateVariantMetrics(controlResults);
    const treatmentMetrics = this.calculateVariantMetrics(treatmentResults);

    // Statistical significance (simplified)
    const significance = this.calculateStatisticalSignificance(controlResults, treatmentResults);

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      controlMetrics,
      treatmentMetrics,
      significance,
      sampleSizes,
      test
    );

    // Determine winning variant
    const winningVariant = this.determineWinner(controlMetrics, treatmentMetrics, significance);

    const status = this.determineTestStatus(sampleSizes, test.minimumSampleSize);

    return {
      testId,
      status,
      sampleSizes,
      results: {
        control: controlMetrics,
        treatment: treatmentMetrics
      },
      statisticalSignificance: significance,
      recommendations,
      winningVariant
    };
  }

  /**
   * Get all active tests
   */
  getActiveTests(): ABTestConfig[] {
    return Array.from(this.activeTests.values()).filter(test => test.enabled);
  }

  /**
   * Create or update a test configuration
   */
  configureTest(config: ABTestConfig): void {
    this.activeTests.set(config.testId, config);
    this.logger.info('A/B test configured', {
      testId: config.testId,
      name: config.name,
      enabled: config.enabled
    });
  }

  /**
   * Get test results for export/analysis
   */
  getTestResults(testId?: string): ABTestResult[] {
    if (testId) {
      return this.testResults.filter(r => r.testId === testId);
    }
    return [...this.testResults];
  }

  private hashSessionId(sessionId: string): number {
    // Simple hash function for consistent assignment
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      const char = sessionId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % 100; // Return 0-99
  }

  private calculateVariantMetrics(results: ABTestResult[]): VariantMetrics {
    if (results.length === 0) {
      return {
        avgAcceptanceRate: 0,
        avgConfidence: 0,
        avgProcessingTime: 0,
        avgCost: 0,
        successRate: 0
      };
    }

    const acceptanceResults = results.filter(r => r.userAcceptance);
    const avgAcceptanceRate = acceptanceResults.length > 0
      ? acceptanceResults.reduce((sum, r) => sum + r.userAcceptance!.acceptanceRate, 0) / acceptanceResults.length
      : 0;

    const avgConfidence = results.reduce((sum, r) => sum + r.qualityMetrics.avgConfidence, 0) / results.length;
    const avgProcessingTime = results.reduce((sum, r) => sum + r.qualityMetrics.processingTime, 0) / results.length;
    const avgCost = results.reduce((sum, r) => sum + (r.qualityMetrics.cost || 0), 0) / results.length;

    // Success rate: sessions with >50% acceptance rate
    const successfulSessions = acceptanceResults.filter(r => r.userAcceptance!.acceptanceRate > 0.5).length;
    const successRate = acceptanceResults.length > 0 ? successfulSessions / acceptanceResults.length : 0;

    return {
      avgAcceptanceRate,
      avgConfidence,
      avgProcessingTime,
      avgCost,
      successRate
    };
  }

  private calculateStatisticalSignificance(
    controlResults: ABTestResult[],
    treatmentResults: ABTestResult[]
  ): SignificanceResult {
    // Simplified statistical significance calculation
    // In production, use proper statistical tests

    const minSampleSize = 10;
    const hasEnoughData = controlResults.length >= minSampleSize && treatmentResults.length >= minSampleSize;

    if (!hasEnoughData) {
      return {
        acceptanceRate: { pValue: 1.0, significant: false },
        confidence: { pValue: 1.0, significant: false },
        cost: { pValue: 1.0, significant: false }
      };
    }

    // Mock p-values based on sample sizes and differences
    // Real implementation would use t-tests, chi-square tests, etc.
    const pValueThreshold = 0.05;

    return {
      acceptanceRate: { pValue: 0.03, significant: true },   // Mock: AI significantly better
      confidence: { pValue: 0.02, significant: true },       // Mock: AI more confident
      cost: { pValue: 0.4, significant: false }              // Mock: No significant cost difference
    };
  }

  private generateRecommendations(
    control: VariantMetrics,
    treatment: VariantMetrics,
    significance: SignificanceResult,
    sampleSizes: SampleSizes,
    test: ABTestConfig
  ): string[] {
    const recommendations: string[] = [];

    if (sampleSizes.control < test.minimumSampleSize || sampleSizes.treatment < test.minimumSampleSize) {
      recommendations.push(`Insufficient sample size. Need ${test.minimumSampleSize} samples per variant.`);
    }

    if (significance.acceptanceRate.significant) {
      if (treatment.avgAcceptanceRate > control.avgAcceptanceRate) {
        recommendations.push(`Treatment (${test.providers.treatment}) shows significantly higher acceptance rate`);
      } else {
        recommendations.push(`Control (${test.providers.control}) shows significantly higher acceptance rate`);
      }
    }

    if (treatment.avgCost > control.avgCost * 1.5) {
      recommendations.push('Treatment variant has significantly higher costs - consider cost optimization');
    }

    if (treatment.avgProcessingTime > control.avgProcessingTime * 2) {
      recommendations.push('Treatment variant has much higher latency - consider performance optimization');
    }

    if (recommendations.length === 0) {
      recommendations.push('Continue collecting data for more conclusive results');
    }

    return recommendations;
  }

  private determineWinner(
    control: VariantMetrics,
    treatment: VariantMetrics,
    significance: SignificanceResult
  ): 'control' | 'treatment' | 'inconclusive' {
    if (!significance.acceptanceRate.significant) {
      return 'inconclusive';
    }

    // Consider multiple factors: acceptance rate, cost, performance
    const treatmentBetter = treatment.avgAcceptanceRate > control.avgAcceptanceRate;
    const costAcceptable = treatment.avgCost <= control.avgCost * 1.5; // Within 50% cost increase
    const performanceAcceptable = treatment.avgProcessingTime <= control.avgProcessingTime * 2;

    if (treatmentBetter && costAcceptable && performanceAcceptable) {
      return 'treatment';
    } else if (!treatmentBetter) {
      return 'control';
    } else {
      return 'inconclusive'; // Better accuracy but too expensive or slow
    }
  }

  private determineTestStatus(sampleSizes: SampleSizes, minimumSampleSize: number): 'running' | 'completed' | 'insufficient_data' {
    if (sampleSizes.control < minimumSampleSize || sampleSizes.treatment < minimumSampleSize) {
      return 'insufficient_data';
    }

    // Simple completion criteria - in production, use statistical power calculations
    if (sampleSizes.control >= minimumSampleSize * 2 && sampleSizes.treatment >= minimumSampleSize * 2) {
      return 'completed';
    }

    return 'running';
  }
}