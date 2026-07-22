import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { sql, type Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database, ReconciliationScheduleRow } from '../../database/types';
import { computeNextRunAt, type ReconciliationCadence } from './cadence';
import type {
  NewReconciliationScheduleInput,
  ReconciliationScheduleView,
  UpdateReconciliationScheduleInput,
} from './ReconciliationCenterTypes';

/**
 * Stable operator/audit contract string written to a reclaimed stale run's
 * error_message. Defined ONCE here and referenced by both the implementation and
 * the tests so the contract cannot drift accidentally. The `[stale-run-reclaim]`
 * prefix lets operators distinguish sweep-reclaimed rows from reconciler-errored
 * failures.
 */
export const STALE_RUN_RECLAIM_MESSAGE =
  '[stale-run-reclaim] run exceeded max duration; marked failed by sweep';

/** Thrown when an update/delete targets a schedule id that does not exist for the tenant. */
export class ReconciliationScheduleNotFoundError extends Error {
  readonly tenantId: string;
  readonly scheduleId: string;
  constructor(tenantId: string, scheduleId: string) {
    super(`reconciliation schedule not found: tenantId=${tenantId} id=${scheduleId}`);
    this.name = 'ReconciliationScheduleNotFoundError';
    this.tenantId = tenantId;
    this.scheduleId = scheduleId;
  }
}

export interface ClaimScheduleInput {
  tenantId: string;
  scheduleId: string;
  /**
   * The next_run_at value read in listDueSchedules — the optimistic-concurrency
   * guard. Typed `string | Date` because Postgres TIMESTAMP reads can arrive as
   * Date; passed UNCHANGED into the WHERE clause (so it matches the stored
   * representation) and into computeNextRunAt (which normalizes it).
   */
  expectedNextRunAt: string | Date;
  now: Date;
  cadence: ReconciliationCadence;
}

export interface RunLifecycleInput {
  tenantId: string;
  runId: string;
}

@injectable()
export class ReconciliationScheduleRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) dbService: DatabaseService) {
    this.db = dbService.getDatabase();
  }

  /** Candidate read — active schedules due at or before `now`. The atomic claim reserves them. */
  listDueSchedules(now: Date): Promise<ReconciliationScheduleRow[]> {
    return this.db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('active', '=', true)
      .where('next_run_at', '<=', now.toISOString())
      .orderBy('next_run_at', 'asc')
      .execute();
  }

  /**
   * Atomically reserve a due schedule (multi-replica safe — AGENTS.md Tier-B
   * rule). Advances next_run_at (drift-free) AND inserts the running run row in
   * one transaction, guarded by `next_run_at = expectedNextRunAt`. Returns the
   * run id if this replica won, or null if another replica already advanced it.
   */
  async claimDueScheduleAndCreateRun(input: ClaimScheduleInput): Promise<{ runId: string } | null> {
    const { tenantId, scheduleId, expectedNextRunAt, now, cadence } = input;
    const nowIso = now.toISOString();
    const driftFreeNext = computeNextRunAt(expectedNextRunAt, nowIso, cadence);
    // Normalize to string for the WHERE clause — Postgres TIMESTAMP reads
    // arrive as Date; SQLite always returns strings. Either way we compare
    // against the stored ISO string.
    const expectedStr = typeof expectedNextRunAt === 'string' ? expectedNextRunAt : expectedNextRunAt.toISOString();

    return this.db.transaction().execute(async trx => {
      const updated = await trx
        .updateTable('reconciliation_schedules')
        .set({ next_run_at: driftFreeNext, updated_at: nowIso })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', scheduleId)
        .where('active', '=', true)
        // Optimistic-concurrency guard: only the replica whose expectedNextRunAt
        // still matches the stored value wins. The redundant `<= now` below keeps
        // the claim correct even if a stale (already-future) candidate is passed.
        .where('next_run_at', '=', expectedStr)
        .where('next_run_at', '<=', nowIso)
        .executeTakeFirst();

      // numUpdatedRows is bigint in Kysely but varies by driver; normalize.
      if (rowCount(updated.numUpdatedRows) === 0) {
        return null; // another replica claimed it, or it is no longer due
      }

      const runId = `rrun_${randomUUID()}`;
      await trx
        .insertInto('reconciliation_runs')
        .values({
          id: runId,
          tenant_id: tenantId,
          schedule_id: scheduleId,
          status: 'running',
          started_at: nowIso,
          completed_at: null,
          exceptions_created: 0,
          error_message: null,
        })
        .execute();
      return { runId };
    });
  }

  async completeRun(input: RunLifecycleInput & { exceptionsCreated: number }): Promise<void> {
    await this.db
      .updateTable('reconciliation_runs')
      .set({ status: 'completed', completed_at: new Date().toISOString(), exceptions_created: input.exceptionsCreated })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.runId)
      .execute();
  }

  async failRun(input: RunLifecycleInput & { errorMessage: string }): Promise<void> {
    await this.db
      .updateTable('reconciliation_runs')
      .set({ status: 'failed', completed_at: new Date().toISOString(), error_message: input.errorMessage })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.runId)
      .execute();
  }

  /**
   * Reclaim orphaned `running` run rows. The atomic claim advances next_run_at
   * BEFORE connector work, so a process crash (or a DB failure on
   * completeRun/failRun) between claim and completion leaves a `running` row that
   * nothing revisits — the schedule already moved on. This marks every `running`
   * row older than `cutoff` as `failed` with the stable STALE_RUN_RECLAIM_MESSAGE.
   *
   * Cross-tenant by design (infra hygiene, not a tenant-facing read): one sweep
   * reclaims orphans across all tenants — no tenant_id filter. Atomic + idempotent
   * — a concurrent replica's identical UPDATE matches zero already-flipped rows.
   * The `started_at < cutoff` age threshold guarantees a freshly-started run on
   * another replica is never reaped; strict `<` means a row exactly at `cutoff` is
   * NOT reclaimed. Returns the number of rows reclaimed.
   *
   * The `status = 'running'` predicate is emitted as a SQL LITERAL (`sql.lit`),
   * not a bound parameter. This is deliberate: the supporting index (migration
   * 054) is a PARTIAL index `... WHERE status = 'running'`, and a query planner
   * can only use a partial index when it can prove the query's predicate implies
   * the index's predicate. A bound `status = ?` defeats that proof on a Postgres
   * generic plan (the value isn't known at plan time), so the sweep would fall
   * back to a full scan. A literal `status = 'running'` matches the partial
   * predicate exactly under any plan type on both Postgres and SQLite. `started_at`
   * stays a bound parameter (a range on it is index-usable regardless). The
   * literal is a fixed source constant — no injection surface. Index usage is
   * pinned by the EXPLAIN QUERY PLAN test in migration 054's suite.
   */
  async reclaimStaleRuns(cutoff: Date): Promise<number> {
    // Single captured timestamp for completed_at — no clock-drift seam between
    // value generation and the row write.
    const nowIso = new Date().toISOString();
    const result = await this.db
      .updateTable('reconciliation_runs')
      .set({ status: 'failed', completed_at: nowIso, error_message: STALE_RUN_RECLAIM_MESSAGE })
      .where('status', '=', sql.lit('running'))
      .where('started_at', '<', cutoff.toISOString())
      .executeTakeFirst();
    // numUpdatedRows is bigint in Kysely but varies by driver; normalize.
    return rowCount(result.numUpdatedRows);
  }

  /**
   * Create an operator-defined schedule. Sets active=true and next_run_at=now so
   * the next scheduler tick picks it up. integration_config_id is required at the
   * API boundary (the route rejects empty), though the column stays nullable for
   * legacy directly-seeded rows. Returns the created row as a camelCased view.
   */
  async createSchedule(input: NewReconciliationScheduleInput): Promise<ReconciliationScheduleView> {
    const id = `rsched_${randomUUID()}`;
    const nowIso = new Date().toISOString();
    await this.db
      .insertInto('reconciliation_schedules')
      .values({
        id,
        tenant_id: input.tenantId,
        name: input.name,
        cadence: input.cadence,
        handler_key: input.handlerKey,
        active: true,
        next_run_at: nowIso,
        integration_config_id: input.integrationConfigId,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute();
    const row = await this.db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toScheduleView(row);
  }

  /** Tenant-scoped list of all schedules (newest first). */
  async listSchedules(tenantId: string): Promise<ReconciliationScheduleView[]> {
    const rows = await this.db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toScheduleView);
  }

  /** Tenant-scoped single-row fetch as a camelCased view, or null if absent. */
  async getScheduleById(tenantId: string, id: string): Promise<ReconciliationScheduleView | null> {
    const row = await this.db
      .selectFrom('reconciliation_schedules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toScheduleView(row) : null;
  }

  /**
   * Tenant-scoped partial update. Only provided fields change; updated_at is always
   * bumped. Throws ReconciliationScheduleNotFoundError if no row matched (unknown or
   * cross-tenant id). Returns the updated camelCased view.
   *
   * Note: this method does NOT recompute `next_run_at` when `cadence` changes —
   * `next_run_at` is left unchanged, so a cadence change first takes effect at the
   * already-scheduled time and advances by the new cadence thereafter. Recomputing
   * on cadence change is a deferred service-layer policy decision.
   */
  async updateSchedule(tenantId: string, id: string, patch: UpdateReconciliationScheduleInput): Promise<ReconciliationScheduleView> {
    const fields: Partial<{
      name: string;
      cadence: ReconciliationCadence;
      active: boolean;
      integration_config_id: string;
    }> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.cadence !== undefined) fields.cadence = patch.cadence;
    if (patch.active !== undefined) fields.active = patch.active;
    if (patch.integrationConfigId !== undefined) fields.integration_config_id = patch.integrationConfigId;

    const result = await this.db
      .updateTable('reconciliation_schedules')
      .set({ ...fields, updated_at: new Date().toISOString() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();

    if (rowCount(result.numUpdatedRows) === 0) {
      throw new ReconciliationScheduleNotFoundError(tenantId, id);
    }
    const updated = await this.getScheduleById(tenantId, id);
    if (!updated) throw new ReconciliationScheduleNotFoundError(tenantId, id);
    return updated;
  }

  /**
   * Tenant-scoped hard delete. reconciliation_runs.schedule_id is nullable and
   * FK-less (migration 048), so historical run rows are intentionally left intact.
   * Throws ReconciliationScheduleNotFoundError if no row matched.
   */
  async deleteSchedule(tenantId: string, id: string): Promise<void> {
    const result = await this.db
      .deleteFrom('reconciliation_schedules')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (rowCount(result.numDeletedRows) === 0) {
      throw new ReconciliationScheduleNotFoundError(tenantId, id);
    }
  }
}

/**
 * Postgres TIMESTAMP/TIMESTAMPTZ columns can arrive as `Date` objects via
 * node-postgres (migrations 048/053 note this for `next_run_at`), while SQLite
 * returns ISO strings. The columns are typed `string` in `database/types`, so
 * cast through `string | Date` and normalize to a string here — otherwise the
 * all-string `ReconciliationScheduleView` contract would be violated at runtime
 * on Postgres. Mirrors the `string | Date` handling in `cadence.ts`.
 */
export function toIsoString(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/** Normalize a Kysely affected-row count (bigint, or undefined on some drivers) to a number. */
export function rowCount(n: bigint | undefined): number {
  return Number(n ?? 0n);
}

function toScheduleView(row: ReconciliationScheduleRow): ReconciliationScheduleView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    cadence: row.cadence,
    handlerKey: row.handler_key,
    // SQLite stores active as 0/1; coerce to boolean at the read boundary.
    active: Boolean(row.active),
    nextRunAt: toIsoString(row.next_run_at as string | Date),
    integrationConfigId: row.integration_config_id,
    createdAt: toIsoString(row.created_at as string | Date),
    updatedAt: toIsoString(row.updated_at as string | Date),
  };
}
