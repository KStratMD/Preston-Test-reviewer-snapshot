/**
 * Performance Metrics Service - Performance analysis and metric calculations
 * Extracted from ProcessOptimizationAgent for better separation of concerns
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { PerformanceMetric } from '../../interfaces';
import type {
  PerformanceAnalysis,
  ProcessMetric
} from '../types/process-optimization';

@injectable()
export class PerformanceMetricsService {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Analyze performance metrics to derive key performance indicators
   */
  async analyzePerformance(metrics: PerformanceMetric[]): Promise<PerformanceAnalysis> {
    this.logger.info('Analyzing performance metrics', {
      metricsCount: metrics.length
    });

    const processMetrics: ProcessMetric[] = metrics.map(metric => ({
      name: metric.name,
      current: metric.currentValue,
      target: metric.targetValue,
      unit: metric.unit,
      trend: metric.trend,
      variance: Math.abs(metric.currentValue - metric.targetValue) / metric.targetValue
    }));

    // Calculate derived metrics
    const throughput = this.calculateThroughput(metrics);
    const utilization = this.calculateUtilization(metrics);
    const efficiency = this.calculateEfficiency(metrics);
    const waitTime = this.calculateWaitTime(metrics);
    const processingTime = this.calculateProcessingTime(metrics);
    const setupTime = this.calculateSetupTime(metrics);

    this.logger.info('Performance analysis completed', {
      throughput,
      utilization,
      efficiency,
      waitTime,
      processingTime,
      setupTime
    });

    return {
      throughput,
      utilization,
      efficiency,
      waitTime,
      processingTime,
      setupTime,
      metrics: processMetrics
    };
  }

  /**
   * Calculate throughput metric (units per hour)
   */
  private calculateThroughput(metrics: PerformanceMetric[]): number {
    const throughputMetric = metrics.find(m => m.name.toLowerCase().includes('throughput'));
    return throughputMetric ? throughputMetric.currentValue : 50; // Default
  }

  /**
   * Calculate resource utilization rate (0-1)
   */
  private calculateUtilization(metrics: PerformanceMetric[]): number {
    const utilizationMetric = metrics.find(m => m.name.toLowerCase().includes('utilization'));
    return utilizationMetric ? utilizationMetric.currentValue / 100 : 0.75; // Default
  }

  /**
   * Calculate process efficiency rate (0-1)
   */
  private calculateEfficiency(metrics: PerformanceMetric[]): number {
    const efficiencyMetric = metrics.find(m => m.name.toLowerCase().includes('efficiency'));
    return efficiencyMetric ? efficiencyMetric.currentValue / 100 : 0.8; // Default
  }

  /**
   * Calculate average wait time (minutes)
   */
  private calculateWaitTime(metrics: PerformanceMetric[]): number {
    const waitTimeMetric = metrics.find(m => m.name.toLowerCase().includes('wait'));
    return waitTimeMetric ? waitTimeMetric.currentValue : 5; // Default minutes
  }

  /**
   * Calculate average processing time (minutes)
   */
  private calculateProcessingTime(metrics: PerformanceMetric[]): number {
    const processingMetric = metrics.find(m => m.name.toLowerCase().includes('processing'));
    return processingMetric ? processingMetric.currentValue : 30; // Default minutes
  }

  /**
   * Calculate average setup time (minutes)
   */
  private calculateSetupTime(metrics: PerformanceMetric[]): number {
    const setupMetric = metrics.find(m => m.name.toLowerCase().includes('setup'));
    return setupMetric ? setupMetric.currentValue : 10; // Default minutes
  }
}
