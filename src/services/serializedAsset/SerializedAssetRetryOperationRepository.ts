import { injectable, inject } from 'inversify';
import type { Selectable } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { SerializedAssetRetryOperationsTable } from '../../database/types';

/**
 * Durable state for the forced serialized-asset retry (A9, migration 063).
 *
 * The operation used to live entirely inside an HTTP request. This repository
 * is the persistence half of moving it off that path: a reservation that
 * survives a restart, a lease that keeps one worker at a time from CLAIMING
 * it, and a fencing token so a worker whose lease lapsed cannot publish a
 * result over its successor's.
 *
 * BE PRECISE ABOUT THE GUARANTEE (Codex round 7). An earlier version of this
 * sentence said the lease means "exactly one worker RUNS it". It does not. If
 * a lease lapses while its holder is still executing — wedged on a connector
 * call, or simply slow — a successor claims the row and both are running the
 * drain at once. What the fencing token buys is that the stale holder cannot
 * write a terminal result over its successor's; it cannot stop the duplicate
 * work itself.
 *
 * What absorbs the duplicate work is convergence of the BUSINESS-UNIT effects,
 * and only those: Salesforce writes are External-ID upserts, and deferred
 * bookkeeping is CAS per A7. Be precise about the limit (Codex round 8) — the
 * drain is NOT convergent in every write it performs. `setNextOffset` on the
 * sweep cursor is select-then-update with no monotonic or CAS guard, so
 * overlapping runs can overwrite each other's cursor state, and quarantine
 * audit writes are append-style and can duplicate. Those are the known costs
 * of a concurrent drain; they are tolerable because a cursor is re-derivable
 * and duplicate audit rows are additive, but they are real and they are not
 * "convergent".
 *
 * There is deliberately NO leader election and no queue framework here. Every
 * transition is a single conditional UPDATE whose predicate carries the whole
 * claim — the database is the only coordinator, exactly as in A7's
 * `touchAttempt` and A8's approval CAS.
 */

/** How long a claim is valid before another worker may take it over. */
export const SERIALIZED_ASSET_RETRY_LEASE_MS = 5 * 60_000;
/** How often the running worker must extend its lease. */
export const SERIALIZED_ASSET_RETRY_HEARTBEAT_MS = 30_000;
/** How often the job looks for claimable work. */
export const SERIALIZED_ASSET_RETRY_POLL_MS = 5_000;

/** Insert attempts a reservation may make; see `reserve`. */
const RESERVE_ATTEMPTS = 2;

/** Fixed text for a reservation that could not converge. Carries no data. */
export const SERIALIZED_ASSET_RETRY_NO_CONVERGENCE =
  'serialized-asset forced retry reservation did not converge';

/**
 * `claimObserved` was handed a snapshot that was not claimable when observed.
 * That is a caller programming error, not a race — the races are what the CAS
 * predicate handles, and those return null rather than throwing. Fixed text.
 */
export const SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT =
  'serialized-asset forced retry claim was given a snapshot that was not claimable';

export type RetryOperationStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'interrupted';

/** Statuses a worker may still act on. Mirrors migration 063's partial index. */
const ACTIVE_STATUSES: readonly RetryOperationStatus[] = ['accepted', 'running'];

/**
 * The statuses a reservation can hand back: it either creates an `accepted`
 * row or converges onto an operation that is already active. A terminal status
 * is not reachable from `reserve`, and saying so in the type keeps a future
 * regression from surfacing one in a 202 response (Copilot round 8).
 */
export type ActiveRetryOperationStatus = Extract<RetryOperationStatus, 'accepted' | 'running'>;

export function isActiveRetryOperationStatus(
  status: RetryOperationStatus,
): status is ActiveRetryOperationStatus {
  return status === 'accepted' || status === 'running';
}

export interface RetryOperationCounters {
  read: number;
  upserted: number;
  deferred: number;
  quarantined: number;
  failed: number;
}

/**
 * The camelCased view every read returns. Carries no payload, no serial
 * numbers, and no error message — see migration 063's note on why the columns
 * to hold them do not exist.
 */
export interface RetryOperation {
  id: string;
  tenantId: string;
  configurationId: string;
  requesterUserId: string;
  correlationId: string;
  status: RetryOperationStatus;
  leaseOwner: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  unitsRead: number | null;
  unitsUpserted: number | null;
  unitsDeferred: number | null;
  unitsQuarantined: number | null;
  unitsFailed: number | null;
  errorCode: string | null;
  errorClass: string | null;
}

export interface ReserveInput {
  id: string;
  tenantId: string;
  configurationId: string;
  requesterUserId: string;
  correlationId: string;
}

export type ReserveResult =
  | { outcome: 'created'; operation: RetryOperation }
  | { outcome: 'existing'; operation: RetryOperation };

/** Identity a caller must present for any write against a claimed operation. */
export interface LeaseHolder {
  id: string;
  leaseOwner: string;
  fencingToken: number;
}

export type SerializedAssetRetryDatabase = Pick<DatabaseService, 'getDatabase'>;

/**
 * Name of migration 063's partial unique index. Postgres reports it verbatim as
 * `error.constraint`, which is what lets the predicate below recognise THIS
 * conflict rather than any unique violation.
 */
export const SERIALIZED_ASSET_RETRY_ACTIVE_INDEX = 'uq_serialized_asset_retry_active';

/**
 * True only for a violation of the single-active-operation index.
 *
 * Identified by driver code plus a known identifier, never by pattern-matching
 * a raw message into control flow — the same rule, and the same two engine
 * shapes, as A8's approval conflict predicate. Postgres carries the index name
 * in `constraint`; better-sqlite3 has no such field and names the columns.
 *
 * CAUTION: the Postgres error's `detail` contains the conflicting values, so
 * one of these errors must never be logged whole.
 */
export function isActiveRetryOperationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';

  if (code === '23505') {
    return candidate.constraint === SERIALIZED_ASSET_RETRY_ACTIVE_INDEX;
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    return (
      message.includes('serialized_asset_retry_operations.tenant_id') &&
      message.includes('serialized_asset_retry_operations.configuration_id')
    );
  }
  return false;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `selectAll()` yields the SELECT projection of the table, not the raw
 * `ColumnType` declarations, so this takes `Selectable<...>` — casting the
 * ColumnType shape directly is what TypeScript rejected, and rightly.
 */
type RetryOperationRow = Selectable<SerializedAssetRetryOperationsTable>;

function toView(row: RetryOperationRow): RetryOperation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    configurationId: row.configuration_id,
    requesterUserId: row.requester_user_id,
    correlationId: row.correlation_id,
    status: row.status as RetryOperationStatus,
    leaseOwner: row.lease_owner,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: toIso(row.lease_expires_at),
    heartbeatAt: toIso(row.heartbeat_at),
    createdAt: toIso(row.created_at) as string,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    unitsRead: row.units_read,
    unitsUpserted: row.units_upserted,
    unitsDeferred: row.units_deferred,
    unitsQuarantined: row.units_quarantined,
    unitsFailed: row.units_failed,
    errorCode: row.error_code,
    errorClass: row.error_class,
  };
}

@injectable()
export class SerializedAssetRetryOperationRepository {
  constructor(
    @inject(TYPES.DatabaseService) private readonly db: SerializedAssetRetryDatabase,
    /**
     * Injected so lease and takeover behaviour can be driven deterministically
     * in tests without fake timers. Production passes the real clock.
     */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Durably reserve a forced retry, or converge onto the one already live.
   *
   * Convergence is the point: two operators pressing the button, or one
   * retrying a timed-out request, must not start parallel drains of a single
   * backlog. The database decides the winner via migration 063's partial
   * unique index; this method only interprets the conflict.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    // Two attempts, for one reason: the active row can go terminal between a
    // failed insert and the follow-up read, which frees the slot. Copilot
    // review on #1132 — the first version rethrew the unique violation there,
    // surfacing a transient 500 for a conflict that no longer existed. The
    // comment even claimed the caller retried; it did not. Bounded at two
    // because each retry is only earned by a blocker having genuinely
    // disappeared.
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
      const result = await this.tryReserve(input);
      if (result) return result;
    }
    throw new Error(SERIALIZED_ASSET_RETRY_NO_CONVERGENCE);
  }

  private async tryReserve(input: ReserveInput): Promise<ReserveResult | null> {
    const db = this.db.getDatabase();
    const nowIso = this.now().toISOString();

    try {
      await db
        .insertInto('serialized_asset_retry_operations')
        .values({
          id: input.id,
          tenant_id: input.tenantId,
          configuration_id: input.configurationId,
          requester_user_id: input.requesterUserId,
          correlation_id: input.correlationId,
          status: 'accepted',
          lease_owner: null,
          fencing_token: 0,
          lease_expires_at: null,
          heartbeat_at: null,
          created_at: nowIso,
          started_at: null,
          finished_at: null,
          units_read: null,
          units_upserted: null,
          units_deferred: null,
          units_quarantined: null,
          units_failed: null,
          error_code: null,
          error_class: null,
        })
        .execute();
    } catch (error) {
      if (!isActiveRetryOperationConflict(error)) throw error;

      const existing = await this.findActive(input.tenantId, input.configurationId);
      // The blocker went terminal between the failed insert and this read, so
      // the single-active slot is free again. Signal "retry" rather than
      // reporting a conflict that no longer exists.
      if (!existing) return null;
      return { outcome: 'existing', operation: existing };
    }

    const created = await this.getById(input.tenantId, input.id);
    if (!created) {
      // Unreachable: the insert above succeeded with this id.
      throw new Error('serialized_asset_retry_operations: reserved row could not be read back');
    }
    return { outcome: 'created', operation: created };
  }

  /**
   * Tenant AND configuration scoped read, for the HTTP status endpoint.
   *
   * Scoping on configuration is not decoration: the status URL carries an
   * integration id, and without this an operation could be fetched through ANY
   * integration id belonging to the tenant, making the URL misleading and the
   * path a weaker statement than it appears (Copilot review on #1132).
   */
  async getByIdForConfiguration(
    tenantId: string,
    configurationId: string,
    id: string,
  ): Promise<RetryOperation | null> {
    const row = await this.db
      .getDatabase()
      .selectFrom('serialized_asset_retry_operations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  /** Tenant-scoped read. Returns null on tenant mismatch or unknown id. */
  async getById(tenantId: string, id: string): Promise<RetryOperation | null> {
    const row = await this.db
      .getDatabase()
      .selectFrom('serialized_asset_retry_operations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  /**
   * Claim one operation for `leaseOwner`, or return null when none is
   * claimable.
   *
   * Claimable means: `accepted` (never started), or `running` whose lease has
   * LAPSED. A live running operation is never taken over, which is what keeps
   * two workers from claiming the same operation while one is demonstrably
   * healthy.
   *
   * That is NOT the same as preventing concurrent drains, and this comment
   * used to say it was. A lease can lapse while its holder is still executing,
   * and the successor's claim does nothing to stop the original — see the
   * module docstring on what the fencing token does and does not buy.
   *
   * Read-then-CAS rather than one statement, because the row to claim is chosen
   * by a scan while the claim itself must be conditional. The CAS carries the
   * status and the fencing token the read observed, so a racing worker that
   * claimed first makes this update match zero rows and this call returns null
   * instead of stealing the claim.
   */
  async claimNext(leaseOwner: string): Promise<RetryOperation | null> {
    const db = this.db.getDatabase();
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + SERIALIZED_ASSET_RETRY_LEASE_MS).toISOString();

    const candidate = await db
      .selectFrom('serialized_asset_retry_operations')
      .selectAll()
      .where('status', 'in', ACTIVE_STATUSES as unknown as string[])
      .where((eb) =>
        eb.or([
          eb('status', '=', 'accepted'),
          eb('lease_expires_at', '<=', nowIso),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    if (!candidate) return null;
    return this.claimObserved(toView(candidate), leaseOwner);
  }

  /**
   * The claim CAS, split from the scan so it can be tested against a snapshot
   * that has gone stale — which is the only way to exercise the interleaving
   * that matters. Same shape as A7's `touchAttempt(expectedAttemptCount)`: the
   * caller passes what it observed, and the predicate carries it.
   *
   * Public for that reason; `claimNext` is the normal entry point.
   *
   * Being public makes it a footgun (Codex round 2 on #1132): the SQL predicate
   * matches the OBSERVED lease, so a caller handing over a snapshot of a
   * healthy, currently-leased operation would satisfy it and steal a live
   * claim. The guard below closes that by rejecting a snapshot that was not
   * claimable WHEN OBSERVED, using the same rule as the scan above.
   *
   * Note what the guard deliberately does NOT do: re-check claimability inside
   * the UPDATE. Doing so would make the lease-equality predicate redundant, and
   * the heartbeat-race test — which passes a snapshot that was claimable when
   * observed and became live afterwards — would then pass with that predicate
   * removed. The guard validates the INPUT; the CAS handles the RACE. Keeping
   * them separate is what keeps that test load-bearing.
   */
  async claimObserved(observed: RetryOperation, leaseOwner: string): Promise<RetryOperation | null> {
    const db = this.db.getDatabase();
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + SERIALIZED_ASSET_RETRY_LEASE_MS).toISOString();

    // Compared as instants, not as strings (Copilot round 3). `toView` routes
    // every timestamp through `toIso`, so in practice these are canonical ISO
    // UTC and would also sort correctly lexicographically — but that makes this
    // comparison depend on an invariant enforced far away, and a driver or
    // column change that returned a different string shape would silently
    // misclassify a lapsed lease as live. Parsing costs nothing and removes the
    // dependency. An unparseable value is treated as NOT claimable, so a
    // malformed snapshot is refused rather than allowed to claim.
    const observedLeaseMs =
      observed.leaseExpiresAt === null ? null : Date.parse(observed.leaseExpiresAt);
    const claimableAsObserved =
      observed.status === 'accepted' ||
      (observed.status === 'running' &&
        observedLeaseMs !== null &&
        Number.isFinite(observedLeaseMs) &&
        observedLeaseMs <= now.getTime());
    if (!claimableAsObserved) {
      throw new Error(SERIALIZED_ASSET_RETRY_UNCLAIMABLE_SNAPSHOT);
    }

    let claim = db
      .updateTable('serialized_asset_retry_operations')
      .set({
        status: 'running',
        lease_owner: leaseOwner,
        fencing_token: observed.fencingToken + 1,
        lease_expires_at: leaseExpiresAt,
        heartbeat_at: nowIso,
        started_at: observed.startedAt ?? nowIso,
      })
      .where('id', '=', observed.id)
      // Tenant is part of the CAS even though `id` alone identifies the row
      // (Codex round 3). Without it the UPDATE and the read below disagree:
      // the claim would land on the row while the tenant-scoped `getById`
      // returned null, so the operation would be silently claimed and never
      // reported — running until its lease lapsed with nobody executing it.
      // With it, a snapshot carrying the wrong tenant matches zero rows and
      // this returns null, which is the honest answer.
      .where('tenant_id', '=', observed.tenantId)
      .where('status', '=', observed.status)
      .where('fencing_token', '=', observed.fencingToken);

    // The lease value the scan OBSERVED is part of the CAS. Codex review on
    // #1132: without it, an incumbent that heartbeats between this worker's
    // read and its update still matches, because a heartbeat renews the lease
    // WITHOUT changing the fencing token — so a live claim could be stolen
    // from a healthy owner. Matching the observed expiry makes any renewal in
    // that window fail the update.
    claim = observed.leaseExpiresAt === null
      ? claim.where('lease_expires_at', 'is', null)
      : claim.where('lease_expires_at', '=', observed.leaseExpiresAt);

    const result = await claim.executeTakeFirst();

    if (!this.oneRowChanged(result.numUpdatedRows)) return null;
    return this.getById(observed.tenantId, observed.id);
  }

  /** Extend the lease. Gated on the full claim, like every other write here. */
  async heartbeat(holder: LeaseHolder): Promise<boolean> {
    const now = this.now();
    const result = await this.db
      .getDatabase()
      .updateTable('serialized_asset_retry_operations')
      .set({
        heartbeat_at: now.toISOString(),
        lease_expires_at: new Date(now.getTime() + SERIALIZED_ASSET_RETRY_LEASE_MS).toISOString(),
      })
      .where('id', '=', holder.id)
      .where('status', '=', 'running')
      .where('lease_owner', '=', holder.leaseOwner)
      .where('fencing_token', '=', holder.fencingToken)
      .executeTakeFirst();
    return this.oneRowChanged(result.numUpdatedRows);
  }

  /** Terminal success. Counters only — there is nowhere to put anything else. */
  async complete(args: LeaseHolder & { counters: RetryOperationCounters }): Promise<boolean> {
    return this.finish(args, {
      status: 'succeeded',
      units_read: args.counters.read,
      units_upserted: args.counters.upserted,
      units_deferred: args.counters.deferred,
      units_quarantined: args.counters.quarantined,
      units_failed: args.counters.failed,
    });
  }

  /**
   * Terminal failure. `errorCode` and `errorClass` must already be bounded
   * values chosen by the caller — never a driver or connector message, which
   * can embed a serial number or a whole row.
   */
  async fail(args: LeaseHolder & { errorCode: string; errorClass: string }): Promise<boolean> {
    return this.finish(args, {
      status: 'failed',
      error_code: args.errorCode,
      error_class: args.errorClass,
    });
  }

  /** Terminal interruption — claimed, then shut down before execution began. */
  async interrupt(holder: LeaseHolder): Promise<boolean> {
    return this.finish(holder, { status: 'interrupted' });
  }

  private async finish(
    holder: LeaseHolder,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.db
      .getDatabase()
      .updateTable('serialized_asset_retry_operations')
      .set({ ...fields, finished_at: this.now().toISOString() } as never)
      .where('id', '=', holder.id)
      // The fencing predicate, in full. A worker whose lease lapsed and whose
      // operation was taken over matches none of these, so its late result
      // affects zero rows instead of overwriting its successor's.
      .where('status', '=', 'running')
      .where('lease_owner', '=', holder.leaseOwner)
      .where('fencing_token', '=', holder.fencingToken)
      .executeTakeFirst();
    return this.oneRowChanged(result.numUpdatedRows);
  }

  private async findActive(tenantId: string, configurationId: string): Promise<RetryOperation | null> {
    const row = await this.db
      .getDatabase()
      .selectFrom('serialized_asset_retry_operations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('configuration_id', '=', configurationId)
      .where('status', 'in', ACTIVE_STATUSES as unknown as string[])
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  /**
   * Same rule as A7's `touchAttempt`: "zero rows" and "the driver did not
   * report a count" are different facts. Collapsing them would report a
   * successful terminal write as a rejected one, and the worker would then
   * treat its own completed run as lost.
   */
  private oneRowChanged(numUpdatedRows: unknown): boolean {
    const updated = Number(numUpdatedRows);
    if (!Number.isFinite(updated)) {
      throw new Error('serialized_asset_retry_operations: driver reported no updated-row count');
    }
    return updated === 1;
  }
}
