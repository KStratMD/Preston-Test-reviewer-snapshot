import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import { sql } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { TenantConfigurationRepository } from '../../database/repositories/TenantConfigurationRepository';
import type { ProcessedClaim, ProcessedStatus } from './types';

@injectable()
export class SyncErrorAssistRepository {
  constructor(
    @inject(TYPES.DatabaseService) private db: DatabaseService,
    @inject(TYPES.TenantConfigurationRepository) private tenantConfig: TenantConfigurationRepository,
  ) {}

  /**
   * Discover tenants whose `sync_error_assist.enabled` gate resolves true,
   * honoring both plaintext and encrypted (KMS Tier-C) rows.
   *
   * One DB query pulls candidate rows with a `(is_encrypted = true OR
   * setting_value = 'true')` filter — plaintext rows whose value is
   * anything other than `'true'` are dropped at the DB layer (R9.2),
   * encrypted rows are kept regardless because `setting_value` stores the
   * deterministic secret name and not the literal boolean. The loop then:
   *
   *   - plaintext rows: short-circuit and emit directly. The DB filter
   *     guarantees `setting_value === 'true'`, so no async resolution
   *     needed.
   *   - encrypted rows: delegate to
   *     `tenantConfig.resolveBooleanForRow(tenantId, settingKey, row)`,
   *     which decrypts via `SecretManager.getSecret` without re-reading
   *     the row from the DB (R8.1 helper).
   *
   * Why we can't just `WHERE setting_value='true'`: PR 808 KMS Tier-C
   * stores encrypted boolean rows as deterministic secret names, not the
   * literal `'true'`. A direct value filter would silently skip every
   * encrypted enrollment (Codex P2 finding on PR #808).
   *
   * `(tenant_id, setting_key)` is UNIQUE per the table constraint, so no
   * `distinct()` clause is needed — each tenant appears at most once.
   */
  async getActiveTenants(): Promise<string[]> {
    const candidates = await this.db.getDatabase()
      .selectFrom('tenant_configurations')
      .select(['tenant_id', 'setting_value', 'is_encrypted'])
      .where('setting_key', '=', 'sync_error_assist.enabled')
      .where((eb) => eb.or([
        eb('is_encrypted', '=', true),
        eb('setting_value', '=', 'true'),
      ]))
      .execute();
    const enabled: string[] = [];
    for (const row of candidates) {
      if (row.is_encrypted) {
        // Encrypted path: SecretManager-aware resolve (no redundant DB read).
        if (await this.tenantConfig.resolveBooleanForRow(
          row.tenant_id,
          'sync_error_assist.enabled',
          { setting_value: row.setting_value, is_encrypted: row.is_encrypted },
        )) {
          enabled.push(row.tenant_id);
        }
      } else {
        // Plaintext fast path: the DB filter already ensured
        // setting_value === 'true' here — no further check or await needed.
        enabled.push(row.tenant_id);
      }
    }
    return enabled;
  }

  /** Atomic claim: insert new OR retry-existing-failed-retryable.
   *  Returns null if another replica owns it / already succeeded / non_retryable / exhausted.
   *
   *  `errorLastModifiedAt` is the snapshot of the NetSuite error record's
   *  lastModified at claim time. Used by reapStuckProcessing() to reset the
   *  watermark when stuck rows are reaped, closing the residual READ COMMITTED
   *  race in tryAdvanceWatermark. Pass null only for legacy paths that
   *  don't have the timestamp; rows so claimed will not contribute to the
   *  reaper's watermark-recovery MIN-aggregate.
   *
   *  On the retry branch (failed_retryable + attempts < 3), the existing
   *  error_last_modified_at is preserved if the caller passes null, and
   *  overwritten with the fresher value if the caller provides one — webhooks
   *  re-delivering a record may carry a newer lastModified than the
   *  first-attempt snapshot, and the polling path may see an updated record
   *  on retry. SQL: `COALESCE(${newValue}, existing)` — returns the new
   *  value when the caller has a fresher snapshot, falls back to the
   *  existing column when the caller passes null. */
  async claim(
    tenantId: string,
    errorRecordId: string,
    errorLastModifiedAt: string | null = null,
  ): Promise<ProcessedClaim | null> {
    const id = randomUUID();
    const reservedAt = new Date().toISOString();

    const result = await sql<{
      id: string; tenant_id: string; error_record_id: string; attempts: number;
    }>`
      INSERT INTO sync_error_assist_processed
        (id, tenant_id, error_record_id, status, attempts, reserved_at, error_last_modified_at)
      VALUES (${id}, ${tenantId}, ${errorRecordId}, 'processing', 1, ${reservedAt}, ${errorLastModifiedAt})
      ON CONFLICT (tenant_id, error_record_id) DO UPDATE
        SET status='processing',
            attempts=sync_error_assist_processed.attempts + 1,
            reserved_at=${reservedAt},
            failure_reason=NULL,
            error_last_modified_at=COALESCE(${errorLastModifiedAt}, sync_error_assist_processed.error_last_modified_at)
        WHERE sync_error_assist_processed.status='failed_retryable'
          AND sync_error_assist_processed.attempts < 3
      RETURNING id, tenant_id, error_record_id, attempts
    `.execute(this.db.getDatabase());

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      errorRecordId: row.error_record_id,
      attempts: row.attempts,
    };
  }

  async updateSucceeded(id: string, fields: {
    suggestionRecordId: string;
    traceId: string;
    provider: string;
    costEstimateUsdCents: number | null;
    confidence: string | null;
    suggestionType: string | null;
    suggestionText: string | null;
    referencesField: string | null;
  }): Promise<void> {
    await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        status: 'succeeded',
        suggestion_record_id: fields.suggestionRecordId,
        trace_id: fields.traceId,
        provider: fields.provider,
        cost_estimate_usd_cents: fields.costEstimateUsdCents,
        confidence: fields.confidence,
        suggestion_type: fields.suggestionType,
        suggestion_text: fields.suggestionText,
        references_field: fields.referencesField,
        completed_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('status', '=', 'processing')                    // OCC guard
      .execute();
  }

  async updateFailed(
    id: string,
    status: 'failed_retryable' | 'failed_non_retryable',
    failureReason: string,
  ): Promise<void> {
    await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        status,
        failure_reason: failureReason,
        completed_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('status', '=', 'processing')                    // OCC guard
      .execute();
  }

  /**
   * Reap orphaned `processing` rows + run per-tenant watermark recovery.
   *
   * Returns BOTH the reaped count AND the list of watermark recoveries that
   * actually ratcheted (Codex PR #777 R2 NIT — without the recovery list,
   * actual race-recovery events were silently swallowed and operators had no
   * way to observe whether the new mechanism was firing in production).
   *
   * Caller (`SyncErrorAssistService.runAllEnabledTenants`) emits a structured
   * log entry per recovery so the timing + recovered-to value flows into
   * Loki/CloudWatch dashboards.
   */
  async reapStuckProcessing(cutoff: Date): Promise<{
    reaped: number;
    recoveries: { tenantId: string; recoveredTo: string }[];
  }> {
    // SELECT-then-JS-clamp-then-UPDATE pattern (MIN/LEAST not portable across dialects).
    // We also collect the affected tenants so we can run the post-reap
    // watermark recovery sweep below (one MIN-aggregate query per tenant).
    const stuckRows = await this.db.getDatabase()
      .selectFrom('sync_error_assist_processed')
      .select(['id', 'tenant_id', 'attempts'])
      .where('status', '=', 'processing')
      .where('reserved_at', '<', cutoff.toISOString())
      .execute();

    if (stuckRows.length === 0) return { reaped: 0, recoveries: [] };

    const affectedTenants = new Set<string>();
    let actuallyReaped = 0;
    for (const row of stuckRows) {
      const clampedAttempts = Math.min(row.attempts + 1, 3);
      const newStatus: ProcessedStatus =
        clampedAttempts >= 3 ? 'failed_non_retryable' : 'failed_retryable';
      const result = await this.db.getDatabase()
        .updateTable('sync_error_assist_processed')
        .set({
          status: newStatus,
          attempts: clampedAttempts,
          failure_reason: 'orphaned: stuck or crashed (reserved_at exceeded REAPER_CUTOFF_MS)',
          completed_at: new Date().toISOString(),
        })
        .where('id', '=', row.id)
        .where('status', '=', 'processing')                       // OCC guard
        .execute();
      // Kysely UpdateResult is an array of UpdateResult objects with bigint
      // numUpdatedRows. Coerce to number safely; OCC-guarded UPDATEs that lost
      // the race to a finishing cycle return 0 affected rows and don't count.
      const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
      // Only the tenants whose reaping actually succeeded get a watermark
      // reset — if an OCC-guarded reap lost the race (a concurrent
      // updateSucceeded ran first), the watermark for that tenant is
      // already correct.
      if (updated > 0) {
        affectedTenants.add(row.tenant_id);
        actuallyReaped += updated;
      }
    }

    // Watermark recovery sweep: for each tenant whose reaper actually
    // demoted a `processing` row to `failed_retryable`, scan all surviving
    // failed_retryable rows for that tenant and reset the watermark to
    // MIN(error_last_modified_at) IF (and only if) that MIN is older than
    // the current watermark. This closes the residual READ COMMITTED race
    // in tryAdvanceWatermark — if the watermark had over-advanced past a
    // since-orphaned row, this brings it back so the polling path re-picks
    // up the row on the next cycle.
    //
    // Per-recovery outcomes flow to the caller so the service layer can emit
    // a structured log entry — observability gap raised by Codex PR #777
    // review (NIT). Tenants where recovery short-circuited (no anchor row,
    // or watermark already older than MIN) do NOT appear in the list.
    const recoveries: { tenantId: string; recoveredTo: string }[] = [];
    for (const tenantId of affectedTenants) {
      const outcome = await this.recoverWatermarkAfterReap(tenantId);
      if (outcome.recovered && outcome.recoveredTo) {
        recoveries.push({ tenantId, recoveredTo: outcome.recoveredTo });
      }
    }

    return { reaped: actuallyReaped, recoveries };
  }

  /**
   * Watermark recovery: ratchet `sync_error_assist_runs.last_modified_at`
   * backward to the oldest surviving `failed_retryable` row's
   * `error_last_modified_at` (minus one millisecond, so the polling path's
   * strict `> watermark` filter re-includes that row).
   *
   * Only applies when the recovered value is STRICTLY older than the current
   * watermark. This prevents the reaper from making a forward-progress
   * decision on its own (the watermark advances only via tryAdvanceWatermark
   * on the polling path); the reaper just undoes over-advancement.
   *
   * Rows with `error_last_modified_at IS NULL` (pre-migration-038 legacy)
   * are skipped — they never contributed to the watermark via the new path
   * and have no anchor to roll back to. Their recovery still depends on
   * webhook re-delivery or operator surfacing.
   */
  async recoverWatermarkAfterReap(tenantId: string): Promise<{ recovered: boolean; recoveredTo: string | null }> {
    const minRow = await this.db.getDatabase()
      .selectFrom('sync_error_assist_processed')
      .select((eb) => eb.fn.min<Date | string | null>('error_last_modified_at').as('min_lm'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'failed_retryable')
      .where('error_last_modified_at', 'is not', null)
      .executeTakeFirst();

    // Backend-divergent return shape: node-postgres parses TIMESTAMPTZ to Date;
    // better-sqlite3 returns TEXT verbatim as string. Coerce both to epoch ms
    // via a single defensive path so arithmetic-on-strings can't silently NaN.
    const minLm = minRow?.min_lm ?? null;
    if (minLm === null || minLm === undefined) return { recovered: false, recoveredTo: null };
    const minEpoch = minLm instanceof Date ? minLm.getTime() : new Date(minLm).getTime();
    if (!Number.isFinite(minEpoch)) return { recovered: false, recoveredTo: null };

    // Subtract 1ms so the polling path's strict `> watermark` filter
    // re-includes the orphaned row's exact lastModified value.
    const recoveredTo = new Date(minEpoch - 1).toISOString();
    const now = new Date().toISOString();

    // Conditional UPDATE: only ratchet backward, never forward. Uses the
    // existing runs row's last_modified_at as the conditional. If no runs
    // row exists yet, the reaper has nothing to roll back to and there's
    // no over-advancement to repair, so we don't insert.
    const result = await this.db.getDatabase()
      .updateTable('sync_error_assist_runs')
      .set({ last_modified_at: new Date(recoveredTo).getTime(), updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('last_modified_at', '>', new Date(recoveredTo).getTime())
      .execute();

    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return { recovered: updated > 0, recoveredTo: updated > 0 ? recoveredTo : null };
  }

  async getWatermark(tenantId: string): Promise<Date | null> {
    const row = await this.db.getDatabase()
      .selectFrom('sync_error_assist_runs')
      .select('last_modified_at')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!row) return null;
    const epochMs = Number(row.last_modified_at);
    if (!Number.isFinite(epochMs)) return null;
    return new Date(epochMs);
  }

  /**
   * Atomic watermark advance. Returns true if the watermark was advanced,
   * false if held because (a) at least one processing row exists for this
   * tenant, or (b) the candidate would not advance the existing watermark
   * (already-equal or backward).
   *
   * Replaces the prior two-statement gate (`hasProcessingRows()` + `upsertWatermark()`)
   * which left a microsecond race where a concurrent webhook could insert a
   * processing row between the SELECT and the UPSERT, allowing the watermark
   * to advance past it.
   *
   * Single statement: INSERT-from-SELECT gates the first-write case, the
   * conflict's WHERE clause gates the update case with TWO predicates:
   *   1. NO processing rows exist (correctness — same as the first-write gate)
   *   2. excluded.last_modified_at > sync_error_assist_runs.last_modified_at
   *      (monotonicity — the method name promises "advance"; a backward write
   *      would be a regression that re-emits already-processed error records)
   *
   * SQLite serializes writes; Postgres re-evaluates the conflict's WHERE under
   * the row lock acquired at conflict resolution.
   *
   * Residual narrow race in Postgres READ COMMITTED: if a concurrent webhook
   * insert is uncommitted when the `WHERE NOT EXISTS` clause evaluates, the
   * gate misses it and the watermark can advance past that row's
   * `last_modified_at`. The race is narrow (requires webhook-then-mid-
   * process-crash coinciding with the SQL-gate race) but real.
   *
   * **The race is now backstopped** by `reapStuckProcessing`:
   * `reapStuckProcessing` flips a stalled `processing` row to
   * `failed_retryable` after the 60-min `reserved_at` cutoff (see
   * `SyncErrorAssistService.REAPER_CUTOFF_MS` = `60 * 60_000`). The reaper
   * then calls `recoverWatermarkAfterReap(tenantId)` for every tenant whose
   * row was reaped — this query takes `MIN(error_last_modified_at)` of
   * surviving `failed_retryable` rows for that tenant and rolls the
   * watermark back to one millisecond before that minimum, but ONLY if
   * the current watermark is strictly newer (so the reaper never makes a
   * forward-progress decision on its own — that's still tryAdvanceWatermark's
   * job). On the next polling cycle the row is re-fetched and re-processed
   * via `claim()`'s `failed_retryable` retry branch.
   *
   * Pre-migration-038 rows have `error_last_modified_at IS NULL` and so
   * don't contribute to the MIN aggregate. Recovery for those rows still
   * depends on either webhook re-delivery (which hits the same retry branch)
   * or a future operator-surface query that includes `failed_retryable` for
   * manual retry. New rows claimed via this code path carry the
   * `error_last_modified_at` snapshot and are recovered automatically.
   */
  async tryAdvanceWatermark(tenantId: string, candidate: Date): Promise<boolean> {
    const epochMs = candidate.getTime();
    const now = new Date().toISOString();
    const result = await sql<{ tenant_id: string }>`
      INSERT INTO sync_error_assist_runs (tenant_id, last_modified_at, updated_at)
      SELECT ${tenantId}, ${epochMs}, ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM sync_error_assist_processed
        WHERE tenant_id = ${tenantId} AND status = 'processing'
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        last_modified_at = excluded.last_modified_at,
        updated_at = excluded.updated_at
      WHERE NOT EXISTS (
        SELECT 1 FROM sync_error_assist_processed
        WHERE tenant_id = ${tenantId} AND status = 'processing'
      )
      AND excluded.last_modified_at > sync_error_assist_runs.last_modified_at
      RETURNING tenant_id
    `.execute(this.db.getDatabase());
    return result.rows.length > 0;
  }

  async listPendingSuggestionsByTenant(
    tenantId: string,
    opts: { limit: number },
  ): Promise<import('./types').PendingSuggestion[]> {
    const rows = await this.db.getDatabase()
      .selectFrom('sync_error_assist_processed')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'succeeded')
      .where('operator_disposition', '=', 'pending')
      // Confidence buckets: high < mid < low < null/unknown. The ELSE 3 bucket
      // pushes nulls/unknowns AFTER 'low' so that backfilled PR 17a rows
      // (which may have null confidence) sort last regardless of completed_at.
      .orderBy(sql`CASE confidence WHEN 'high' THEN 0 WHEN 'mid' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`)
      // Cross-dialect NULLS-LAST: SQLite < 3.30 doesn't support `NULLS LAST`
      // syntax. The CASE expression below pushes null completed_at to a
      // separate (later) bucket on every dialect Postgres + SQLite both
      // understand. On succeeded rows completed_at is always set by
      // updateSucceeded, but defending the contract is cheap and explicit.
      .orderBy(sql`CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END`)
      .orderBy('completed_at', 'desc')
      .limit(opts.limit)
      .execute();

    const isConfidence = (v: unknown): v is 'high' | 'mid' | 'low' =>
      v === 'high' || v === 'mid' || v === 'low';

    return rows.map((r) => ({
      errorRecordId: r.error_record_id,
      suggestionRecordId: r.suggestion_record_id ?? null,
      tenantId: r.tenant_id,
      confidence: isConfidence(r.confidence) ? r.confidence : null,
      suggestionType: r.suggestion_type,
      suggestionText: r.suggestion_text,
      referencesField: r.references_field,
      reasoningTraceId: r.trace_id,
      providerUsed: r.provider,
      costEstimateUsdCents: r.cost_estimate_usd_cents ?? null,
      // Surfaced rows have status='succeeded', and updateSucceeded sets
      // completed_at unconditionally, so this fallback is defensive only.
      // Use reserved_at as the next-best monotonic timestamp rather than
      // a fake "now" — preserves record-age accuracy for malformed fixtures.
      createdAt: (r.completed_at as string | null) ?? r.reserved_at,
    }));
  }

  async getProcessedRowByErrorRecord(tenantId: string, errorRecordId: string) {
    const row = await this.db.getDatabase()
      .selectFrom('sync_error_assist_processed')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('error_record_id', '=', errorRecordId)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Acquire the accept-lease: atomic transition pending → applying.
   * Returns true iff THIS caller won the race. The caller must follow with
   * EITHER completeAccept (success) OR revertToPending (failure) so the lease
   * does not leak. Stamping userId + timestamp here gives the audit trail an
   * accurate "who started the accept" marker independent of completion.
   */
  async beginAccept(args: {
    tenantId: string;
    errorRecordId: string;
    userId: string;
  }): Promise<boolean> {
    const result = await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        operator_disposition: 'applying',
        operator_disposition_at: new Date().toISOString(),
        operator_disposition_user_id: args.userId,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('error_record_id', '=', args.errorRecordId)
      .where('operator_disposition', '=', 'pending')
      .where('status', '=', 'succeeded')
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Release the accept-lease as success: applying → accepted.
   *
   * Lease isolation: the WHERE clause requires operator_disposition_user_id
   * to match the caller's userId. Only the user who acquired the lease via
   * beginAccept can complete it; a different user's call returns false even
   * if the row is in 'applying' state.
   */
  async completeAccept(args: { tenantId: string; errorRecordId: string; userId: string }): Promise<boolean> {
    const result = await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        operator_disposition: 'accepted',
        operator_disposition_at: new Date().toISOString(),
      })
      .where('tenant_id', '=', args.tenantId)
      .where('error_record_id', '=', args.errorRecordId)
      .where('operator_disposition', '=', 'applying')
      .where('operator_disposition_user_id', '=', args.userId)
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Release the accept-lease as failure: applying → pending (caller may retry).
   *
   * Lease isolation (mirrors completeAccept): only the user who acquired the
   * lease can revert it. A wrong-holder revert returns false; the row stays
   * in 'applying' state for the actual lease holder to resolve.
   */
  async revertToPending(args: { tenantId: string; errorRecordId: string; userId: string }): Promise<boolean> {
    const result = await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        operator_disposition: 'pending',
      })
      .where('tenant_id', '=', args.tenantId)
      .where('error_record_id', '=', args.errorRecordId)
      .where('operator_disposition', '=', 'applying')
      .where('operator_disposition_user_id', '=', args.userId)
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  async markDisposition(args: {
    tenantId: string;
    errorRecordId: string;
    newDisposition: 'rejected' | 'escalated';
    userId: string;
  }): Promise<boolean> {
    if (args.newDisposition !== 'rejected' && args.newDisposition !== 'escalated') {
      throw new Error(`markDisposition received invalid newDisposition=${args.newDisposition}; use beginAccept/completeAccept for accepted`);
    }
    const result = await this.db.getDatabase()
      .updateTable('sync_error_assist_processed')
      .set({
        operator_disposition: args.newDisposition,
        operator_disposition_at: new Date().toISOString(),
        operator_disposition_user_id: args.userId,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('error_record_id', '=', args.errorRecordId)
      .where('operator_disposition', '=', 'pending')
      .where('status', '=', 'succeeded')
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }
}
