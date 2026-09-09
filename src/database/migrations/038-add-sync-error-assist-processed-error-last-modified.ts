import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Adds error_last_modified_at to sync_error_assist_processed so the
 * reaper can close the residual READ COMMITTED race in
 * SyncErrorAssistRepository.tryAdvanceWatermark.
 *
 * Background: tryAdvanceWatermark uses a single INSERT-from-SELECT with a
 * `WHERE NOT EXISTS (...processing rows...)` gate to ensure the watermark
 * never advances past an in-flight row. Under READ COMMITTED, a concurrent
 * webhook insert that is uncommitted when the gate evaluates can slip past,
 * letting the watermark advance past that row's `last_modified_at`. The 60-
 * minute reaper then converts the stalled `processing` row to
 * `failed_retryable`, but until now the watermark itself wasn't reset — the
 * polling path filters by `lastModified > watermark` and so doesn't re-fetch
 * the orphaned row, and the operator-surface query filters
 * `status='succeeded'` and so doesn't expose it either. Recovery depended
 * entirely on NetSuite re-delivering the webhook.
 *
 * With this column populated at claim() time (snapshotted from the
 * NetSuite record's lastModified), the reaper can `MIN(error_last_modified_at)`
 * across surviving failed_retryable rows and write the watermark back to that
 * value, guaranteeing the polling path re-picks up the orphaned row on the
 * next cycle.
 *
 * Backfill: rows that pre-date this migration keep `error_last_modified_at
 * IS NULL`. The reaper's watermark-reset query filters those out — they will
 * not contribute to the MIN, so the legacy population's recovery path is
 * unchanged (webhook re-delivery or operator surfacing via a future PR).
 *
 * Index: a partial index on (tenant_id) WHERE status='failed_retryable' AND
 * error_last_modified_at IS NOT NULL keeps the reaper's MIN-aggregate query
 * O(1) per tenant even at scale. SQLite doesn't support partial indexes pre-
 * 3.8.0; we use a full index on (tenant_id, status, error_last_modified_at)
 * there, which is still useful for the same query shape.
 *
 * Column type — Postgres `TIMESTAMPTZ` not `TIMESTAMP`: the application snapshots
 * UTC-anchored ISO-8601 strings (`...Z` suffix) from NetSuite/webhook payloads
 * into this column. `TIMESTAMP WITHOUT TIME ZONE` discards the offset on insert
 * and depends on the Postgres session timezone to interpret the wall-clock
 * value on read — a sessions-configured-to-non-UTC deployment would silently
 * drift the watermark recovery target. `TIMESTAMPTZ` stores an absolute instant
 * regardless of session timezone and is the right type for UTC-anchored data.
 * SQLite uses TEXT (verbatim ISO string round-trip; no native datetime type).
 * This is intentional inconsistency with older migrations that use `TIMESTAMP`
 * for historical fields where session-timezone alignment is acceptable.
 */
export const migration: MigrationModule = {
  name: 'add_sync_error_assist_processed_error_last_modified',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN error_last_modified_at TEXT`.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_watermark_recovery
          ON sync_error_assist_processed(tenant_id, status, error_last_modified_at)
      `.execute(db);
    } else {
      await sql`
        ALTER TABLE sync_error_assist_processed
          ADD COLUMN IF NOT EXISTS error_last_modified_at TIMESTAMPTZ
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_watermark_recovery
          ON sync_error_assist_processed(tenant_id, error_last_modified_at)
          WHERE status = 'failed_retryable' AND error_last_modified_at IS NOT NULL
      `.execute(db);
    }
  },
};
