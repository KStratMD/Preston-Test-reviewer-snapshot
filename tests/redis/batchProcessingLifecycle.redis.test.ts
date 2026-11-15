/**
 * Real-Redis lifecycle proof for the batch queue (#1102 activation).
 *
 * This is the only evidence in the repo that the wiring actually works.
 * Everything else mocks bullmq, and mocked BullMQ cannot distinguish "we
 * enqueued a job that a worker ran" from "we called a jest.fn()". Bumble's
 * contract says mock-only tests are insufficient for the activation claim,
 * which is exactly why this file exists and why it lives in its own
 * non-hermetic profile (jest.redis.config.cjs) rather than in the slow
 * profile, whose setupEnv forces DISABLE_REDIS=1 for every file it runs.
 *
 * It fails loudly rather than skipping when Redis is absent. A self-skipping
 * proof-of-wiring would go green in exactly the situation it exists to catch.
 */

// Set before any module reads the env schema: env.ts parses once at import
// and QueueService decides its availability from that parsed value.
process.env.DISABLE_REDIS = '0';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'redis-lifecycle-test-secret-123456789012345678901234567890';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import type { Logger } from '../../src/utils/Logger';

const QUEUE_NAME = 'batch-processing-lifecycle-test';

const silentLogger = (): Logger =>
  ({
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child() {
      return this;
    },
    setCorrelationId() {
      return this;
    },
    withCorrelationId() {
      return this;
    },
    getCorrelationId: () => 'redis-lifecycle-test',
  }) as unknown as Logger;

describe('batch queue lifecycle against a real Redis', () => {
  let queueCloseSpy: jest.SpyInstance;
  let workerCloseSpy: jest.SpyInstance;
  let eventsCloseSpy: jest.SpyInstance;

  beforeAll(async () => {
    // Prove Redis is actually reachable before asserting anything about the
    // service, so a connection failure reports itself rather than surfacing as
    // a confusing assertion error later.
    const probe = new Queue(`${QUEUE_NAME}-probe`, {
      connection: { url: process.env.REDIS_URL } as never,
    });
    try {
      await probe.waitUntilReady();
    } finally {
      await probe.close();
    }
  });

  beforeEach(() => {
    // Spies on the real prototypes: this asserts closure positively rather
    // than inferring it from a clean Jest exit. detectOpenHandles/forceExit
    // in this profile are the backstop, not the proof.
    queueCloseSpy = jest.spyOn(Queue.prototype, 'close');
    workerCloseSpy = jest.spyOn(Worker.prototype, 'close');
    eventsCloseSpy = jest.spyOn(QueueEvents.prototype, 'close');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports ready, runs an enqueued job, then closes every connection it owns', async () => {
    const { QueueService } = require('../../src/services/QueueService');
    const service = new QueueService(silentLogger());

    expect(service.getAvailability()).toBe('uninitialized');

    let resolveProcessed: (jobId: string) => void;
    const processed = new Promise<string>((resolve) => {
      resolveProcessed = resolve;
    });

    await service.initializeQueue(QUEUE_NAME, async (job: Job) => {
      resolveProcessed(String(job.id));
    });

    // Readiness is awaited inside initializeQueue, so this is a real
    // "Redis answered" signal, not merely "objects constructed".
    expect(service.getAvailability()).toBe('ready');
    expect(service.isReady()).toBe(true);

    const jobId = await service.addBatchJob(QUEUE_NAME, 'process-integration-batch', {
      integrationId: 'integration-lifecycle-test',
      records: [{ id: 'r1', fields: { name: 'one' } }],
      batchSize: 100,
    });

    expect(jobId).toBeTruthy();
    // A real id from Redis, not the randomUUID() fallback the old
    // implementation returned for work nothing would ever run.
    await expect(processed).resolves.toBe(jobId);

    await service.shutdown();

    expect(workerCloseSpy).toHaveBeenCalled();
    expect(eventsCloseSpy).toHaveBeenCalled();
    expect(queueCloseSpy).toHaveBeenCalled();
    expect(service.getAvailability()).toBe('uninitialized');
  });

  it('refuses operations after shutdown instead of resurrecting silently', async () => {
    const { QueueService } = require('../../src/services/QueueService');
    const { ServiceUnavailableAppError } = require('../../src/errors/AppError');
    const service = new QueueService(silentLogger());

    await service.initializeQueue(`${QUEUE_NAME}-refusal`);
    expect(service.isReady()).toBe(true);

    await service.shutdown();

    await expect(
      service.addBatchJob(`${QUEUE_NAME}-refusal`, 'process-integration-batch', {
        integrationId: 'integration-lifecycle-test',
        records: [],
        batchSize: 10,
      }),
    ).rejects.toThrow(ServiceUnavailableAppError);
  });
});
