import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 059 — durable per-(tenant, configuration) source-sweep cursor for
 * the NetSuite serialized-asset execution profile (Task 7 review round 2,
 * 2026-07-27 NetSuite serialized-asset sync plan).
 *
 * Why a dedicated table rather than reusing something:
 *
 *  - `sync_cursors` (migration 017) has NO `tenant_id` column — it is keyed
 *    `(flow_id, entity_type)`. Encoding a tenant into `flow_id` would create a
 *    new cross-tenant surface with no column-level isolation to enforce it,
 *    where any query that forgot the encoding would read across tenants.
 *  - `tenant_configurations` is the SECRET-bearing table (`is_encrypted` +
 *    SecretManager indirection). Per-configuration sweep state is high-churn
 *    operational data; putting it there would mix hot writes into a
 *    security-sensitive surface, require a synthetic composite setting key to
 *    get per-configuration granularity (unbounded key-namespace growth per
 *    tenant), and store an integer offset as an untyped string.
 *
 * This table is tenant-isolated BY CONSTRUCTION, exactly like migration 058's
 * `deferred_serialized_units`: both key columns are in the primary key and in
 * every WHERE clause of the repository that owns it.
 *
 * `next_offset` is the offset the NEXT run resumes from. A run that reaches the
 * end of the source resets it to 0, so sweeps wrap and no row is permanently
 * unreachable — the defect this migration exists to fix was that every run
 * restarted at offset 0 and therefore re-synced the same first window forever
 * while everything past it was never reached by ANY run.
 *
 * Same dialect-constant pattern as migrations 057/058: SQLite uses TEXT for
 * timestamps, PostgreSQL TIMESTAMPTZ. Real Postgres execution is exercised by
 * the generic `tests/integration/postgres/migrations.test.ts` smoke test, which
 * runs every `MIGRATIONS` module against a live database.
 */
export const migration: MigrationModule = {
  name: 'create_serialized_asset_sweep_cursors_table',
  async run(db, dbType) {
    const TS = dbType === 'sqlite' ? 'TEXT' : 'TIMESTAMPTZ';

    await sql.raw(`
      CREATE TABLE IF NOT EXISTS serialized_asset_sweep_cursors (
        tenant_id TEXT NOT NULL,
        configuration_id TEXT NOT NULL,
        next_offset INTEGER NOT NULL DEFAULT 0
          CHECK (next_offset >= 0),
        last_swept_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (tenant_id, configuration_id)
      )
    `).execute(db);
  },
};
