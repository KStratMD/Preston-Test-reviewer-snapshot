/**
 * MCP A/B Testing Service
 * Phase 3 Week 2: Measure AI accuracy improvement from MCP enhancement
 *
 * Purpose: Compare control group (no MCP) vs treatment group (with MCP)
 * to validate +3-4% accuracy improvement hypothesis
 *
 * Week 3 Enhancement: Integrate user-scoped settings - users with explicit
 * MCP preferences bypass A/B assignment and use their configured settings
 */

import type { Logger } from '../../../utils/Logger';
import type { MCPUserSettingsService } from '../../settings/MCPUserSettingsService';

/**
 * A/B test configuration
 */
export interface MCPABTestConfig {
  testId: string;
  name: string;
  description: string;
  enabled: boolean;

  // Group allocation
  controlGroupPercent: number; // 0-100, typically 50
  treatmentGroupPercent: number; // 0-100, typically 50

  // Test parameters
  minSampleSize: number; // Minimum samples per group before analysis
  confidenceLevel: number; // Statistical confidence (e.g., 0.95 for 95%)

  // Duration
  startDate: Date;
  endDate: Date;

  // Metrics to track
  metrics: string[]; // ['accuracy', 'confidence', 'manualCorrections', 'validationTime']
}

/**
 * Test group assignment
 */
export type TestGroup = 'control' | 'treatment' | 'excluded';

/**
 * Individual test metrics
 */
export interface MCPTestMetrics {
  testId: string;
  sessionId: string;
  userId?: number;
  group: TestGroup;
  timestamp: Date;

  // Field mapping metadata
  sourceSystem: string;
  targetSystem: string;
  fieldCount: number;

  // Accuracy metrics
  totalMappings: number;
  correctMappings: number;
  incorrectMappings: number;
  accuracyRate: number; // correctMappings / totalMappings

  // Confidence metrics
  avgConfidence: number;
  confidenceDistribution: { range: string; count: number }[];

  // Quality metrics
  manualCorrections: number;
  validationTimeMs: number;
  userAcceptanceRate: number; // % of suggestions accepted without modification

  // MCP-specific (treatment group only)
  mcpContextUsed: boolean;
  mcpAccuracyImprovement?: number; // Estimated improvement from MCP
  confidenceBoostApplied?: number; // Average confidence boost
}

/**
 * Aggregated test results
 */
export interface MCPABTestResults {
  testId: string;
  testName: string;

  // Sample sizes
  controlSamples: number;
  treatmentSamples: number;
  totalSamples: number;

  // Control group results
  controlAccuracy: number;
  controlAvgConfidence: number;
  controlManualCorrections: number;
  controlAvgValidationTime: number;

  // Treatment group results
  treatmentAccuracy: number;
  treatmentAvgConfidence: number;
  treatmentManualCorrections: number;
  treatmentAvgValidationTime: number;

  // Improvements (treatment - control)
  accuracyImprovement: number; // Percentage points
  confidenceImprovement: number;
  manualCorrectionReduction: number; // Percentage
  validationTimeReduction: number; // Percentage

  // Statistical significance
  statistically_significant: boolean;
  p_value: number;
  confidence_level: number;

  // Test status
  status: 'running' | 'completed' | 'inconclusive';
  completionDate?: Date;
}

/**
 * MCP A/B Testing Service
 *
 * Manages A/B tests to measure MCP enhancement effectiveness
 */
export class MCPABTestService {
  private readonly logger: Logger;
  private readonly userSettingsService?: MCPUserSettingsService;
  private testConfig?: MCPABTestConfig;
  private metrics = new Map<string, MCPTestMetrics[]>(); // testId -> metrics[]
  private initialized = false;

  constructor(logger: Logger, userSettingsService?: MCPUserSettingsService) {
    this.logger = logger;
    this.userSettingsService = userSettingsService;
  }

  /**
   * Initialize service with test configuration
   */
  async initialize(config: MCPABTestConfig): Promise<void> {
    if (this.initialized) {
      this.logger.warn('MCP A/B test service already initialized');
      return;
    }

    this.testConfig = config;
    this.initialized = true;

    this.logger.info('MCP A/B test service initialized', {
      testId: config.testId,
      testName: config.name,
      controlPercent: config.controlGroupPercent,
      treatmentPercent: config.treatmentGroupPercent,
      minSampleSize: config.minSampleSize
    });
  }

  /**
   * Assign session to test group
   *
   * Uses consistent hashing to ensure same session always gets same group
   *
   * @param sessionId - Unique session identifier
   * @param userId - Optional user ID for user-scoped settings lookup
   * @returns Test group assignment
   */
  async assignGroup(sessionId: string, userId?: string): Promise<TestGroup> {
    this.ensureInitialized();

    // Check if test is enabled
    if (!this.testConfig!.enabled) {
      return 'excluded';
    }

    // Check if test is active
    const now = new Date();
    if (now < this.testConfig!.startDate || now > this.testConfig!.endDate) {
      return 'excluded';
    }

    // Priority 1: Check user-scoped settings (if user ID provided and service available)
    if (userId && this.userSettingsService) {
      try {
        const userSettings = await this.userSettingsService.getUserSettings(userId);

        // Only bypass A/B assignment if user has EXPLICIT settings (not env defaults)
        if (userSettings.is_explicit) {
          // If user has explicitly configured MCP settings, use those instead of A/B assignment
          const hasMCPEnabled = userSettings.mcp_schema_enabled || userSettings.mcp_ai_context_enabled;
          const hasMCPDisabled = !userSettings.mcp_schema_enabled && !userSettings.mcp_ai_context_enabled;

          if (hasMCPEnabled) {
            this.logger.debug('User assigned to treatment group via explicit settings', { userId, sessionId });
            return 'treatment';
          } else if (hasMCPDisabled) {
            this.logger.debug('User assigned to control group via explicit settings', { userId, sessionId });
            return 'control';
          }
        }
        // If settings are not explicit (using env defaults), fall through to A/B assignment
      } catch (error) {
        // Fall through to A/B assignment if settings lookup fails
        this.logger.warn('Failed to load user settings for A/B test assignment', {
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Priority 2: Fall back to A/B test assignment using consistent hashing
    // Consistent hashing: hash sessionId to 0-100
    const hash = this.hashString(sessionId);
    const percent = hash % 100;

    // Assign to groups based on configuration
    if (percent < this.testConfig!.controlGroupPercent) {
      return 'control';
    } else if (percent < this.testConfig!.controlGroupPercent + this.testConfig!.treatmentGroupPercent) {
      return 'treatment';
    } else {
      return 'excluded';
    }
  }

  /**
   * Record test metrics for a session
   *
   * @param metrics - Test metrics to record
   */
  recordMetrics(metrics: MCPTestMetrics): void {
    this.ensureInitialized();

    const testId = metrics.testId;
    if (!this.metrics.has(testId)) {
      this.metrics.set(testId, []);
    }

    this.metrics.get(testId)!.push(metrics);

    this.logger.debug('Test metrics recorded', {
      testId,
      sessionId: metrics.sessionId,
      group: metrics.group,
      accuracyRate: metrics.accuracyRate.toFixed(2)
    });
  }

  /**
   * Get aggregated test results
   *
   * @param testId - Test identifier
   * @returns Aggregated results with statistical analysis
   */
  getResults(testId: string): MCPABTestResults | null {
    this.ensureInitialized();

    const allMetrics = this.metrics.get(testId);
    if (!allMetrics || allMetrics.length === 0) {
      return null;
    }

    // Separate control and treatment groups
    const controlMetrics = allMetrics.filter(m => m.group === 'control');
    const treatmentMetrics = allMetrics.filter(m => m.group === 'treatment');

    // Check minimum sample size
    if (controlMetrics.length < this.testConfig!.minSampleSize ||
        treatmentMetrics.length < this.testConfig!.minSampleSize) {
      this.logger.warn('Insufficient samples for analysis', {
        testId,
        controlSamples: controlMetrics.length,
        treatmentSamples: treatmentMetrics.length,
        minRequired: this.testConfig!.minSampleSize
      });
      return null;
    }

    // Calculate control group stats
    const controlAccuracy = this.calculateAverage(controlMetrics.map(m => m.accuracyRate));
    const controlConfidence = this.calculateAverage(controlMetrics.map(m => m.avgConfidence));
    const controlCorrections = this.calculateSum(controlMetrics.map(m => m.manualCorrections));
    const controlValidationTime = this.calculateAverage(controlMetrics.map(m => m.validationTimeMs));

    // Calculate treatment group stats
    const treatmentAccuracy = this.calculateAverage(treatmentMetrics.map(m => m.accuracyRate));
    const treatmentConfidence = this.calculateAverage(treatmentMetrics.map(m => m.avgConfidence));
    const treatmentCorrections = this.calculateSum(treatmentMetrics.map(m => m.manualCorrections));
    const treatmentValidationTime = this.calculateAverage(treatmentMetrics.map(m => m.validationTimeMs));

    // Calculate improvements
    const accuracyImprovement = (treatmentAccuracy - controlAccuracy) * 100; // Convert to percentage points
    const confidenceImprovement = treatmentConfidence - controlConfidence;
    const manualCorrectionReduction = ((controlCorrections - treatmentCorrections) / controlCorrections) * 100;
    const validationTimeReduction = ((controlValidationTime - treatmentValidationTime) / controlValidationTime) * 100;

    // Statistical significance test (simplified t-test)
    const { significant, pValue } = this.calculateSignificance(
      controlMetrics.map(m => m.accuracyRate),
      treatmentMetrics.map(m => m.accuracyRate),
      this.testConfig!.confidenceLevel
    );

    // Determine test status
    let status: 'running' | 'completed' | 'inconclusive' = 'running';
    if (controlMetrics.length >= this.testConfig!.minSampleSize * 2 &&
        treatmentMetrics.length >= this.testConfig!.minSampleSize * 2) {
      status = significant ? 'completed' : 'inconclusive';
    }

    const results: MCPABTestResults = {
      testId,
      testName: this.testConfig!.name,

      controlSamples: controlMetrics.length,
      treatmentSamples: treatmentMetrics.length,
      totalSamples: allMetrics.length,

      controlAccuracy,
      controlAvgConfidence: controlConfidence,
      controlManualCorrections: controlCorrections,
      controlAvgValidationTime: controlValidationTime,

      treatmentAccuracy,
      treatmentAvgConfidence: treatmentConfidence,
      treatmentManualCorrections: treatmentCorrections,
      treatmentAvgValidationTime: treatmentValidationTime,

      accuracyImprovement,
      confidenceImprovement,
      manualCorrectionReduction,
      validationTimeReduction,

      statistically_significant: significant,
      p_value: pValue,
      confidence_level: this.testConfig!.confidenceLevel,

      status,
      completionDate: status === 'completed' ? new Date() : undefined
    };

    this.logger.info('Test results calculated', {
      testId,
      accuracyImprovement: accuracyImprovement.toFixed(2) + '%',
      significant,
      status
    });

    return results;
  }

  /**
   * Get raw metrics for a test
   */
  getMetrics(testId: string): MCPTestMetrics[] {
    return this.metrics.get(testId) || [];
  }

  /**
   * Clear all test data
   */
  clearTestData(testId?: string): void {
    if (testId) {
      this.metrics.delete(testId);
      this.logger.info('Test data cleared', { testId });
    } else {
      this.metrics.clear();
      this.logger.info('All test data cleared');
    }
  }

  // Helper methods

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCP A/B test service not initialized. Call initialize() first.');
    }
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  private calculateSum(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0);
  }

  private calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = this.calculateAverage(values);
    const squareDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = this.calculateAverage(squareDiffs);
    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Simplified t-test for statistical significance
   *
   * Returns whether the difference between two groups is statistically significant
   */
  private calculateSignificance(
    controlValues: number[],
    treatmentValues: number[],
    confidenceLevel: number
  ): { significant: boolean; pValue: number } {
    // Calculate means
    const controlMean = this.calculateAverage(controlValues);
    const treatmentMean = this.calculateAverage(treatmentValues);

    // Calculate standard deviations
    const controlStdDev = this.calculateStdDev(controlValues);
    const treatmentStdDev = this.calculateStdDev(treatmentValues);

    // Calculate standard error
    const controlSE = controlStdDev / Math.sqrt(controlValues.length);
    const treatmentSE = treatmentStdDev / Math.sqrt(treatmentValues.length);
    const standardError = Math.sqrt(controlSE * controlSE + treatmentSE * treatmentSE);

    // Calculate t-statistic
    const tStatistic = Math.abs(treatmentMean - controlMean) / standardError;

    // Note: Degrees of freedom = n1 + n2 - 2 (for reference, not used in simplified p-value calculation)
    // const df = controlValues.length + treatmentValues.length - 2;

    // Critical values for common confidence levels (two-tailed)
    const criticalValues: { [key: number]: number } = {
      0.90: 1.645, // 90% confidence
      0.95: 1.96,  // 95% confidence
      0.99: 2.576  // 99% confidence
    };

    const criticalValue = criticalValues[confidenceLevel] || 1.96;

    // Check significance
    const significant = tStatistic > criticalValue;

    // Approximate p-value (simplified based on t-statistic thresholds)
    let pValue: number;
    if (tStatistic > 2.576) pValue = 0.01;
    else if (tStatistic > 1.96) pValue = 0.05;
    else if (tStatistic > 1.645) pValue = 0.10;
    else pValue = 0.20;

    return { significant, pValue };
  }
}
