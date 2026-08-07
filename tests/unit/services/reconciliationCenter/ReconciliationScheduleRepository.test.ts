import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { ReconciliationScheduleRepository, STALE_RUN_RECLAIM_MESSAGE, ReconciliationScheduleNotFoundError, toIsoString, rowCount } from '../../../../src/services/reconciliationCenter/ReconciliationScheduleRepository';

// better-sqlite3 rejects boolean binds; replicate DatabaseService's RECURSIVE
// boolean->1/0 patch (Kysely may pass bind params as an array, so a shallow
// top-level map is not enough) so `active: true` inserts/queries work against
// the raw test connection. Mirrors convertBooleansDeep in DatabaseService.ts.
function patchSqliteBooleans(sqlite: BetterSqlite3.Database): void {
  const isPlainObject = (v: unknown): boolean => Object.prototype.toString.call(v) === '[object Object]';
  const convert = (value: unknown): unknown => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(convert);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Date) return value.toISOString();
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = convert(v);
      return out;
    }
    return value;
  };
  const originalPrepare = sqlite.prepare.bind(sqlite);
  (sqlite as unknown as { prepare: (s: string) => unknown }).prepare = (source: string) => {
    const stmt = originalPrepare(source) as Record<string, unknown>;
    for (const name of ['run', 'get', 'all', 'iterate', 'bind']) {
      const method = stmt[name];
      if (typeof method === 'function') {
        const original = (method as (...a: unknown[]) => unknown).bind(stmt);
        stmt[name] = (...args: unknown[]) => original(...args.map(convert));
      }
    }
    return stmt;
  };
}

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  patchSqliteBooleans(sqlite);
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

function makeRepo(db: Kysely<Database>): ReconciliationScheduleRepository {
  return new ReconciliationScheduleRepository({ getDatabase: () => db } as never);
}

async function seedSchedule(
  db: Kysely<Database>,
  over: Partial<{
    id: string;
    tenantId: string;
    active: boolean;
    nextRunAt: string;
    cadence: 'hourly' | 'daily' | 'weekly';
    integrationConfigId: string;
  }> = {},
): Promise<void> {
  await db
    .insertInto('reconciliation_schedules')
    .values({
      id: over.id ?? 'sch_1',
      tenant_id: over.tenantId ?? 't1',
      name: 'nightly',
      cadence: over.cadence ?? 'hourly',
      active: over.active ?? true,
      next_run_at: over.nextRunAt ?? '2026-05-29T00:00:00.000Z',
      handler_key: 'netsuite_business_central_invoice_reconciliation',
      integration_config_id: over.integrationConfigId ?? 'cfg_seed',
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z',
    })
    .execute();
}

async function seedRun(
  db: Kysely<Database>,
  over: Partial<{
    id: string;
    tenantId: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
  }> = {},
): Promise<void> {
  await db
    .insertInto('reconciliation_runs')
    .values({
      id: over.id ?? 'rrun_1',
      tenant_id: over.tenantId ?? 't1',
      // reclaimStaleRuns has no use for a valid schedule reference; null keeps the
      // helper self-contained (no seedSchedule prerequisite) and FK-safe if a
      // future migration adds a reconciliation_runs.schedule_id foreign key.
      schedule_id: null,
      status: over.status ?? 'running',
      started_at: over.startedAt ?? '2026-05-29T00:00:00.000Z',
      completed_at: null,
      exceptions_created: 0,
      error_message: null,
    })
    .execute();
}

describe('ReconciliationScheduleRepository', () => {
  let db: Kysely<Database>;
  let repo: ReconciliationScheduleRepository;
  const NOW = new Date('2026-05-29T05:30:00.000Z');

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = makeRepo(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('listDueSchedules returns active rows due at or before now', async () => {
    await seedSchedule(db, { id: 'due', nextRunAt: '2026-05-29T00:00:00.000Z' });
    await seedSchedule(db, { id: 'future', nextRunAt: '2026-05-29T23:00:00.000Z' });
    await seedSchedule(db, { id: 'inactive', active: false, nextRunAt: '2026-05-29T00:00:00.000Z' });
    const due = await repo.listDueSchedules(NOW);
    expect(due.map(s => s.id)).toEqual(['due']);
  });

  it('claimDueScheduleAndCreateRun advances next_run_at and inserts a running run row', async () => {
    await seedSchedule(db, { id: 'sch_1', nextRunAt: '2026-05-29T00:00:00.000Z', cadence: 'hourly' });
    const claim = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: '2026-05-29T00:00:00.000Z',
      now: NOW,
      cadence: 'hourly',
    });
    expect(claim).not.toBeNull();
    const sched = await db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('id', '=', 'sch_1')
      .executeTakeFirstOrThrow();
    expect(sched.next_run_at).toBe('2026-05-29T06:00:00.000Z'); // next future hourly boundary
    const run = await db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', claim!.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({ tenant_id: 't1', schedule_id: 'sch_1', status: 'running' });
  });

  it('claims correctly when expectedNextRunAt is a Date (Postgres TIMESTAMPTZ reads return Date objects)', async () => {
    // After migration 053, next_run_at is TIMESTAMPTZ; node-postgres parses it
    // into a Date. listDueSchedules then hands a Date (not a string) back into
    // the claim. The claim must normalize it to the same UTC ISO string the row
    // stores so the optimistic-concurrency equality still matches.
    await seedSchedule(db, { id: 'sch_1', nextRunAt: '2026-05-29T00:00:00.000Z', cadence: 'hourly' });
    const claim = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: new Date('2026-05-29T00:00:00.000Z'),
      now: NOW,
      cadence: 'hourly',
    });
    expect(claim).not.toBeNull();
    const sched = await db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('id', '=', 'sch_1')
      .executeTakeFirstOrThrow();
    expect(sched.next_run_at).toBe('2026-05-29T06:00:00.000Z');
  });

  it('a second claim with the same expectedNextRunAt returns null (concurrency guard)', async () => {
    await seedSchedule(db, { id: 'sch_1', nextRunAt: '2026-05-29T00:00:00.000Z' });
    const first = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: '2026-05-29T00:00:00.000Z',
      now: NOW,
      cadence: 'hourly',
    });
    const second = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: '2026-05-29T00:00:00.000Z',
      now: NOW,
      cadence: 'hourly',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const runs = await db.selectFrom('reconciliation_runs').selectAll().execute();
    expect(runs).toHaveLength(1); // losing claim wrote no run row
  });

  it('completeRun is tenant-scoped — cannot complete another tenant run by id', async () => {
    await seedSchedule(db, { id: 'sch_1', nextRunAt: '2026-05-29T00:00:00.000Z' });
    const claim = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: '2026-05-29T00:00:00.000Z',
      now: NOW,
      cadence: 'hourly',
    });
    await repo.completeRun({ tenantId: 't_other', runId: claim!.runId, exceptionsCreated: 3 }); // wrong tenant
    const run = await db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', claim!.runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('running'); // untouched
    await repo.completeRun({ tenantId: 't1', runId: claim!.runId, exceptionsCreated: 3 }); // correct tenant
    const run2 = await db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', claim!.runId)
      .executeTakeFirstOrThrow();
    expect(run2).toMatchObject({ status: 'completed', exceptions_created: 3 });
    expect(run2.completed_at).not.toBeNull();
  });

  it('failRun stamps failed status + error message', async () => {
    await seedSchedule(db, { id: 'sch_1', nextRunAt: '2026-05-29T00:00:00.000Z' });
    const claim = await repo.claimDueScheduleAndCreateRun({
      tenantId: 't1',
      scheduleId: 'sch_1',
      expectedNextRunAt: '2026-05-29T00:00:00.000Z',
      now: NOW,
      cadence: 'hourly',
    });
    await repo.failRun({ tenantId: 't1', runId: claim!.runId, errorMessage: 'boom' });
    const run = await db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', claim!.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({ status: 'failed', error_message: 'boom' });
  });
});

describe('ReconciliationScheduleRepository.reclaimStaleRuns', () => {
  let db: Kysely<Database>;
  let repo: ReconciliationScheduleRepository;
  const CUTOFF = new Date('2026-05-29T05:00:00.000Z');

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = makeRepo(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const fetchRun = (id: string) =>
    db.selectFrom('reconciliation_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('marks a running row older than cutoff as failed with the stable message + completed_at', async () => {
    await seedRun(db, { id: 'stale', status: 'running', startedAt: '2026-05-29T00:00:00.000Z' });
    const n = await repo.reclaimStaleRuns(CUTOFF);
    expect(n).toBe(1);
    const row = await fetchRun('stale');
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe(STALE_RUN_RECLAIM_MESSAGE);
    expect(row.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('does NOT reclaim a row whose started_at equals cutoff exactly (strict <)', async () => {
    await seedRun(db, { id: 'boundary', status: 'running', startedAt: CUTOFF.toISOString() });
    const n = await repo.reclaimStaleRuns(CUTOFF);
    expect(n).toBe(0);
    expect((await fetchRun('boundary')).status).toBe('running');
  });

  it('leaves a fresh running row (started_at after cutoff) untouched', async () => {
    await seedRun(db, { id: 'fresh', status: 'running', startedAt: '2026-05-29T05:30:00.000Z' });
    expect(await repo.reclaimStaleRuns(CUTOFF)).toBe(0);
    expect((await fetchRun('fresh')).status).toBe('running');
  });

  it('leaves already-terminal completed/failed rows untouched', async () => {
    await seedRun(db, { id: 'done', status: 'completed', startedAt: '2026-05-29T00:00:00.000Z' });
    await seedRun(db, { id: 'gone', status: 'failed', startedAt: '2026-05-29T00:00:00.000Z' });
    expect(await repo.reclaimStaleRuns(CUTOFF)).toBe(0);
    expect((await fetchRun('done')).status).toBe('completed');
    expect((await fetchRun('gone')).status).toBe('failed');
  });

  it('is idempotent — a second sweep over the same cutoff reclaims nothing', async () => {
    await seedRun(db, { id: 'stale', status: 'running', startedAt: '2026-05-29T00:00:00.000Z' });
    expect(await repo.reclaimStaleRuns(CUTOFF)).toBe(1);
    expect(await repo.reclaimStaleRuns(CUTOFF)).toBe(0);
  });

  it('reclaims stale running rows across multiple tenants in one sweep (no tenant filter)', async () => {
    await seedRun(db, { id: 't1run', tenantId: 't1', status: 'running', startedAt: '2026-05-29T00:00:00.000Z' });
    await seedRun(db, { id: 't2run', tenantId: 't2', status: 'running', startedAt: '2026-05-29T00:00:00.000Z' });
    expect(await repo.reclaimStaleRuns(CUTOFF)).toBe(2);
  });

  it('reclaims a run that was fresh at start once enough time elapses (in-flight crosses TTL residual)', async () => {
    // Accepted residual, pinned executably: a legitimately long-running job that
    // exceeds the TTL while still in flight IS reclaimed. Seed fresh at T0, then
    // sweep with a cutoff representing time advanced past T0 + TTL.
    const T0 = '2026-05-29T01:00:00.000Z';
    await seedRun(db, { id: 'longrun', status: 'running', startedAt: T0 });
    const cutoffAfterTtl = new Date('2026-05-29T03:30:00.000Z'); // T0 + 2.5h (> 2h TTL)
    expect(await repo.reclaimStaleRuns(cutoffAfterTtl)).toBe(1);
    expect((await fetchRun('longrun')).status).toBe('failed');
  });

  it('normalizes a driver that returns undefined numUpdatedRows to 0 (the ?? 0n fallback)', async () => {
    // SQLite/PG always populate numUpdatedRows; the `?? 0n` guards drivers that
    // don't. Exercise it with a minimal chainable fake db so the defensive
    // fallback is covered without departing from real-DB tests for the behaviour.
    const chain = {
      set: () => chain,
      where: () => chain,
      executeTakeFirst: async () => ({ numUpdatedRows: undefined }),
    };
    const fakeDb = { updateTable: () => chain };
    const repoWithFakeDb = new ReconciliationScheduleRepository({ getDatabase: () => fakeDb } as never);
    expect(await repoWithFakeDb.reclaimStaleRuns(CUTOFF)).toBe(0);
  });
});

describe('createSchedule + listSchedules', () => {
  it('createSchedule persists every column and returns the camelCased view', async () => {
    const db = makeDb();
    await runAll(db);
    const repo = makeRepo(db);

    const view = await repo.createSchedule({
      tenantId: 't1',
      name: 'nightly NS<->BC',
      cadence: 'daily',
      handlerKey: 'netsuite_business_central_invoice_reconciliation',
      integrationConfigId: 'cfg_ns_bc',
    });

    expect(view.id).toMatch(/^rsched_/);
    expect(view.tenantId).toBe('t1');
    expect(view.name).toBe('nightly NS<->BC');
    expect(view.cadence).toBe('daily');
    expect(view.handlerKey).toBe('netsuite_business_central_invoice_reconciliation');
    expect(view.integrationConfigId).toBe('cfg_ns_bc');
    expect(view.active).toBe(true);
    expect(typeof view.nextRunAt).toBe('string');
    expect(view.nextRunAt.length).toBeGreaterThan(0);

    const row = await db.selectFrom('reconciliation_schedules').selectAll().where('id', '=', view.id).executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe('t1');
    expect(row.handler_key).toBe('netsuite_business_central_invoice_reconciliation');
    expect(row.integration_config_id).toBe('cfg_ns_bc');
  });

  it('listSchedules returns only the calling tenant rows', async () => {
    const db = makeDb();
    await runAll(db);
    const repo = makeRepo(db);
    await seedSchedule(db, { id: 's_a', tenantId: 't1' });
    await seedSchedule(db, { id: 's_b', tenantId: 't2' });

    const list = await repo.listSchedules('t1');

    expect(list.map((s) => s.id)).toEqual(['s_a']);
    expect(list[0].tenantId).toBe('t1');
  });
});

describe('updateSchedule + deleteSchedule + getScheduleById', () => {
  it('getScheduleById returns the tenant row or null', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    expect((await repo.getScheduleById('t1', created.id))?.id).toBe(created.id);
    expect(await repo.getScheduleById('t1', 'missing')).toBeNull();
    expect(await repo.getScheduleById('t2', created.id)).toBeNull(); // tenant isolation
  });

  it('updateSchedule patches provided columns, scopes by tenant, bumps updated_at', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    const updated = await repo.updateSchedule('t1', created.id, { name: 'renamed', cadence: 'weekly', active: false, integrationConfigId: 'cfg_b' });
    expect(updated).toMatchObject({ name: 'renamed', cadence: 'weekly', active: false, integrationConfigId: 'cfg_b' });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('updateSchedule leaves unpatched columns unchanged (partial patch)', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'orig', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    const updated = await repo.updateSchedule('t1', created.id, { name: 'only-name' });
    expect(updated.name).toBe('only-name');
    // untouched fields retain their original values
    expect(updated.cadence).toBe('daily');
    expect(updated.active).toBe(created.active);
    expect(updated.integrationConfigId).toBe('cfg_a');
    expect(updated.handlerKey).toBe('h');
  });

  it('updateSchedule throws ReconciliationScheduleNotFoundError for an unknown/cross-tenant id', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    await expect(repo.updateSchedule('t1', 'missing', { active: false })).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
    await expect(repo.updateSchedule('t2', created.id, { active: false })).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
  });

  it('updateSchedule throws NotFound if the row vanishes between update and re-read (defensive)', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    jest.spyOn(repo, 'getScheduleById').mockResolvedValueOnce(null);
    await expect(repo.updateSchedule('t1', created.id, { name: 'x' })).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
  });

  it('deleteSchedule removes the tenant row and leaves reconciliation_runs untouched', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    // Seed the surviving run with the deleted schedule's id — this is the scenario
    // the FK-less design actually targets: historical run rows must outlive their
    // parent schedule and keep their schedule_id reference intact (not cascaded/nulled).
    await db.insertInto('reconciliation_runs').values({
      id: 'rrun_keep',
      tenant_id: 't1',
      schedule_id: created.id,
      status: 'completed',
      started_at: '2026-05-29T00:00:00.000Z',
      completed_at: '2026-05-29T00:01:00.000Z',
      exceptions_created: 0,
      error_message: null,
    }).execute();
    await repo.deleteSchedule('t1', created.id);
    expect(await repo.getScheduleById('t1', created.id)).toBeNull();
    const runs = await db.selectFrom('reconciliation_runs').selectAll().where('id', '=', 'rrun_keep').execute();
    expect(runs).toHaveLength(1);
    expect(runs[0].schedule_id).toBe(created.id);
  });

  it('deleteSchedule throws NotFound for unknown/cross-tenant id', async () => {
    const db = makeDb(); await runAll(db); const repo = makeRepo(db);
    const created = await repo.createSchedule({ tenantId: 't1', name: 'n', cadence: 'daily', handlerKey: 'h', integrationConfigId: 'cfg_a' });
    await expect(repo.deleteSchedule('t1', 'missing')).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
    await expect(repo.deleteSchedule('t2', created.id)).rejects.toBeInstanceOf(ReconciliationScheduleNotFoundError);
  });
});

describe('toIsoString (Postgres Date-column normalization)', () => {
  it('passes an ISO string through unchanged (SQLite path)', () => {
    expect(toIsoString('2026-05-30T00:00:00.000Z')).toBe('2026-05-30T00:00:00.000Z');
  });

  it('converts a Date to an ISO string (Postgres node-postgres path)', () => {
    expect(toIsoString(new Date('2026-05-30T12:34:56.000Z'))).toBe('2026-05-30T12:34:56.000Z');
  });
});

describe('rowCount', () => {
  it('normalizes bigint and undefined', () => {
    expect(rowCount(3n)).toBe(3);
    expect(rowCount(undefined)).toBe(0);
  });
});
