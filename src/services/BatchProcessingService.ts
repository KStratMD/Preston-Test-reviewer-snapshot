import { injectable, inject } from 'inversify';
import type { Job } from 'bullmq';
import type { Logger } from '../utils/Logger';
import type { IntegrationService } from './IntegrationService';
import type { QueueService, BatchProcessingJob, JobProgress } from './QueueService';
import { TYPES } from '../inversify/types';
import type { DataRecord } from '../types';

export interface BatchResult {
  jobId: string;
  integrationId: string;
  totalRecords: number;
  processedRecords: number;
  failedRecords: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  errors: string[];
}

export interface BatchProcessingOptions {
  batchSize?: number;
  priority?: number;
  delay?: number;
  maxAttempts?: number;
  enableProgressTracking?: boolean;
}

/**
 * Service for handling large batch processing operations
 * Breaks down large datasets into manageable chunks for queue processing
 */
@injectable()
export class BatchProcessingService {
  private readonly logger: Logger;
  private readonly queueService: QueueService;
  private readonly integrationService: IntegrationService;
  private readonly QUEUE_NAME = 'batch-processing';
  private readonly DEFAULT_BATCH_SIZE = 100;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.QueueService) queueService: QueueService,
    @inject(TYPES.IntegrationService) integrationService: IntegrationService,
  ) {
    this.logger = logger;
    this.queueService = queueService;
    this.integrationService = integrationService;
  }

  /**
   * Initialize the batch processing service
   */
  async initialize(): Promise<void> {
    try {
      await this.queueService.initializeQueue(
        this.QUEUE_NAME,
        this.processBatchJob.bind(this),
      );

      this.logger.info('Batch processing service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize batch processing service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Submit a large dataset for batch processing
   */
  async submitBatch(
    integrationId: string,
    records: DataRecord[],
    options: BatchProcessingOptions = {},
  ): Promise<string> {
    const batchSize = options.batchSize || this.DEFAULT_BATCH_SIZE;

    if (records.length === 0) {
      throw new Error('Cannot process empty record set');
    }

    if (records.length <= batchSize) {
      // Process small datasets directly without queuing
      return this.processSmallBatch(integrationId, records);
    }

    try {
      const batchJob: BatchProcessingJob = {
        integrationId,
        records,
        batchSize,
        options: {
          priority: options.priority || 0,
          delay: options.delay || 0,
          attempts: options.maxAttempts || 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      };

      const jobId = await this.queueService.addBatchJob(
        this.QUEUE_NAME,
        'process-integration-batch',
        batchJob,
      );

      this.logger.info('Batch submitted for processing', {
        integrationId,
        recordCount: records.length,
        batchSize,
        jobId,
      });

      return jobId;
    } catch (error) {
      this.logger.error('Failed to submit batch for processing', {
        integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get batch processing status
   */
  async getBatchStatus(jobId: string): Promise<BatchResult | null> {
    try {
      const progress = await this.queueService.getJobProgress(this.QUEUE_NAME, jobId);

      if (!progress) {
        return null;
      }

      return {
        jobId,
        integrationId: '', // Will be filled from job data if needed
        totalRecords: progress.total,
        processedRecords: progress.processed,
        failedRecords: progress.failed,
        status: this.getStatusFromProgress(progress),
        errors: [], // Could be enhanced to track specific errors
      };
    } catch (error) {
      this.logger.error('Failed to get batch status', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get batch processing metrics
   */
  async getBatchMetrics() {
    try {
      return await this.queueService.getQueueMetrics(this.QUEUE_NAME);
    } catch (error) {
      this.logger.error('Failed to get batch metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Pause batch processing
   */
  async pauseBatchProcessing(): Promise<void> {
    try {
      await this.queueService.pauseQueue(this.QUEUE_NAME);
      this.logger.info('Batch processing paused');
    } catch (error) {
      this.logger.error('Failed to pause batch processing', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Resume batch processing
   */
  async resumeBatchProcessing(): Promise<void> {
    try {
      await this.queueService.resumeQueue(this.QUEUE_NAME);
      this.logger.info('Batch processing resumed');
    } catch (error) {
      this.logger.error('Failed to resume batch processing', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retry failed batch jobs
   */
  async retryFailedBatches(): Promise<number> {
    try {
      const retriedCount = await this.queueService.retryFailedJobs(this.QUEUE_NAME);
      this.logger.info('Failed batches retried', { retriedCount });
      return retriedCount;
    } catch (error) {
      this.logger.error('Failed to retry failed batches', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Process a batch job (called by the queue worker)
   */
  private async processBatchJob(job: Job<BatchProcessingJob>): Promise<void> {
    const { integrationId, records, batchSize } = job.data;

    this.logger.info('Starting batch job processing', {
      jobId: job.id,
      integrationId,
      recordCount: records.length,
      batchSize,
    });

    const totalBatches = Math.ceil(records.length / batchSize);
    let processedRecords = 0;
    let failedRecords = 0;
    const errors: string[] = [];

    try {
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * batchSize;
        const endIndex = Math.min(startIndex + batchSize, records.length);
        const batchRecords = records.slice(startIndex, endIndex) as DataRecord[];

        this.logger.debug('Processing batch', {
          jobId: job.id,
          batchIndex: batchIndex + 1,
          totalBatches,
          batchSize: batchRecords.length,
        });

        try {
          // Process this batch using the integration service
          const result = await this.processBatchRecords(integrationId, batchRecords);
          processedRecords += result.successCount;
          failedRecords += result.failureCount;

          if (result.errors.length > 0) {
            errors.push(...result.errors);
          }

          // Update job progress
          const progress: JobProgress = {
            total: records.length,
            processed: processedRecords,
            failed: failedRecords,
            percentage: Math.round((processedRecords + failedRecords) / records.length * 100),
            currentBatch: batchIndex + 1,
          };

          if (job.updateProgress) {
            await job.updateProgress(progress);
          }

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error('Batch processing error', {
            jobId: job.id,
            batchIndex: batchIndex + 1,
            error: errorMessage,
          });

          errors.push(`Batch ${batchIndex + 1}: ${errorMessage}`);
          failedRecords += batchRecords.length;
        }

        // Add small delay between batches to prevent overwhelming target systems
        if (batchIndex < totalBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      this.logger.info('Batch job completed', {
        jobId: job.id,
        integrationId,
        totalRecords: records.length,
        processedRecords,
        failedRecords,
        errorCount: errors.length,
      });

      // If there were any failures, throw an error to mark the job as failed
      if (failedRecords > 0) {
        throw new Error(`Batch processing completed with ${failedRecords} failed records. Errors: ${errors.join('; ')}`);
      }

    } catch (error) {
      this.logger.error('Batch job failed', {
        jobId: job.id,
        integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Process a small batch directly without queuing
   */
  private async processSmallBatch(integrationId: string, records: DataRecord[]): Promise<string> {
    try {
      const result = await this.processBatchRecords(integrationId, records);

      this.logger.info('Small batch processed directly', {
        integrationId,
        recordCount: records.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
      });

      // Return a synthetic job ID for consistency
      return `direct-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    } catch (error) {
      this.logger.error('Failed to process small batch', {
        integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Process a batch of records using the integration service
   */
  private async processBatchRecords(
    integrationId: string,
    records: DataRecord[],
  ): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
    let successCount = 0;
    let failureCount = 0;
    const errors: string[] = [];

    for (const record of records) {
      try {
        // This would need to be enhanced based on how IntegrationService
        // should handle individual record processing
        // For now, we'll simulate processing
        await this.processRecord(integrationId, record);
        successCount++;
      } catch (error) {
        failureCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Record ${record.id}: ${errorMessage}`);
      }
    }

    return { successCount, failureCount, errors };
  }

  /**
   * Process a single record through the integration pipeline
   */
  private async processRecord(integrationId: string, record: DataRecord): Promise<void> {
    try {
      // For batch processing, we use the syncSingleRecord method if the record has an ID
      // Otherwise, we'll need to process it differently
      if (record.id) {
        await this.integrationService.syncSingleRecord(integrationId, record.id);
      } else {
        this.logger.warn('Record has no ID for sync processing', {
          integrationId,
          recordData: record.fields ? Object.keys(record.fields) : 'no fields',
        });
        // For records without IDs, we might need a different processing approach
        // This could be implemented based on specific business requirements
        throw new Error('Cannot process record without ID in batch mode');
      }
    } catch (error) {
      this.logger.error('Failed to process record in batch', {
        integrationId,
        recordId: record.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error; // Re-throw to be handled by the batch processing pipeline
    }
  }

  /**
   * Determine status from progress
   */
  private getStatusFromProgress(progress: JobProgress): 'queued' | 'processing' | 'completed' | 'failed' {
    if (progress.percentage === 0) {
      return 'queued';
    } else if (progress.percentage === 100) {
      return progress.failed > 0 ? 'failed' : 'completed';
    } else {
      return 'processing';
    }
  }

  /**
   * Shutdown the batch processing service
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down batch processing service');
      // The QueueService will handle the actual shutdown
    } catch (error) {
      this.logger.error('Error during batch processing service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
