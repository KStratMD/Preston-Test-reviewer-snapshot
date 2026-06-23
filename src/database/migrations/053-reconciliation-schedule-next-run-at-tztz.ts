import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 053 — convert `reconciliation_schedules.next_run_at` from a
 * zone-less `TIMESTAMP` (migration 048) to `TIMESTAMPTZ`.
 *
 * Why only this column: `next_run_at` is the ONLY reconciliation timestamp used
 * in date arithmetic (`computeNextRunAt`) AND in the optimistic-concurrency
 * claim equality (`WHERE next_run_at = :expectedNextRunAt`). With a zone-less
 * column, node-postgres parses the value as a LOCAL-time `Date`; on a non-UTC
 * host that (a) skews the drift-free advance math and (b) makes the claim
 * equality silently never match (the scheduler would claim nothing). The app
 * always writes UTC ISO-8601 strings, so reading them back as `TIMESTAMPTZ`
 * (a true UTC instant) makes both paths zone-stable. The other columns
 * (created_at / updated_at / run timestamps) are display-only and intentionally
 * left as-is to keep this change surgical.
 *
 * Idempotency:
 *   Postgres — guarded by information_schema so a replay (when the column is
 *              already `timestamp with time zone`) is a no-op; the
 *              `AT TIME ZONE 'UTC'` reinterpretation only runs on the
 *              zone-less original, so it can never double-shift.
 *   SQLite — no-op. SQLite has no real timestamp types (the column is TEXT);
 *            JS always reads/writes ISO-8601 UTC strings, so there is no zone
 *            ambiguity to fix.
 */
export const migration: MigrationModule = {
  name: 'reconciliation_schedule_next_run_at_tztz',
  async run(db, dbType) {
    if (dbType !== 'postgres') return;
    await sql`
      DO $$
      BEGIN
        IF (
          SELECT data_type FROM information_schema.columns
          WHERE table_name = 'reconciliation_schedules' AND column_name = 'next_run_at'
        ) = 'timestamp without time zone' THEN
          ALTER TABLE reconciliation_schedules
            ALTER COLUMN next_run_at TYPE TIMESTAMPTZ
            USING next_run_at AT TIME ZONE 'UTC';
        END IF;
      END $$;
    `.execute(db);
  },
};
