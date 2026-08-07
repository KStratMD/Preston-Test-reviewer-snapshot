import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_indexes',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      // SQLite with better-sqlite3 requires separate execution for each CREATE INDEX statement
      await sql`CREATE INDEX IF NOT EXISTS idx_integration_jobs_integration_id ON integration_jobs(integration_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_integration_jobs_status ON integration_jobs(status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_integration_jobs_created_at ON integration_jobs(created_at)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_config_history_config_id ON integration_config_history(config_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_config_history_version ON integration_config_history(config_id, version)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_config_history_active ON integration_config_history(config_id, is_active)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_execution_logs_integration_id ON integration_execution_logs(integration_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_execution_logs_job_id ON integration_execution_logs(job_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_execution_logs_level ON integration_execution_logs(level)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_execution_logs_created_at ON integration_execution_logs(created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_execution_logs_trace_id ON integration_execution_logs(trace_id)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_quality_reports_integration_id ON data_quality_reports(integration_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_quality_reports_created_at ON data_quality_reports(created_at)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(metric_name, timestamp)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_tenant_config_tenant_id ON tenant_configurations(tenant_id)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys(tenant_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_dead_letter_records_queue ON dead_letter_records(original_queue)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_dead_letter_records_created_at ON dead_letter_records(created_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_dead_letter_records_retried ON dead_letter_records(retried_at)`.execute(db);
    } else {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_integration_jobs_integration_id ON integration_jobs(integration_id);
        CREATE INDEX IF NOT EXISTS idx_integration_jobs_status ON integration_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_integration_jobs_created_at ON integration_jobs(created_at);

        CREATE INDEX IF NOT EXISTS idx_config_history_config_id ON integration_config_history(config_id);
        CREATE INDEX IF NOT EXISTS idx_config_history_version ON integration_config_history(config_id, version);
        CREATE INDEX IF NOT EXISTS idx_config_history_active ON integration_config_history(config_id, is_active);

        CREATE INDEX IF NOT EXISTS idx_execution_logs_integration_id ON integration_execution_logs(integration_id);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_job_id ON integration_execution_logs(job_id);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_level ON integration_execution_logs(level);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_created_at ON integration_execution_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_execution_logs_trace_id ON integration_execution_logs(trace_id);

        CREATE INDEX IF NOT EXISTS idx_quality_reports_integration_id ON data_quality_reports(integration_id);
        CREATE INDEX IF NOT EXISTS idx_quality_reports_created_at ON data_quality_reports(created_at);

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry
          ON webhook_deliveries(next_retry_at) WHERE status = 'retrying';

        CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

        CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(metric_name, timestamp);
        CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);

        CREATE INDEX IF NOT EXISTS idx_tenant_config_tenant_id ON tenant_configurations(tenant_id);

        CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
        CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

        CREATE INDEX IF NOT EXISTS idx_dead_letter_records_queue ON dead_letter_records(original_queue);
        CREATE INDEX IF NOT EXISTS idx_dead_letter_records_created_at ON dead_letter_records(created_at);
        CREATE INDEX IF NOT EXISTS idx_dead_letter_records_retried ON dead_letter_records(retried_at);
        CREATE INDEX IF NOT EXISTS idx_dead_letter_records_error
          ON dead_letter_records USING gin(to_tsvector('english', error));
      `.execute(db);
    }
  },
};
