import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { Logger } from '../utils/Logger';
import { SquireConnector } from '../connectors/SquireConnector';
import { SuiteCentralProductionConnector } from '../connectors/SuiteCentralProductionConnector';
import type { NetSuiteConnector } from '../connectors/NetSuiteConnector';
import { getConnectorRegistration } from '../connectors/connectorRegistry';
import { FieldMapperUtility } from '../utils/fieldMapper';
import { AuthService } from '../services/AuthService';
import { suiteCentralMetrics as metrics } from '../services/SuiteCentralMetrics';
import { getMappingMetadata } from '../data/squireMockData';
import type { DataRecord, SyncResult } from '../types';
import { container } from '../inversify/inversify.config';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';
import { TYPES } from '../inversify/types';
import { PendingApprovalError } from '../services/governance/OutboundGovernanceErrors';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

interface PipelineStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  records?: number;
  errors?: string[];
  metadata?: unknown;
}

interface FullPipelineResult {
  pipelineId: string;
  status: 'success' | 'partial' | 'failed';
  startTime: Date;
  endTime: Date;
  steps: PipelineStep[];
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  errors: string[];
  performance: {
    totalDuration: number;
    averageRecordTime: number;
    throughput: number; // records per second
  };
}

export function createFullPipelineDemoRouter(): Router {
  const router = Router();
  const logger = new Logger('FullPipelineDemo');
  const fieldMapper = new FieldMapperUtility(logger);
  const authService = new AuthService(logger);
  

  /**
   * Execute complete Squire → SuiteCentral → NetSuite integration pipeline
   */
  router.post(
    '/execute',
    asyncHandler(async (req, res): Promise<void> => {
      const {
        module = 'SupplierCentral',
        entityType = 'vendors',
        batchSize = 10,
        includeNetSuiteSync = true,
        dryRun = false
      } = req.body;

      const pipelineId = `pipeline_${Date.now()}`;
      const startTime = new Date();
      
      logger.info('Starting full pipeline demo', {
        pipelineId,
        module,
        entityType,
        batchSize,
        includeNetSuiteSync,
        dryRun
      });

      const result: FullPipelineResult = {
        pipelineId,
        status: 'success',
        startTime,
        endTime: new Date(),
        steps: [],
        totalRecords: 0,
        successfulRecords: 0,
        failedRecords: 0,
        errors: [],
        performance: {
          totalDuration: 0,
          averageRecordTime: 0,
          throughput: 0
        }
      };

      try {
        // Step 1: Initialize connectors
        const step1 = await initializeConnectors(result, logger, authService);
        if (step1.status === 'failed') {
          res.json(result);
          return;
        }

        const { squireConnector, suiteCentralConnector, netSuiteConnector } = step1.connectors!;

        // Step 2: Extract data from Squire
        const step2 = await extractFromSquire(
          result, 
          squireConnector, 
          entityType, 
          logger
        );

        if (step2.status === 'failed' || !step2.data?.length) {
          res.json(result);
          return;
        }

        // Step 3: Transform data for SuiteCentral
        const step3 = await transformForSuiteCentral(
          result,
          step2.data,
          module,
          entityType,
          fieldMapper,
          logger
        );

        if (step3.status === 'failed' || !step3.transformedData?.length) {
          res.json(result);
          return;
        }

        // Step 4: Load data to SuiteCentral
        const step4 = await loadToSuiteCentral(
          result,
          suiteCentralConnector,
          step3.transformedData,
          entityType,
          batchSize,
          dryRun,
          logger
        );

        // Step 5: Sync from SuiteCentral to NetSuite (if enabled)
        if (includeNetSuiteSync && step4.status === 'completed' && step4.syncedData?.length) {
          await syncToNetSuite(
            result,
            netSuiteConnector,
            step4.syncedData,
            entityType,
            batchSize,
            dryRun,
            logger
          );
        }

        // Calculate final metrics
        calculateFinalMetrics(result);

        // Record comprehensive pipeline metrics
        metrics.recordPipelineExecution(
          result.status,
          result.performance.totalDuration,
          includeNetSuiteSync,
          result.totalRecords
        );

        // Record individual step metrics
        result.steps.forEach(step => {
          const stepDuration = step.endTime && step.startTime ? 
            (step.endTime.getTime() - step.startTime.getTime()) / 1000 : undefined;
          metrics.recordPipelineStep(step.step, step.status, stepDuration);
        });

        // Record memory usage
        const memUsage = process.memoryUsage();
        metrics.setMemoryUsage('pipeline_execution', memUsage.heapUsed);

        logger.info('Full pipeline demo completed', {
          pipelineId: result.pipelineId,
          status: result.status,
          totalRecords: result.totalRecords,
          successfulRecords: result.successfulRecords,
          duration: result.performance.totalDuration
        });

        res.json(result);

      } catch (error) {
        if (await handleApprovalQueueError(error, req, res, {
          operationType: 'connector_write',
          resourceType: 'full_pipeline_demo.netsuite_sync',
          resourceId: result.pipelineId,
        })) return;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Full pipeline demo failed', error);

        result.status = 'failed';
        result.endTime = new Date();
        result.errors.push(`Pipeline execution failed: ${errorMsg}`);

        calculateFinalMetrics(result);
        res.status(500).json(result);
      }
    })
  );

  /**
   * Get pipeline status and progress
   */
  router.get(
    '/status/:pipelineId',
    asyncHandler(async (req, res): Promise<void> => {
      const { pipelineId } = req.params;
      
      // In a real implementation, this would check stored pipeline status
      res.json({
        pipelineId,
        message: 'Pipeline status tracking not implemented in demo mode',
        suggestion: 'Use the /execute endpoint for real-time pipeline execution'
      });
    })
  );

  /**
   * Get available pipeline configurations
   */
  router.get(
    '/configurations',
    asyncHandler(async (req, res): Promise<void> => {
      const configurations = {
        modules: [
          {
            name: 'SupplierCentral',
            entityTypes: ['vendors', 'suppliers'],
            description: 'Vendor/supplier lifecycle management'
          },
          {
            name: 'InstallerCentral', 
            entityTypes: ['installers', 'technicians'],
            description: 'Installation partner management'
          },
          {
            name: 'PayoutCentral',
            entityTypes: ['payouts', 'commissions'],
            description: 'Commission and payment processing'
          }
        ],
        defaultSettings: {
          batchSize: 10,
          includeNetSuiteSync: true,
          dryRun: false
        },
        estimatedDuration: {
          small: '30-60 seconds (10-50 records)',
          medium: '2-5 minutes (51-200 records)', 
          large: '5-15 minutes (200+ records)'
        }
      };

      res.json(configurations);
    })
  );

  /**
   * Get enhanced SuiteCentral metrics summary
   */
  router.get(
    '/metrics',
    asyncHandler(async (req, res): Promise<void> => {
      const summary = metrics.getMetricsSummary();
      
      const enhancedSummary = {
        ...summary,
        metricsBreakdown: {
          syncOperations: {
            description: 'Total sync operations across all SuiteCentral modules',
            value: summary.totalSyncOperations
          },
          recordsProcessed: {
            description: 'Total records processed in all sync operations',
            value: summary.totalRecords
          },
          errorRate: {
            description: 'Error rate percentage',
            value: summary.totalSyncOperations > 0 ? 
              (summary.totalErrors / summary.totalSyncOperations * 100).toFixed(2) + '%' : '0%'
          },
          pipelineExecutions: {
            description: 'Full pipeline executions (Squire → SuiteCentral → NetSuite)',
            value: summary.totalPipelineExecutions
          },
          activeConnections: {
            description: 'Current active connections to SuiteCentral modules',
            value: summary.activeConnectionsCount
          }
        },
        availableMetrics: [
          'suitecentral_sync_operations_total',
          'suitecentral_sync_records_total', 
          'suitecentral_sync_duration_seconds',
          'suitecentral_sync_errors_total',
          'suitecentral_pipeline_executions_total',
          'suitecentral_pipeline_steps_total',
          'suitecentral_pipeline_duration_seconds',
          'suitecentral_record_throughput_per_second',
          'suitecentral_financial_transactions_total',
          'suitecentral_data_quality_score',
          'suitecentral_compliance_checks_total'
        ]
      };

      res.json(enhancedSummary);
    })
  );

  return router;
}

/**
 * Step 1: Initialize all required connectors
 */
async function initializeConnectors(
  result: FullPipelineResult,
  logger: Logger,
  authService: AuthService
): Promise<{
  status: 'completed' | 'failed';
  connectors?: {
    squireConnector: SquireConnector;
    suiteCentralConnector: SuiteCentralProductionConnector;
    netSuiteConnector: NetSuiteConnector;
  };
}> {
  const step: PipelineStep = {
    step: 'initialize_connectors',
    status: 'running',
    startTime: new Date()
  };
  result.steps.push(step);

  try {
    logger.info('Initializing connectors...');

    // Initialize Squire connector
    const squireConnector = new SquireConnector('Squire', 'squire', logger, authService);
    await squireConnector.initialize({
      type: 'api_key',
      credentials: {
        apiKey: 'squire-demo-key',
        baseUrl: 'https://api.squire.demo'
      }
    });

    // Initialize SuiteCentral connector  
    const suiteCentralConnector = new SuiteCentralProductionConnector(
      'SuiteCentral',
      'suitecentral-prod',
      logger,
      authService
    );
    await suiteCentralConnector.initialize({
      type: 'api_key',
      credentials: {
        apiKey: process.env.SUITECENTRAL_API_KEY || 'demo-key',
        baseUrl: process.env.SUITECENTRAL_BASE_URL || 'https://demo.suitecentral.local/api/v1',
        tenantId: process.env.SUITECENTRAL_TENANT_ID || 'demo-tenant',
        productionMode: false // Force demo mode for this demo
      }
    });

    // Initialize NetSuite connector via the canonical registry factory.
    const outboundGovernance = container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
    const netSuiteConnector = getConnectorRegistration('netsuite')!.factory!('netsuite-demo', {
      logger,
      authService,
      outboundGovernance,
    }) as NetSuiteConnector;
    
    // Only initialize NetSuite if we have real credentials
    const hasNetSuiteCredentials = process.env.NETSUITE_ACCOUNT_ID && 
                                  process.env.NETSUITE_CONSUMER_KEY;
    
    if (hasNetSuiteCredentials) {
      await netSuiteConnector.initialize({
        type: 'oauth1',
        credentials: {
          accountId: process.env.NETSUITE_ACCOUNT_ID!,
          consumerKey: process.env.NETSUITE_CONSUMER_KEY!,
          consumerSecret: process.env.NETSUITE_CONSUMER_SECRET!,
          tokenId: process.env.NETSUITE_TOKEN_ID!,
          tokenSecret: process.env.NETSUITE_TOKEN_SECRET!,
          baseUrl: process.env.NETSUITE_BASE_URL
        }
      });
    } else {
      logger.warn('NetSuite credentials not found, NetSuite sync will be simulated');
    }

    step.status = 'completed';
    step.endTime = new Date();
    step.metadata = {
      squireConnected: true,
      suiteCentralConnected: true,
      netSuiteConnected: hasNetSuiteCredentials,
      demoMode: !hasNetSuiteCredentials
    };

    logger.info('Connectors initialized successfully');

    return {
      status: 'completed',
      connectors: {
        squireConnector,
        suiteCentralConnector,
        netSuiteConnector
      }
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    step.status = 'failed';
    step.endTime = new Date();
    step.errors = [errorMsg];
    result.errors.push(`Connector initialization failed: ${errorMsg}`);
    result.status = 'failed';
    
    logger.error('Connector initialization failed', error);
    return { status: 'failed' };
  }
}

/**
 * Step 2: Extract data from Squire system
 */
async function extractFromSquire(
  result: FullPipelineResult,
  squireConnector: SquireConnector,
  entityType: string,
  logger: Logger
): Promise<{
  status: 'completed' | 'failed';
  data?: DataRecord[];
}> {
  const step: PipelineStep = {
    step: 'extract_from_squire',
    status: 'running',
    startTime: new Date()
  };
  result.steps.push(step);

  try {
    logger.info(`Extracting ${entityType} from Squire...`);

    const data = await squireConnector.list(entityType, { limit: 50 });
    
    step.status = 'completed';
    step.endTime = new Date();
    step.records = data.length;
    step.metadata = {
      entityType,
      extractedRecords: data.length
    };

    result.totalRecords = data.length;
    
    logger.info(`Extracted ${data.length} records from Squire`);

    return {
      status: 'completed',
      data
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    step.status = 'failed';
    step.endTime = new Date();
    step.errors = [errorMsg];
    result.errors.push(`Squire extraction failed: ${errorMsg}`);
    result.status = 'failed';
    
    logger.error('Squire extraction failed', error);
    return { status: 'failed' };
  }
}

/**
 * Step 3: Transform data for SuiteCentral format
 */
async function transformForSuiteCentral(
  result: FullPipelineResult,
  sourceData: DataRecord[],
  module: string,
  entityType: string,
  fieldMapper: FieldMapperUtility,
  logger: Logger
): Promise<{
  status: 'completed' | 'failed';
  transformedData?: DataRecord[];
}> {
  const step: PipelineStep = {
    step: 'transform_for_suitecentral',
    status: 'running',
    startTime: new Date()
  };
  result.steps.push(step);

  try {
    logger.info(`Transforming ${sourceData.length} records for ${module}...`);

    // Get mapping metadata for the specific module
    const mappingKey = module.toLowerCase().replace('central', 'Central') as keyof typeof import('../data/squireMockData').suiteCentralMappings;
    const mappingMetadata = getMappingMetadata(mappingKey);
    
    const transformedData: DataRecord[] = [];
    const errors: string[] = [];

    for (const record of sourceData) {
      try {
        const mappingResult = await fieldMapper.mapFields(record, mappingMetadata);
        
        if (mappingResult.success && mappingResult.mappedRecord) {
          transformedData.push(mappingResult.mappedRecord);
        } else {
          errors.push(...mappingResult.errors);
          result.failedRecords++;
        }
      } catch (error) {
        const errorMsg = `Transform failed for record ${record.id}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        result.failedRecords++;
      }
    }

    step.status = 'completed';
    step.endTime = new Date();
    step.records = transformedData.length;
    step.errors = errors.length > 0 ? errors.slice(0, 5) : undefined; // Limit to first 5 errors
    step.metadata = {
      module,
      originalRecords: sourceData.length,
      transformedRecords: transformedData.length,
      failedTransformations: errors.length,
      mappingsApplied: mappingMetadata.mappings.length
    };

    if (errors.length > 0) {
      result.errors.push(...errors.slice(0, 3)); // Add first 3 errors to main result
    }

    logger.info(`Transformed ${transformedData.length}/${sourceData.length} records for ${module}`);

    return {
      status: 'completed',
      transformedData
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    step.status = 'failed';
    step.endTime = new Date();
    step.errors = [errorMsg];
    result.errors.push(`Transformation failed: ${errorMsg}`);
    result.status = 'failed';
    
    logger.error('Transformation failed', error);
    return { status: 'failed' };
  }
}

/**
 * Step 4: Load transformed data to SuiteCentral
 */
async function loadToSuiteCentral(
  result: FullPipelineResult,
  suiteCentralConnector: SuiteCentralProductionConnector,
  transformedData: DataRecord[],
  entityType: string,
  batchSize: number,
  dryRun: boolean,
  logger: Logger
): Promise<{
  status: 'completed' | 'failed';
  syncedData?: DataRecord[];
}> {
  const step: PipelineStep = {
    step: 'load_to_suitecentral',
    status: 'running',
    startTime: new Date()
  };
  result.steps.push(step);

  try {
    logger.info(`Loading ${transformedData.length} records to SuiteCentral (dryRun: ${dryRun})...`);

    if (dryRun) {
      // Simulate the load operation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      step.status = 'completed';
      step.endTime = new Date();
      step.records = transformedData.length;
      step.metadata = {
        dryRun: true,
        simulatedLoad: transformedData.length,
        batchSize
      };

      result.successfulRecords += transformedData.length;
      
      logger.info(`DRY RUN: Would have loaded ${transformedData.length} records to SuiteCentral`);

      return {
        status: 'completed',
        syncedData: transformedData
      };
    }

    // Process in batches
    const syncedData: DataRecord[] = [];
    const errors: string[] = [];

    for (let i = 0; i < transformedData.length; i += batchSize) {
      const batch = transformedData.slice(i, i + batchSize);
      
      try {
        logger.debug(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(transformedData.length / batchSize)}`);

        // Use individual create operations since bulk operations may not be available in demo mode
        for (const record of batch) {
          try {
            const syncedRecord = await suiteCentralConnector.create(entityType, record);
            syncedData.push(syncedRecord);
            result.successfulRecords++;
          } catch (error) {
            const errorMsg = `Failed to sync record ${record.id}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
            result.failedRecords++;
          }
        }

        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        const errorMsg = `Batch ${Math.floor(i / batchSize) + 1} failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
        result.failedRecords += batch.length;
      }
    }

    step.status = 'completed';
    step.endTime = new Date();
    step.records = syncedData.length;
    step.errors = errors.length > 0 ? errors.slice(0, 5) : undefined;
    step.metadata = {
      batchSize,
      totalBatches: Math.ceil(transformedData.length / batchSize),
      syncedRecords: syncedData.length,
      failedRecords: result.failedRecords,
      dryRun: false
    };

    if (errors.length > 0) {
      result.errors.push(...errors.slice(0, 3));
    }

    logger.info(`Loaded ${syncedData.length}/${transformedData.length} records to SuiteCentral`);

    return {
      status: 'completed', 
      syncedData
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    step.status = 'failed';
    step.endTime = new Date();
    step.errors = [errorMsg];
    result.errors.push(`SuiteCentral load failed: ${errorMsg}`);
    result.status = 'failed';
    
    logger.error('SuiteCentral load failed', error);
    return { status: 'failed' };
  }
}

/**
 * Step 5: Sync from SuiteCentral to NetSuite
 */
async function syncToNetSuite(
  result: FullPipelineResult,
  netSuiteConnector: NetSuiteConnector,
  suiteCentralData: DataRecord[],
  entityType: string,
  batchSize: number,
  dryRun: boolean,
  logger: Logger
): Promise<void> {
  const step: PipelineStep = {
    step: 'sync_to_netsuite',
    status: 'running',
    startTime: new Date()
  };
  result.steps.push(step);

  try {
    logger.info(`Syncing ${suiteCentralData.length} records from SuiteCentral to NetSuite (dryRun: ${dryRun})...`);

    if (dryRun || !process.env.NETSUITE_ACCOUNT_ID) {
      // Simulate NetSuite sync
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      step.status = 'completed';
      step.endTime = new Date();
      step.records = suiteCentralData.length;
      step.metadata = {
        dryRun: true,
        simulatedSync: suiteCentralData.length,
        netSuiteAvailable: !!process.env.NETSUITE_ACCOUNT_ID
      };

      logger.info(`${dryRun ? 'DRY RUN: ' : ''}Simulated sync of ${suiteCentralData.length} records to NetSuite`);
      return;
    }

    // Real NetSuite sync implementation
    const errors: string[] = [];
    let syncedCount = 0;

    for (let i = 0; i < suiteCentralData.length; i += batchSize) {
      const batch = suiteCentralData.slice(i, i + batchSize);
      
      try {
        // Convert SuiteCentral format to NetSuite format
        const netSuiteBatch = batch.map(record => ({
          ...(record.fields as any),
          externalId: record.externalId,
          source: 'SuiteCentral'
        })) as DataRecord[];

        // Sync batch to NetSuite
        for (const record of netSuiteBatch) {
          try {
            await netSuiteConnector.create(entityType, record);
            syncedCount++;
          } catch (error) {
            // PR 3B: rethrow governance approval signals so the top-level
            // handler's catch can enqueue + 202. Per-record swallowing of
            // PendingApprovalError would silently drop the approval flow.
            if (error instanceof PendingApprovalError) {
              throw error;
            }
            const errorMsg = `NetSuite sync failed for record ${record.externalId}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(errorMsg);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 300)); // NetSuite rate limiting

      } catch (error) {
        // Rethrow PendingApprovalError so it reaches the top-level handler
        // catch (where handleApprovalQueueError fires). Without this, the
        // batch-level swallow at this site reabsorbs the inner per-record
        // rethrow and the approval flow silently degrades to an error entry.
        // Copilot R9 caught this; the inner-only rethrow at line 752 was
        // insufficient because of this AND the outermost catch below.
        if (error instanceof PendingApprovalError) {
          throw error;
        }
        const errorMsg = `NetSuite batch sync failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMsg);
      }
    }

    step.status = 'completed';
    step.endTime = new Date(); 
    step.records = syncedCount;
    step.errors = errors.length > 0 ? errors.slice(0, 5) : undefined;
    step.metadata = {
      batchSize,
      totalBatches: Math.ceil(suiteCentralData.length / batchSize),
      syncedToNetSuite: syncedCount,
      netSuiteErrors: errors.length
    };

    if (errors.length > 0) {
      result.errors.push(...errors.slice(0, 3));
    }

    logger.info(`Synced ${syncedCount}/${suiteCentralData.length} records from SuiteCentral to NetSuite`);

  } catch (error) {
    // Outermost rethrow so PendingApprovalError escapes syncToNetSuite()
    // entirely and reaches the route's top-level catch (where
    // handleApprovalQueueError fires). Copilot R9.
    if (error instanceof PendingApprovalError) {
      throw error;
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    step.status = 'failed';
    step.endTime = new Date();
    step.errors = [errorMsg];
    result.errors.push(`NetSuite sync failed: ${errorMsg}`);

    logger.error('NetSuite sync failed', error);
  }
}

/**
 * Calculate final pipeline performance metrics
 */
function calculateFinalMetrics(result: FullPipelineResult): void {
  result.endTime = new Date();
  result.performance.totalDuration = (result.endTime.getTime() - result.startTime.getTime()) / 1000;
  
  if (result.totalRecords > 0) {
    result.performance.averageRecordTime = result.performance.totalDuration / result.totalRecords;
    result.performance.throughput = result.totalRecords / result.performance.totalDuration;
  }

  // Determine overall pipeline status
  const failedSteps = result.steps.filter(step => step.status === 'failed').length;
  if (failedSteps > 0) {
    result.status = result.successfulRecords > 0 ? 'partial' : 'failed';
  } else if (result.failedRecords > 0) {
    result.status = 'partial';
  } else {
    result.status = 'success';
  }
}
