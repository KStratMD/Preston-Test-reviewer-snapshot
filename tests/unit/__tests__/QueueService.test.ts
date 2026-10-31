/**
 * QueueService — availability contract (#1102 activation).
 *
 * These tests exist because the previous implementation's "stub mode" was not
 * a no-op: it handed BullMQ a plain `{on, disconnect}` object as `connection`,
 * and BullMQ treats any non-client object as RedisOptions and builds its own
 * ioredis from it (defaulting to localhost:6379). The old suite could not
 * catch that, because it mocked bullmq wholesale and never asserted whether
 * the constructors ran at all. So the central assertions here are about
 * *construction* and *refusal*, not just return values.
 *
 * env.DISABLE_REDIS is read at construction time from the parsed env schema,
 * which is a module singleton. Each scenario therefore resets the module
 * registry and re-imports so the flag is re-parsed.
 */
import type { Logger } from '../utils/Logger';

const flushEnv = (disableRedis?: string) => {
  jest.resetModules();
  if (disableRedis === undefined) {
    delete process.env.DISABLE_REDIS;
  } else {
    process.env.DISABLE_REDIS = disableRedis;
  }
};

const makeLogger = (): jest.Mocked<Logger> =>
  ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
    setCorrelationId: jest.fn().mockReturnThis(),
    withCorrelationId: jest.fn().mockReturnThis(),
    getCorrelationId: jest.fn().mockReturnValue('test-correlation-id'),
  }) as unknown as jest.Mocked<Logger>;

/** Builds a bullmq mock whose constructors and close() calls are observable. */
const installBullmqMock = (opts: { failReady?: boolean } = {}) => {
  const queueClose = jest.fn().mockResolvedValue(undefined);
  const workerClose = jest.fn().mockResolvedValue(undefined);
  const eventsClose = jest.fn().mockResolvedValue(undefined);
  const queueAdd = jest.fn().mockResolvedValue({ id: 'job-123' });

  const waitUntilReady = opts.failReady
    ? jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'))
    : jest.fn().mockResolvedValue(undefined);

  // `on` matters: the service registers an 'error' listener on every BullMQ
  // object, and a mock without it silently turned that into a TypeError that
  // the init catch swallowed as "unavailable" — a mock gap that made the
  // success path look like a failure path.
  const Queue = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    add: queueAdd,
    getJob: jest.fn(),
    getWaiting: jest.fn().mockResolvedValue([]),
    getActive: jest.fn().mockResolvedValue([]),
    getCompleted: jest.fn().mockResolvedValue([]),
    getFailed: jest.fn().mockResolvedValue([]),
    getDelayed: jest.fn().mockResolvedValue([]),
    isPaused: jest.fn().mockResolvedValue(false),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    clean: jest.fn().mockResolvedValue(undefined),
    waitUntilReady,
    close: queueClose,
  }));
  const Worker = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    close: workerClose,
  }));
  const QueueEvents = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    close: eventsClose,
  }));

  jest.doMock('bullmq', () => ({ Queue, Worker, QueueEvents }));
  return { Queue, Worker, QueueEvents, queueClose, workerClose, eventsClose, queueAdd };
};

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const loadQueueService = (): any => require('../services/QueueService').QueueService;
const loadUnavailableError = (): any => require('../errors/AppError').ServiceUnavailableAppError;

describe('QueueService availability contract', () => {
  const originalDisableRedis = process.env.DISABLE_REDIS;

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalDisableRedis === undefined) {
      delete process.env.DISABLE_REDIS;
    } else {
      process.env.DISABLE_REDIS = originalDisableRedis;
    }
  });

  describe('DISABLE_REDIS explicitly set', () => {
    it('reports disabled and constructs NO bullmq objects', async () => {
      flushEnv('1');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());

      expect(svc.getAvailability()).toBe('disabled');
      expect(svc.isReady()).toBe(false);

      await svc.initializeQueue('batch-processing', jest.fn());

      // The heart of the regression: disabled must mean "nothing constructed".
      // The old stub mode still ran `new Queue(...)`, which opened a real
      // ioredis to localhost:6379 under the hood.
      expect(mock.Queue).not.toHaveBeenCalled();
      expect(mock.Worker).not.toHaveBeenCalled();
      expect(mock.QueueEvents).not.toHaveBeenCalled();
      expect(svc.getAvailability()).toBe('disabled');
    });

    it('refuses every queue operation instead of returning a synthetic success', async () => {
      flushEnv('1');
      installBullmqMock();
      const QueueService = loadQueueService();
      const ServiceUnavailableAppError = loadUnavailableError();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing');

      const job = { integrationId: 'i-1', records: [], batchSize: 10 };
      await expect(svc.addBatchJob('batch-processing', 'n', job)).rejects.toThrow(
        ServiceUnavailableAppError,
      );
      await expect(svc.getQueueMetrics('batch-processing')).rejects.toThrow(
        ServiceUnavailableAppError,
      );
      await expect(svc.getJobProgress('batch-processing', 'j-1')).rejects.toThrow(
        ServiceUnavailableAppError,
      );
      await expect(svc.pauseQueue('batch-processing')).rejects.toThrow(ServiceUnavailableAppError);
      await expect(svc.resumeQueue('batch-processing')).rejects.toThrow(ServiceUnavailableAppError);
      await expect(svc.retryFailedJobs('batch-processing')).rejects.toThrow(
        ServiceUnavailableAppError,
      );
      await expect(svc.cleanQueue('batch-processing')).rejects.toThrow(ServiceUnavailableAppError);
    });

    it.each([
      ['0', 'uninitialized'],
      ['false', 'uninitialized'],
      ['1', 'disabled'],
      ['true', 'disabled'],
    ])('treats DISABLE_REDIS=%s as %s', (value, expected) => {
      flushEnv(value);
      installBullmqMock();
      const QueueService = loadQueueService();
      // Guards the exact bug the env normalization fixed: Boolean('0') is true,
      // and docker-compose sets DISABLE_REDIS=0 to mean "Redis enabled".
      expect(new QueueService(makeLogger()).getAvailability()).toBe(expected);
    });
  });

  describe('Redis enabled', () => {
    it('becomes ready only after readiness is awaited', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());

      expect(svc.getAvailability()).toBe('uninitialized');
      await svc.initializeQueue('batch-processing', jest.fn());

      expect(mock.Queue).toHaveBeenCalledTimes(1);
      expect(mock.Worker).toHaveBeenCalledTimes(1);
      expect(mock.QueueEvents).toHaveBeenCalledTimes(1);
      expect(svc.getAvailability()).toBe('ready');
      expect(svc.isReady()).toBe(true);
    });

    it('gives fail-fast options to the producer Queue but NOT to Worker/QueueEvents', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      await new QueueService(makeLogger()).initializeQueue('batch-processing', jest.fn());

      const queueOpts = mock.Queue.mock.calls[0][1];

      // LEVEL MATTERS, and an earlier version of this test got it wrong.
      // skipWaitingForReady is a BullMQ queue option — queue-base.js:41 reads
      // `opts.skipWaitingForReady` and redis-connection.js:193 gates readiness
      // on it. Nested inside `connection` it is an unknown ioredis option and
      // is silently ignored, so asserting it there pins an inert config.
      expect(queueOpts.skipWaitingForReady).toBe(true);
      expect(queueOpts.connection.skipWaitingForReady).toBeUndefined();

      // maxRetriesPerRequest IS an ioredis option, so it belongs in connection.
      expect(queueOpts.connection.maxRetriesPerRequest).toBe(3);

      // A persistent consumer must keep retrying; producer fail-fast settings
      // here would silently stop the queue draining after a transient blip.
      const workerOpts = mock.Worker.mock.calls[0][2];
      expect(workerOpts.skipWaitingForReady).toBeUndefined();
      expect(workerOpts.connection.skipWaitingForReady).toBeUndefined();
      expect(workerOpts.connection.maxRetriesPerRequest).toBeUndefined();

      const eventsOpts = mock.QueueEvents.mock.calls[0][1];
      expect(eventsOpts.skipWaitingForReady).toBeUndefined();
      expect(eventsOpts.connection.skipWaitingForReady).toBeUndefined();
      expect(eventsOpts.connection.maxRetriesPerRequest).toBeUndefined();
    });

    it('degrades to unavailable without ever constructing the consumers', async () => {
      flushEnv('0');
      const mock = installBullmqMock({ failReady: true });
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());

      // Boot-and-degrade: initialization must not throw into Server.start().
      await expect(svc.initializeQueue('batch-processing', jest.fn())).resolves.toBeUndefined();
      expect(svc.getAvailability()).toBe('unavailable');

      // The producer gates the consumers. This is not just tidiness: against a
      // real unreachable Redis, constructing a Worker and then closing it
      // mid-reconnect produces an unhandled rejection that kills the process.
      // Not building it is the only reliable way not to have to tear it down.
      expect(mock.Queue).toHaveBeenCalledTimes(1);
      expect(mock.Worker).not.toHaveBeenCalled();
      expect(mock.QueueEvents).not.toHaveBeenCalled();

      // The one object that was built is still released.
      expect(mock.queueClose).toHaveBeenCalled();
    });

    it('registers an error listener on every constructed BullMQ object', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      await new QueueService(makeLogger()).initializeQueue('batch-processing', jest.fn());

      // BullMQ re-emits connection failures on its own objects, and Node
      // escalates an 'error' event with no listener into a process-killing
      // unhandled rejection. Every object needs one.
      for (const ctor of [mock.Queue, mock.Worker, mock.QueueEvents]) {
        const instance = ctor.mock.results[0].value as { on: jest.Mock };
        const events = instance.on.mock.calls.map((c: unknown[]) => c[0]);
        expect(events).toContain('error');
      }
    });

    it('returns the real job id and never a synthesised one', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing', jest.fn());

      const id = await svc.addBatchJob('batch-processing', 'process', {
        integrationId: 'i-1',
        records: [{ id: 'r1' }],
        batchSize: 10,
      });
      expect(id).toBe('job-123');
      expect(mock.queueAdd).toHaveBeenCalled();
    });

    it('refuses when the id cannot be confirmed rather than inventing one', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const ServiceUnavailableAppError = loadUnavailableError();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing', jest.fn());
      mock.queueAdd.mockResolvedValueOnce({ id: undefined });

      await expect(
        svc.addBatchJob('batch-processing', 'process', {
          integrationId: 'i-1',
          records: [],
          batchSize: 10,
        }),
      ).rejects.toThrow(ServiceUnavailableAppError);
    });
  });

  describe('shutdown', () => {
    it('positively closes Queue, Worker and QueueEvents', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing', jest.fn());

      await svc.shutdown();

      // Asserted directly rather than inferred from a clean Jest exit: the
      // slow profile sets forceExit:true and detectOpenHandles:false, so a
      // green run proves nothing about whether handles were released.
      expect(mock.workerClose).toHaveBeenCalledTimes(1);
      expect(mock.eventsClose).toHaveBeenCalledTimes(1);
      expect(mock.queueClose).toHaveBeenCalledTimes(1);
      expect(svc.getAvailability()).toBe('uninitialized');
    });

    it('closes the remaining objects even when one close() rejects', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing', jest.fn());
      mock.workerClose.mockRejectedValueOnce(new Error('Shutdown failed'));

      // Must not reject: a worker refusing to close cannot be allowed to strand
      // the queue and event connections behind it.
      await expect(svc.shutdown()).resolves.toBeUndefined();
      expect(mock.eventsClose).toHaveBeenCalled();
      expect(mock.queueClose).toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      flushEnv('0');
      const mock = installBullmqMock();
      const QueueService = loadQueueService();
      const svc = new QueueService(makeLogger());
      await svc.initializeQueue('batch-processing', jest.fn());

      await svc.shutdown();
      await svc.shutdown();

      expect(mock.queueClose).toHaveBeenCalledTimes(1);
    });
  });
});
