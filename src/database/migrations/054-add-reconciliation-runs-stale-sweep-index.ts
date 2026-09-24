import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 054 — partial index backing the stale-run reclaim sweep.
 *
 * ReconciliationCenterService.runDueSchedules runs a cross-tenant sweep
 * (ReconciliationScheduleRepository.reclaimStaleRuns) on EVERY scheduler tick,
 * on every replica: `UPDATE reconciliation_runs SET status='failed' WHERE
 * status='running' AND started_at < cutoff`. The only pre-existing index
 * (idx_reconciliation_runs_tenant_schedule, migration 048) does not cover this
 * predicate, so the sweep would scan the whole runs table — which grows
 * unboundedly as run history accumulates — to find a usually-tiny set of
 * `running` rows.
 *
 * A PARTIAL index keyed on started_at, filtered to status='running', exactly
 * covers the predicate and stays near-empty at steady state (almost every row
 * is completed/failed), so it is essentially free to maintain. Both Postgres
 * and modern SQLite (better-sqlite3) support partial indexes with identical
 * `CREATE INDEX ... WHERE` syntax, so no dbType branching is needed.
 * `IF NOT EXISTS` keeps the migration replay-safe.
 */
export const migration: MigrationModule = {
  name: 'add_reconciliation_runs_stale_sweep_index',
  async run(db) {
    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_running_started_at ON reconciliation_runs (started_at) WHERE status = 'running'`.execute(db);
  },
};
