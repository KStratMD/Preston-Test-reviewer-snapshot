import 'reflect-metadata';
import { ReconciliationCenterService } from '../../../../src/services/reconciliationCenter/ReconciliationCenterService';
import type { ReconciliationExceptionRepository } from '../../../../src/services/reconciliationCenter/ReconciliationExceptionRepository';
import type { ReconciliationScheduleRepository } from '../../../../src/services/reconciliationCenter/ReconciliationScheduleRepository';
import { ReconcilerRegistry, UnknownReconcilerError, ReconcilerConfigError } from '../../../../src/services/reconciliationCenter/reconcilers/Reconciler';
import type { Reconciler } from '../../../../src/services/reconciliationCenter/reconcilers/Reconciler';
import { ReconciliationScheduleNotFoundError } from '../../../../src/services/reconciliationCenter/ReconciliationScheduleRepository';
import type { ReconciliationScheduleView } from '../../../../src/services/reconciliationCenter/ReconciliationCenterTypes';
import type { ReconciliationScheduleRow } from '../../../../src/database/types';
import type { ReconciliationDiscrepancy } from '../../../../src/services/reconciliationCenter/invoiceComparison';

const reconcilerStub = (key: string, run: Reconciler['run']): Reconciler => ({ key, validateConfig: jest.fn(), run });

type ExcMethods = 'createException' | 'listExceptions' | 'updateStatus' | 'existsOpenException';
type SchedMethods = 'listDueSchedules' | 'claimDueScheduleAndCreateRun' | 'completeRun' | 'failRun' | 'reclaimStaleRuns';

function excMock(): jest.Mocked<Pick<ReconciliationExceptionRepository, ExcMethods>> {
  return {
    createException: jest.fn(),
    listExceptions: jest.fn(),
    updateStatus: jest.fn(),
    existsOpenException: jest.fn().mockResolvedValue(false),
  };
}
function schedMock(): jest.Mocked<Pick<ReconciliationScheduleRepository, SchedMethods>> {
  return {
    listDueSchedules: jest.fn().mockResolvedValue([]),
    claimDueScheduleAndCreateRun: jest.fn(),
    completeRun: jest.fn(),
    failRun: jest.fn(),
    reclaimStaleRuns: jest.fn().mockResolvedValue(0),
  };
}
function loggerMock() {
  return { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
}
function makeService(
  exc = excMock(),
  sched = schedMock(),
  registry = new ReconcilerRegistry(),
  logger = loggerMock(),
): {
  svc: ReconciliationCenterService;
  exc: ReturnType<typeof excMock>;
  sched: ReturnType<typeof schedMock>;
  registry: ReconcilerRegistry;
  logger: ReturnType<typeof loggerMock>;
} {
  const svc = new ReconciliationCenterService(
    exc as unknown as ReconciliationExceptionRepository,
    sched as unknown as ReconciliationScheduleRepository,
    registry,
    logger as never,
  );
  return { svc, exc, sched, registry, logger };
}

const schedRow = (over: Partial<ReconciliationScheduleRow> = {}): ReconciliationScheduleRow => ({
  id: 'sch_1',
  tenant_id: 't1',
  name: 'nightly',
  cadence: 'hourly',
  active: true,
  next_run_at: '2026-05-29T00:00:00.000Z',
  handler_key: 'k',
  integration_config_id: 'cfg_seed',
  created_at: '',
  updated_at: '',
  ...over,
});
const disc = (over: Partial<ReconciliationDiscrepancy> = {}): ReconciliationDiscrepancy => ({
  sourceSystem: 'netsuite',
  targetSystem: 'business_central',
  sourceRecordId: 'INV-1',
  exceptionType: 'amount_mismatch',
  severity: 'medium',
  amountDelta: 20,
  currency: 'USD',
  description: 'd',
  suggestedAction: 'a',
  ...over,
});

describe('ReconciliationCenterService — existing API', () => {
  it('creates exceptions from processor discrepancies with tenant attribution', async () => {
    const { svc, exc } = makeService();
    exc.createException.mockResolvedValue('rex_1');
    const ids = await svc.ingestPaymentDiscrepancies({
      tenantId: 't_squire',
      sourceSystem: 'stripe',
      targetSystem: 'business_central',
      discrepancies: [
        {
          transactionId: 'txn_1',
          type: 'amount_mismatch',
          severity: 'high',
          processorAmount: 120,
          businessCentralAmount: 100,
          description: 'Amounts differ',
          suggestedAction: 'Review fees',
        },
      ],
    });
    expect(ids).toEqual(['rex_1']);
    expect(exc.createException).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRecordId: 'txn_1', amountDelta: 20 }),
    );
  });

  it('lists open exceptions scoped by tenant', async () => {
    const { svc, exc } = makeService();
    const expected = [{ id: 'rex_1', tenantId: 't_squire', status: 'open' as const }];
    exc.listExceptions.mockResolvedValue(expected as never);
    expect(await svc.listOpen('t_squire')).toBe(expected);
    expect(exc.listExceptions).toHaveBeenCalledWith({ tenantId: 't_squire', status: 'open' });
  });

  it('resolves an exception with operator attribution', async () => {
    const { svc, exc } = makeService();
    await svc.resolveException({ tenantId: 't_squire', exceptionId: 'rex_1', actorUserId: 'u_ops', note: 'Matched' });
    expect(exc.updateStatus).toHaveBeenCalledWith({
      tenantId: 't_squire',
      exceptionId: 'rex_1',
      status: 'resolved',
      actorUserId: 'u_ops',
      resolutionNote: 'Matched',
    });
  });

  it('omits amountDelta when one side of the comparison is missing', async () => {
    const { svc, exc } = makeService();
    exc.createException.mockResolvedValue('rex_2');
    await svc.ingestPaymentDiscrepancies({
      tenantId: 't_squire',
      sourceSystem: 'stripe',
      targetSystem: 'business_central',
      discrepancies: [
        {
          transactionId: 'txn_2',
          type: 'missing_in_target',
          severity: 'critical',
          processorAmount: 50,
          description: 'No ERP record',
          suggestedAction: 'Open ticket',
        },
      ],
    });
    expect(exc.createException).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRecordId: 'txn_2', amountDelta: null }),
    );
  });
});

describe('ReconciliationCenterService.runDueSchedules — dispatch', () => {
  it('returns a zero tick when no schedules are due', async () => {
    const { svc, sched } = makeService();
    sched.listDueSchedules.mockResolvedValue([]);
    await expect(svc.runDueSchedules(new Date())).resolves.toEqual({ schedulesRun: 0, exceptionsCreated: 0, staleRunsReclaimed: 0 });
  });

  it('claims a due schedule, runs its reconciler, persists exceptions, completes the run', async () => {
    const { svc, exc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    exc.createException.mockResolvedValue('rex_1');
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([disc()])));

    const result = await svc.runDueSchedules(new Date('2026-05-29T05:30:00.000Z'));

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 1, staleRunsReclaimed: 0 });
    expect(exc.createException).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch' }),
    );
    expect(sched.completeRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'rrun_1', exceptionsCreated: 1 });
    expect(sched.failRun).not.toHaveBeenCalled();
  });

  it('skips a schedule whose claim returns null (lost to another replica)', async () => {
    const { svc, sched } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow()]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue(null);
    const result = await svc.runDueSchedules(new Date());
    expect(result).toEqual({ schedulesRun: 0, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.completeRun).not.toHaveBeenCalled();
    expect(sched.failRun).not.toHaveBeenCalled();
  });

  it('coalesces: does not re-create an exception that is already open', async () => {
    const { svc, exc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    exc.existsOpenException.mockResolvedValue(true);
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([disc()])));

    const result = await svc.runDueSchedules(new Date());

    expect(exc.createException).not.toHaveBeenCalled();
    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.completeRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'rrun_1', exceptionsCreated: 0 });
  });

  it('fails the run (does not throw) when the reconciler throws', async () => {
    const { svc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    registry.register(reconcilerStub('k', jest.fn().mockRejectedValue(new Error('connector down'))));

    const result = await svc.runDueSchedules(new Date());

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.failRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'rrun_1', errorMessage: 'connector down' });
  });

  it('stringifies a non-Error reconciler throw and logs a non-Error persist failure', async () => {
    // Covers the `String(err)` and `new Error(String(persistErr))` fallback
    // branches: a reconciler that rejects with a non-Error value, and a failRun
    // that itself rejects with a non-Error value.
    const { svc, sched, registry, logger } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    registry.register(reconcilerStub('k', jest.fn().mockRejectedValue('string failure')));
    sched.failRun.mockRejectedValue('persist string failure');

    const result = await svc.runDueSchedules(new Date());

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.failRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'rrun_1', errorMessage: 'string failure' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // The 2nd arg (Error) must be a real Error wrapping the non-Error reject.
    expect(logger.error.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('fails the run for an unknown handler_key', async () => {
    const { svc, sched } = makeService(); // registry has no handlers
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'missing' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });

    const result = await svc.runDueSchedules(new Date());

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.failRun).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', runId: 'rrun_1' }));
    expect(sched.failRun.mock.calls[0][0].errorMessage).toMatch(/missing/);
  });

  it('isolates a failing schedule: a throw in one schedule still runs the others', async () => {
    const { svc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([
      schedRow({ id: 's1', handler_key: 'bad' }),
      schedRow({ id: 's2', handler_key: 'good' }),
    ]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValueOnce({ runId: 'r1' }).mockResolvedValueOnce({ runId: 'r2' });
    registry.register(reconcilerStub('bad', jest.fn().mockRejectedValue(new Error('boom'))));
    registry.register(reconcilerStub('good', jest.fn().mockResolvedValue([])));

    const result = await svc.runDueSchedules(new Date());

    expect(result.schedulesRun).toBe(2);
    expect(sched.failRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', errorMessage: 'boom' }));
    expect(sched.completeRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'r2', exceptionsCreated: 0 });
  });

  it('logs and continues (does not throw) when persisting the run status fails', async () => {
    const { svc, sched, registry, logger } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([])));
    sched.completeRun.mockRejectedValue(new Error('db down'));

    await expect(svc.runDueSchedules(new Date())).resolves.toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('fails the run when ingest (existsOpenException) throws mid-loop', async () => {
    const { svc, exc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([disc()])));
    exc.existsOpenException.mockRejectedValue(new Error('db read failed'));

    const result = await svc.runDueSchedules(new Date());

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'rrun_1', errorMessage: 'db read failed' }),
    );
  });

  it('reclaims stale runs (cutoff = now − 2h) before the claim loop, surfacing the count', async () => {
    const { svc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    sched.reclaimStaleRuns.mockResolvedValue(2);
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([])));

    const result = await svc.runDueSchedules(new Date('2026-05-29T05:30:00.000Z'));

    // cutoff is exactly 2h before `now`
    expect(sched.reclaimStaleRuns).toHaveBeenCalledWith(new Date('2026-05-29T03:30:00.000Z'));
    // reclaim runs BEFORE the first claim
    expect(sched.reclaimStaleRuns.mock.invocationCallOrder[0]).toBeLessThan(
      sched.claimDueScheduleAndCreateRun.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 2 });
  });

  it('isolates a reclaim failure: logs it and runs the claim loop unchanged (staleRunsReclaimed=0)', async () => {
    const { svc, sched, registry, logger } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    sched.reclaimStaleRuns.mockRejectedValue(new Error('reclaim db down'));
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([])));

    const result = await svc.runDueSchedules(new Date());

    // Claim loop ran exactly as if reclaim had succeeded; count falls back to 0.
    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(sched.completeRun).toHaveBeenCalledWith({ tenantId: 't1', runId: 'rrun_1', exceptionsCreated: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('reclaim failed'),
      expect.any(Error),
      expect.objectContaining({ errorMessage: 'reclaim db down' }),
    );
  });

  it('stringifies a non-Error reclaim rejection for the isolated log', async () => {
    // Covers the `reclaimErr instanceof Error ? … : new Error(String(reclaimErr))`
    // and `… : String(reclaimErr)` fallback branches in the step-0 catch.
    const { svc, sched, registry, logger } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    sched.reclaimStaleRuns.mockRejectedValue('reclaim string failure');
    registry.register(reconcilerStub('k', jest.fn().mockResolvedValue([])));

    const result = await svc.runDueSchedules(new Date());

    expect(result).toEqual({ schedulesRun: 1, exceptionsCreated: 0, staleRunsReclaimed: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('reclaim failed'),
      expect.any(Error), // non-Error reject wrapped into a real Error
      expect.objectContaining({ errorMessage: 'reclaim string failure' }),
    );
  });

  it('threads schedule.integration_config_id into the reconciler run context', async () => {
    const { svc, sched, registry } = makeService();
    sched.listDueSchedules.mockResolvedValue([schedRow({ handler_key: 'k', integration_config_id: 'cfg_42' })]);
    sched.claimDueScheduleAndCreateRun.mockResolvedValue({ runId: 'rrun_1' });
    const run = jest.fn().mockResolvedValue([]);
    registry.register(reconcilerStub('k', run));

    await svc.runDueSchedules(new Date());

    expect(run).toHaveBeenCalledWith({ tenantId: 't1', integrationConfigId: 'cfg_42' });
  });
});

describe('createSchedule + listSchedules', () => {
  const defaultGet = (key: string): Reconciler => ({ key, run: jest.fn(), validateConfig: jest.fn() });

  function makeService(overrides?: {
    get?: (k: string) => Reconciler;
    createSchedule?: jest.Mock;
    listSchedules?: jest.Mock;
    getScheduleById?: jest.Mock;
    updateSchedule?: jest.Mock;
    deleteSchedule?: jest.Mock;
  }) {
    const scheduleRepo = {
      createSchedule: overrides?.createSchedule ?? jest.fn(async (i) => ({ id: 'rsched_1', ...i, active: true, nextRunAt: 'now', createdAt: 'now', updatedAt: 'now' })),
      listSchedules: overrides?.listSchedules ?? jest.fn(async () => [{ id: 'rsched_1' }]),
      getScheduleById: overrides?.getScheduleById ?? jest.fn(async () => null),
      updateSchedule: overrides?.updateSchedule ?? jest.fn(async () => ({ id: 's1' })),
      deleteSchedule: overrides?.deleteSchedule ?? jest.fn(async () => undefined),
    };
    const registry = { get: overrides?.get ?? defaultGet };
    const service = new ReconciliationCenterService(
      {} as never,
      scheduleRepo as never,
      registry as never,
      { error: jest.fn() } as never,
    );
    return { service, scheduleRepo, registry };
  }

  it('createSchedule delegates to the repo when the handler is registered', async () => {
    const { service, scheduleRepo } = makeService();
    const view = await service.createSchedule({
      tenantId: 't1', name: 'nightly', cadence: 'daily',
      handlerKey: 'netsuite_business_central_invoice_reconciliation', integrationConfigId: 'cfg',
    });
    expect(view.id).toBe('rsched_1');
    expect(scheduleRepo.createSchedule).toHaveBeenCalledTimes(1);
  });

  it('createSchedule throws UnknownReconcilerError for an unregistered handler (and does not write)', async () => {
    const { service, scheduleRepo } = makeService({ get: () => { throw new UnknownReconcilerError('nope'); } });
    await expect(service.createSchedule({
      tenantId: 't1', name: 'x', cadence: 'daily', handlerKey: 'nope', integrationConfigId: 'cfg',
    })).rejects.toBeInstanceOf(UnknownReconcilerError);
    expect(scheduleRepo.createSchedule).not.toHaveBeenCalled();
  });

  it('validates config before persisting and does not insert on failure', async () => {
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig: jest.fn(() => { throw new ReconcilerConfigError('config_not_found'); }) }),
    });
    await expect(service.createSchedule({
      tenantId: 't1', name: 'x', cadence: 'daily', handlerKey: 'k', integrationConfigId: 'bad_cfg',
    })).rejects.toBeInstanceOf(ReconcilerConfigError);
    expect(scheduleRepo.createSchedule).not.toHaveBeenCalled();
  });

  it('listSchedules delegates to the repo', async () => {
    const { service, scheduleRepo } = makeService();
    const list = await service.listSchedules('t1');
    expect(list).toHaveLength(1);
    expect(scheduleRepo.listSchedules).toHaveBeenCalledWith('t1');
  });

  it('updateSchedule revalidates config when integrationConfigId changes', async () => {
    const validateConfig = jest.fn();
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: 'cfg_a' } as unknown as ReconciliationScheduleView)),
      updateSchedule: jest.fn(async () => ({ id: 's1' } as unknown as ReconciliationScheduleView)),
    });
    await service.updateSchedule('t1', 's1', { integrationConfigId: 'cfg_b' });
    expect(validateConfig).toHaveBeenCalledWith({ tenantId: 't1', integrationConfigId: 'cfg_b' });
    expect(scheduleRepo.updateSchedule).toHaveBeenCalled();
  });

  it('updateSchedule does NOT revalidate when integrationConfigId is unchanged/absent', async () => {
    const validateConfig = jest.fn();
    const { service } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: 'cfg_a' } as unknown as ReconciliationScheduleView)),
      updateSchedule: jest.fn(async () => ({ id: 's1' } as unknown as ReconciliationScheduleView)),
    });
    await service.updateSchedule('t1', 's1', { name: 'x' });
    expect(validateConfig).not.toHaveBeenCalled();
  });

  it('updateSchedule does NOT revalidate when integrationConfigId equals the existing value', async () => {
    const validateConfig = jest.fn();
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: 'cfg_a' } as unknown as ReconciliationScheduleView)),
      updateSchedule: jest.fn(async () => ({ id: 's1' } as unknown as ReconciliationScheduleView)),
    });
    await service.updateSchedule('t1', 's1', { integrationConfigId: 'cfg_a' }); // same value
    expect(validateConfig).not.toHaveBeenCalled();
    expect(scheduleRepo.updateSchedule).toHaveBeenCalled();
  });

  it('updateSchedule revalidates the EXISTING config when activating (active:true) even if the config is unchanged', async () => {
    // "active implies a valid config" — re-enabling a row must prove the config is valid.
    const validateConfig = jest.fn();
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: 'cfg_a' } as unknown as ReconciliationScheduleView)),
      updateSchedule: jest.fn(async () => ({ id: 's1' } as unknown as ReconciliationScheduleView)),
    });
    await service.updateSchedule('t1', 's1', { active: true });
    expect(validateConfig).toHaveBeenCalledWith({ tenantId: 't1', integrationConfigId: 'cfg_a' });
    expect(scheduleRepo.updateSchedule).toHaveBeenCalled();
  });

  it('updateSchedule rejects re-activating a sentinel/invalid-config schedule and does not persist', async () => {
    // The migration-056 sentinel row (__unconfigured__, deactivated) cannot be flipped
    // back to active without a real config — validateConfig throws config_not_found.
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig: jest.fn(() => { throw new ReconcilerConfigError('config_not_found'); }) }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: '__unconfigured__' } as unknown as ReconciliationScheduleView)),
    });
    await expect(service.updateSchedule('t1', 's1', { active: true })).rejects.toBeInstanceOf(ReconcilerConfigError);
    expect(scheduleRepo.updateSchedule).not.toHaveBeenCalled();
  });

  it('updateSchedule does NOT revalidate when deactivating (active:false)', async () => {
    const validateConfig = jest.fn();
    const { service, scheduleRepo } = makeService({
      get: (key) => ({ key, run: jest.fn(), validateConfig }),
      getScheduleById: jest.fn(async () => ({ id: 's1', handlerKey: 'h', integrationConfigId: 'cfg_a' } as unknown as ReconciliationScheduleView)),
      updateSchedule: jest.fn(async () => ({ id: 's1' } as unknown as ReconciliationScheduleView)),
    });
    await service.updateSchedule('t1', 's1', { active: false });
    expect(validateConfig).not.toHaveBeenCalled();
    expect(scheduleRepo.updateSchedule).toHaveBeenCalled();
  });

  it('updateSchedule throws NotFound when the schedule is absent', async () => {
    const { service } = makeService({ getScheduleById: jest.fn(async () => null) });
    await expect(service.updateSchedule('t1', 'missing', { active: false })).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
  });

  it('deleteSchedule delegates to the repo', async () => {
    const { service, scheduleRepo } = makeService({ deleteSchedule: jest.fn(async () => undefined) });
    await service.deleteSchedule('t1', 's1');
    expect(scheduleRepo.deleteSchedule).toHaveBeenCalledWith('t1', 's1');
  });

  it('deleteSchedule propagates ReconciliationScheduleNotFoundError from the repo', async () => {
    const { service } = makeService({
      deleteSchedule: jest.fn(async () => { throw new ReconciliationScheduleNotFoundError('t1', 's1'); }),
    });
    await expect(service.deleteSchedule('t1', 's1')).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
  });
});
