import type { IntegrationService } from '../services/IntegrationService';
import { logger as fallbackLogger } from '../utils/Logger';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BusinessStep {
  name: string;
  description: string;
  weight?: number; // relative complexity/time weight
}

interface StepResult {
  processed: number;
  successful: number;
  failed: number;
  errors: string[];
  metrics?: Record<string, unknown>;
}

function getScenarioDisplayName(scenario: string): string {
  const displayNames: Record<string, string> = {
    'customer_onboarding': 'Customer Onboarding Workflow',
    'inventory_sync': 'Inventory Synchronization',
    'order_processing': 'Order Processing Pipeline',
    'vendor_management': 'Vendor Management Sync',
    'financial_reconciliation': 'Financial Reconciliation Process'
  };
  return displayNames[scenario] || 'Business Process Sync';
}

function getScenarioRecordCount(scenario: string): number {
  const recordCounts: Record<string, number> = {
    'customer_onboarding': 45,
    'inventory_sync': 1247,
    'order_processing': 189,
    'vendor_management': 78,
    'financial_reconciliation': 342
  };
  return recordCounts[scenario] || 100;
}

function getScenarioMinTime(scenario: string, recordCount: number): number {
  const baseTime = recordCount * 2; // 2ms per record base
  const multipliers: Record<string, number> = {
    'customer_onboarding': 3,
    'inventory_sync': 1.5,
    'order_processing': 2.5,
    'vendor_management': 2,
    'financial_reconciliation': 4
  };
  return Math.max(100, baseTime * (multipliers[scenario] || 2));
}

function getScenarioMaxTime(scenario: string, recordCount: number): number {
  return getScenarioMinTime(scenario, recordCount) * 2.5;
}

function getBusinessStepsForScenario(scenario: string): BusinessStep[] {
  const businessSteps: Record<string, BusinessStep[]> = {
    'customer_onboarding': [
      { name: 'data-validation', description: 'Validating customer data integrity and completeness', weight: 2 },
      { name: 'duplicate-check', description: 'Checking for duplicate customer records', weight: 3 },
      { name: 'credit-verification', description: 'Performing credit checks and risk assessment', weight: 4 },
      { name: 'account-creation', description: 'Creating customer accounts and profiles', weight: 2 },
      { name: 'welcome-automation', description: 'Triggering welcome emails and onboarding workflows', weight: 1 }
    ],
    'inventory_sync': [
      { name: 'inventory-scan', description: 'Scanning inventory levels across all warehouses', weight: 3 },
      { name: 'price-update', description: 'Synchronizing product pricing and cost updates', weight: 2 },
      { name: 'availability-check', description: 'Updating product availability and stock status', weight: 2 },
      { name: 'reorder-analysis', description: 'Analyzing reorder points and generating alerts', weight: 4 }
    ],
    'order_processing': [
      { name: 'order-validation', description: 'Validating order details and customer information', weight: 2 },
      { name: 'inventory-allocation', description: 'Allocating inventory and checking availability', weight: 3 },
      { name: 'payment-processing', description: 'Processing payments and financial transactions', weight: 4 },
      { name: 'fulfillment-prep', description: 'Preparing orders for fulfillment and shipping', weight: 2 },
      { name: 'notification-dispatch', description: 'Sending order confirmations and tracking updates', weight: 1 }
    ],
    'vendor_management': [
      { name: 'vendor-validation', description: 'Validating vendor credentials and compliance status', weight: 3 },
      { name: 'contract-sync', description: 'Synchronizing contract terms and pricing agreements', weight: 4 },
      { name: 'performance-analysis', description: 'Analyzing vendor performance metrics', weight: 2 },
      { name: 'payment-reconciliation', description: 'Reconciling vendor payments and outstanding balances', weight: 3 }
    ],
    'financial_reconciliation': [
      { name: 'transaction-matching', description: 'Matching transactions across financial systems', weight: 4 },
      { name: 'discrepancy-analysis', description: 'Analyzing and flagging financial discrepancies', weight: 5 },
      { name: 'adjustment-processing', description: 'Processing necessary financial adjustments', weight: 3 },
      { name: 'audit-trail-generation', description: 'Generating comprehensive audit trails', weight: 2 },
      { name: 'compliance-reporting', description: 'Preparing compliance and regulatory reports', weight: 3 }
    ]
  };
  return businessSteps[scenario] || [
    { name: 'data-processing', description: 'Processing business data', weight: 2 },
    { name: 'validation', description: 'Validating data integrity', weight: 1 },
    { name: 'sync-completion', description: 'Completing synchronization process', weight: 1 }
  ];
}

async function simulateBusinessStepLogic(step: BusinessStep, totalRecords: number, opts: FakeRunnerOptions): Promise<StepResult> {
  const stepWeight = step.weight || 1;
  const recordsToProcess = Math.max(1, Math.floor(totalRecords / 5)); // Process portion of records per step
  
  let successful = recordsToProcess;
  let failed = 0;
  const errors: string[] = [];
  
  // Simulate realistic business validation failures
  if (opts.simulateDataValidation && Math.random() < 0.1) {
    const failureCount = Math.max(1, Math.floor(recordsToProcess * 0.05)); // 5% failure rate
    failed = failureCount;
    successful = recordsToProcess - failureCount;
    
    const businessErrors = [
      'Invalid customer email format detected',
      'Duplicate customer ID found in external system',
      'Credit check service temporarily unavailable',
      'Required field missing: billing address',
      'Product SKU not found in inventory system',
      'Price list mismatch between systems',
      'Vendor payment terms validation failed',
      'Financial period is closed for transactions'
    ];
    
    for (let i = 0; i < Math.min(failureCount, 3); i++) {
      const randomError = businessErrors[Math.floor(Math.random() * businessErrors.length)];
      if (randomError) errors.push(randomError);
    }
  }

  // Simulate transformation rule applications
  const metrics: Record<string, unknown> = {};
  if (opts.includeBusinessMetrics) {
    metrics.stepComplexity = stepWeight;
    metrics.recordsPerSecond = Math.round((recordsToProcess / (stepWeight * 100)) * 100) / 100;
    metrics.businessRulesApplied = Math.floor(Math.random() * 5) + 1;
    if (opts.simulateTransformationRules) {
      metrics.fieldsTransformed = Math.floor(Math.random() * 12) + 3;
      metrics.dataEnrichments = Math.floor(Math.random() * 4) + 1;
    }
  }
  
  return {
    processed: recordsToProcess,
    successful,
    failed,
    errors,
    metrics
  };
}

export interface FakeRunnerOptions {
  // overall min/max ms if not using per-step timings
  minMs?: number;
  maxMs?: number;
  // number of logical steps to split the work into
  steps?: number;
  // per-step min/max ms (overrides overall min/max when provided)
  stepMinMs?: number;
  stepMaxMs?: number;
  // verbose: include stepLogs in the returned payload
  verbose?: boolean;
  // simulate a failure with this probability (0-1)
  failureProbability?: number;
  // optionally force failure at a specific step (1-based)
  failAtStep?: number;
  // business scenario simulation options
  scenario?: 'customer_onboarding' | 'inventory_sync' | 'order_processing' | 'vendor_management' | 'financial_reconciliation';
  recordCount?: number;
  includeBusinessMetrics?: boolean;
  simulateDataValidation?: boolean;
  simulateTransformationRules?: boolean;
}

export async function runFakeSuiteCentralSync(
  integrationService?: unknown,
  observability?: unknown,
  opts: FakeRunnerOptions = {},
) {
  const logger = observability && (observability as any).logging && typeof (observability as any).logging.getLogger === 'function'
    ? (observability as any).logging.getLogger()
    : fallbackLogger;

  const start = new Date();
  const stepLogs: { step: number; name?: string; ms: number; message?: string; status: 'ok' | 'failed' }[] = [];

  try {
    if (logger && typeof logger.info === 'function') logger.info('FakeSuiteCentral: starting fake sync');
    else fallbackLogger.info('[FakeSuiteCentral] starting fake sync');

    // Discover configuration count if available
    let configsCount = 0;
    try {
      if (integrationService) {
        if (typeof (integrationService as any).getAllConfigurations === 'function') {
          const cfgs = await Promise.resolve((integrationService as any).getAllConfigurations());
          configsCount = Array.isArray(cfgs) ? cfgs.length : 0;
        } else if ((integrationService as any).configService && typeof (integrationService as any).configService.getAllConfigurations === 'function') {
          const cfgs = await Promise.resolve((integrationService as any).configService.getAllConfigurations());
          configsCount = Array.isArray(cfgs) ? cfgs.length : 0;
        }
      }
    } catch (e) {
      // ignore discovery errors
    }

    if (logger && typeof logger.debug === 'function') logger.debug(`FakeSuiteCentral: found ${configsCount} configurations`);

    // Prepare simulation parameters based on scenario
    const scenario = opts.scenario ?? 'customer_onboarding';
    const recordCount = opts.recordCount ?? getScenarioRecordCount(scenario);
    const businessSteps = getBusinessStepsForScenario(scenario);
    const steps = Math.max(1, Math.floor(opts.steps ?? businessSteps.length));
    const overallMin = opts.minMs ?? getScenarioMinTime(scenario, recordCount);
    const overallMax = opts.maxMs ?? getScenarioMaxTime(scenario, recordCount);
    const stepMin = opts.stepMinMs ?? Math.max(10, Math.floor(overallMin / steps));
    const stepMax = opts.stepMaxMs ?? Math.max(stepMin, Math.floor(overallMax / Math.max(1, steps)));
  // Allow deterministic-success mode for CI/local demos via env var
  const deterministic = process.env.DEMO_FAKE_DETERMINISTIC === '1' || process.env.DEMO_FAKE_DETERMINISTIC === 'true';
  const failureProbability = deterministic ? 0 : Math.min(1, Math.max(0, Number(opts.failureProbability ?? 0)));
    const forcedFailAt = typeof opts.failAtStep === 'number' && opts.failAtStep > 0 ? Math.floor(opts.failAtStep) : undefined;

    if (logger && typeof logger.debug === 'function') logger.debug(`FakeSuiteCentral: simulating ${steps} steps (per-step ${stepMin}-${stepMax}ms) failureProb=${failureProbability}`);

    // Determine if we'll fail and which step
    let willFail = false;
    let failAt = forcedFailAt;
    if (failureProbability > 0 && Math.random() < failureProbability) {
      willFail = true;
      if (!failAt) failAt = Math.floor(Math.random() * steps) + 1;
    }

    // Execute business-realistic steps sequentially
    const businessStepsToExecute = businessSteps.slice(0, steps);
    let recordsProcessed = 0;
    let recordsSuccessful = 0;
    let recordsFailed = 0;
    const businessErrors: string[] = [];
    
    for (let s = 1; s <= steps; s += 1) {
      const stepMs = Math.floor(Math.random() * (stepMax - stepMin + 1)) + stepMin;
      const businessStep = businessStepsToExecute[s - 1] || { name: `step-${s}`, description: 'Generic processing step' };
      const stepName = businessStep.name;
      const stepDescription = businessStep.description;
      
      if (logger && typeof logger.info === 'function') logger.info(`FakeSuiteCentral: ${stepDescription} (~${stepMs}ms)`);
      else fallbackLogger.info(`[FakeSuiteCentral] ${stepDescription} (~${stepMs}ms)`);

      // Simulate realistic step processing
      await sleep(stepMs / 2); // Partial processing
      
      // Simulate business logic during step
      const stepResult = await simulateBusinessStepLogic(businessStep, recordCount, opts);
      recordsProcessed += stepResult.processed;
      recordsSuccessful += stepResult.successful;
      recordsFailed += stepResult.failed;
      businessErrors.push(...stepResult.errors);
      
      await sleep(stepMs / 2); // Complete processing

      if (willFail && failAt === s) {
        const err = new Error(`Business validation failed during ${stepDescription}: ${stepResult.errors[0] || 'Critical system error'}`);
        if (logger && typeof logger.error === 'function') logger.error(`FakeSuiteCentral: ${stepName} failed`, err);
        stepLogs.push({ step: s, name: stepName, ms: stepMs, message: String(err.message), status: 'failed' });
        throw err;
      }

      if (logger && typeof logger.debug === 'function') logger.debug(`FakeSuiteCentral: completed ${stepDescription}`);
      stepLogs.push({ 
        step: s, 
        name: stepName, 
        ms: stepMs, 
        message: `${stepDescription} - Processed: ${stepResult.processed}, Success: ${stepResult.successful}, Failed: ${stepResult.failed}`, 
        status: 'ok'
      });
    }

    const end = new Date();
    const processingMs = Math.max(0, end.getTime() - start.getTime());
    if (logger && typeof logger.info === 'function') logger.info('FakeSuiteCentral: completed fake sync', { processingMs });

    const result: Record<string, unknown> = {
      success: true,
      message: `SuiteCentral ${getScenarioDisplayName(scenario)} completed successfully`,
      scenario: scenario,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      processingMs,
      processingTime: `${(processingMs / 1000).toFixed(1)}s`,
      recordsProcessed,
      recordsSuccessful,
      recordsFailed,
      errors: businessErrors,
      businessMetrics: {
        scenario: getScenarioDisplayName(scenario),
        totalRecords: recordCount,
        throughputPerSecond: Math.round((recordsProcessed / (processingMs / 1000)) * 100) / 100,
        successRate: recordsProcessed > 0 ? Math.round((recordsSuccessful / recordsProcessed) * 10000) / 100 : 100,
        avgProcessingTimePerRecord: recordsProcessed > 0 ? Math.round((processingMs / recordsProcessed) * 100) / 100 : 0
      }
    };
    if (opts.verbose) result.stepLogs = stepLogs;
    return result;
  } catch (err) {
    const end = new Date();
    const processingMs = Math.max(0, end.getTime() - start.getTime());
    if (logger && typeof logger.error === 'function') logger.error('FakeSuiteCentral: failed', err);
    return {
      success: false,
      message: 'Fake SuiteCentral sync failed',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      processingMs,
      error: String(err),
      stepLogs,
    };
  }
}

export default runFakeSuiteCentralSync;
