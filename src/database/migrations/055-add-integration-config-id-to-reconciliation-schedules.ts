import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 055 — add nullable `integration_config_id` to reconciliation_schedules.
 *
 * A schedule references the tenant's NetSuite↔Business Central IntegrationConfig
 * so the reconciler can resolve credentials and initialize connectors before
 * listing. NULLABLE by design: there is no schedule-creation API yet (rows are
 * seeded directly) and no production schedules to backfill, so enforcing the
 * reference (API-required, then DB NOT NULL) is deferred. A null reference fails
 * the run cleanly at dispatch time.
 *
 * NO foreign key: IntegrationConfigs are NOT DB rows — ConfigurationService keys
 * them in-memory by (tenantId, id) and persists flat `${id}.json` files. There is
 * no table to reference; resolution + validation happen at run time.
 *
 * Idempotency: SQLite swallows the duplicate-column error on replay (mirrors
 * migration 052); Postgres uses native `ADD COLUMN IF NOT EXISTS`.
 */
export const migration: MigrationModule = {
  name: 'add_integration_config_id_to_reconciliation_schedules',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE reconciliation_schedules ADD COLUMN integration_config_id TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE reconciliation_schedules ADD COLUMN IF NOT EXISTS integration_config_id VARCHAR(255)`.execute(db);
    }
    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_schedules_tenant_config ON reconciliation_schedules(tenant_id, integration_config_id)`.execute(db);
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}
