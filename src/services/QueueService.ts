import { injectable, inject } from 'inversify';
import { Queue, Worker, QueueEvents, type Job } from 'bullmq';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { env } from '../config/env';
import * as IORedis from 'ioredis';
import { randomUUID } from 'crypto';

export interface BatchProcessingJob {
  integrationId: string;
  records: unknown[];
  batchSize: number;
  options?: {
    priority?: number;
    delay?: number;
    attempts?: number;
    backoff?: {
      type: 'fixed' | 'exponential';
      delay: number;
    };
  };
}

export interface JobProgress {
  total: number;
  processed: number;
  failed: number;
  percentage: number;
  currentBatch?: number;
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

/**
 * Service for managing background job queues for batch processing
 * Uses BullMQ for robust job processing with Redis
 */
@injectable()
export class QueueService {
  private readonly logger: Logger;
  // Minimal Redis-like connection shape accepted by bullmq constructors.
  // Using a narrow structural type avoids importing internal ioredis types
  // and keeps tests (which mock ioredis) working.
  private readonly connection: {
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
    disconnect?: () => void;
  };
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly queueEvents = new Map<string, QueueEvents>();
  private isStubMode = false;
  private redisInstance: unknown = null;

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    if (process.env.DISABLE_REDIS === '1' || /^(true|yes)$/i.test(process.env.DISABLE_REDIS || '')) {
      // Provide a lightweight stub connection; queues will be no-ops
      this.connection = {
        on: () => undefined,
        disconnect: () => undefined,
      };
      this.logger.warn('DISABLE_REDIS set - QueueService operating in no-op mode');
      return;
    }
    try {
      const RedisConstructorRaw = (IORedis as unknown as { Redis?: unknown; default?: unknown }).Redis
        || (IORedis as unknown as { Redis?: unknown; default?: unknown }).default
        || IORedis;
      if (typeof RedisConstructorRaw === 'function') {
        // Some test environments mock ioredis; cast to any for safe construction
        try {
          const instance = new (RedisConstructorRaw as unknown as new (opts: unknown) => unknown)({
            host: '127.0.0.1',
            port: 6379,
            retryDelayOnFailover: 100,
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            connectTimeout: 3000,
            commandTimeout: 5000,
            enableReadyCheck: true,
            onError: (err: Error) => {
              this.logger.warn('Redis connection failed, switching to stub mode', { error: err.message });
              this.isStubMode = true;
            },
          });
          
          // Add error handlers to prevent uncaught exceptions
          (instance as any).on?.('error', (err: Error) => {
            this.logger.warn('Redis error occurred, using stub mode', { error: err.message });
            this.isStubMode = true;
          });
          
          this.redisInstance = instance;
          // Keep as unknown; we'll cast to the appropriate runtime type when
          // passing into bullmq constructors (tests may provide a stub).
          this.connection = instance as unknown as {
            on?: (event: string, cb: (...args: unknown[]) => void) => void;
            disconnect?: () => void;
          };
          this.logger.info('QueueService initialized with Redis connection');
        } catch (err) {
          this.logger.warn('Failed to create Redis connection, using stub mode', { error: (err as Error).message });
          this.isStubMode = true;
          // Fallback stub for failed connection
          this.connection = {
            on: () => undefined,
            disconnect: () => undefined,
          };
        }
      } else {
        this.logger.warn('Redis constructor not available, using stub mode');
        this.isStubMode = true;
        // Minimal stub for test environments
        this.connection = {
          on: () => undefined,
          disconnect: () => undefined,
        };
      }
    } catch (error) {
      this.logger.warn('Failed to create Redis connection, using fallback stub', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Fallback stub for environments where Redis is not available
      this.connection = {
        on: () => undefined,
        disconnect: () => undefined,
      };
    }

    const conn = this.connection as { on?: (event: string, cb: (...args: unknown[]) => void) => void } | undefined;
    conn?.on?.('connect', () => {
      this.logger.info('Queue service connected to Redis');
    });

    conn?.on?.('error', (error: unknown) => {
      this.logger.error('Queue service Redis connection error', error instanceof Error ? error : String(error));
    });
  }

  /**
   * Initialize a queue for a specific job type
   */
  async initializeQueue(queueName: string, processor?: (job: Job) => Promise<void>): Promise<void> {
    try {
      // Create queue
      const queue = new Queue(queueName, {
        connection: this.connection as any,
        defaultJobOptions: {
          removeOnComplete: 100, // Keep last 100 completed jobs
          removeOnFail: 50, // Keep last 50 failed jobs
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      });

      this.queues.set(queueName, queue);

      // Create worker if processor provided
      if (processor) {
        const concurrency = Number(env.QUEUE_CONCURRENCY) || 5;
        const worker = new Worker(queueName, processor, {
          connection: this.connection as any,
          concurrency,
        });

        worker.on('completed', (job: unknown) => {
          const j = job as { id?: string; name?: string; processedOn?: number } | undefined;
          const processedOn = j && typeof j.processedOn === 'number' ? j.processedOn : Date.now();
          this.logger.info('Job completed', {
            queueName,
            jobId: j?.id,
            jobName: j?.name,
            duration: Date.now() - processedOn,
          });
        });

        worker.on('failed', (job: unknown, err: unknown) => {
          const j = job as { id?: string; name?: string; attemptsMade?: number } | undefined;
          const e = err as Error | undefined;
          this.logger.error('Job failed', {
            queueName,
            jobId: j?.id,
            jobName: j?.name,
            error: e?.message,
            attempts: j?.attemptsMade,
          });
        });

        worker.on('progress', (job: unknown, progress: unknown) => {
          const j = job as { id?: string } | undefined;
          this.logger.debug('Job progress', {
            queueName,
            jobId: j?.id,
            progress,
          });
        });

        this.workers.set(queueName, worker);
      }

      // Create queue events for monitoring
      const queueEvents = new QueueEvents(queueName, {
        connection: this.connection as any,
      });

      queueEvents.on('waiting', (payload: unknown) => {
        const p = payload as { jobId?: string } | undefined;
        this.logger.debug('Job waiting', { queueName, jobId: p?.jobId });
      });

      queueEvents.on('active', (payload: unknown) => {
        const p = payload as { jobId?: string } | undefined;
        this.logger.debug('Job active', { queueName, jobId: p?.jobId });
      });

      queueEvents.on('stalled', (payload: unknown) => {
        const p = payload as { jobId?: string } | undefined;
        this.logger.warn('Job stalled', { queueName, jobId: p?.jobId });
      });

      this.queueEvents.set(queueName, queueEvents);

      this.logger.info('Queue initialized', {
        queueName,
        hasProcessor: !!processor,
      });
    } catch (error) {
      this.logger.error('Failed to initialize queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Add a batch processing job to the queue
   */
  async addBatchJob(
    queueName: string,
    jobName: string,
    data: BatchProcessingJob,
  ): Promise<string> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      const buildOpts = (d: BatchProcessingJob) => ({
        priority: d.options?.priority ?? 0,
        delay: d.options?.delay ?? 0,
        attempts: d.options?.attempts ?? 3,
        backoff: d.options?.backoff ?? {
          type: 'exponential',
          delay: 2000,
        },
      });

      const job = queue.add ? await queue.add(jobName, data, buildOpts(data)) : undefined;
      const jobId = job?.id ?? randomUUID();

      this.logger.info('Batch job added to queue', {
        queueName,
        jobName,
        jobId: String(jobId),
        integrationId: data.integrationId,
        recordCount: Array.isArray(data.records) ? data.records.length : 0,
        batchSize: data.batchSize ?? 0,
      });

      return String(jobId);
    } catch (error) {
      this.logger.error('Failed to add batch job', {
        queueName,
        jobName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get job progress
   */
  async getJobProgress(queueName: string, jobId: string): Promise<JobProgress | null> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      const job = await queue.getJob(jobId);
      if (!job) {
        return null;
      }

      const progress = job.progress as JobProgress;
      return progress || {
        total: 0,
        processed: 0,
        failed: 0,
        percentage: 0,
      };
    } catch (error) {
      this.logger.error('Failed to get job progress', {
        queueName,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get queue metrics
   */
  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      const waiting = (await queue.getWaiting?.()) || [];
      const active = (await queue.getActive?.()) || [];
      const completed = (await queue.getCompleted?.()) || [];
      const failed = (await queue.getFailed?.()) || [];
      const delayed = (await queue.getDelayed?.()) || [];
      const isPaused = await this.getIsPaused(queue);

      return {
        waiting: this.countLength(waiting),
        active: this.countLength(active),
        completed: this.countLength(completed),
        failed: this.countLength(failed),
        delayed: this.countLength(delayed),
        paused: isPaused,
      };
    } catch (error) {
      this.logger.error('Failed to get queue metrics', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async getIsPaused(queue: unknown): Promise<boolean> {
    try {
      const fn = (queue as { isPaused?: () => Promise<boolean> }).isPaused;
      const result = fn ? await fn.call(queue) : false;
      return !!result;
    } catch {
      return false;
    }
  }

  private countLength(v: unknown): number {
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'number') return v;
    return 0;
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      await queue.pause();
      this.logger.info('Queue paused', { queueName });
    } catch (error) {
      this.logger.error('Failed to pause queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Resume a queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      await queue.resume();
      this.logger.info('Queue resumed', { queueName });
    } catch (error) {
      this.logger.error('Failed to resume queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retry failed jobs in a queue
   */
  async retryFailedJobs(queueName: string): Promise<number> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      const failedJobs = (await queue.getFailed?.()) || [];
      let retriedCount = 0;

      for (const job of failedJobs) {
        if (job && typeof job.retry === 'function') {
          await job.retry();
          retriedCount++;
        }
      }

      this.logger.info('Failed jobs retried', {
        queueName,
        retriedCount,
      });

      return retriedCount;
    } catch (error) {
      this.logger.error('Failed to retry failed jobs', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clean up old jobs
   */
  async cleanQueue(queueName: string, grace: number = 24 * 60 * 60 * 1000): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not initialized`);
    }

    try {
      const cleaner = queue as unknown as {
        clean?: (grace: number, limit: number, type: string) => Promise<void>;
      };
      await cleaner.clean?.(grace, 100, 'completed');
      await cleaner.clean?.(grace, 50, 'failed');
      this.logger.info('Queue cleaned', { queueName, grace });
    } catch (error) {
      this.logger.error('Failed to clean queue', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Shutdown all queues and workers
   */
  async shutdown(): Promise<void> {
    try {
      // Close all workers
      for (const [queueName, worker] of this.workers) {
        await worker.close();
        this.logger.info('Worker closed', { queueName });
      }

      // Close all queue events
      for (const [queueName, queueEvents] of this.queueEvents) {
        await queueEvents.close();
        this.logger.info('Queue events closed', { queueName });
      }

      // Close all queues
      for (const [queueName, queue] of this.queues) {
        await queue.close();
        this.logger.info('Queue closed', { queueName });
      }

      // Close Redis connection (optional - connection may be a test stub)
      (this.connection as { disconnect?: () => void } | undefined)?.disconnect?.();

      this.logger.info('Queue service shutdown completed');
    } catch (error) {
      this.logger.error('Error during queue service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
