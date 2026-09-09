import 'reflect-metadata';
import { SyncErrorAssistDailyJob } from '../../../../src/services/syncErrorAssist/SyncErrorAssistDailyJob';

function makeMockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), withCorrelationId: jest.fn().mockReturnThis() };
}

describe('SyncErrorAssistDailyJob', () => {
  let mockService: any;
  let job: SyncErrorAssistDailyJob;

  beforeEach(() => {
    jest.useFakeTimers();
    mockService = { runAllEnabledTenants: jest.fn().mockResolvedValue([]) };
    job = new SyncErrorAssistDailyJob(makeMockLogger() as any, mockService);
  });

  afterEach(async () => {
    await job.stop();
    jest.useRealTimers();
  });

  it('start() schedules a tick at the given interval', async () => {
    job.start(1000);
    expect(mockService.runAllEnabledTenants).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);
  });

  it('start() called twice is a no-op (idempotent)', () => {
    job.start(1000);
    job.start(1000);
    jest.advanceTimersByTime(1000);
  });

  it('skips overlapping ticks via inflightPromise guard', async () => {
    let resolveFirstTick: (() => void) | null = null;
    mockService.runAllEnabledTenants = jest.fn().mockImplementation(() => new Promise<any[]>((r) => { resolveFirstTick = () => r([]); }));

    job.start(1000);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);

    resolveFirstTick!();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(2);
    // Resolve the second tick so afterEach's job.stop() can await cleanly.
    resolveFirstTick!();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('stop() resolves only after the inflight cycle settles', async () => {
    let resolveTick: (() => void) | null = null;
    mockService.runAllEnabledTenants = jest.fn().mockImplementation(() => new Promise<any[]>((r) => { resolveTick = () => r([]); }));

    job.start(1000);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    const stopPromise = job.stop();
    let stopResolved = false;
    stopPromise.then(() => { stopResolved = true; });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    resolveTick!();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('stop() clears the interval BEFORE awaiting inflight — no new ticks scheduled during drain', async () => {
    // Regression for the new ordering. Previously stop() awaited inflight first,
    // so the timer could fire (and no-op via the guard) during drain. Now timers
    // are cleared up front so no extra ticks are scheduled while we wait.
    let resolveTick: (() => void) | null = null;
    mockService.runAllEnabledTenants = jest.fn().mockImplementation(() => new Promise<any[]>((r) => { resolveTick = () => r([]); }));

    job.start(1000);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);

    const stopPromise = job.stop();
    // Advance time PAST the next interval window — if the interval was still
    // active, this would schedule another runAllEnabledTenants call.
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);  // still 1 — interval is dead

    resolveTick!();
    await stopPromise;
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);
  });

  it('runOnce() invokes service directly without starting timer', async () => {
    mockService.runAllEnabledTenants.mockResolvedValue([{ tenantId: 't1', errorsScanned: 0 } as any]);
    const result = await job.runOnce();
    expect(result).toEqual([{ tenantId: 't1', errorsScanned: 0 }]);
    expect(mockService.runAllEnabledTenants).toHaveBeenCalledTimes(1);
  });
});
