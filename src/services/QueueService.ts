import { injectable, inject } from 'inversify';
import { Queue, Worker, QueueEvents, type Job, type ConnectionOptions } from 'bullmq';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { env, buildQueueConnectionOptions } from '../config/env';
import { ServiceUnavailableAppError } from '../errors/AppError';

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
/**
 * Availability of the batch queue subsystem.
 *
 * `disabled` and `unavailable` are deliberately distinct: the first is an
 * operator choice (DISABLE_REDIS) and is logged at info, the second is a
 * failure to reach a Redis we were told to use and is logged at error. Both
 * boot-and-degrade rather than aborting startup — the one machine-required
 * check boots the production image with DISABLE_REDIS=1
 * (scripts/smoke-docker-prod.sh), so failing startup here would redden it by
 * construction. Callers cannot act on the difference; they only ever see a
 * refusal. It exists so operators can tell "off on purpose" from "broken".
 */
export type QueueAvailability = 'disabled' | 'unavailable' | 'uninitialized' | 'ready';

@injectable()
export class QueueService {
  private readonly logger: Logger;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly queueEvents = new Map<string, QueueEvents>();
  private availability: QueueAvailability;

  /**
   * How long startup will wait for Redis before declaring the subsystem
   * unavailable. Bounded because this runs before the HTTP port opens.
   */
  private static readonly READINESS_TIMEOUT_MS = 10_000;

  /**
   * How long shutdown will wait for a single BullMQ object to close before
   * abandoning it. QueueEvents.close() does not settle against an unreachable
   * Redis, and shutdown must not be able to hang startup or process exit.
   */
  private static readonly CLOSE_TIMEOUT_MS = 5_000;

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    // Single source of truth for the flag: the normalized env schema. The old
    // hand-rolled regex here disagreed with z.coerce.boolean() in env.ts on
    // the string '0', which is exactly what docker-compose sets.
    if (env.DISABLE_REDIS) {
      this.availability = 'disabled';
      this.logger.info('DISABLE_REDIS set - batch queue subsystem disabled; queue operations will be refused');
      return;
    }
    this.availability = 'uninitialized';
  }

  getAvailability(): QueueAvailability {
    return this.availability;
  }

  isReady(): boolean {
    return this.availability === 'ready';
  }

  /**
   * Refuse any queue operation unless the subsystem is genuinely ready.
   *
   * Fails closed on purpose. The previous implementation degraded to a "stub
   * mode" that returned synthesised job IDs, so callers were told work had
   * been accepted that no worker would ever run.
   */
  private assertReady(operation: string): void {
    if (this.availability === 'ready') {
      return;
    }
    throw new ServiceUnavailableAppError(
      `Batch queue subsystem is ${this.availability}; ${operation} is unavailable`,
    );
  }

  /**
   * Fail-closed accessor for every queue operation.
   *
   * Checks availability *before* looking the queue up, so a caller running
   * with Redis disabled gets an honest "unavailable" rather than a misleading
   * "not initialized" — the queue is absent in that mode by design.
   */
  private requireQueue(queueName: string): Queue {
    this.assertReady(`queue "${queueName}"`);
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new ServiceUnavailableAppError(`Queue ${queueName} is not initialized`);
    }
    return queue;
  }

  /**
   * Keep a BullMQ object's connection errors from killing the process.
   *
   * Node escalates an 'error' event with no listener into an unhandled
   * rejection, so every one of these objects needs a listener attached before
   * anything awaits — a retrying connection to a dead Redis emits them
   * continuously. Logging is the whole job: availability is tracked
   * separately, operations already fail closed, and the connection retries on
   * its own, so there is nothing here to escalate or recover.
   */
  private attachErrorListener(
    emitter: { on: (event: 'error', cb: (err: Error) => void) => unknown },
    kind: string,
    queueName: string,
  ): void {
    emitter.on('error', (error: Error) => {
      this.logger.warn(`${kind} connection error`, {
        queueName,
        availability: this.availability,
        error: error?.message ?? String(error),
      });
    });
  }

  /**
   * Await readiness with a hard bound, so an unreachable Redis degrades
   * instead of blocking startup.
   *
   * The timer is unref'd: a pending timeout must never be the reason the
   * process stays alive, which matters for the Redis test profile that runs
   * with forceExit disabled precisely to surface leaked handles.
   */
  private async withReadinessTimeout<T>(work: Promise<T>, queueName: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Redis did not become ready within ${QueueService.READINESS_TIMEOUT_MS}ms for queue "${queueName}"`,
                ),
              ),
            QueueService.READINESS_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Confirm Redis is actually reachable using the producer alone.
   *
   * Throws on failure so initializeQueue()'s catch records `unavailable`. The
   * swallow-guard matters: the race's loser keeps running and this promise
   * rejects later, which would otherwise be an orphaned rejection.
   */
  private async probeProducerReadiness(queue: Queue, queueName: string): Promise<void> {
    const ready = queue.waitUntilReady();
    void ready.catch((): undefined => undefined);
    await this.withReadinessTimeout(ready, queueName);
  }

  /**
   * Initialize a queue for a specific job type
   */
  async initializeQueue(queueName: string, processor?: (job: Job) => Promise<void>): Promise<void> {
    if (this.availability === 'disabled') {
      // Deliberately not an error: boot-and-degrade. Constructing nothing is
      // the point — BullMQ treats any object passed as `connection` as
      // RedisOptions and builds its own ioredis from it, so the previous
      // "no-op stub" was in fact opening real sockets to localhost:6379.
      this.logger.info('Skipping queue initialization; Redis is disabled', { queueName });
      return;
    }

    try {
      const connection = buildQueueConnectionOptions();

      // Producer: fail fast. An HTTP-facing or request-scoped caller must not
      // block on a dead Redis. Deliberately NOT applied to the worker/event
      // consumers below, which are long-lived and must keep retrying.
      //
      // The two options live at DIFFERENT levels and that is not cosmetic:
      //   - maxRetriesPerRequest is an ioredis option, so it belongs inside
      //     `connection` and is forwarded to the client constructor.
      //   - skipWaitingForReady is a BullMQ option read off the QUEUE options
      //     (`queue-base.js:41` reads `opts.skipWaitingForReady`, then
      //     `redis-connection.js:193` gates readiness-waiting on it). Nested
      //     inside `connection` it is silently ignored as an unknown ioredis
      //     option — inert, which is exactly how it was first written here.
      const queue = new Queue(queueName, {
        connection: { ...connection, maxRetriesPerRequest: 3 } as ConnectionOptions,
        skipWaitingForReady: true,
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

      // Attach the error listener IMMEDIATELY, before anything awaits.
      //
      // Queue/Worker/QueueEvents are EventEmitters over a retrying ioredis
      // connection. With Redis unreachable they emit 'error' repeatedly, and
      // an 'error' event with no listener is escalated by Node into an
      // unhandled rejection that takes the process down. Without these, the
      // boot-and-degrade contract was a claim rather than a behaviour: a
      // verified probe against a dead Redis produced
      // `UNHANDLED REJECTION: ECONNREFUSED` even though initializeQueue()
      // correctly reported `unavailable`.
      //
      // These handlers deliberately only log. The connection keeps retrying on
      // its own, availability is already tracked separately, and every
      // operation fails closed — so there is nothing to escalate.
      this.attachErrorListener(queue, 'Queue', queueName);

      this.queues.set(queueName, queue);

      // Gate the CONSUMERS on the producer's readiness, rather than building
      // all three and tearing them down on failure.
      //
      // Two reasons, one of them a verified crash. First, honesty: if Redis is
      // unreachable there is no point spinning up a Worker and QueueEvents
      // that will retry forever against it. Second, and decisively:
      // constructing a Worker against an unreachable Redis and then closing it
      // mid-reconnect produces an unhandled rejection that kills the process —
      // reproduced against a closed port, and the reason the earlier
      // build-then-tear-down shape could not deliver boot-and-degrade no
      // matter how many error listeners were attached. Not building the
      // consumer is the only reliable way not to have to tear it down.
      //
      // The producer alone is enough to answer "is Redis reachable", and
      // Queue.close() does settle against a dead Redis where QueueEvents.close()
      // does not.
      await this.probeProducerReadiness(queue, queueName);

      // Create worker if processor provided
      if (processor) {
        const concurrency = Number(env.QUEUE_CONCURRENCY) || 5;
        // Persistent consumer: no producer fail-fast options. A worker that
        // gave up after a bounded number of retries would silently stop
        // draining the queue after a transient Redis blip.
        const worker = new Worker(queueName, processor, {
          connection: { ...connection } as ConnectionOptions,
          concurrency,
        });

        this.attachErrorListener(worker, 'Worker', queueName);

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
      // Persistent consumer, same reasoning as the worker above.
      const queueEvents = new QueueEvents(queueName, {
        connection: { ...connection } as ConnectionOptions,
      });

      this.attachErrorListener(queueEvents, 'QueueEvents', queueName);

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

      // `ready` only after Redis actually answers. waitUntilReady() is what
      // turns "objects constructed" into "subsystem usable" — without it the
      // producer's skipWaitingForReady would let us advertise readiness while
      // the connection is still failing.
      //
      // BOUNDED, and that bound is load-bearing. ioredis retries the
      // *connection* forever by default; maxRetriesPerRequest caps command
      // retries, not connect attempts. An unbounded await here therefore
      // hangs against an unreachable Redis — verified: a probe against a
      // closed port sat in waitUntilReady() indefinitely rather than
      // degrading. Since this runs before Server.start() opens the port, that
      // is a startup hang, which is a worse failure than the crash it was
      // meant to prevent. The timeout converts "never answers" into the
      // `unavailable` path the contract promises.
      // Consumers were only constructed because the producer already proved
      // Redis reachable, so these should settle promptly. Still bounded and
      // still swallow-guarded: Promise.race does not cancel losers, and an
      // orphaned late rejection is an unhandled rejection.
      const consumerReadiness: Promise<unknown>[] = [queueEvents.waitUntilReady()];
      if (processor) {
        const worker = this.workers.get(queueName);
        if (worker) {
          consumerReadiness.push(worker.waitUntilReady());
        }
      }
      consumerReadiness.forEach((p): void => {
        void p.catch((): undefined => undefined);
      });

      await this.withReadinessTimeout(Promise.all(consumerReadiness), queueName);

      this.availability = 'ready';
      this.logger.info('Queue initialized', {
        queueName,
        hasProcessor: !!processor,
      });
    } catch (error) {
      // Boot-and-degrade: record the failure, tear down whatever was half
      // built so it cannot leak connections, and let startup continue. Every
      // operation will refuse via assertReady() until a future init succeeds.
      this.availability = 'unavailable';
      this.logger.error('Failed to initialize queue; batch processing unavailable', {
        queueName,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.closeAll();
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
    const queue = this.requireQueue(queueName);

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

      // No synthesised fallback id. The previous `?? randomUUID()` handed the
      // caller a plausible-looking job id for work that had not been enqueued,
      // which is the exact "accepted but never runs" failure this contract
      // exists to remove.
      const job = await queue.add(jobName, data, buildOpts(data));
      const jobId = job?.id;
      if (!jobId) {
        throw new ServiceUnavailableAppError(
          `Queue ${queueName} accepted job "${jobName}" without returning an id`,
        );
      }

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
    const queue = this.requireQueue(queueName);

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
    const queue = this.requireQueue(queueName);

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
    const queue = this.requireQueue(queueName);

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
    const queue = this.requireQueue(queueName);

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
    const queue = this.requireQueue(queueName);

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
    const queue = this.requireQueue(queueName);

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
    await this.closeAll();
    if (this.availability === 'ready') {
      this.availability = 'uninitialized';
    }
    this.logger.info('Queue service shutdown completed');
  }

  /**
   * Close every BullMQ object this service owns and forget it.
   *
   * Each close() failure is caught individually and logged rather than
   * propagated: a worker that refuses to close must not prevent the queues and
   * event listeners behind it from being closed, or shutdown leaks the very
   * connections it exists to release. Idempotent — the maps are cleared, so a
   * second call is a no-op.
   *
   * Connections are not closed separately here. Queue/Worker/QueueEvents are
   * each constructed from plain connection *options*, so BullMQ owns the
   * ioredis client it created and releases it on close(). There is no
   * separately-owned client to disconnect.
   */
  private async closeAll(): Promise<void> {
    const closeQuietly = async (
      kind: string,
      queueName: string,
      close: () => Promise<void>,
    ): Promise<void> => {
      // Bounded, because close() is not guaranteed to settle. Verified against
      // bullmq 5.77.6 with an unreachable Redis: Queue.close() and
      // Worker.close() resolve immediately, but QueueEvents.close() stays
      // pending indefinitely — it waits on a blocking connection that will
      // never answer. Unbounded, that hangs closeAll(), which hangs the
      // initialize() failure path, which hangs Server.start() *before* the
      // port opens. A startup hang is a worse outcome than the leaked socket
      // this bound risks, and the socket is being torn down anyway.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          close(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.logger.warn(`${kind} close timed out; abandoning it`, {
                queueName,
                timeoutMs: QueueService.CLOSE_TIMEOUT_MS,
              });
              resolve();
            }, QueueService.CLOSE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        this.logger.info(`${kind} closed`, { queueName });
      } catch (error) {
        this.logger.error(`Failed to close ${kind}`, {
          queueName,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };

    // Workers first so in-flight jobs stop being picked up before the queues
    // and event streams they depend on go away.
    for (const [queueName, worker] of this.workers) {
      await closeQuietly('Worker', queueName, () => worker.close());
    }
    this.workers.clear();

    for (const [queueName, queueEvents] of this.queueEvents) {
      await closeQuietly('Queue events', queueName, () => queueEvents.close());
    }
    this.queueEvents.clear();

    for (const [queueName, queue] of this.queues) {
      await closeQuietly('Queue', queueName, () => queue.close());
    }
    this.queues.clear();
  }
}
