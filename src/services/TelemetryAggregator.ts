import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryStore, TelemetryQueryOptions } from './TelemetryStore';
import type { AllTelemetryEvents } from '../domain/telemetry/events';
import type { ROIAnalysisService } from './ai/orchestrator/agents/intelligence/ROIAnalysisService';

export interface ROIMetrics {
  totalRevenue: number;
  costSavings: number;
  implementationCosts: number;
  operationalCosts: number;
  netROI: number;
  roiPercentage: number;
  paybackPeriodMonths: number;
  timeToValue: number;
}

export interface BusinessMetrics {
  integrationEfficiency: number;
  dataAccuracy: number;
  systemUptime: number;
  processingSpeed: number;
  errorRate: number;
  customerSatisfaction: number;
  timeToMarket: number;
}

export interface ExecutiveSummary {
  period: {
    start: number;
    end: number;
    label: string;
  };
  totalIntegrations: number;
  activeIntegrations: number;
  totalDataProcessed: number;
  successRate: number;
  costSavings: number;
  revenueImpact: number;
  roi: ROIMetrics;
  businessMetrics: BusinessMetrics;
  keyInsights: string[];
  recommendations: string[];
  riskFactors: string[];
}

export interface TrendData {
  timestamp: number;
  value: number;
  label: string;
}

export interface PerformanceBreakdown {
  connector: string;
  totalOperations: number;
  successRate: number;
  averageLatency: number;
  throughputPerHour: number;
  errorRate: number;
  lastActivity: number;
}

/**
 * TelemetryAggregator processes telemetry data to generate business insights,
 * ROI calculations, and executive summaries for the Squire platform.
 */
@injectable()
export class TelemetryAggregator {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ROIAnalysisService) private roiService: ROIAnalysisService,
  ) {
    this.logger.info('TelemetryAggregator initialized');
  }

  /**
   * Calculate ROI metrics based on integration performance
   */
  async calculateROI(
    telemetryStore: TelemetryStore,
    timeRangeMs: number = 30 * 24 * 60 * 60 * 1000, // 30 days
  ): Promise<ROIMetrics> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;

      const metrics = await telemetryStore.getMetrics({
        startTime,
        endTime,
      });

      // If no data and in demo mode, return sample ROI data
      if (metrics.totalEvents === 0 && process.env.DEMO_MODE === '1') {
        this.logger.info('No telemetry data found, returning demo ROI metrics');
        return this.getDemoROIMetrics();
      }

      // Base calculations for ROI (these would be configured per client)
      const integrationCostPerRecord = 0.05; // $0.05 per record processed
      const manualProcessingCost = 2.5; // $2.50 per record manually processed
      const implementationCostBase = 50000; // $50K base implementation
      const monthlyOperationalCost = 5000; // $5K monthly operational costs

      // Calculate cost savings
      const recordsProcessed = metrics.totalRecordsProcessed;
      const costSavings = recordsProcessed * (manualProcessingCost - integrationCostPerRecord);

      // Calculate revenue impact (based on processing speed improvements)
      const timeToMarketImprovement = 0.3; // 30% faster time to market
      const averageCustomerValue = 15000; // $15K average customer value
      const additionalCustomers = Math.floor(recordsProcessed / 100 * timeToMarketImprovement);
      const totalRevenue = additionalCustomers * averageCustomerValue;

      // Calculate costs
      const monthsInOperation = Math.ceil(timeRangeMs / (30 * 24 * 60 * 60 * 1000));
      const operationalCosts = monthsInOperation * monthlyOperationalCost;
      const implementationCosts = implementationCostBase;

      // Calculate ROI
      const netROI = this.roiService.calculateNetROI(totalRevenue + costSavings, implementationCosts + operationalCosts);
      const roiPercentage = this.roiService.calculateSimpleROI(totalRevenue + costSavings, implementationCosts + operationalCosts);

      // Calculate payback period
      const monthlySavings = costSavings / monthsInOperation + totalRevenue / monthsInOperation;
      const paybackPeriodMonths = monthlySavings > 0 ?
        (implementationCosts + operationalCosts) / monthlySavings : 36;

      // Time to value (months to see positive ROI)
      const timeToValue = Math.min(paybackPeriodMonths, 6);

      this.logger.info('ROI metrics calculated', {
        netROI,
        roiPercentage,
        paybackPeriodMonths,
        recordsProcessed,
      });

      return {
        totalRevenue,
        costSavings,
        implementationCosts,
        operationalCosts,
        netROI,
        roiPercentage,
        paybackPeriodMonths,
        timeToValue,
      };
    } catch (error) {
      this.logger.error('Failed to calculate ROI metrics', { error });
      throw error;
    }
  }

  /**
   * Generate business metrics for executive reporting
   */
  async calculateBusinessMetrics(
    telemetryStore: TelemetryStore,
    timeRangeMs: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<BusinessMetrics> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;

      const metrics = await telemetryStore.getMetrics({
        startTime,
        endTime,
      });

      // If no data and in demo mode, return sample business metrics
      if (metrics.totalEvents === 0 && process.env.DEMO_MODE === '1') {
        this.logger.info('No telemetry data found, returning demo business metrics');
        return this.getDemoBusinessMetrics();
      }

      // Calculate integration efficiency (records per hour)
      const hoursInPeriod = timeRangeMs / (60 * 60 * 1000);
      const integrationEfficiency = metrics.totalRecordsProcessed / hoursInPeriod;

      // Data accuracy based on error rates
      const dataAccuracy = Math.max(0, 100 - (metrics.failureCount / metrics.totalEvents * 100));

      // System uptime based on successful vs failed events
      const systemUptime = metrics.successRate;

      // Processing speed (average duration)
      const processingSpeed = metrics.averageDuration > 0 ?
        10000 / metrics.averageDuration : 100; // Higher is better

      // Error rate
      const errorRate = (metrics.failureCount / metrics.totalEvents) * 100;

      // Customer satisfaction (derived from success rates and processing speed)
      const customerSatisfaction = Math.min(100,
        (systemUptime * 0.4) +
        (dataAccuracy * 0.4) +
        (Math.min(100, processingSpeed) * 0.2)
      );

      // Time to market improvement (based on processing efficiency)
      const timeToMarket = Math.min(100, integrationEfficiency / 10);

      return {
        integrationEfficiency,
        dataAccuracy,
        systemUptime,
        processingSpeed,
        errorRate,
        customerSatisfaction,
        timeToMarket,
      };
    } catch (error) {
      this.logger.error('Failed to calculate business metrics', { error });
      throw error;
    }
  }

  /**
   * Generate comprehensive executive summary
   */
  async generateExecutiveSummary(
    telemetryStore: TelemetryStore,
    timeRangeMs: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<ExecutiveSummary> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;

      const [telemetryMetrics, roiMetrics, businessMetrics] = await Promise.all([
        telemetryStore.getMetrics({ startTime, endTime }),
        this.calculateROI(telemetryStore, timeRangeMs),
        this.calculateBusinessMetrics(telemetryStore, timeRangeMs),
      ]);

      // Generate insights based on data
      const keyInsights: string[] = [];
      const recommendations: string[] = [];
      const riskFactors: string[] = [];

      // Key insights
      if (businessMetrics.integrationEfficiency > 1000) {
        keyInsights.push(`Exceptional processing efficiency: ${Math.round(businessMetrics.integrationEfficiency)} records/hour`);
      }

      if (roiMetrics.roiPercentage > 300) {
        keyInsights.push(`Outstanding ROI of ${Math.round(roiMetrics.roiPercentage)}% achieved`);
      }

      if (businessMetrics.systemUptime > 99) {
        keyInsights.push(`Excellent system reliability: ${businessMetrics.systemUptime.toFixed(1)}% uptime`);
      }

      // Recommendations
      if (businessMetrics.errorRate > 5) {
        recommendations.push('Focus on reducing error rates through enhanced validation and monitoring');
      }

      if (roiMetrics.paybackPeriodMonths < 12) {
        recommendations.push('Consider expanding integration capabilities to maximize ROI potential');
      }

      if (businessMetrics.processingSpeed < 50) {
        recommendations.push('Optimize data transformation pipelines for improved processing speed');
      }

      // Risk factors
      if (businessMetrics.errorRate > 10) {
        riskFactors.push('High error rate may impact customer satisfaction and data integrity');
      }

      if (roiMetrics.paybackPeriodMonths > 24) {
        riskFactors.push('Extended payback period may affect investment justification');
      }

      if (businessMetrics.systemUptime < 95) {
        riskFactors.push('System reliability issues could impact business operations');
      }

      const period = {
        start: startTime,
        end: endTime,
        label: timeRangeMs >= 30 * 24 * 60 * 60 * 1000 ? 'Last 30 Days' : 'Custom Period',
      };

      // Count active vs total integrations
      const integrationEvents = await telemetryStore.queryEvents({
        eventTypes: ['IntegrationFlowStarted', 'IntegrationFlowCompleted'],
        startTime,
        endTime,
      });

      const uniqueFlows = new Set(integrationEvents.map(e => e.flowId)).size;
      const activeFlows = new Set(
        integrationEvents
          .filter(e => e.type === 'IntegrationFlowStarted')
          .map(e => e.flowId)
      ).size;

      this.logger.info('Executive summary generated', {
        totalIntegrations: uniqueFlows,
        activeIntegrations: activeFlows,
        roiPercentage: roiMetrics.roiPercentage,
        successRate: telemetryMetrics.successRate,
      });

      return {
        period,
        totalIntegrations: uniqueFlows,
        activeIntegrations: activeFlows,
        totalDataProcessed: telemetryMetrics.totalRecordsProcessed,
        successRate: telemetryMetrics.successRate,
        costSavings: roiMetrics.costSavings,
        revenueImpact: roiMetrics.totalRevenue,
        roi: roiMetrics,
        businessMetrics,
        keyInsights,
        recommendations,
        riskFactors,
      };
    } catch (error) {
      this.logger.error('Failed to generate executive summary', { error });
      throw error;
    }
  }

  /**
   * Generate trend data for charts and visualizations
   */
  async generateTrendData(
    telemetryStore: TelemetryStore,
    metric: 'throughput' | 'success_rate' | 'processing_time' | 'error_count',
    timeRangeMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days
    bucketCount = 24,
  ): Promise<TrendData[]> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;
      const bucketSizeMs = timeRangeMs / bucketCount;

      const trendData: TrendData[] = [];

      for (let i = 0; i < bucketCount; i++) {
        const bucketStart = startTime + (i * bucketSizeMs);
        const bucketEnd = bucketStart + bucketSizeMs;

        const bucketMetrics = await telemetryStore.getMetrics({
          startTime: bucketStart,
          endTime: bucketEnd,
        });

        let value = 0;
        switch (metric) {
          case 'throughput':
            value = bucketMetrics.totalRecordsProcessed;
            break;
          case 'success_rate':
            value = bucketMetrics.successRate;
            break;
          case 'processing_time':
            value = bucketMetrics.averageDuration;
            break;
          case 'error_count':
            value = bucketMetrics.failureCount;
            break;
        }

        const label = new Date(bucketStart).toISOString().split('T')[0] || 'Unknown';
        trendData.push({
          timestamp: bucketStart,
          value,
          label,
        });
      }

      return trendData;
    } catch (error) {
      this.logger.error('Failed to generate trend data', { error, metric });
      throw error;
    }
  }

  /**
   * Generate performance breakdown by connector
   */
  async generatePerformanceBreakdown(
    telemetryStore: TelemetryStore,
    timeRangeMs: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<PerformanceBreakdown[]> {
    try {
      const endTime = Date.now();
      const startTime = endTime - timeRangeMs;

      const events = await telemetryStore.queryEvents({
        startTime,
        endTime,
        eventTypes: ['IntegrationFlowStarted', 'IntegrationFlowCompleted', 'IntegrationFlowFailed'],
      });

      // If no events and in demo mode, return sample data
      if (events.length === 0 && process.env.DEMO_MODE === '1') {
        this.logger.info('No telemetry events found, returning demo performance data');
        return this.getDemoPerformanceBreakdown();
      }

      const connectorStats: Record<string, {
        totalOperations: number;
        successes: number;
        failures: number;
        totalDuration: number;
        durationCount: number;
        lastActivity: number;
        recordsProcessed: number;
      }> = {};

      for (const event of events) {
        const connector = ('sourceSystem' in event ? event.sourceSystem : 'Unknown') || 'Unknown';

        if (!connectorStats[connector]) {
          connectorStats[connector] = {
            totalOperations: 0,
            successes: 0,
            failures: 0,
            totalDuration: 0,
            durationCount: 0,
            lastActivity: 0,
            recordsProcessed: 0,
          };
        }

        const stats = connectorStats[connector];

        if (event.type === 'IntegrationFlowStarted') {
          stats.totalOperations++;
          stats.lastActivity = Math.max(stats.lastActivity, event.timestamp);
        } else if (event.type === 'IntegrationFlowCompleted') {
          stats.successes++;
          if ('durationMs' in event && typeof event.durationMs === 'number') {
            stats.totalDuration += event.durationMs;
            stats.durationCount++;
          }
          if ('successCount' in event && typeof event.successCount === 'number') {
            stats.recordsProcessed += event.successCount;
          }
        } else if (event.type === 'IntegrationFlowFailed') {
          stats.failures++;
        }
      }

      const performanceBreakdown: PerformanceBreakdown[] = [];
      const hoursInPeriod = timeRangeMs / (60 * 60 * 1000);

      for (const [connector, stats] of Object.entries(connectorStats)) {
        const successRate = stats.totalOperations > 0 ?
          (stats.successes / stats.totalOperations) * 100 : 0;

        const averageLatency = stats.durationCount > 0 ?
          stats.totalDuration / stats.durationCount : 0;

        const throughputPerHour = stats.recordsProcessed / hoursInPeriod;

        const errorRate = stats.totalOperations > 0 ?
          (stats.failures / stats.totalOperations) * 100 : 0;

        performanceBreakdown.push({
          connector,
          totalOperations: stats.totalOperations,
          successRate,
          averageLatency,
          throughputPerHour,
          errorRate,
          lastActivity: stats.lastActivity,
        });
      }

      // Sort by total operations (most active first)
      performanceBreakdown.sort((a, b) => b.totalOperations - a.totalOperations);

      return performanceBreakdown;
    } catch (error) {
      this.logger.error('Failed to generate performance breakdown', { error });
      throw error;
    }
  }

  /**
   * Generate demo performance breakdown data for demonstration purposes
   */
  private getDemoPerformanceBreakdown(): PerformanceBreakdown[] {
    const now = Date.now();

    return [
      {
        connector: 'Salesforce',
        totalOperations: 1247,
        successRate: 95.2,
        averageLatency: 1245,
        throughputPerHour: 1247,
        errorRate: 4.8,
        lastActivity: now - 2 * 60 * 60 * 1000 // 2 hours ago
      },
      {
        connector: 'NetSuite',
        totalOperations: 892,
        successRate: 98.1,
        averageLatency: 856,
        throughputPerHour: 892,
        errorRate: 1.9,
        lastActivity: now - 30 * 60 * 1000 // 30 minutes ago
      },
      {
        connector: 'SAP',
        totalOperations: 445,
        successRate: 93.7,
        averageLatency: 2145,
        throughputPerHour: 445,
        errorRate: 6.3,
        lastActivity: now - 4 * 60 * 60 * 1000 // 4 hours ago
      },
      {
        connector: 'SuiteCentral',
        totalOperations: 623,
        successRate: 97.8,
        averageLatency: 1067,
        throughputPerHour: 623,
        errorRate: 2.2,
        lastActivity: now - 15 * 60 * 1000 // 15 minutes ago
      },
      {
        connector: 'Dynamics365',
        totalOperations: 378,
        successRate: 91.5,
        averageLatency: 1789,
        throughputPerHour: 378,
        errorRate: 8.5,
        lastActivity: now - 6 * 60 * 60 * 1000 // 6 hours ago
      },
      {
        connector: 'Oracle',
        totalOperations: 234,
        successRate: 89.3,
        averageLatency: 2567,
        throughputPerHour: 234,
        errorRate: 10.7,
        lastActivity: now - 8 * 60 * 60 * 1000 // 8 hours ago
      }
    ];
  }

  /**
   * Generate demo ROI metrics for demonstration purposes
   */
  private getDemoROIMetrics(): ROIMetrics {
    return {
      totalRevenue: 2485000,
      costSavings: 485000,
      implementationCosts: 55000,
      operationalCosts: 25000,
      netROI: 2405000,
      roiPercentage: 340.7,
      paybackPeriodMonths: 8.2,
      timeToValue: 6
    };
  }

  /**
   * Generate demo business metrics for demonstration purposes
   */
  private getDemoBusinessMetrics(): BusinessMetrics {
    return {
      integrationEfficiency: 4819,
      dataAccuracy: 95.4,
      systemUptime: 99.2,
      processingSpeed: 87.3,
      errorRate: 4.6,
      customerSatisfaction: 94.1,
      timeToMarket: 78.5
    };
  }
}