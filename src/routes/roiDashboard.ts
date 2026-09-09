import { Router, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { TelemetryStore } from '../services/TelemetryStore';
import { TelemetryAggregator } from '../services/TelemetryAggregator';
import { IntegrationService } from '../services/IntegrationService';
import { ConfigurationService } from '../services/ConfigurationService';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { ROIAnalysisService } from '../services/ai/orchestrator/agents/intelligence/ROIAnalysisService';
import type { BusinessImpactAnalysis } from '../services/ai/orchestrator/agents/types/business-intelligence/analysis.types';
import type { ImplementationScenario } from '../services/ai/orchestrator/agents/types/business-intelligence/core.types';
import type { AllTelemetryEvents } from '../domain/telemetry/events';
import { logger } from '../utils/Logger';

const router = Router();

// Helper function to seed demo telemetry data
async function seedDemoTelemetryData(telemetryStore: TelemetryStore): Promise<void> {
  const storageStats = telemetryStore.getStorageStats();

  logger.info(`[DEMO] Checking telemetry storage: ${storageStats.totalEvents} events exist`);

  // Only seed if no data exists
  if (storageStats.totalEvents > 0) {
    logger.info('[DEMO] Telemetry data already exists, skipping seeding');
    return;
  }

  logger.info('[DEMO] Seeding telemetry data for performance overview...');

  const now = Date.now();
  const systems = [
    { source: 'Salesforce', target: 'NetSuite' },
    { source: 'NetSuite', target: 'Dynamics365' },
    { source: 'SAP', target: 'Oracle' },
    { source: 'SuiteCentral', target: 'Salesforce' },
    { source: 'Workday', target: 'NetSuite' },
  ];

  let eventId = 1000;

  // Generate sample events over the last 30 days
  for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
    const dayTime = now - (dayOffset * 24 * 60 * 60 * 1000);

    for (const system of systems) {
      const flowsPerDay = Math.floor(Math.random() * 5) + 2; // 2-6 flows per day

      for (let flowIdx = 0; flowIdx < flowsPerDay; flowIdx++) {
        const flowId = `flow-${system.source}-${system.target}-${dayOffset}-${flowIdx}`;
        const recordCount = Math.floor(Math.random() * 5000) + 100;
        const startTime = dayTime + (flowIdx * 2 * 60 * 60 * 1000); // Spread throughout day

        // Integration started event
        const startedEvent: AllTelemetryEvents = {
          id: `event-${eventId++}`,
          timestamp: startTime,
          type: 'IntegrationFlowStarted',
          flowId,
          sourceSystem: system.source,
          targetSystem: system.target,
          recordCount,
          metadata: { connector: system.source }
        };
        await telemetryStore.storeEvent(startedEvent);

        // Determine if flow succeeds or fails (90% success rate)
        const successful = Math.random() > 0.1;
        const duration = Math.floor(Math.random() * 120000) + 30000; // 30s - 2m

        if (successful) {
          const successCount = Math.floor(recordCount * (0.95 + Math.random() * 0.05));
          const failureCount = recordCount - successCount;

          const completedEvent: AllTelemetryEvents = {
            id: `event-${eventId++}`,
            timestamp: startTime + duration,
            type: 'IntegrationFlowCompleted',
            flowId,
            sourceSystem: system.source,
            targetSystem: system.target,
            recordCount,
            successCount,
            failureCount,
            durationMs: duration,
            metadata: { connector: system.source }
          };
          await telemetryStore.storeEvent(completedEvent);
        } else {
          const failedEvent: AllTelemetryEvents = {
            id: `event-${eventId++}`,
            timestamp: startTime + duration,
            type: 'IntegrationFlowFailed',
            flowId,
            sourceSystem: system.source,
            targetSystem: system.target,
            errorCode: 'CONN_TIMEOUT',
            errorMessage: 'Connection timeout during data transfer',
            durationMs: duration,
            metadata: { connector: system.source }
          };
          await telemetryStore.storeEvent(failedEvent);
        }
      }
    }
  }

  logger.info(`[DEMO] Seeded ${eventId - 1000} telemetry events for demo`);
}

interface ROIMetrics {
  totalSavings: number;
  timeReduction: number;
  processEfficiency: number;
  errorReduction: number;
  automationLevel: number;
  businessImpact: {
    revenueImpact: number;
    costSavings: number;
    productivityGains: number;
  };
  trends: {
    daily: { date: string; value: number }[];
    weekly: { week: string; value: number }[];
    monthly: { month: string; value: number }[];
  };
}

interface ExecutiveSummary {
  kpis: {
    totalIntegrations: number;
    activeIntegrations: number;
    successRate: number;
    avgProcessingTime: number;
    dataVolume: number;
    errorRate: number;
  };
  financialMetrics: {
    costPerTransaction: number;
    totalCostSavings: number;
    roi: number;
    paybackPeriod: number;
  };
  operationalMetrics: {
    uptime: number;
    throughput: number;
    latency: number;
    automationRate: number;
  };
  alerts: {
    type: 'warning' | 'error' | 'info';
    message: string;
    timestamp: Date;
  }[];
}

// Interactive ROI calculation endpoint
router.post('/calculate', asyncHandler(async (req, res) => {
  const roiService = container.get<ROIAnalysisService>(TYPES.ROIAnalysisService);

  const {
    initialInvestment = 100000,
    annualSavings = 200000,
    annualRevenue = 50000,
    operationalCost = 20000,
    timeframeYears = 3
  } = req.body;

  // Construct BusinessImpactAnalysis object
  const businessImpact: BusinessImpactAnalysis = {
    businessValue: {
      monetaryImpact: {
        implementationCost: Number(initialInvestment),
        annualSavings: Number(annualSavings),
        revenueOpportunity: Number(annualRevenue),
        paybackPeriodMonths: 0,
        netROI: 0
      },
      currentState: {
        processEfficiency: 0,
        operationalCost: Number(operationalCost),
        dataQualityScore: 0,
        complianceRating: 0
      },
      potentialImprovements: {
        qualityGainPercentage: 0,
        efficiencyGainPercentage: 0,
        costReductionPercentage: 0,
        revenueUpliftPercentage: 0
      }
    },
    riskAssessment: {
      overallRiskLevel: 'medium',
      riskCategories: [],
      mitigationStrategies: [],
      complianceRisks: []
    }
  };

  const scenario: ImplementationScenario = {
    scenario: 'realistic',
    timeframe: Number(timeframeYears),
    discountRate: 0.08,
    implementationApproach: 'phased',
    riskTolerance: 'medium'
  };

  const result = await roiService.performROICalculation(businessImpact, scenario);
  res.json(result);
}));

// Real-time ROI metrics endpoint
router.get('/metrics', asyncHandler(async (req, res) => {
  const telemetryStore = container.get<TelemetryStore>(TYPES.TelemetryStore);
  const aggregator = container.get<TelemetryAggregator>(TYPES.TelemetryAggregator);

  // Seed demo data if running in demo mode
  if (process.env.DEMO_MODE === '1') {
    await seedDemoTelemetryData(telemetryStore);
  }

  // Calculate ROI metrics using TelemetryAggregator
  const roiData = await aggregator.calculateROI(telemetryStore);

  // Generate trends data
  const dailyTrends: { date: string; value: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dailyTrends.push({
      date: date.toISOString().split('T')[0] as string,
      value: roiData.roiPercentage
    });
  }

  const metrics: ROIMetrics = {
    totalSavings: roiData.costSavings,
    timeReduction: 75, // Mock data - could be enhanced
    processEfficiency: 85, // Mock data - could be enhanced
    errorReduction: 60, // Mock data - could be enhanced
    automationLevel: 80, // Mock data - could be enhanced
    businessImpact: {
      revenueImpact: roiData.totalRevenue,
      costSavings: roiData.costSavings,
      productivityGains: roiData.costSavings * 0.6 // Estimate
    },
    trends: {
      daily: dailyTrends,
      weekly: [], // Could implement weekly aggregation
      monthly: [] // Could implement monthly aggregation
    }
  };

  res.json(metrics);
}));

// Executive summary endpoint
router.get('/executive-summary', asyncHandler(async (req, res) => {
  const telemetryStore = container.get<TelemetryStore>(TYPES.TelemetryStore);
  const aggregator = container.get<TelemetryAggregator>(TYPES.TelemetryAggregator);
  const configService = container.get<ConfigurationService>(TYPES.ConfigurationService);
  const integrationService = await container.getAsync<IntegrationService>(TYPES.IntegrationService);

  // Seed demo data if running in demo mode
  if (process.env.DEMO_MODE === '1') {
    await seedDemoTelemetryData(telemetryStore);
  }

  // Generate executive summary using TelemetryAggregator
  const executiveSummary = await aggregator.generateExecutiveSummary(telemetryStore);

  // Get system health for operational metrics
  const systemHealth = await integrationService.getSystemHealth();
  const configs = configService.getAllConfigurations();

  // Calculate additional metrics
  const totalIntegrations = configs.length;
  const activeIntegrations = configs.filter(c => c.isActive).length;

  // Generate alerts based on system health and metrics
  const alerts: { type: 'warning' | 'error' | 'info'; message: string; timestamp: Date }[] = [];

  if (executiveSummary.successRate < 95) {
    alerts.push({
      type: 'warning',
      message: `Integration success rate is ${executiveSummary.successRate.toFixed(1)}% - below 95% threshold`,
      timestamp: new Date()
    });
  }

  Object.entries(systemHealth.systemStatus).forEach(([system, status]) => {
    if (!status) {
      alerts.push({
        type: 'error',
        message: `${system} system is currently unavailable`,
        timestamp: new Date()
      });
    }
  });

  const summary: ExecutiveSummary = {
    kpis: {
      totalIntegrations,
      activeIntegrations,
      successRate: Math.round(executiveSummary.successRate * 100) / 100,
      avgProcessingTime: Math.round(executiveSummary.businessMetrics.processingSpeed),
      dataVolume: executiveSummary.totalDataProcessed,
      errorRate: Math.round(executiveSummary.businessMetrics.errorRate * 100) / 100
    },
    financialMetrics: {
      costPerTransaction: executiveSummary.roi.operationalCosts / Math.max(executiveSummary.totalDataProcessed, 1),
      totalCostSavings: executiveSummary.roi.costSavings,
      roi: executiveSummary.roi.roiPercentage,
      paybackPeriod: executiveSummary.roi.paybackPeriodMonths
    },
    operationalMetrics: {
      uptime: Object.values(systemHealth.systemStatus).filter(Boolean).length /
        Math.max(Object.values(systemHealth.systemStatus).length, 1) * 100,
      throughput: executiveSummary.businessMetrics.processingSpeed,
      latency: executiveSummary.businessMetrics.processingSpeed,
      automationRate: (activeIntegrations / Math.max(totalIntegrations, 1)) * 100
    },
    alerts
  };

  res.json(summary);
}));

// Real-time performance metrics
router.get('/performance', asyncHandler(async (req, res) => {
  const telemetryStore = container.get<TelemetryStore>(TYPES.TelemetryStore);
  const aggregator = container.get<TelemetryAggregator>(TYPES.TelemetryAggregator);

  const performanceData = await aggregator.generatePerformanceBreakdown(telemetryStore);

  res.json(performanceData);
}));

// Cost analysis endpoint
router.get('/cost-analysis', asyncHandler(async (req, res) => {
  const { timeframe = '30d' } = req.query;

  const telemetryStore = container.get<TelemetryStore>(TYPES.TelemetryStore);
  const aggregator = container.get<TelemetryAggregator>(TYPES.TelemetryAggregator);

  // Seed demo data if running in demo mode
  if (process.env.DEMO_MODE === '1') {
    await seedDemoTelemetryData(telemetryStore);
  }

  let timeRangeMs: number;
  switch (timeframe) {
    case '7d':
      timeRangeMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case '30d':
      timeRangeMs = 30 * 24 * 60 * 60 * 1000;
      break;
    case '90d':
      timeRangeMs = 90 * 24 * 60 * 60 * 1000;
      break;
    default:
      timeRangeMs = 30 * 24 * 60 * 60 * 1000;
  }

  const costData = await aggregator.calculateROI(telemetryStore, timeRangeMs);
  const totalCosts = costData.implementationCosts + costData.operationalCosts;

  res.json({
    timeframe,
    totalCosts,
    costSavings: costData.costSavings,
    roi: costData.roiPercentage,
    breakdown: {
      infrastructure: totalCosts * 0.3,
      labor: totalCosts * 0.5,
      software: totalCosts * 0.2
    },
    projectedSavings: {
      monthly: costData.costSavings / (timeframe === '90d' ? 3 : timeframe === '30d' ? 1 : 0.25),
      yearly: costData.costSavings * (365 / (timeframe === '90d' ? 90 : timeframe === '30d' ? 30 : 7))
    }
  });
}));

export { router as roiDashboardRouter };