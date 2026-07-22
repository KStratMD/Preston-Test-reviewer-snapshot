import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { MigrationRunner } from '../../../src/database/MigrationRunner';
import { MIGRATIONS } from '../../../src/database/migrations';
import type { MigrationModule } from '../../../src/database/migrations';
import type { Database } from '../../../src/database/types';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('MigrationRunner', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('runs ordered migrations once and records them', async () => {
    const calls: string[] = [];
    const modules: MigrationModule[] = [
      {
        name: 'create_integration_jobs_table',
        run: async (database) => {
          calls.push('create_integration_jobs_table');
          await sql`CREATE TABLE integration_jobs (id TEXT PRIMARY KEY)`.execute(database);
        },
      },
    ];

    const runner = new MigrationRunner({
      db,
      dbType: 'sqlite',
      modules,
      logger,
    });

    await runner.runAll();
    await runner.runAll();

    expect(calls).toEqual(['create_integration_jobs_table']);
    const result = await sql<{ name: string }>`SELECT name FROM migrations`.execute(db);
    expect(result.rows.map((row) => row.name)).toEqual(['create_integration_jobs_table']);
  });
});

describe('MIGRATIONS registry', () => {
  it('keeps the canonical migration order', () => {
    expect(MIGRATIONS.map((migration) => migration.name)).toEqual([
      'create_integration_jobs_table',
      'create_integration_config_history_table',
      'create_integration_execution_logs_table',
      'create_data_quality_reports_table',
      'create_webhook_deliveries_table',
      'create_audit_logs_table',
      'create_metrics_table',
      'create_tenant_configurations_table',
      'create_api_keys_table',
      'create_circuit_breaker_states_table',
      'create_dead_letter_records_table',
      'create_ai_configurations_table',
      'seed_ai_configurations_defaults',
      'create_mcp_user_settings_table',
      'add_mcp_gateway_user_settings_columns',
      'create_mcp_tool_policies_table',
      'create_sync_cursors_table',
      'create_saga_executions_table',
      'create_indexes',
      'create_mdm_tables',
      'create_mdm_indexes',
      'create_mdm_survivorship_rules_table',
      'create_mdm_survivorship_rules_indexes',
      'seed_mdm_survivorship_rules_defaults',
      'create_mdm_conflict_stats_table',
      'create_mdm_conflict_history_table',
      'create_mdm_conflict_indexes',
      'create_ai_sessions_table',
      'create_reasoning_traces_table',
      'create_reasoning_traces_indexes',
      'harden_audit_logs_for_persistence',
      'create_embedded_sessions_table',
      'create_embedded_service_token_versions_table',
      'add_tenant_configurations_key_value_index',
      'create_sync_error_assist_runs_table',
      'create_sync_error_assist_processed_table',
      'extend_sync_error_assist_processed',
      'add_sync_error_assist_processed_error_last_modified',
      'create_finance_central_approvals_table',
      'create_tenants_and_status_audit_tables',
      'create_workflow_central_tasks_table',
      'create_workflow_central_instances_table',
      'add_workflow_central_payload_column',
      'create_workflow_central_activity_logs_table',
      'create_governance_approvals_table',
      'add_governance_approvals_decided_index',
      'create_cost_rollup_tables',
      'create_reconciliation_center_tables',
      'create_lineage_events_table',
      'add_write_descriptor_to_governance_approvals',
      'add_apply_lifecycle_to_governance_approvals',
      'add_handler_key_to_reconciliation_schedules',
      'reconciliation_schedule_next_run_at_tztz',
      'add_reconciliation_runs_stale_sweep_index',
      'add_integration_config_id_to_reconciliation_schedules',
      'reconciliation_schedules_integration_config_not_null',
      'create_suitecentral_control_plane_tables',
    ]);
  });

  it('uses unique names', () => {
    const names = MIGRATIONS.map((migration) => migration.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
