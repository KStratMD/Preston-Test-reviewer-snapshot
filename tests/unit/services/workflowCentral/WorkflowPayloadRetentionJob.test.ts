import 'reflect-metadata';
import { WorkflowPayloadRetentionJob } from '../../../../src/services/workflowCentral/WorkflowPayloadRetentionJob';

function makeMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    withCorrelationId: jest.fn().mockReturnThis(),
  };
}

type MockRepo = {
  clearExpiredEphemeralPayloads: jest.Mock<
    Promise<{ tasksCleared: number; instancesCleared: number }>,
    [Date]
  >;
};

function makeMockRepo(
  result: { tasksCleared: number; instancesCleared: number } = { tasksCleared: 0, instancesCleared: 0 },
): MockRepo {
  return {
    clearExpiredEphemeralPayloads: jest.fn().mockResolvedValue(result),
  };
}

describe('WorkflowPayloadRetentionJob', () => {
  let logger: ReturnType<typeof makeMockLogger>;
  let repo: MockRepo;
  let job: WorkflowPayloadRetentionJob;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = makeMockLogger();
    repo = makeMockRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job = new WorkflowPayloadRetentionJob(repo as any, logger as any);
  });

  afterEach(async () => {
    await job.stop();
    jest.useRealTimers();
  });

  describe('start()', () => {
    it('schedules a tick at the configured interval', async () => {
      job.start(1000);
      expect(repo.clearExpiredEphemeralPayloads).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      // Flush the microtask queue so the setInterval callback's awaited
      // tick() resolves before assertions.
      await Promise.resolve();
      await Promise.resolve();
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — double-start warns and does not double-schedule', async () => {
      job.start(1000);
      job.start(1000);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('start() called while already running'),
      );
      jest.advanceTimersByTime(1000);
      // Flush microtasks so the setInterval callback's awaited tick()
      // resolves before assertion. Critical that this count be EXACTLY 1 —
      // a regression to double-interval scheduling would show as 2.
      await Promise.resolve();
      await Promise.resolve();
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(1);
    });

    it('skips overlapping ticks via inflight guard', async () => {
      type ClearResult = { tasksCleared: number; instancesCleared: number };
      let resolveFirstTick: (value: ClearResult) => void = () => undefined;
      repo.clearExpiredEphemeralPayloads.mockImplementationOnce(
        () =>
          new Promise<ClearResult>((resolve) => {
            resolveFirstTick = resolve;
          }),
      );

      job.start(1000);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      // First tick is in flight. Advance another interval — second tick
      // should be skipped because inflight is still non-null.
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('previous tick still running, skipping this interval'),
      );

      // Resolve the first tick so subsequent ticks are no longer blocked.
      // We intentionally do NOT assert on a third tick firing — fake-timer
      // microtask ordering with chained .then/.finally makes that brittle.
      // The behaviour we care about is the SKIP on overlap (asserted above).
      resolveFirstTick({ tasksCleared: 0, instancesCleared: 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe('tick()', () => {
    it('returns repository cleared counts unchanged', async () => {
      repo = makeMockRepo({ tasksCleared: 3, instancesCleared: 2 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job = new WorkflowPayloadRetentionJob(repo as any, logger as any);
      const result = await job.tick();
      expect(result).toEqual({ tasksCleared: 3, instancesCleared: 2 });
    });

    it('emits an info log when at least one row was cleared', async () => {
      repo = makeMockRepo({ tasksCleared: 1, instancesCleared: 0 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job = new WorkflowPayloadRetentionJob(repo as any, logger as any);
      await job.tick();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('tick complete'),
        { tasksCleared: 1, instancesCleared: 0 },
      );
    });

    it('does NOT emit an info log on no-op ticks (zero-cleared sweep)', async () => {
      logger.info.mockClear();
      await job.tick();
      // Logger.info gets called by start() under different tests; here we
      // verify the "tick complete" log is NOT emitted when nothing was cleared.
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('tick complete'),
        expect.anything(),
      );
    });

    it('swallows repo errors and returns zero counts', async () => {
      repo.clearExpiredEphemeralPayloads.mockRejectedValueOnce(new Error('db down'));
      const result = await job.tick();
      expect(result).toEqual({ tasksCleared: 0, instancesCleared: 0 });
      // Logger.error is (message, error?, metadata?) — the Error MUST be the
      // 2nd arg, metadata the 3rd. A non-Error 2nd arg is silently dropped
      // by the Logger (feedback-logger-error-metadata-position-bug).
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('clearExpiredEphemeralPayloads failed'),
        expect.any(Error),
        expect.objectContaining({ errorMessage: 'db down' }),
      );
    });

    it('handles non-Error throws — passes undefined as arg 2 and stringified value as arg 3', async () => {
      // Repo throws a non-Error value (e.g. a primitive). The Logger.error
      // call must NOT pass a non-Error in arg 2 (which would be silently
      // dropped); the err-instance-of-Error branch must yield undefined and
      // the String(err) fallback must populate the metadata. Exercises the
      // `err instanceof Error ? err : undefined` ternary branch that the
      // happy-path "db down" test does not cover.
      repo.clearExpiredEphemeralPayloads.mockRejectedValueOnce('boom-as-string');
      const result = await job.tick();
      expect(result).toEqual({ tasksCleared: 0, instancesCleared: 0 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('clearExpiredEphemeralPayloads failed'),
        undefined,
        { errorMessage: 'boom-as-string' },
      );
    });

    it('interval-driven tick() catches non-Error rejections (3-arg log shape)', async () => {
      // Exercises tick()'s own catch path when invoked via the setInterval
      // callback (not directly). tick()'s try/catch wraps the repo call;
      // for a non-Error rejection, the catch's
      // `err instanceof Error ? err : undefined` ternary must yield
      // undefined in Logger.error arg 2 and the stringified value in arg 3.
      // The outer .then(_, err => ...) rejection handler in start() is
      // defense-in-depth — never fires here because tick() catches first
      // and resolves with {0,0}.
      repo.clearExpiredEphemeralPayloads.mockRejectedValueOnce(42 as unknown as Error);
      job.start(1000);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('clearExpiredEphemeralPayloads failed'),
        undefined,
        { errorMessage: '42' },
      );
    });

    it('passes the provided now timestamp through to the repo', async () => {
      const fixedNow = new Date('2026-05-20T10:00:00.000Z');
      await job.tick(fixedNow);
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledWith(fixedNow);
    });
  });

  describe('stop()', () => {
    it('is a no-op when never started', async () => {
      await job.stop();
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('stopped'),
      );
    });

    it('clears the interval and emits a stopped log', async () => {
      job.start(1000);
      await job.stop();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('stopped'),
      );
      // Advance past the interval — no further tick should fire.
      const callsBeforeAdvance = repo.clearExpiredEphemeralPayloads.mock.calls.length;
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(repo.clearExpiredEphemeralPayloads).toHaveBeenCalledTimes(callsBeforeAdvance);
    });

    it('awaits an in-flight tick so the sweep is not cut mid-batch', async () => {
      type ClearResult = { tasksCleared: number; instancesCleared: number };
      let resolveTick: (value: ClearResult) => void = () => undefined;
      repo.clearExpiredEphemeralPayloads.mockImplementationOnce(
        () =>
          new Promise<ClearResult>((resolve) => {
            resolveTick = resolve;
          }),
      );

      job.start(1000);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Initiate stop while the tick is still in flight.
      let stopResolved = false;
      const stopPromise = job.stop().then(() => {
        stopResolved = true;
      });
      // Microtask flush is not enough — stop is waiting on the inflight promise.
      await Promise.resolve();
      expect(stopResolved).toBe(false);

      // Resolve the tick — stop should now complete.
      resolveTick({ tasksCleared: 0, instancesCleared: 0 });
      await stopPromise;
      expect(stopResolved).toBe(true);
    });
  });

  describe('isRunning()', () => {
    it('reports the interval state accurately across start/stop', async () => {
      expect(job.isRunning()).toBe(false);
      job.start(1000);
      expect(job.isRunning()).toBe(true);
      await job.stop();
      expect(job.isRunning()).toBe(false);
    });
  });
});
