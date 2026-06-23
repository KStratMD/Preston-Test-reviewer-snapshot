import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Logger } from '../utils/Logger';

export interface SuiteCentralSyncMetadata {
  module: string;
  entityType: string;
  operation: string;
  status: 'success' | 'partial' | 'failed';
  batchSize?: number;
  recordCount?: number;
  errorType?: string;
}

export interface PipelineMetadata {
  pipelineId: string;
  step: string;
  stepStatus: 'pending' | 'running' | 'completed' | 'failed';
  totalSteps?: number;
  recordCount?: number;
}

/**
 * Enhanced Prometheus metrics for SuiteCentral integration monitoring
 * Provides comprehensive observability for sync operations, pipeline executions,
 * performance tracking, and error analysis.
 */
class SuiteCentralMetricsInternal {
  private logger: Logger;

  // Sync operation metrics
  private syncOperationsTotal!: Counter<string>;
  private syncRecordsTotal!: Counter<string>;
  private syncDuration!: Histogram<string>;
  private syncErrorsTotal!: Counter<string>;
  
  // Pipeline execution metrics
  private pipelineExecutionsTotal!: Counter<string>;
  private pipelineStepsTotal!: Counter<string>;
  private pipelineDuration!: Histogram<string>;
  private pipelineStepDuration!: Histogram<string>;
  private activeConnections!: Gauge<string>;
  
  // Performance metrics
  private recordThroughputHist!: Histogram<string>;
  private batchProcessingTime!: Histogram<string>;
  private apiResponseTime!: Histogram<string>;
  private memoryUsage!: Gauge<string>;
  
  // Business metrics
  private financialTransactionsTotal!: Counter<string>;
  private financialAmountTotal!: Counter<string>;
  private dataQualityScore!: Gauge<string>;
  private complianceChecksTotal!: Counter<string>;

  constructor(logger: Logger) {
    this.logger = logger;
    
    // Initialize Prometheus default metrics only once globally
    if (!(global as any).__promDefaultMetricsInitialized) {
      if (process.env.PROM_DISABLE_DEFAULT_METRICS !== '1') {
        const stop = (collectDefaultMetrics as any)?.({ register });
        if (typeof stop === 'function') {
          (global as any).__promDefaultMetricsStopper = stop;
        }
      }
      (global as any).__promDefaultMetricsInitialized = true;
    }
    
    this.initializeSyncMetrics();
    this.initializePipelineMetrics();
    this.initializePerformanceMetrics();
    this.initializeBusinessMetrics();
    
    this.logger.info('SuiteCentral metrics initialized', {
      metricsCount: register.getMetricsAsArray().length
    });
  }

  /**
   * Initialize sync operation metrics
   */
  private initializeSyncMetrics(): void {
    this.syncOperationsTotal = new Counter({
      name: 'suitecentral_sync_operations_total',
      help: 'Total number of SuiteCentral sync operations',
      labelNames: ['module', 'entity_type', 'operation', 'status'] as const,
      registers: [register]
    });

    this.syncRecordsTotal = new Counter({
      name: 'suitecentral_sync_records_total', 
      help: 'Total number of records processed in SuiteCentral sync operations',
      labelNames: ['module', 'entity_type', 'operation', 'status'] as const,
      registers: [register]
    });

    this.syncDuration = new Histogram({
      name: 'suitecentral_sync_duration_seconds',
      help: 'Duration of SuiteCentral sync operations in seconds',
      labelNames: ['module', 'entity_type', 'operation'] as const,
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300], // 100ms to 5min
      registers: [register]
    });

    this.syncErrorsTotal = new Counter({
      name: 'suitecentral_sync_errors_total',
      help: 'Total number of SuiteCentral sync errors',
      labelNames: ['module', 'entity_type', 'operation', 'error_type'] as const,
      registers: [register]
    });
  }

  /**
   * Initialize pipeline execution metrics
   */
  private initializePipelineMetrics(): void {
    this.pipelineExecutionsTotal = new Counter({
      name: 'suitecentral_pipeline_executions_total',
      help: 'Total number of full pipeline executions (Squire → SuiteCentral → NetSuite)',
      labelNames: ['status', 'include_netsuite'] as const,
      registers: [register]
    });

    this.pipelineStepsTotal = new Counter({
      name: 'suitecentral_pipeline_steps_total', 
      help: 'Total number of pipeline steps executed',
      labelNames: ['step', 'status'] as const,
      registers: [register]
    });

    this.pipelineDuration = new Histogram({
      name: 'suitecentral_pipeline_duration_seconds',
      help: 'Duration of full pipeline executions in seconds',
      labelNames: ['include_netsuite'] as const,
      buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10min
      registers: [register]
    });

    this.pipelineStepDuration = new Histogram({
      name: 'suitecentral_pipeline_step_duration_seconds',
      help: 'Duration of individual pipeline steps in seconds', 
      labelNames: ['step'] as const,
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60], // 100ms to 1min
      registers: [register]
    });

    this.activeConnections = new Gauge({
      name: 'suitecentral_active_connections',
      help: 'Number of active connections to SuiteCentral modules',
      labelNames: ['module', 'production_mode'] as const,
      registers: [register]
    });
  }

  /**
   * Initialize performance metrics
   */
  private initializePerformanceMetrics(): void {
    this.recordThroughputHist = new Histogram({
      name: 'suitecentral_record_throughput_per_second',
      help: 'Records processed per second during sync operations',
      labelNames: ['module', 'operation'] as const,
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000], // 1 to 1000 records/sec
      registers: [register]
    });

    this.batchProcessingTime = new Histogram({
      name: 'suitecentral_batch_processing_seconds',
      help: 'Time to process a batch of records',
      labelNames: ['module', 'batch_size'] as const,
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20], // 100ms to 20s
      registers: [register]
    });

    this.apiResponseTime = new Histogram({
      name: 'suitecentral_api_response_seconds',
      help: 'SuiteCentral API response time',
      labelNames: ['module', 'endpoint', 'method'] as const,
      buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5], // 10ms to 5s
      registers: [register]
    });

    this.memoryUsage = new Gauge({
      name: 'suitecentral_memory_usage_bytes',
      help: 'Memory usage during SuiteCentral operations',
      labelNames: ['operation_type'] as const,
      registers: [register]
    });
  }

  /**
   * Initialize business-specific metrics
   */
  private initializeBusinessMetrics(): void {
    this.financialTransactionsTotal = new Counter({
      name: 'suitecentral_financial_transactions_total',
      help: 'Total number of financial transactions processed through PayoutCentral',
      labelNames: ['transaction_type', 'status'] as const,
      registers: [register]
    });

    this.financialAmountTotal = new Counter({
      name: 'suitecentral_financial_amount_total',
      help: 'Total financial amount processed (in USD)',
      labelNames: ['transaction_type', 'currency'] as const,
      registers: [register]
    });

    this.dataQualityScore = new Gauge({
      name: 'suitecentral_data_quality_score',
      help: 'Data quality score for synchronized records (0-1)',
      labelNames: ['module', 'entity_type'] as const,
      registers: [register]
    });

    this.complianceChecksTotal = new Counter({
      name: 'suitecentral_compliance_checks_total',
      help: 'Total number of compliance validation checks performed',
      labelNames: ['check_type', 'result'] as const,
      registers: [register]
    });
  }

  /**
   * Record a sync operation
   */
  recordSyncOperation(
    metadata: SuiteCentralSyncMetadata,
    duration: number,
    recordCount = 0
  ): void {
    const { module, entityType, operation, status } = metadata;
    
    this.syncOperationsTotal
      .labels(module, entityType, operation, status)
      .inc();
    
    if (recordCount > 0) {
      this.syncRecordsTotal
        .labels(module, entityType, operation, status)
        .inc(recordCount);
    }
    
    this.syncDuration
      .labels(module, entityType, operation)
      .observe(duration);

    this.logger.debug('Recorded sync operation metric', {
      module,
      entityType,
      operation,
      status,
      duration,
      recordCount
    });
  }

  /**
   * Record a sync error
   */
  recordSyncError(
    metadata: SuiteCentralSyncMetadata,
    errorType = 'unknown'
  ): void {
    const { module, entityType, operation } = metadata;
    
    this.syncErrorsTotal
      .labels(module, entityType, operation, errorType)
      .inc();

    this.logger.debug('Recorded sync error metric', {
      module,
      entityType,
      operation,
      errorType
    });
  }

  /**
   * Record a pipeline execution
   */
  recordPipelineExecution(
    status: 'success' | 'partial' | 'failed',
    duration: number,
    includeNetSuite = true,
    recordCount = 0
  ): void {
    this.pipelineExecutionsTotal
      .labels(status, includeNetSuite.toString())
      .inc();
    
    this.pipelineDuration
      .labels(includeNetSuite.toString())
      .observe(duration);

    this.logger.debug('Recorded pipeline execution metric', {
      status,
      duration,
      includeNetSuite,
      recordCount
    });
  }

  /**
   * Record a pipeline step
   */
  recordPipelineStep(
    step: string,
    status: 'pending' | 'running' | 'completed' | 'failed',
    duration?: number
  ): void {
    this.pipelineStepsTotal
      .labels(step, status)
      .inc();
    
    if (duration !== undefined) {
      this.pipelineStepDuration
        .labels(step)
        .observe(duration);
    }

    this.logger.debug('Recorded pipeline step metric', {
      step,
      status,
      duration
    });
  }

  /**
   * Update active connections gauge
   */
  setActiveConnections(module: string, productionMode: boolean, count: number): void {
    this.activeConnections
      .labels(module, productionMode.toString())
      .set(count);
  }

  /**
   * Record throughput metrics
   */
  recordThroughput(
    module: string,
    operation: string,
    recordsPerSecond: number
  ): void {
    this.recordThroughputHist
      .labels(module, operation)
      .observe(recordsPerSecond);

    this.logger.debug('Recorded throughput metric', {
      module,
      operation,
      recordsPerSecond
    });
  }

  /**
   * Record batch processing time
   */
  recordBatchProcessing(
    module: string,
    batchSize: number,
    processingTime: number
  ): void {
    this.batchProcessingTime
      .labels(module, batchSize.toString())
      .observe(processingTime);
  }

  /**
   * Record API response time
   */
  recordApiResponse(
    module: string,
    endpoint: string,
    method: string,
    responseTime: number
  ): void {
    this.apiResponseTime
      .labels(module, endpoint, method)
      .observe(responseTime);
  }

  /**
   * Update memory usage
   */
  setMemoryUsage(operationType: string, bytes: number): void {
    this.memoryUsage
      .labels(operationType)
      .set(bytes);
  }

  /**
   * Record financial transaction
   */
  recordFinancialTransaction(
    transactionType: string,
    status: string,
    amount = 0,
    currency = 'USD'
  ): void {
    this.financialTransactionsTotal
      .labels(transactionType, status)
      .inc();
    
    if (amount > 0) {
      this.financialAmountTotal
        .labels(transactionType, currency)
        .inc(amount);
    }

    this.logger.debug('Recorded financial transaction metric', {
      transactionType,
      status,
      amount,
      currency
    });
  }

  /**
   * Update data quality score
   */
  setDataQualityScore(
    module: string,
    entityType: string,
    score: number
  ): void {
    this.dataQualityScore
      .labels(module, entityType)
      .set(score);
  }

  /**
   * Record compliance check
   */
  recordComplianceCheck(
    checkType: string,
    result: 'passed' | 'failed' | 'warning'
  ): void {
    this.complianceChecksTotal
      .labels(checkType, result)
      .inc();
  }

  /**
   * Get metrics summary for health checks
   */
  getMetricsSummary(): {
    totalSyncOperations: number;
    totalRecords: number;
    totalErrors: number;
    totalPipelineExecutions: number;
    activeConnectionsCount: number;
    lastUpdateTime: string;
  } {
    const metrics = register.getMetricsAsArray();
    
    // Extract key metrics (simplified for demo)
    const syncOpsMetric = metrics.find(m => m.name === 'suitecentral_sync_operations_total');
    const recordsMetric = metrics.find(m => m.name === 'suitecentral_sync_records_total');
    const errorsMetric = metrics.find(m => m.name === 'suitecentral_sync_errors_total');
    const pipelineMetric = metrics.find(m => m.name === 'suitecentral_pipeline_executions_total');
    const connectionsMetric = metrics.find(m => m.name === 'suitecentral_active_connections');
    
    return {
      totalSyncOperations: this.extractMetricTotal(syncOpsMetric),
      totalRecords: this.extractMetricTotal(recordsMetric),
      totalErrors: this.extractMetricTotal(errorsMetric),
      totalPipelineExecutions: this.extractMetricTotal(pipelineMetric),
      activeConnectionsCount: this.extractMetricTotal(connectionsMetric),
      lastUpdateTime: new Date().toISOString()
    };
  }

  /**
   * Extract total value from a Prometheus metric (helper method)
   */
  private extractMetricTotal(metric: unknown): number {
    if (!metric || !(metric as any).get) return 0;

    try {
      const metricValue = (metric as any).get();
      if (metricValue && metricValue.values) {
        return metricValue.values.reduce((sum: number, value: unknown) => sum + ((value as any).value || 0), 0);
      }
      return metricValue?.value || 0;
    } catch (error) {
      this.logger.warn('Failed to extract metric total', { metric: (metric as any)?.name, error });
      return 0;
    }
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    register.clear();
    this.logger.info('All SuiteCentral metrics reset');
  }

  /**
   * Get Prometheus metrics registry
   */
  getRegistry() {
    return register;
  }
}

// Export the internal class for type-scripting and advanced use cases
export const SuiteCentralMetrics = SuiteCentralMetricsInternal;

// Create and export a singleton instance
import { Logger as GlobalLogger } from '../utils/Logger';
const logger = new GlobalLogger('SuiteCentralMetrics');
export const suiteCentralMetrics = new SuiteCentralMetricsInternal(logger);