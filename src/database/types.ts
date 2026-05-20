import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type JsonColumn = ColumnType<object, object | string, object | string>;
type NullableJsonColumn = ColumnType<object | null, object | string | null | undefined, object | string | null>;
type DateColumn = ColumnType<Date | string, Date | string, Date | string>;
type GeneratedDateColumn = ColumnType<Date | string, Date | string | undefined, Date | string>;
type Override<TBase, TOverrides extends object> = Omit<TBase, keyof TOverrides> & TOverrides;

// Database table definitions
export interface IntegrationJobsTable {
  id: Generated<string>;
  integration_id: string;
  queue_job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  total_records: number;
  processed_records: number;
  failed_records: number;
  batch_size: number;
  priority: number;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  metadata: object | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IntegrationConfigHistoryTable {
  id: Generated<string>;
  config_id: string;
  version: number;
  configuration: object;
  checksum: string;
  is_active: boolean;
  created_by: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface IntegrationExecutionLogsTable {
  id: Generated<string>;
  integration_id: string;
  job_id: string | null;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata: object | null;
  trace_id: string | null;
  span_id: string | null;
  created_at: Generated<Date>;
}

export interface DataQualityReportsTable {
  id: Generated<string>;
  integration_id: string;
  job_id: string | null;
  source_system: string;
  target_system: string;
  record_count: number;
  valid_records: number;
  invalid_records: number;
  duplicate_records: number;
  quality_score: number;
  validation_rules: object;
  quality_metrics: object;
  created_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  event_type: string;
  payload: object;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  http_status: number | null;
  response_body: string | null;
  attempt_count: number;
  next_retry_at: Date | null;
  delivered_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  old_values: NullableJsonColumn;
  new_values: NullableJsonColumn;
  details: NullableJsonColumn;
  result: ColumnType<'success' | 'failure', 'success' | 'failure' | undefined, 'success' | 'failure'>;
  error_message: ColumnType<string | null, string | null | undefined, string | null>;
  duration_ms: ColumnType<number | null, number | null | undefined, number | null>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: GeneratedDateColumn;
}

export interface SyncErrorAssistRunsTable {
  tenant_id: string;
  last_modified_at: number;     // epoch-ms (matches sync_cursors precedent)
  updated_at: ColumnType<string, string | undefined, string>;
}

export interface SyncErrorAssistProcessedTable {
  id: Generated<string>;
  tenant_id: string;
  error_record_id: string;
  status: string;          // ProcessedStatus union; type-narrowed in repo
  attempts: number;
  suggestion_record_id: string | null;
  trace_id: string | null;
  provider: string | null;
  cost_estimate_usd_cents: number | null;
  failure_reason: string | null;
  reserved_at: ColumnType<string, string, string>;
  completed_at: ColumnType<string | null, string | null | undefined, string | null>;

  // AI suggestion fields (mirror what's written to NetSuite by PR 17a;
  // surfaced locally so the operator list endpoint avoids per-list NS calls).
  confidence: string | null;             // 'high' | 'mid' | 'low'
  suggestion_type: string | null;        // 'create_missing_record' | 'fix_field_value' | 'manual_review'
  suggestion_text: string | null;
  references_field: string | null;

  // Operator disposition state machine.
  // 'pending' (default) → 'applying' (lease held by accept caller, not user-visible)
  //   → 'accepted' (success), 'rejected' (terminal), 'escalated' (terminal)
  //   OR 'applying' → 'pending' on connector-write failure (returnable for retry).
  operator_disposition: Generated<string>; // narrowed in the repo by OperatorDisposition union; DB default 'pending'
  operator_disposition_at: string | null;
  operator_disposition_user_id: string | null;

  // Snapshot of the NetSuite error record's lastModified at claim time.
  // Populated by claim() from polling-page records and webhook payloads;
  // null for rows that pre-date migration 038. reapStuckProcessing()'s
  // post-reap watermark reset uses MIN(error_last_modified_at) across
  // surviving failed_retryable rows to close the residual READ COMMITTED
  // race documented in SyncErrorAssistRepository.tryAdvanceWatermark.
  //
  // Runtime return shape diverges by backend: node-postgres parses TIMESTAMPTZ
  // results into `Date` objects, while better-sqlite3 returns TEXT values
  // verbatim as strings. Select type accepts both; SyncErrorAssistRepository
  // .recoverWatermarkAfterReap coerces inline via
  // `value instanceof Date ? value.getTime() : new Date(value).getTime()`
  // before arithmetic. No shared helper exists.
  error_last_modified_at: ColumnType<
    Date | string | null,
    string | null | undefined,
    Date | string | null
  >;
}

export type SyncErrorAssistProcessed = Selectable<SyncErrorAssistProcessedTable>;
export type NewSyncErrorAssistProcessed = Insertable<SyncErrorAssistProcessedTable>;

// Operator-promotion of FinanceCentralService approvals (migration 039).
// Two-stage state machine mirrors SyncErrorAssist: pending → applying → accepted,
// with revert-on-failure. See docs/plans/2026-05-13-operator-promotion-spec.md §2.D5.
export interface FinanceCentralApprovalsTable {
  id: Generated<string>;
  tenant_id: string;
  approval_id: string;
  document_id: string;
  document_number: string;
  document_type: string; // invoice | bill | purchase_order | expense_report | journal_entry
  description: string;
  entity_name: string | null;
  employee_name: string | null;
  // Runtime drift: SQLite REAL returns number; Postgres DECIMAL(15,2) returns
  // string (the `pg` driver's default — installing a custom type parser
  // would change this). The Kysely type pins `number` for caller ergonomics;
  // `FinanceCentralRepository.listPendingApprovals` coerces `Number(r.amount)`
  // at the read boundary so consumers always see a JS number regardless of
  // backend (PR 6 R2 / Codex SC-1).
  amount: number;
  currency: string;
  submitted_by: string;
  submitted_at: ColumnType<string, string, string>;
  current_approver: string;
  approval_level: number;
  priority: string; // low | medium | high | urgent — narrowed in service layer
  netsuite_id: string | null;

  // Operator disposition state machine.
  // 'pending' (default) → 'applying' (lease held by accept caller, not user-visible)
  //   → 'accepted' (success), 'rejected' (terminal)
  //   OR 'applying' → 'pending' on connector-write failure (returnable for retry).
  operator_disposition: Generated<string>; // narrowed in repo by ApprovalDisposition union; DB default 'pending'
  operator_disposition_at: string | null;
  operator_disposition_user_id: string | null;

  applied_record_id: string | null;
  rejection_reason: string | null;
  approval_comments: string | null;
  created_at: ColumnType<string, string, string>;
  updated_at: ColumnType<string, string, string>;
}

export type FinanceCentralApproval = Selectable<FinanceCentralApprovalsTable>;
export type NewFinanceCentralApproval = Insertable<FinanceCentralApprovalsTable>;

// Tenant lifecycle status table (migration 040).
// Single source of truth for tenant status — gated by tenantStatusGate middleware.
// Status CHECK constraint is defence-in-depth; transitions enforced in TenantLifecycleService.
export interface TenantsTable {
  id: string;
  status: Generated<string>; // 'active' (DB default) | 'suspended' | 'disabled' | 'trial_expired' — narrowed in service layer
  status_changed_at: string | null;
  status_changed_by: string | null;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type Tenant = Selectable<TenantsTable>;
export type NewTenant = Insertable<TenantsTable>;
export type UpdateableTenant = Updateable<TenantsTable>;

// Immutable audit trail for every tenant status transition (migration 040).
// seq is auto-increment (SQLite AUTOINCREMENT / Postgres BIGSERIAL) and is the
// stable ordering key; occurred_at is ms-precision only. id is UUID for API
// reference (app-supplied on SQLite, gen_random_uuid() default on Postgres).
export interface TenantStatusAuditTable {
  seq: Generated<number>;
  id: Generated<string>;
  tenant_id: string;
  previous_status: string;
  new_status: string;
  actor_user_id: string;
  actor_source: string;
  reason: string | null;
  occurred_at: string;
}

export type TenantStatusAudit = Selectable<TenantStatusAuditTable>;
export type NewTenantStatusAudit = Insertable<TenantStatusAuditTable>;

// Operator-promotion of WorkflowCentralService task management (migration 041).
// Tasks are created per workflow step for manual approval/completion by operators.
// See docs/plans/2026-05-14-workflow-central-operator-promotion-spec.md §2.D3.
export interface WorkflowCentralTaskTable {
  // Caller-supplied task ID in the existing `TASK-${Date.now()}-...` format
  // (spec §2.D3; UUIDv7 migration deferred). NOT `Generated<string>`.
  id: string;
  tenant_id: string;
  instance_id: string;
  workflow_id: string;
  workflow_name: string;
  step_id: string;
  step_name: string;
  task_type: string;
  status: 'pending' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id: string;
  assignee_name: string;
  description: string;
  due_at: string | null;
  /** @deprecated — superseded by `payload` in governance-without-hosting-data Phase 1 (ADR-019). Phase 1 follow-up (migration 044) drops this column. */
  data: string;       // JSON-stringified Record<string, unknown>
  actions: string;    // JSON-stringified TaskAction[]
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
  completion_action_id: string | null;
  completion_comment: string | null;
  /** JSON-serialized WorkflowPayload tagged union (ADR-019). Null for legacy rows pre-backfill. */
  payload: string | null;
}

export type WorkflowCentralTask = Selectable<WorkflowCentralTaskTable>;
export type NewWorkflowCentralTask = Insertable<WorkflowCentralTaskTable>;

// Durable workflow instance row (PR-OP-3, migration 042).
// Spec refs: §4.1, D5 (JSON columns), D8 (no cancellation_reason), D23 (paused_from_status).
// status and paused_from_status are left as string (not a narrow union) so that the
// repo-level deserializer can validate/narrow at read time rather than at the DB layer.
export interface WorkflowCentralInstanceTable {
  id: string;
  tenant_id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  status: string;                       // narrow at repo deserialize boundary
  current_step_id: string | null;
  current_step_name: string | null;
  /** @deprecated — superseded by `payload` in governance-without-hosting-data Phase 1 (ADR-019). Phase 1 follow-up (migration 044) drops this column. */
  variables: string;                    // JSON TEXT — Record<string, unknown>
  step_history: string;                 // JSON TEXT — StepHistoryEntry[]
  /** JSON-serialized WorkflowPayload tagged union (ADR-019). Null for legacy rows pre-backfill. */
  payload: string | null;
  started_by: string;
  started_at: string;
  completed_at: string | null;
  due_at: string | null;
  error: string | null;
  paused_from_status: string | null;   // D23: set when pausing, cleared on resume
  created_at: string;
  updated_at: string;
}

export type WorkflowCentralInstance = Selectable<WorkflowCentralInstanceTable>;
export type NewWorkflowCentralInstance = Insertable<WorkflowCentralInstanceTable>;
export type WorkflowCentralInstanceUpdate = Updateable<WorkflowCentralInstanceTable>;

export interface WorkflowCentralActivityLogTable {
  id: string;
  tenant_id: string;
  instance_id: string;
  workflow_name: string;
  action: string;                       // narrow at repo deserialize boundary
  user_id: string;
  user_name: string;
  step_name: string | null;
  details: string | null;               // JSON-or-prose payload (caller's choice)
  timestamp: string;
}

export type WorkflowCentralActivityLog = Selectable<WorkflowCentralActivityLogTable>;
export type NewWorkflowCentralActivityLog = Insertable<WorkflowCentralActivityLogTable>;

// HITL approval-queue table (PR 3A; migration 045).
// status / operation_type / risk_level kept as `string` at the schema layer;
// narrowed at the repository deserialize boundary so the DB enforcement is a
// CHECK constraint candidate without forcing test fixtures to import unions.
// `apply_idempotency_key` is intentionally NOT UNIQUE — the contract is a
// per-approval CAS in `claimForApply`, not a global key invariant.
//
// Timestamp columns are typed as `Date | string` (Selectable side) because the
// runtime return shape diverges by backend: Postgres TIMESTAMPTZ comes back
// as a `Date` via node-postgres; SQLite returns the raw TEXT verbatim. The
// repository deserializer (`rowToPersistedApproval`) coerces both to ISO
// strings before any in-memory comparison so the TTL gate (R3) and the
// disambiguation read (R4) operate on a single representation. Mirrors the
// convention in `SyncErrorAssistProcessedTable.error_last_modified_at`
// (Copilot R6 on PR #819).
export interface GovernanceApprovalsTable {
  id: string;
  tenant_id: string;
  requester_user_id: string;
  operation_type: string;               // 'ai_call' | 'connector_write' | 'audit_log' — narrowed in repo
  resource_type: string;
  resource_id: string;
  risk_level: string;                   // 'low' | 'medium' | 'high' — narrowed in repo
  redacted_payload: string;             // JSON TEXT — DLP-scanned form from OutboundDecision.redactedPayload
  policy_findings: string;              // JSON TEXT — string[] of PII types
  status: string;                       // 'pending' | 'approved' | 'rejected' | 'expired' — narrowed in repo
  created_at: ColumnType<Date | string, Date | string, Date | string>;
  expires_at: ColumnType<Date | string, Date | string, Date | string>;
  decided_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  decided_by_user_id: string | null;
  decision_reason: string | null;
  apply_idempotency_key: string | null;
}

export type GovernanceApproval = Selectable<GovernanceApprovalsTable>;
export type NewGovernanceApproval = Insertable<GovernanceApprovalsTable>;
export type GovernanceApprovalUpdate = Updateable<GovernanceApprovalsTable>;

export interface MetricsTable {
  id: Generated<string>;
  metric_name: string;
  metric_type: 'counter' | 'gauge' | 'histogram' | 'summary';
  value: number;
  labels: object | null;
  timestamp: Date;
  created_at: Generated<Date>;
}

export interface TenantConfigurationsTable {
  id: Generated<string>;
  tenant_id: string;
  setting_key: string;
  setting_value: string;
  is_encrypted: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  tenant_id: string | null;
  key_name: string;
  key_hash: string;
  key_prefix: string;
  permissions: string[];
  rate_limit: number | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_active: boolean;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CircuitBreakerStatesTable {
  id: Generated<string>;
  service_name: string;
  state: 'closed' | 'open' | 'half-open';
  failure_count: number;
  success_count: number;
  last_failure_at: Date | null;
  last_success_at: Date | null;
  opened_at: Date | null;
  next_attempt_at: Date | null;
  updated_at: Generated<Date>;
}

export interface DeadLetterRecordsTable {
  id: string;
  original_queue: string;
  job_id: string;
  job_data: object;
  error: string;
  failure_count: number;
  last_attempt_at: Date;
  retried_at: Date | null;
  retry_queue: string | null;
  metadata: object | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OAuthClientsTable {
  id: Generated<string>;
  client_id: string;
  client_secret: string;
  name: string;
  tenant_id: string | null;
  redirect_uris: string; // JSON string
  grant_types: string; // JSON string
  scopes: string; // JSON string
  is_active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OAuthAccessTokensTable {
  id: Generated<string>;
  token_hash: string;
  client_id: string;
  user_id: string | null;
  tenant_id: string | null;
  scopes: string; // JSON string
  expires_at: Date;
  revoked: boolean;
  revoked_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OAuthRefreshTokensTable {
  id: Generated<string>;
  token: string;
  client_id: string;
  user_id: string | null;
  tenant_id: string | null;
  scopes: string; // JSON string
  expires_at: Date;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OAuthAuthorizationCodesTable {
  id: Generated<string>;
  code: string;
  client_id: string;
  user_id: string | null;
  redirect_uri: string;
  scopes: string; // JSON string
  used: boolean;
  expires_at: Date;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApiKeyUsageTable {
  id: Generated<string>;
  key_id: string;
  endpoint: string;
  method: string;
  status_code: number;
  response_status: number;
  response_time: number;
  request_size: number | null;
  response_size: number | null;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: Date;
  created_at: Generated<Date>;
}

// AI Configuration Tables
export interface AIProviderConfigsTable {
  id: Generated<number>;
  user_id: number;
  organization_id: number | null;
  provider_type: string;
  provider_name: string;
  encrypted_api_key: string | null;
  endpoint_url: string | null;
  is_active: boolean;
  is_default: boolean;
  configuration: string | object;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AITaskModelConfigsTable {
  id: Generated<number>;
  user_id: number;
  organization_id: number | null;
  task_type: string;
  provider_config_id: number;
  model_version: string;
  model_parameters: string | object;
  is_active: boolean;
  priority: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AIUsageLogsTable {
  id: Generated<number>;
  user_id: number;
  organization_id: number | null;
  provider_config_id: number | null;
  task_model_config_id: number | null;
  task_type: string;
  provider_type: string;
  model_version: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  request_type: string;
  session_id: string | null;
  execution_time_ms: number;
  success: boolean;
  error_message: string | null;
  records_processed: number;
  fields_analyzed: number;
  created_at: Generated<Date>;
}

export interface AIConfigAuditLogTable {
  id: Generated<number>;
  user_id: number;
  config_type: string;
  config_id: number;
  action: string;
  old_values: object | null;
  new_values: object | null;
  created_at: Generated<Date>;
}

// Connector Credential Tables
export interface ConnectorCredentialsTable {
  id: Generated<number>;
  user_id: number;
  organization_id: number | null;
  connector_id: string;
  connector_name: string;
  environment: string;
  encrypted_credentials: string;
  credential_type: string;
  encryption_version: string;
  is_active: boolean;
  last_tested_at: Date | null;
  last_test_status: string | null;
  last_test_error: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: number | null;
  updated_by: number | null;
}

export interface ConnectorCredentialAuditLogTable {
  id: Generated<number>;
  credential_id: number | null;
  user_id: number;
  organization_id: number | null;
  action: string;
  action_status: string;
  old_values: object | null;
  new_values: object | null;
  change_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  session_id: string | null;
  access_granted: boolean;
  denial_reason: string | null;
  created_at: Generated<Date>;
}

export interface ConnectorMetadataTable {
  id: Generated<number>;
  connector_id: string;
  connector_name: string;
  connector_type: string;
  supported_auth_types: object;
  required_credential_fields: object;
  optional_credential_fields: object | null;
  default_credential_type: string | null;
  supports_sandbox: boolean;
  supports_multi_environment: boolean;
  connection_test_endpoint: string | null;
  documentation_url: string | null;
  vendor_name: string | null;
  vendor_website: string | null;
  logo_url: string | null;
  description: string | null;
  is_active: boolean;
  is_beta: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// MDM Tables
export interface MDMGoldenRecordsTable {
  id: string;
  entity_type: string;
  data: JsonColumn;
  confidence: number;
  conflicts: JsonColumn;
  conflict_count: number;
  status: string;
  approved_by: string | null;
  approved_at: DateColumn | null;
  created_at: GeneratedDateColumn;
  updated_at: GeneratedDateColumn;
}

export interface MDMEntitySourcesTable {
  id: Generated<number>;
  golden_record_id: string;
  source_system: string;
  source_record_id: string;
  source_data: JsonColumn;
  last_synced_at: DateColumn;
  sync_status: string;
  created_at: GeneratedDateColumn;
}

export interface MDMSyncRequestsTable {
  id: string;
  golden_record_id: string;
  target_systems: JsonColumn;
  requested_by: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: DateColumn | null;
  created_at: GeneratedDateColumn;
}

export interface MDMSurvivorshipRulesTable {
  id: string;
  entity_type: string;
  field_name: string;
  strategy: string;
  config: JsonColumn;
  priority: number;
  is_default: number;
  created_at: GeneratedDateColumn;
  updated_at: GeneratedDateColumn;
}

export interface MDMConflictStatsTable {
  id: Generated<number>;
  field_name: string;
  source_system: string;
  target_system: string;
  conflict_count: number;
  resolution_count: number;
  auto_resolution_count: number;
  manual_resolution_count: number;
  last_conflict_at: DateColumn;
  common_issues: JsonColumn;
  created_at: GeneratedDateColumn;
  updated_at: GeneratedDateColumn;
}

export interface MDMConflictHistoryTable {
  id: Generated<number>;
  field_name: string;
  source_a: string;
  source_b: string;
  value_a: unknown;
  value_b: unknown;
  resolution: string;
  created_at: GeneratedDateColumn;
}

// AI Sessions & Reasoning Traces Tables
export interface AISessionsTable {
  session_id: string;
  user_id: string | null;
  workflow_type: string | null;
  started_at: Date;
  completed_at: Date | null;
  status: string | null;
  overall_confidence: number | null;
  total_execution_time: number | null;
  metadata: object | null;
  created_at: Generated<Date>;
}

export interface ReasoningTracesTable {
  id: string;
  session_id: string;
  step_number: number;
  agent_name: string;
  action: string;
  input_summary: string | null;
  output_summary: string | null;
  confidence: number | null;
  reasoning: string | null;
  timestamp: Date;
  execution_time: number | null;
  user_id: string | null;
  metadata: object | null;
  created_at: Generated<Date>;
}

// Database interface
export interface Database {
  integration_jobs: IntegrationJobsTable;
  integration_config_history: IntegrationConfigHistoryTable;
  integration_execution_logs: IntegrationExecutionLogsTable;
  data_quality_reports: DataQualityReportsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  audit_logs: AuditLogsTable;
  metrics: MetricsTable;
  tenant_configurations: TenantConfigurationsTable;
  api_keys: ApiKeysTable;
  circuit_breaker_states: CircuitBreakerStatesTable;
  dead_letter_records: DeadLetterRecordsTable;
  oauth_clients: OAuthClientsTable;
  oauth_access_tokens: OAuthAccessTokensTable;
  oauth_refresh_tokens: OAuthRefreshTokensTable;
  oauth_authorization_codes: OAuthAuthorizationCodesTable;
  api_key_usage: ApiKeyUsageTable;
  ai_provider_configs: AIProviderConfigsTable;
  ai_task_model_configs: AITaskModelConfigsTable;
  ai_usage_logs: AIUsageLogsTable;
  ai_config_audit_log: AIConfigAuditLogTable;
  connector_credentials: ConnectorCredentialsTable;
  connector_credential_audit_log: ConnectorCredentialAuditLogTable;
  connector_metadata: ConnectorMetadataTable;
  mdm_golden_records: MDMGoldenRecordsTable;
  mdm_entity_sources: MDMEntitySourcesTable;
  mdm_sync_requests: MDMSyncRequestsTable;
  mdm_survivorship_rules: MDMSurvivorshipRulesTable;
  mdm_conflict_stats: MDMConflictStatsTable;
  mdm_conflict_history: MDMConflictHistoryTable;
  ai_sessions: AISessionsTable;
  reasoning_traces: ReasoningTracesTable;
  embedded_sessions: EmbeddedSessionsTable;
  embedded_service_token_versions: EmbeddedServiceTokenVersionsTable;
  sync_error_assist_runs: SyncErrorAssistRunsTable;
  sync_error_assist_processed: SyncErrorAssistProcessedTable;
  finance_central_approvals: FinanceCentralApprovalsTable;
  tenants: TenantsTable;
  tenant_status_audit: TenantStatusAuditTable;
  workflow_central_tasks: WorkflowCentralTaskTable;
  workflow_central_instances: WorkflowCentralInstanceTable;
  workflow_central_activity_logs: WorkflowCentralActivityLogTable;
  governance_approvals: GovernanceApprovalsTable;
}

// ----- Embedded ERP Surface Contract (PR 10a) ------------------------------

/**
 * One row per active embedded session (created by host-bootstrap, consumed by
 * guest context-fetch, retired by sendBeacon DELETE or EmbeddedRetentionJob).
 */
export interface EmbeddedSessionsTable {
  session_id: string;
  tenant_id: string;
  user_id: string;
  platform: string;
  platform_account_id: string | null;
  csrf_token: string;
  expected_host_origin: string;
  expires_at: Date | string;
  last_rotation_at: Date | string | null;
  erp_record_type: string | null;
  erp_record_id: string | null;
  erp_record_url: string | null;
  /** JSON-encoded string[] (e.g. '["finance","ops"]'). Persisted as TEXT
   *  rather than JSONB so the sqlite test backend works identically to
   *  postgres prod. Never queried by the JSON contents — opaque to the DB. */
  user_roles: string | null;
  created_at: Generated<Date | string>;
}

export type EmbeddedSession = Selectable<EmbeddedSessionsTable>;
export type NewEmbeddedSession = Insertable<EmbeddedSessionsTable>;
export type EmbeddedSessionUpdate = Updateable<EmbeddedSessionsTable>;

/**
 * One row per service-token version (active OR retired). Hot-path validation
 * looks up by token_hash. The raw token lives in SecureCredentialManager
 * (one current entry per tenant); the multi-version overlap window is fully
 * represented here so validation never has to read through SCM.
 */
export interface EmbeddedServiceTokenVersionsTable {
  token_hash: string;
  tenant_id: string;
  platform: string;
  platform_account_id: string;
  valid_from: Date | string;
  valid_until: Date | string;
  retired_at: Date | string | null;
  created_at: Generated<Date | string>;
}

export type EmbeddedServiceTokenVersion = Selectable<EmbeddedServiceTokenVersionsTable>;
export type NewEmbeddedServiceTokenVersion = Insertable<EmbeddedServiceTokenVersionsTable>;

export type SyncErrorAssistRun = Selectable<SyncErrorAssistRunsTable>;
export type NewSyncErrorAssistRun = Insertable<SyncErrorAssistRunsTable>;

// Type helpers
export type IntegrationJob = Selectable<IntegrationJobsTable>;
export type NewIntegrationJob = Insertable<IntegrationJobsTable>;
export type IntegrationJobUpdate = Updateable<IntegrationJobsTable>;

export type IntegrationConfigHistory = Selectable<IntegrationConfigHistoryTable>;
export type NewIntegrationConfigHistory = Insertable<IntegrationConfigHistoryTable>;

export type IntegrationExecutionLog = Selectable<IntegrationExecutionLogsTable>;
export type NewIntegrationExecutionLog = Insertable<IntegrationExecutionLogsTable>;

export type DataQualityReport = Selectable<DataQualityReportsTable>;
export type NewDataQualityReport = Insertable<DataQualityReportsTable>;

export type WebhookDelivery = Selectable<WebhookDeliveriesTable>;
export type NewWebhookDelivery = Insertable<WebhookDeliveriesTable>;
export type WebhookDeliveryUpdate = Updateable<WebhookDeliveriesTable>;

export type AuditLog = Selectable<AuditLogsTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;

export type Metric = Selectable<MetricsTable>;
export type NewMetric = Insertable<MetricsTable>;

export type TenantConfiguration = Selectable<TenantConfigurationsTable>;
export type NewTenantConfiguration = Insertable<TenantConfigurationsTable>;
export type TenantConfigurationUpdate = Updateable<TenantConfigurationsTable>;

export type ApiKey = Selectable<ApiKeysTable>;
export type NewApiKey = Insertable<ApiKeysTable>;
export type ApiKeyUpdate = Updateable<ApiKeysTable>;

export type CircuitBreakerState = Selectable<CircuitBreakerStatesTable>;
export type NewCircuitBreakerState = Insertable<CircuitBreakerStatesTable>;
export type CircuitBreakerStateUpdate = Updateable<CircuitBreakerStatesTable>;

export type DeadLetterRecord = Selectable<DeadLetterRecordsTable>;
export type NewDeadLetterRecord = Insertable<DeadLetterRecordsTable>;
export type DeadLetterRecordUpdate = Updateable<DeadLetterRecordsTable>;

export type OAuthClient = Selectable<OAuthClientsTable>;
export type NewOAuthClient = Insertable<OAuthClientsTable>;
export type OAuthClientUpdate = Updateable<OAuthClientsTable>;

export type OAuthAccessToken = Selectable<OAuthAccessTokensTable>;
export type NewOAuthAccessToken = Insertable<OAuthAccessTokensTable>;
export type OAuthAccessTokenUpdate = Updateable<OAuthAccessTokensTable>;

export type OAuthRefreshToken = Selectable<OAuthRefreshTokensTable>;
export type NewOAuthRefreshToken = Insertable<OAuthRefreshTokensTable>;
export type OAuthRefreshTokenUpdate = Updateable<OAuthRefreshTokensTable>;

export type OAuthAuthorizationCode = Selectable<OAuthAuthorizationCodesTable>;
export type NewOAuthAuthorizationCode = Insertable<OAuthAuthorizationCodesTable>;
export type OAuthAuthorizationCodeUpdate = Updateable<OAuthAuthorizationCodesTable>;

export type ApiKeyUsage = Selectable<ApiKeyUsageTable>;
export type NewApiKeyUsage = Insertable<ApiKeyUsageTable>;
export type ApiKeyUsageUpdate = Updateable<ApiKeyUsageTable>;

export type AIProviderConfig = Selectable<AIProviderConfigsTable>;
export type NewAIProviderConfig = Insertable<AIProviderConfigsTable>;
export type AIProviderConfigUpdate = Updateable<AIProviderConfigsTable>;

export type AITaskModelConfig = Selectable<AITaskModelConfigsTable>;
export type NewAITaskModelConfig = Insertable<AITaskModelConfigsTable>;
export type AITaskModelConfigUpdate = Updateable<AITaskModelConfigsTable>;

export type AIUsageLog = Selectable<AIUsageLogsTable>;
export type NewAIUsageLog = Insertable<AIUsageLogsTable>;

export type AIConfigAuditLog = Selectable<AIConfigAuditLogTable>;
export type NewAIConfigAuditLog = Insertable<AIConfigAuditLogTable>;

export type ConnectorCredentials = Selectable<ConnectorCredentialsTable>;
export type NewConnectorCredentials = Insertable<ConnectorCredentialsTable>;
export type ConnectorCredentialsUpdate = Updateable<ConnectorCredentialsTable>;

export type ConnectorCredentialAuditLog = Selectable<ConnectorCredentialAuditLogTable>;
export type NewConnectorCredentialAuditLog = Insertable<ConnectorCredentialAuditLogTable>;

export type ConnectorMetadata = Selectable<ConnectorMetadataTable>;
export type NewConnectorMetadata = Insertable<ConnectorMetadataTable>;
export type ConnectorMetadataUpdate = Updateable<ConnectorMetadataTable>;

export type MDMGoldenRecordRow = Selectable<MDMGoldenRecordsTable>;
export type NewMDMGoldenRecord = Override<Insertable<MDMGoldenRecordsTable>, {
  data: object;
  conflicts: object;
}>;
export type MDMGoldenRecordUpdate = Override<Updateable<MDMGoldenRecordsTable>, {
  data?: object;
  conflicts?: object;
}>;

export type MDMEntitySourceRow = Selectable<MDMEntitySourcesTable>;
export type NewMDMEntitySource = Override<Insertable<MDMEntitySourcesTable>, {
  source_data: object;
}>;

export type MDMSyncRequestRow = Selectable<MDMSyncRequestsTable>;
export type NewMDMSyncRequest = Override<Insertable<MDMSyncRequestsTable>, {
  target_systems: object;
}>;
export type MDMSyncRequestUpdate = Override<Updateable<MDMSyncRequestsTable>, {
  target_systems?: object;
}>;

export type MDMSurvivorshipRuleRow = Selectable<MDMSurvivorshipRulesTable>;
export type NewMDMSurvivorshipRule = Override<Insertable<MDMSurvivorshipRulesTable>, {
  config: object;
}>;
export type MDMSurvivorshipRuleUpdate = Override<Updateable<MDMSurvivorshipRulesTable>, {
  config?: object;
}>;

export type MDMConflictStatRow = Selectable<MDMConflictStatsTable>;
export type NewMDMConflictStat = Override<Insertable<MDMConflictStatsTable>, {
  common_issues: object;
}>;
export type MDMConflictStatUpdate = Override<Updateable<MDMConflictStatsTable>, {
  common_issues?: object;
}>;

export type MDMConflictHistoryRow = Selectable<MDMConflictHistoryTable>;
export type NewMDMConflictHistory = Insertable<MDMConflictHistoryTable>;

export type AISessionRow = Selectable<AISessionsTable>;
export type NewAISession = Insertable<AISessionsTable>;
export type AISessionUpdate = Updateable<AISessionsTable>;

export type ReasoningTraceRow = Selectable<ReasoningTracesTable>;
export type NewReasoningTrace = Insertable<ReasoningTracesTable>;
