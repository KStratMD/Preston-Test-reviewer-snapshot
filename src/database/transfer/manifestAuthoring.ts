import { migrationManifestHash, type ManifestColumn, type ManifestTable, type TransferManifest } from './manifest';
import type { DiscoveredColumn, DiscoveredSchema, DiscoveredTable } from './schemaDiscovery';
import type { CanonicalKind } from './types';

const JSON_COLUMN_KEYS = new Set([
  'integration_jobs.metadata', 'integration_config_history.configuration', 'integration_execution_logs.metadata',
  'data_quality_reports.validation_rules', 'data_quality_reports.quality_metrics',
  'webhook_deliveries.payload', 'audit_logs.old_values', 'audit_logs.new_values', 'audit_logs.details',
  'dead_letter_records.job_data', 'dead_letter_records.metadata',
  'ai_provider_configs.configuration', 'ai_task_model_configs.model_parameters',
  'ai_sessions.metadata',
  'ai_config_audit_log.old_values', 'ai_config_audit_log.new_values',
  'sync_cursors.metadata', 'saga_executions.steps_json', 'saga_executions.context_json',
  'mdm_golden_records.data', 'mdm_golden_records.conflicts', 'mdm_entity_sources.source_data',
  'mdm_sync_requests.target_systems', 'mdm_survivorship_rules.config', 'mdm_conflict_stats.common_issues',
  'metrics.labels', 'reasoning_traces.metadata', 'suitecentral_allowed_hosts.allowed_ports',
  'suitecentral_environments.rate_limit_config',
  'suitecentral_environments.security_config', 'suitecentral_environments.feature_config',
  'suitecentral_credential_profiles.scopes', 'suitecentral_templates.target_entities',
  'suitecentral_templates.field_mappings', 'suitecentral_templates.business_rules',
  'suitecentral_templates.sync_settings', 'suitecentral_monitoring_configs.thresholds',
  'deferred_serialized_units.normalized_payload',
]);

const UUID_COLUMNS = new Set([
  'integration_jobs.id', 'integration_config_history.id', 'integration_execution_logs.id',
  'data_quality_reports.id', 'webhook_deliveries.id', 'audit_logs.id', 'circuit_breaker_states.id',
  'tenant_configurations.id', 'api_keys.id', 'sync_cursors.id', 'saga_executions.id',
  'sync_error_assist_processed.id', 'finance_central_approvals.id', 'tenant_status_audit.id',
  'metrics.id',
]);

const UUID_TABLE_COLUMNS = new Set<string>();

const BOOL_COLUMNS = new Set([
  'integration_config_history.is_active',
  'ai_provider_configs.is_active', 'ai_provider_configs.is_default',
  'ai_task_model_configs.is_active', 'ai_usage_logs.success',
  'api_keys.is_active',
  'tenant_configurations.is_encrypted',
  'mcp_user_settings.mcp_schema_enabled', 'mcp_user_settings.mcp_ai_context_enabled',
  'mcp_user_settings.mcp_validation_enabled', 'mcp_user_settings.mcp_gateway_enabled',
  'mcp_user_settings.mcp_bc_enabled', 'reconciliation_schedules.active',
  'suitecentral_environments.is_active', 'suitecentral_credential_profiles.is_active',
  'suitecentral_monitoring_configs.enabled',
]);

// This legacy PostgreSQL table deliberately keeps the SQLite-compatible
// integer flag rather than using BOOLEAN; the name-based boolean heuristic
// must not rewrite it.
const INTEGER_COLUMNS = new Set(['mdm_survivorship_rules.is_default']);

// SQLite stores this legacy API-key permission list in a TEXT column while
// the PostgreSQL migration uses its native TEXT[] representation. Keep the
// dialect adapter explicit in the manifest instead of treating the array as a
// generic scalar TEXT value.
const TEXT_ARRAY_COLUMNS = new Set(['api_keys.permissions']);

const INET_COLUMNS = new Set(['audit_logs.ip_address']);

const INSTANT_COLUMNS = new Set([
  'sync_error_assist_processed.error_last_modified_at',
  'tenant_status_audit.occurred_at', 'tenants.status_changed_at', 'tenants.created_at', 'tenants.updated_at',
  'governance_approvals.created_at', 'governance_approvals.expires_at', 'governance_approvals.decided_at',
  'governance_approvals.applied_at', 'governance_approvals.apply_failed_at',
  'workflow_central_activity_logs.timestamp', 'lineage_events.occurred_at',
  'reconciliation_schedules.next_run_at',
  'serialized_asset_retry_operations.lease_expires_at', 'serialized_asset_retry_operations.heartbeat_at',
  'serialized_asset_retry_operations.created_at', 'serialized_asset_retry_operations.started_at',
  'serialized_asset_retry_operations.finished_at', 'deferred_serialized_units.next_attempt_at',
  'deferred_serialized_units.first_deferred_at', 'deferred_serialized_units.last_attempt_at',
  'serialized_asset_sweep_cursors.last_swept_at', 'serialized_asset_sweep_cursors.updated_at',
  'suitecentral_allowed_hosts.created_at', 'suitecentral_allowed_hosts.updated_at',
  'suitecentral_credential_profiles.created_at', 'suitecentral_credential_profiles.updated_at',
  'suitecentral_credential_profiles.rotated_at', 'suitecentral_credential_profiles.last_used_at',
  'suitecentral_environments.created_at', 'suitecentral_environments.updated_at',
  'suitecentral_monitoring_configs.created_at', 'suitecentral_monitoring_configs.updated_at',
  'suitecentral_templates.created_at', 'suitecentral_templates.updated_at',
]);

const NAIVE_TIMESTAMP_COLUMNS = new Set([
  'ai_sessions.started_at', 'ai_sessions.completed_at', 'ai_sessions.created_at',
  'reasoning_traces.timestamp', 'reasoning_traces.created_at', 'reasoning_traces.completed_at',
  'embedded_service_token_versions.valid_from', 'embedded_service_token_versions.valid_until',
]);

const DATE_COLUMNS = new Set(['cost_rollup_daily.date_utc', 'cost_rollup_per_flow.date_utc']);

const EPOCH_INTEGER_COLUMNS = new Set([
  'sync_cursors.last_sync_timestamp', 'sync_cursors.created_at', 'sync_cursors.updated_at',
  'sync_error_assist_runs.last_modified_at', 'saga_executions.created_at',
  'saga_executions.updated_at', 'saga_executions.completed_at',
]);

const DECIMAL_OVERRIDES = new Map<string, { type: string; precision: number; scale: number }>([
  ['data_quality_reports.quality_score', { type: 'DECIMAL(5,2)', precision: 5, scale: 2 }],
  ['ai_usage_logs.estimated_cost', { type: 'DECIMAL(10,6)', precision: 10, scale: 6 }],
  ['finance_central_approvals.amount', { type: 'DECIMAL(15,2)', precision: 15, scale: 2 }],
  ['cost_rollup_daily.total_cost_usd', { type: 'NUMERIC(18,6)', precision: 18, scale: 6 }],
  ['cost_rollup_per_flow.total_cost_usd', { type: 'NUMERIC(18,6)', precision: 18, scale: 6 }],
  ['reconciliation_exceptions.amount_delta', { type: 'NUMERIC(18,6)', precision: 18, scale: 6 }],
]);

const DECIMAL_COLUMNS = new Set([
  'metrics.value', 'ai_usage_logs.estimated_cost', 'finance_central_approvals.amount',
  'cost_rollup_daily.total_cost_usd', 'cost_rollup_per_flow.total_cost_usd',
  'reconciliation_exceptions.amount_delta',
]);
const FLOAT64_COLUMNS = new Set([
  'mdm_golden_records.confidence', 'ai_sessions.overall_confidence', 'reasoning_traces.confidence',
]);

function key(table: string, column: string): string { return `${table}.${column}`; }

function sourceKind(table: string, column: DiscoveredColumn): CanonicalKind {
  const k = key(table, column.name);
  if (UUID_COLUMNS.has(k) || UUID_TABLE_COLUMNS.has(k)) return 'uuid';
  if (TEXT_ARRAY_COLUMNS.has(k)) return 'text_array';
  if (INTEGER_COLUMNS.has(k)) return 'integer';
  if (BOOL_COLUMNS.has(k)) return 'boolean';
  if (JSON_COLUMN_KEYS.has(k)) return 'json';
  if (INET_COLUMNS.has(k)) return 'inet';
  if (DATE_COLUMNS.has(k)) return 'date';
  if (INSTANT_COLUMNS.has(k)) return 'instant_utc';
  if (NAIVE_TIMESTAMP_COLUMNS.has(k)) return 'naive_timestamp';
  if (/DATE?TIME|TIMESTAMP/i.test(column.declaredType)) return 'naive_timestamp';
  if (column.declaredType === 'TEXT' && /(?:_at|timestamp)$/i.test(column.name)) return 'naive_timestamp';
  if (EPOCH_INTEGER_COLUMNS.has(k)) return 'integer';
  if (DECIMAL_COLUMNS.has(k) || DECIMAL_OVERRIDES.has(k)) return 'decimal';
  if (FLOAT64_COLUMNS.has(k)) return 'float64';
  if (/INT/i.test(column.declaredType) && /^(?:is_|has_|enabled$|active$|success$)/i.test(column.name)) return 'boolean';
  if (/INT/i.test(column.declaredType)) return 'integer';
  return 'text';
}

function targetType(table: string, column: DiscoveredColumn, kind: CanonicalKind): string {
  const k = key(table, column.name);
  const decimal = DECIMAL_OVERRIDES.get(k);
  if (decimal) return decimal.type;
  if (kind === 'uuid') return 'UUID';
  if (kind === 'boolean') return 'BOOLEAN';
  if (kind === 'json') return 'JSONB';
  if (kind === 'text_array') return 'TEXT[]';
  if (kind === 'inet') return 'INET';
  if (kind === 'instant_utc') return 'TIMESTAMP WITH TIME ZONE';
  if (kind === 'naive_timestamp') return 'TIMESTAMP WITHOUT TIME ZONE';
  if (kind === 'date') return 'DATE';
  if (kind === 'decimal') return 'DECIMAL';
  if (kind === 'float64') {
    if (k === 'ai_sessions.overall_confidence' || k === 'reasoning_traces.confidence') return 'DOUBLE PRECISION';
    return 'DOUBLE PRECISION';
  }
  if (kind === 'integer') {
    if (EPOCH_INTEGER_COLUMNS.has(k)) return 'BIGINT';
    if (column.hasSequence) return 'SERIAL';
    return 'INTEGER';
  }
  return 'TEXT';
}

function sourceType(column: DiscoveredColumn): string {
  return column.declaredType || 'TEXT';
}

function manifestColumn(table: DiscoveredTable, column: DiscoveredColumn): ManifestColumn {
  const kind = sourceKind(table.name, column);
  const decimal = DECIMAL_OVERRIDES.get(key(table.name, column.name));
  return {
    name: column.name,
    sourceType: sourceType(column),
    targetType: targetType(table.name, column, kind),
    sourceNullable: column.nullable,
    targetNullable: column.nullable,
    kind,
    ...(decimal ? { precision: decimal.precision, scale: decimal.scale } : {}),
    ...(kind === 'float64' ? { floatWidth: 64 as const } : {}),
    ...(kind === 'naive_timestamp' ? { timestampPolicy: 'utc_z_to_naive' as const } : {}),
  };
}

function seedFor(table: DiscoveredTable): ManifestTable['seed'] {
  if (table.name === 'ai_provider_configs') {
    return { identityColumns: ['id'], identities: [['1']], volatileColumns: ['created_at', 'updated_at'], volatileJsonPaths: ['configuration.seededAt'] };
  }
  if (table.name === 'ai_task_model_configs') {
    return { identityColumns: ['id'], identities: [['1'], ['2'], ['3'], ['4']], volatileColumns: ['created_at', 'updated_at'], volatileJsonPaths: ['model_parameters.seededAt'] };
  }
  if (table.name === 'mdm_survivorship_rules') {
    return {
      identityColumns: ['id'],
      identities: [
        ['v-name'], ['v-email'], ['v-phone'], ['v-address'], ['v-taxId'],
        ['c-name'], ['c-email'], ['c-phone'], ['c-creditLimit'],
        ['p-name'], ['p-sku'], ['p-price'], ['p-description'], ['default'],
      ],
    };
  }
  return undefined;
}

export function buildTransferManifest(source: DiscoveredSchema, migrationNames: readonly string[], target?: DiscoveredSchema): TransferManifest {
  if (source.dialect !== 'sqlite') throw new Error('Transfer manifest source must be SQLite');
  // Deliberate constant, not a derived count: a table that appears without
  // anyone updating this number is a table nobody decided to govern, and the
  // transfer would carry it silently. Migration 065 raised it from 52 to 54 by
  // adding embedded_role_grants and embedded_user_assertion_nonces. Both must
  // transfer — grants are the only source of approver authority, so dropping
  // them on a SQLite-to-Postgres move would strip every approver without an
  // error, and a replay ledger left behind stops preventing replay.
  if (source.tables.length !== 54) throw new Error(`Expected 54 governed SQLite tables, found ${source.tables.length}`);
  const targetByName = new Map((target?.tables ?? []).map((table) => [table.name, table]));
  const tables: ManifestTable[] = source.tables.map((table) => {
    const targetTable = targetByName.get(table.name);
    if (target && !targetTable) throw new Error(`Target schema missing table ${table.name}`);
    const columns = table.columns.map((column) => manifestColumn(table, column));
    if (targetTable && targetTable.columns.length !== columns.length) throw new Error(`Target column count drift for ${table.name}`);
    return {
      name: table.name,
      primaryKey: table.primaryKey,
      sortColumns: table.primaryKey.length ? table.primaryKey : table.columns.map((column) => column.name),
      dependsOn: table.dependsOn,
      columns,
      sequenceColumns: table.sequenceColumns,
      ...(seedFor(table) ? { seed: seedFor(table) } : {}),
    };
  });
  return {
    format: 'db-transfer-manifest/v1',
    migrationNames,
    migrationManifestHash: migrationManifestHash(migrationNames),
    tables,
  };
}

export function canonicalKindForColumn(table: string, column: DiscoveredColumn): CanonicalKind {
  return sourceKind(table, column);
}

function storageFamily(type: string): string {
  const normalized = type.toUpperCase();
  if (normalized.includes('CHAR') || normalized === 'TEXT') return 'text';
  if (normalized.startsWith('BOOLEAN')) return 'boolean';
  if (normalized.startsWith('ARRAY') && normalized.includes('_TEXT')) return 'text_array';
  if (normalized.includes('INT') || normalized === 'SERIAL' || normalized === 'BIGSERIAL') return 'integer';
  if (normalized === 'UUID') return 'uuid';
  if (normalized.includes('JSON')) return 'json';
  if (normalized === 'INET') return 'inet';
  if (normalized === 'DATE') return 'date';
  if (normalized.includes('TIMESTAMP') && /\bWITH\s+TIME\s+ZONE\b/.test(normalized)) return 'instant_utc';
  if (normalized.includes('TIMESTAMP')) return 'naive_timestamp';
  if (normalized.includes('DOUBLE')) return 'float64';
  if (normalized === 'REAL') return 'float32';
  if (normalized.includes('NUMERIC') || normalized.includes('DECIMAL')) return 'decimal';
  if (normalized === 'BYTEA') return 'binary';
  return normalized;
}

export function assertPostgresMatchesManifest(schema: DiscoveredSchema, manifest: TransferManifest): void {
  if (schema.dialect !== 'postgres') throw new Error('Expected PostgreSQL schema');
  const expectedTables = new Map(manifest.tables.map((table) => [table.name, table]));
  if (schema.tables.length !== manifest.tables.length) throw new Error('PostgreSQL table count drift');
  for (const actualTable of schema.tables) {
    const expectedTable = expectedTables.get(actualTable.name);
    if (!expectedTable) throw new Error(`PostgreSQL unknown table ${actualTable.name}`);
    const expectedColumns = new Map(expectedTable.columns.map((column) => [column.name, column]));
    if (actualTable.columns.length !== expectedTable.columns.length) throw new Error(`PostgreSQL column count drift for ${actualTable.name}`);
    for (const actualColumn of actualTable.columns) {
      const expectedColumn = expectedColumns.get(actualColumn.name);
      if (!expectedColumn) throw new Error(`PostgreSQL unknown column ${actualTable.name}.${actualColumn.name}`);
      if (actualColumn.nullable !== expectedColumn.targetNullable) throw new Error(`PostgreSQL nullability drift for ${actualTable.name}.${actualColumn.name}`);
      const expectedFamily = expectedColumn.kind;
      if (storageFamily(actualColumn.declaredType) !== expectedFamily) throw new Error(`PostgreSQL type drift for ${actualTable.name}.${actualColumn.name}`);
    }
  }
}
