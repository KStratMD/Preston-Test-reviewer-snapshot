import { CostTransparencyDailyJob } from '../../../../src/services/cost/CostTransparencyDailyJob';
import type { CostTransparencyService } from '../../../../src/services/cost/CostTransparencyService';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

describe('CostTransparencyDailyJob', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs all known tenants on tick', async () => {
    const rollupDay = jest.fn().mockResolvedValue(undefined);
    const listTenants = jest.fn().mockResolvedValue(['t1', 't2']);
    const svc = { rollupDay, listTenants } as unknown as CostTransparencyService;

    const job = new CostTransparencyDailyJob(logger, svc);
    job.start(60_000);
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    // Drain microtasks for the async chain to flush.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(rollupDay).toHaveBeenCalled();
    expect(rollupDay).toHaveBeenCalledWith('t1', expect.any(String));
    expect(rollupDay).toHaveBeenCalledWith('t2', expect.any(String));
    await job.stop();
  });

  it('fires an initial tick on start (no timer advance needed)', async () => {
    const rollupDay = jest.fn().mockResolvedValue(undefined);
    const listTenants = jest.fn().mockResolvedValue(['t1']);
    const svc = { rollupDay, listTenants } as unknown as CostTransparencyService;

    const job = new CostTransparencyDailyJob(logger, svc);
    job.start(60_000);
    // Drain microtasks; do NOT advance timers
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(listTenants).toHaveBeenCalled();
    expect(rollupDay).toHaveBeenCalledWith('t1', expect.any(String));
    await job.stop();
  });

  it('start is idempotent', async () => {
    const svc = { rollupDay: jest.fn(), listTenants: jest.fn().mockResolvedValue([]) } as unknown as CostTransparencyService;
    const job = new CostTransparencyDailyJob(logger, svc);
    job.start(60_000);
    job.start(60_000);
    // Drain microtasks for the initial tick to complete
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await job.stop();
    // Initial tick fires once; second start short-circuits without firing another tick.
    expect(svc.listTenants).toHaveBeenCalledTimes(1);
  });

  it('stop drains inflight', async () => {
    let resolveTick: (v: unknown) => void = () => {};
    const inflight = new Promise((r) => { resolveTick = r; });
    const svc = { rollupDay: jest.fn().mockReturnValue(inflight), listTenants: jest.fn().mockResolvedValue(['t1']) } as unknown as CostTransparencyService;
    const job = new CostTransparencyDailyJob(logger, svc);
    job.start(60_000);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    const stopP = job.stop();
    resolveTick(undefined);
    await stopP;
    expect(svc.rollupDay).toHaveBeenCalledWith('t1', expect.any(String));
  });
});
