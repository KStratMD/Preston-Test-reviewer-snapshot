import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 058 — durable tenant-scoped deferred-work store for the NetSuite
 * serialized-asset execution profile (Task 2, 2026-07-27 NetSuite
 * serialized-asset sync plan).
 *
 * When a NetSuite `inventorynumber` cannot yet be upserted as a Salesforce
 * `Asset` (its parent Product2 hasn't synced yet, or a dependency call failed
 * transiently), the executor persists it here instead of dropping it. Rows
 * are unique by `(tenant_id, configuration_id, inventory_number_id)` —
 * decision 9 of the plan — so a repeat deferral of the same physical unit
 * updates the existing row rather than accumulating duplicates. A row is
 * deleted only after a confirmed Salesforce upsert (repository-layer
 * `deleteSucceeded`, not this migration).
 *
 * `normalized_payload` holds the design-approved normalized unit (may include
 * the serial number — decision 8 permits this ONE column to carry it). Every
 * other surface (logs, metrics labels, audit details, exception messages, and
 * `reason` itself) MUST NOT carry a serial number; `reason` is deliberately a
 * closed enum so it structurally cannot.
 *
 * Same dialect-constant pattern as migration 057: SQLite uses TEXT for both
 * the JSON and timestamp columns; PostgreSQL uses JSONB/TIMESTAMPTZ. Real
 * Postgres execution is exercised by the existing generic
 * `tests/integration/postgres/migrations.test.ts` smoke test, which runs every
 * `MIGRATIONS` module against a live database — no migration-specific
 * Postgres unit test is needed (matches the precedent set by migration 053).
 */
export const migration: MigrationModule = {
  name: 'create_deferred_serialized_units_table',
  async run(db, dbType) {
    const isSqlite = dbType === 'sqlite';
    const JSON_COL = isSqlite ? 'TEXT' : 'JSONB';
    const TS = isSqlite ? 'TEXT' : 'TIMESTAMPTZ';

    await sql.raw(`
      CREATE TABLE IF NOT EXISTS deferred_serialized_units (
        tenant_id TEXT NOT NULL,
        configuration_id TEXT NOT NULL,
        inventory_number_id TEXT NOT NULL,
        normalized_payload ${JSON_COL} NOT NULL,
        reason TEXT NOT NULL
          CHECK (reason IN ('parent_missing', 'transient_dependency_failure', 'write_failed')),
        attempt_count INTEGER NOT NULL DEFAULT 1,
        next_attempt_at ${TS} NOT NULL,
        first_deferred_at ${TS} NOT NULL,
        last_attempt_at ${TS} NOT NULL,
        PRIMARY KEY (tenant_id, configuration_id, inventory_number_id)
      )
    `).execute(db);

    // Backs listDue's (tenant_id, configuration_id, next_attempt_at <= now)
    // predicate and listForRetry's (tenant_id, configuration_id) scoping.
    await sql.raw(`
      CREATE INDEX IF NOT EXISTS idx_deferred_serialized_units_due
        ON deferred_serialized_units (tenant_id, configuration_id, next_attempt_at)
    `).execute(db);
  },
};
