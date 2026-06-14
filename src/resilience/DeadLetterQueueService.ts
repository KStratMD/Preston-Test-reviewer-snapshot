import { injectable, inject } from 'inversify';
import { Queue, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { DatabaseService } from '../database/DatabaseService';

export interface DeadLetterRecord {
  id: string;
  originalQueue: string;
  jobId: string;
  jobData: unknown;
  error: string;
  failureCount: number;
  lastAttemptAt: Date;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface DeadLetterStats {
  totalDeadLetters: number;
  byQueue: Record<string, number>;
  byErrorType: Record<string, number>;
  oldestRecord: Date | null;
  newestRecord: Date | null;
}

/**
 * Dead Letter Queue service for handling permanently failed jobs
 * Provides inspection, retry, and cleanup capabilities
 */
@injectable()
export class DeadLetterQueueService {
  private readonly logger: Logger;
  private readonly databaseService: DatabaseService;
  private deadLetterQueue: Queue | null = null;
  private connection: Redis | null = null;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.DatabaseService) databaseService: DatabaseService,
  ) {
    this.logger = logger;
    this.databaseService = databaseService;
  }

  /**
   * Initialize dead letter queue service
   */
  async initialize(): Promise<void> {
    try {
      // Create Redis connection
      this.connection = new Redis({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        lazyConnect: true,
      });

      // Create dead letter queue
      this.deadLetterQueue = new Queue('dead-letter-queue', {
        connection: this.connection,
        defaultJobOptions: {
          removeOnComplete: 1000, // Keep more completed DLQ jobs for analysis
          removeOnFail: 1000,
          attempts: 1, // Dead letter jobs should not retry
        },
      });

      this.logger.info('Dead letter queue service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize dead letter queue service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Send a failed job to dead letter queue
   */
  async sendToDeadLetter(
    originalQueue: string,
    job: Job,
    error: Error,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deadLetterQueue) {
      throw new Error('Dead letter queue service not initialized');
    }

    try {
      const deadLetterRecord: DeadLetterRecord = {
        id: `dlq_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        originalQueue,
        jobId: job.id,
        jobData: job.data,
        error: error.message,
        failureCount: job.attemptsMade ?? 0,
        lastAttemptAt: new Date(),
        createdAt: new Date(),
        metadata,
      };

      // Add to dead letter queue
      await this.deadLetterQueue.add(
        'dead-letter-record',
        deadLetterRecord,
        {
          priority: 0, // Low priority for dead letters
          delay: 0,
        },
      );

      // Store in database for persistence and querying
      await this.storeInDatabase(deadLetterRecord);

      this.logger.warn('Job sent to dead letter queue', {
        originalQueue,
        jobId: job.id,
        error: error.message,
        failureCount: job.attemptsMade ?? 0,
      });
    } catch (dlqError) {
      this.logger.error('Failed to send job to dead letter queue', {
        originalQueue,
        jobId: job.id,
        error: error.message,
        dlqError: dlqError instanceof Error ? dlqError.message : String(dlqError),
      });
      throw dlqError;
    }
  }

  /**
   * Get dead letter records with filtering and pagination
   */
  async getDeadLetters(options?: {
    queue?: string;
    limit?: number;
    offset?: number;
    since?: Date;
    errorType?: string;
  }): Promise<{
    records: DeadLetterRecord[];
    total: number;
  }> {
    try {
      const db = this.databaseService.getDatabase();

      let query = db
        .selectFrom('dead_letter_records as dlr')
        .selectAll();

      if (options?.queue) {
        query = query.where('dlr.original_queue', '=', options.queue);
      }

      if (options?.since) {
        query = query.where('dlr.created_at', '>=', options.since);
      }

      if (options?.errorType) {
        query = query.where('dlr.error', 'ilike', `%${options.errorType}%`);
      }

      // Get total count
      const countQuery = query.select((eb) => eb.fn.count('dlr.id').as('total'));
      const countResult = await countQuery.executeTakeFirst();
      const total = Number(countResult?.total || 0);

      // Get records with pagination
      query = query.orderBy('dlr.created_at', 'desc');

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.offset(options.offset);
      }

      const results = await query.execute();

      const records: DeadLetterRecord[] = results.map(row => ({
        id: row.id,
        originalQueue: row.original_queue,
        jobId: row.job_id,
        jobData: row.job_data,
        error: row.error,
        failureCount: row.failure_count,
        lastAttemptAt: row.last_attempt_at,
        createdAt: row.created_at,
        metadata: row.metadata as Record<string, unknown> || undefined,
      }));

      return { records, total };
    } catch (error) {
      this.logger.error('Failed to get dead letter records', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retry a dead letter record
   */
  async retryDeadLetter(
    deadLetterId: string,
    targetQueue?: string,
  ): Promise<void> {
    try {
      const db = this.databaseService.getDatabase();

      // Get the dead letter record
      const record = await db
        .selectFrom('dead_letter_records')
        .selectAll()
        .where('id', '=', deadLetterId)
        .executeTakeFirst();

      if (!record) {
        throw new Error(`Dead letter record not found: ${deadLetterId}`);
      }

      // Create new queue for retry
      const queueName = targetQueue || record.original_queue;
      if (!this.connection) {
        throw new Error('Redis connection not initialized');
      }

      const retryQueue = new Queue(queueName, {
        connection: this.connection,
      });

      // Add job back to original queue
      await retryQueue.add(
        'retry-from-dlq',
        record.job_data,
        {
          priority: 1, // Higher priority for retried jobs
          attempts: 3, // Give it normal retry attempts
        },
      );

      // Mark as retried in database
      await db
        .updateTable('dead_letter_records')
        .set({
          retried_at: new Date(),
          retry_queue: queueName,
          updated_at: new Date(),
        })
        .where('id', '=', deadLetterId)
        .execute();

      this.logger.info('Dead letter record retried', {
        deadLetterId,
        originalQueue: record.original_queue,
        targetQueue: queueName,
        jobId: record.job_id,
      });
    } catch (error) {
      this.logger.error('Failed to retry dead letter record', {
        deadLetterId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Bulk retry dead letters by criteria
   */
  async bulkRetryDeadLetters(criteria: {
    queue?: string;
    errorType?: string;
    since?: Date;
    limit?: number;
  }): Promise<number> {
    try {
      const { records } = await this.getDeadLetters({
        queue: criteria.queue,
        errorType: criteria.errorType,
        since: criteria.since,
        limit: criteria.limit || 100,
      });

      let retriedCount = 0;

      for (const record of records) {
        try {
          await this.retryDeadLetter(record.id);
          retriedCount++;
        } catch (error) {
          this.logger.warn('Failed to retry individual dead letter record', {
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.info('Bulk retry completed', {
        totalRecords: records.length,
        retriedCount,
        criteria,
      });

      return retriedCount;
    } catch (error) {
      this.logger.error('Failed to bulk retry dead letters', {
        criteria,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get dead letter statistics
   */
  async getStatistics(): Promise<DeadLetterStats> {
    try {
      const db = this.databaseService.getDatabase();

      // Get total count
      const totalResult = await db
        .selectFrom('dead_letter_records')
        .select((eb) => eb.fn.count('id').as('total'))
        .where('retried_at', 'is', null) // Only count non-retried records
        .executeTakeFirst();

      const totalDeadLetters = Number(totalResult?.total || 0);

      // Get counts by queue
      const queueResults = await db
        .selectFrom('dead_letter_records')
        .select(['original_queue', (eb) => eb.fn.count('id').as('count')])
        .where('retried_at', 'is', null)
        .groupBy('original_queue')
        .execute();

      const byQueue = queueResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.original_queue] = Number(row.count);
        return acc;
      }, {});

      // Get counts by error type (simplified)
      const errorResults = await db
        .selectFrom('dead_letter_records')
        .select(['error', (eb) => eb.fn.count('id').as('count')])
        .where('retried_at', 'is', null)
        .groupBy('error')
        .execute();

      const byErrorType = errorResults.reduce<Record<string, number>>((acc, row) => {
        // Simplify error messages for grouping
        const errorType = this.categorizeError(row.error);
        acc[errorType] = (acc[errorType] || 0) + Number(row.count);
        return acc;
      }, {});

      // Get oldest and newest records
      const rangeResult = await db
        .selectFrom('dead_letter_records')
        .select([
          (eb) => eb.fn.min('created_at').as('oldest'),
          (eb) => eb.fn.max('created_at').as('newest'),
        ])
        .where('retried_at', 'is', null)
        .executeTakeFirst();

      return {
        totalDeadLetters,
        byQueue,
        byErrorType,
        oldestRecord: rangeResult?.oldest || null,
        newestRecord: rangeResult?.newest || null,
      };
    } catch (error) {
      this.logger.error('Failed to get dead letter statistics', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clean up old dead letter records
   */
  async cleanupOldRecords(olderThanDays: number): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const db = this.databaseService.getDatabase();

      const result = await db
        .deleteFrom('dead_letter_records')
        .where('created_at', '<', cutoffDate)
        .where('retried_at', 'is not', null) // Only delete already retried records
        .executeTakeFirst();

      const deletedCount = Number(result.numDeletedRows || 0);

      this.logger.info('Dead letter records cleaned up', {
        deletedCount,
        olderThanDays,
        cutoffDate,
      });

      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to cleanup old dead letter records', {
        olderThanDays,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Store dead letter record in database
   */
  private async storeInDatabase(record: DeadLetterRecord): Promise<void> {
    const db = this.databaseService.getDatabase();

    await db
      .insertInto('dead_letter_records')
      .values({
        id: record.id,
        original_queue: record.originalQueue,
        job_id: record.jobId,
        job_data: record.jobData as object,
        error: record.error,
        failure_count: record.failureCount,
        last_attempt_at: record.lastAttemptAt,
        metadata: record.metadata,
        created_at: record.createdAt,
        updated_at: new Date(),
      })
      .execute();
  }

  /**
   * Categorize error for statistics
   */
  private categorizeError(error: string): string {
    const lowerError = error.toLowerCase();

    if (lowerError.includes('timeout') || lowerError.includes('network')) {
      return 'Network/Timeout';
    }

    if (lowerError.includes('auth') || lowerError.includes('credential')) {
      return 'Authentication';
    }

    if (lowerError.includes('validation') || lowerError.includes('invalid')) {
      return 'Validation';
    }

    if (lowerError.includes('rate limit') || lowerError.includes('quota')) {
      return 'Rate Limiting';
    }

    if (lowerError.includes('not found') || lowerError.includes('missing')) {
      return 'Not Found';
    }

    return 'Other';
  }

  /**
   * Shutdown dead letter queue service
   */
  async shutdown(): Promise<void> {
    try {
      if (this.deadLetterQueue) {
        await this.deadLetterQueue.close();
        this.deadLetterQueue = null;
      }

      if (this.connection) {
        this.connection.disconnect();
        this.connection = null;
      }

      this.logger.info('Dead letter queue service shutdown completed');
    } catch (error) {
      this.logger.error('Error during dead letter queue service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
