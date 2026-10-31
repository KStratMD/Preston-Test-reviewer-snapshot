import 'reflect-metadata';
import { ReconciliationScheduleJob } from '../../../../src/services/reconciliationCenter/ReconciliationScheduleJob';

type FakeLogger = { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

function logger(): FakeLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('ReconciliationScheduleJob', () => {
  it('reports not running until start() is invoked', () => {
    const service = { runDueSchedules: jest.fn() };
    const job = new ReconciliationScheduleJob(service as never, logger() as never);
    expect(job.isRunning()).toBe(false);
  });

  it('start is idempotent and warns on duplicate start', async () => {
    const service = { runDueSchedules: jest.fn(async () => ({ schedulesRun: 1, exceptionsCreated: 2, staleRunsReclaimed: 0 })) };
    const log = logger();
    const job = new ReconciliationScheduleJob(service as never, log as never);

    expect(job.isRunning()).toBe(false);
    job.start(60 * 60 * 1000);
    job.start(60 * 60 * 1000);
    expect(job.isRunning()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already running'));

    await job.stop();
    expect(job.isRunning()).toBe(false);
  });

  it('stop awaits the interval-driven inflight tick', async () => {
    jest.useFakeTimers();
    try {
      let resolveService!: () => void;
      const servicePromise = new Promise<void>((r) => { resolveService = r; });
      const service = {
        runDueSchedules: jest.fn(async () => {
          await servicePromise;
          return { schedulesRun: 1, exceptionsCreated: 2, staleRunsReclaimed: 0 };
        }),
      };
      const job = new ReconciliationScheduleJob(service as never, logger() as never);

      job.start(60 * 1000);
      expect(job.isRunning()).toBe(true);

      // Fire the interval callback — this enters the async IIFE that sets
      // job.inflight to a pending promise awaiting servicePromise via tick().
      jest.advanceTimersByTime(60 * 1000);
      // Flush the synchronous portion of the async IIFE and tick().
      await Promise.resolve();
      await Promise.resolve();
      expect(service.runDueSchedules).toHaveBeenCalledTimes(1);

      // stop() must AWAIT the in-flight tick. Without resolving servicePromise,
      // the stop promise should still be pending after a microtask yield.
      let stopped = false;
      const stopPromise = job.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      // Release the service. The IIFE's finally clears inflight; stop() resolves.
      resolveService();
      await stopPromise;
      expect(stopped).toBe(true);
      expect(job.isRunning()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('tick swallows service errors and returns a zero tick so the loop survives', async () => {
    const service = { runDueSchedules: jest.fn(async () => { throw new Error('downstream'); }) };
    const log = logger();
    const job = new ReconciliationScheduleJob(service as never, log as never);

    const result = await job.tick(new Date());

    expect(result).toEqual({ schedulesRun: 0, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('tick failed'),
      expect.any(Error),
      expect.objectContaining({ errorMessage: 'downstream' }),
    );
  });

  it('tick propagates staleRunsReclaimed from the service result', async () => {
    const service = {
      runDueSchedules: jest.fn(async () => ({ schedulesRun: 2, exceptionsCreated: 1, staleRunsReclaimed: 4 })),
    };
    const job = new ReconciliationScheduleJob(service as never, logger() as never);
    const result = await job.tick(new Date());
    expect(result).toEqual({ schedulesRun: 2, exceptionsCreated: 1, staleRunsReclaimed: 4 });
  });

  it('concurrent stop() calls all await the same inflight tick', async () => {
    jest.useFakeTimers();
    try {
      let resolveService!: () => void;
      const servicePromise = new Promise<void>((r) => { resolveService = r; });
      const service = {
        runDueSchedules: jest.fn(async () => {
          await servicePromise;
          return { schedulesRun: 1, exceptionsCreated: 2, staleRunsReclaimed: 0 };
        }),
      };
      const job = new ReconciliationScheduleJob(service as never, logger() as never);

      job.start(60 * 1000);
      jest.advanceTimersByTime(60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(service.runDueSchedules).toHaveBeenCalledTimes(1);

      // Two concurrent stop()s. The first clears intervalHandle and awaits
      // inflight. The second sees intervalHandle === null but MUST still
      // capture the existing inflight and await it — otherwise it returns
      // while the tick is still running.
      let stopA = false;
      let stopB = false;
      const a = job.stop().then(() => { stopA = true; });
      const b = job.stop().then(() => { stopB = true; });

      await Promise.resolve();
      expect(stopA).toBe(false);
      expect(stopB).toBe(false);

      resolveService();
      await Promise.all([a, b]);
      expect(stopA).toBe(true);
      expect(stopB).toBe(true);
      expect(job.isRunning()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('performs an immediate sweep on start() so overdue schedules are not delayed a full interval', async () => {
    const service = { runDueSchedules: jest.fn(async () => ({ schedulesRun: 0, exceptionsCreated: 0, staleRunsReclaimed: 0 })) };
    const job = new ReconciliationScheduleJob(service as never, logger() as never);

    // start() kicks off one guarded tick synchronously (no timer advance needed).
    job.start(60 * 60 * 1000);
    await job.stop(); // drains the immediate sweep's inflight tick

    expect(service.runDueSchedules).toHaveBeenCalledTimes(1);
    expect(job.isRunning()).toBe(false);
  });

  it('stop is a no-op when the job was never started', async () => {
    const service = { runDueSchedules: jest.fn() };
    const job = new ReconciliationScheduleJob(service as never, logger() as never);
    await expect(job.stop()).resolves.toBeUndefined();
    expect(service.runDueSchedules).not.toHaveBeenCalled();
  });
});
