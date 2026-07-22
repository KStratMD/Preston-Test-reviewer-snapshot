import type { Kysely } from 'kysely';
import type { Database } from '../types';
import { migration as m001 } from './001-create-integration-jobs-table';
import { migration as m002 } from './002-create-integration-config-history-table';
import { migration as m003 } from './003-create-integration-execution-logs-table';
import { migration as m004 } from './004-create-data-quality-reports-table';
import { migration as m005 } from './005-create-webhook-deliveries-table';
import { migration as m006 } from './006-create-audit-logs-table';
import { migration as m007 } from './007-create-metrics-table';
import { migration as m008 } from './008-create-tenant-configurations-table';
import { migration as m009 } from './009-create-api-keys-table';
import { migration as m010 } from './010-create-circuit-breaker-states-table';
import { migration as m011 } from './011-create-dead-letter-records-table';
import { migration as m012 } from './012-create-ai-configurations-table';
import { migration as m013 } from './013-seed-ai-configurations-defaults';
import { migration as m014 } from './014-create-mcp-user-settings-table';
import { migration as m015 } from './015-add-mcp-gateway-user-settings-columns';
import { migration as m016 } from './016-create-mcp-tool-policies-table';
import { migration as m017 } from './017-create-sync-cursors-table';
import { migration as m018 } from './018-create-saga-executions-table';
import { migration as m019 } from './019-create-indexes';
import { migration as m020 } from './020-create-mdm-tables';
import { migration as m021 } from './021-create-mdm-indexes';
import { migration as m022 } from './022-create-mdm-survivorship-rules-table';
import { migration as m023 } from './023-create-mdm-survivorship-rules-indexes';
import { migration as m024 } from './024-seed-mdm-survivorship-rules-defaults';
import { migration as m025 } from './025-create-mdm-conflict-stats-table';
import { migration as m026 } from './026-create-mdm-conflict-history-table';
import { migration as m027 } from './027-create-mdm-conflict-indexes';
import { migration as m028 } from './028-create-ai-sessions-table';
import { migration as m029 } from './029-create-reasoning-traces-table';
import { migration as m030 } from './030-create-reasoning-traces-indexes';
import { migration as m031 } from './031-harden-audit-logs-for-persistence';
import { migration as m032 } from './032-create-embedded-sessions-table';
import { migration as m033 } from './033-create-embedded-service-token-versions-table';
import { migration as m034 } from './034-add-tenant-configurations-key-value-index';
import { migration as m035 } from './035-create-sync-error-assist-runs-table';
import { migration as m036 } from './036-create-sync-error-assist-processed-table';
import { migration as m037 } from './037-extend-sync-error-assist-processed';
import { migration as m038 } from './038-add-sync-error-assist-processed-error-last-modified';
import { migration as m039 } from './039-create-finance-central-approvals-table';
import { migration as m040 } from './040-create-tenants-and-status-audit-tables';
import { migration as m041 } from './041-create-workflow-central-tasks-table';
import { migration as m042 } from './042-create-workflow-central-instances-table';
import { migration as m043 } from './043-add-workflow-central-payload-column';
import { migration as m044 } from './044-create-workflow-central-activity-logs-table';
import { migration as m045 } from './045-create-governance-approvals-table';
import { migration as m046 } from './046-add-governance-approvals-decided-index';
import { migration as m047 } from './047-create-cost-rollup-tables';
import { migration as m048 } from './048-create-reconciliation-center-tables';
import { migration as m049 } from './049-create-lineage-events-table';
import { migration as m050 } from './050-add-write-descriptor-to-governance-approvals';
import { migration as m051 } from './051-add-apply-lifecycle-to-governance-approvals';
import { migration as m052 } from './052-add-handler-key-to-reconciliation-schedules';
import { migration as m053 } from './053-reconciliation-schedule-next-run-at-tztz';
import { migration as m054 } from './054-add-reconciliation-runs-stale-sweep-index';
import { migration as m055 } from './055-add-integration-config-id-to-reconciliation-schedules';
import { migration as m056 } from './056-reconciliation-schedules-integration-config-not-null';
import { migration as m057 } from './057-create-suitecentral-control-plane-tables';

export type DbType = 'sqlite' | 'postgres';

export type MigrationName =
  | 'create_integration_jobs_table'
  | 'create_integration_config_history_table'
  | 'create_integration_execution_logs_table'
  | 'create_data_quality_reports_table'
  | 'create_webhook_deliveries_table'
  | 'create_audit_logs_table'
  | 'create_metrics_table'
  | 'create_tenant_configurations_table'
  | 'create_api_keys_table'
  | 'create_circuit_breaker_states_table'
  | 'create_dead_letter_records_table'
  | 'create_ai_configurations_table'
  | 'seed_ai_configurations_defaults'
  | 'create_mcp_user_settings_table'
  | 'add_mcp_gateway_user_settings_columns'
  | 'create_mcp_tool_policies_table'
  | 'create_sync_cursors_table'
  | 'create_saga_executions_table'
  | 'create_indexes'
  | 'create_mdm_tables'
  | 'create_mdm_indexes'
  | 'create_mdm_survivorship_rules_table'
  | 'create_mdm_survivorship_rules_indexes'
  | 'seed_mdm_survivorship_rules_defaults'
  | 'create_mdm_conflict_stats_table'
  | 'create_mdm_conflict_history_table'
  | 'create_mdm_conflict_indexes'
  | 'create_ai_sessions_table'
  | 'create_reasoning_traces_table'
  | 'create_reasoning_traces_indexes'
  | 'harden_audit_logs_for_persistence'
  | 'create_embedded_sessions_table'
  | 'create_embedded_service_token_versions_table'
  | 'add_tenant_configurations_key_value_index'
  | 'create_sync_error_assist_runs_table'
  | 'create_sync_error_assist_processed_table'
  | 'extend_sync_error_assist_processed'
  | 'add_sync_error_assist_processed_error_last_modified'
  | 'create_finance_central_approvals_table'
  | 'create_tenants_and_status_audit_tables'
  | 'create_workflow_central_tasks_table'
  | 'create_workflow_central_instances_table'
  | 'add_workflow_central_payload_column'
  | 'create_workflow_central_activity_logs_table'
  | 'create_governance_approvals_table'
  | 'add_governance_approvals_decided_index'
  | 'create_cost_rollup_tables'
  | 'create_reconciliation_center_tables'
  | 'create_lineage_events_table'
  | 'add_write_descriptor_to_governance_approvals'
  | 'add_apply_lifecycle_to_governance_approvals'
  | 'add_handler_key_to_reconciliation_schedules'
  | 'reconciliation_schedule_next_run_at_tztz'
  | 'add_reconciliation_runs_stale_sweep_index'
  | 'add_integration_config_id_to_reconciliation_schedules'
  | 'reconciliation_schedules_integration_config_not_null'
  | 'create_suitecentral_control_plane_tables';

export interface MigrationModule {
  readonly name: MigrationName;
  run(db: Kysely<Database>, dbType: DbType): Promise<void>;
}

export const MIGRATIONS: readonly MigrationModule[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040,
  m041, m042, m043, m044, m045, m046,
  m047, m048, m049, m050,
  m051, m052, m053, m054, m055, m056,
  m057,
];
