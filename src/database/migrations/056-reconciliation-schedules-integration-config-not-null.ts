import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 056 — flip reconciliation_schedules.integration_config_id to NOT NULL.
 *
 * Closes the API-required -> DB-required loop (the column was added nullable in
 * migration 055 because no creation API existed). POST/PATCH now enforce a
 * non-empty reference, so the column can be made NOT NULL.
 *
 * Backfill (dialect-split): legacy NULL-config rows get the sentinel
 * '__unconfigured__' AND active=false so they never run; if reactivated they
 * fail-clean at dispatch (config_not_found). The deactivation literal differs by
 * driver — SQLite stores active as INTEGER (active = 0), Postgres as a real
 * boolean (active = FALSE); a `= 0` literal against the Postgres boolean column
 * raises a type-mismatch error. The sentinel string is hard-coded here on purpose:
 * migrations must not import runtime modules (immutability). The runtime copy lives
 * in services/reconciliationCenter/constants.ts; tests pin both to the same string.
 *
 * Postgres: ALTER COLUMN ... SET NOT NULL.
 * SQLite: cannot add NOT NULL in place, so rebuild the table (precedent 015/031/040),
 * preserving every column, the cadence CHECK, the handler_key/active defaults, and
 * both indexes.
 */
export const migration: MigrationModule = {
  name: 'reconciliation_schedules_integration_config_not_null',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        UPDATE reconciliation_schedules
           SET integration_config_id = '__unconfigured__', active = 0
         WHERE integration_config_id IS NULL
      `.execute(db);
      // Drop any orphaned rebuild table from a prior interrupted run. The migration
      // runner is non-transactional and records the migration row only AFTER run()
      // returns, so a crash mid-rebuild re-executes this from the top; dropping the
      // stale `_new` first makes the rebuild fully re-runnable (no leftover rows to
      // collide with the INSERT...SELECT below).
      await sql`DROP TABLE IF EXISTS reconciliation_schedules_new`.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_schedules_new (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
          handler_key TEXT NOT NULL DEFAULT 'netsuite_business_central_invoice_reconciliation',
          active INTEGER NOT NULL DEFAULT 1,
          next_run_at TEXT NOT NULL,
          integration_config_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `.execute(db);
      await sql`
        INSERT INTO reconciliation_schedules_new
          (id, tenant_id, name, cadence, handler_key, active, next_run_at, integration_config_id, created_at, updated_at)
        SELECT id, tenant_id, name, cadence, handler_key, active, next_run_at, integration_config_id, created_at, updated_at
          FROM reconciliation_schedules
      `.execute(db);
      await sql`DROP TABLE reconciliation_schedules`.execute(db);
      await sql`ALTER TABLE reconciliation_schedules_new RENAME TO reconciliation_schedules`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_schedules_tenant_active ON reconciliation_schedules(tenant_id, active)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_schedules_tenant_config ON reconciliation_schedules(tenant_id, integration_config_id)`.execute(db);
    } else {
      await sql`
        UPDATE reconciliation_schedules
           SET integration_config_id = '__unconfigured__', active = FALSE
         WHERE integration_config_id IS NULL
      `.execute(db);
      await sql`ALTER TABLE reconciliation_schedules ALTER COLUMN integration_config_id SET NOT NULL`.execute(db);
    }
  },
};
