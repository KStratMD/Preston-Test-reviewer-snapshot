export * from './api-responses';
export * from './legacy';
export * from './credentials';
export * from './cardinality';
export * from './serializedAsset';

import type {
  CardinalityStrategy,
  FieldCardinalityResolution,
  PersistedCardinalityOverride,
  CardinalityValidationSnapshot,
} from './cardinality';
import type {
  IntegrationExecutionProfile,
  SerializedAssetProfileDraftConfig,
} from './serializedAsset';

export interface SystemConfig {
  type: string;
  systemId?: string;
  credentialSource?: 'secret_manager' | 'environment' | 'inline';
}

export interface IntegrationConfig {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  sourceSystem: string | SystemConfig;
  targetSystem: string | SystemConfig;
  sourceEntity: string;
  targetEntity: string;
  syncDirection: 'unidirectional' | 'bidirectional' | 'source_to_target' | 'target_to_source';
  syncMode: 'realtime' | 'batch' | 'manual';
  isActive: boolean;
  fieldMappings: FieldMapping[];
  transformationRules: TransformationRule[];
  sourceAuthentication?: AuthenticationConfig;
  targetAuthentication?: AuthenticationConfig;
  authentication?: {
    source?: AuthenticationConfig;
    target?: AuthenticationConfig;
  };
  security?: {
    credentialEncryption?: boolean;
    auditLogging?: boolean;
    credentialRotation?: {
      enabled: boolean;
      intervalDays: number;
    };
  };
  batchSize?: number;
  retryConfig?: {
    maxRetries: number;
    retryDelay: number;
    backoffStrategy: 'linear' | 'exponential';
  };
  /** Entity/flow cardinality strategies. Persisted, part of the analysis plan. */
  cardinalityStrategies?: CardinalityStrategy[];
  /**
   * The single server-authored override record, persisted atomically with
   * configuration. One activation carries one `CardinalityOverrideRequest`
   * bound to the run's `combinedFingerprint`, so at most one durable approval
   * exists per configuration version (durability follows the fingerprint, not a
   * growing list). Never trusted from client input or import; the canonical
   * schema strips it.
   */
  cardinalityApproval?: PersistedCardinalityOverride;
  /**
   * Server-authored validation snapshot for the last active save. Never trusted
   * from client input or import; the canonical schema strips it.
   */
  cardinalityValidation?: CardinalityValidationSnapshot;
  /**
   * Dedicated execution profile (Task 1, 2026-07-27 NetSuite serialized-asset
   * sync plan — decision 1: a dedicated profile, not a generic fan-out/
   * cardinality executor). `undefined` and `'standard'` preserve current
   * behavior.
   */
  executionProfile?: IntegrationExecutionProfile;
  /** Profile-specific configuration. Required when `executionProfile` is `'netsuite_serialized_asset'`. */
  executionProfileConfig?: SerializedAssetProfileDraftConfig;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transformationType: 'direct' | 'concatenate' | 'concatenation' | 'split' | 'lookup' | 'expression' | 'conditional' | 'calculation';
  isRequired: boolean;
  defaultValue?: unknown;
  transformationConfig?: {
    type: string;
    fields?: string[];
    separator?: string;
    lookupTable?: string;
    keyField?: string;
    valueField?: string;
    expression?: string;
  };
  /** Field-value cardinality resolution owned by the mapping writing this target. */
  cardinality?: FieldCardinalityResolution;
}

export interface TransformationRule {
  id: string;
  name: string;
  type: 'conditional_logic' | 'data_validation' | 'data_enrichment' | 'business_logic' | 'field_mapping' | 'enrichment' | 'VALIDATION' | 'TRANSFORMATION' | 'ENRICHMENT' | 'FILTER';
  condition?: string;
  action: 'set_field_value' | 'validate_field' | 'calculate_field' | 'transform' | 'validate' | 'enrich' | 'filter' | 'reject' | 'conditional_mapping' | 'set_default_value' | 'validate_required' | 'derive_account_type' | 'validate_email_format';
  parameters?: {
    targetField?: string;
    field?: string;
    validationType?: string;
    validationConfig?: {
      pattern?: string;
    };
    conditions?: ({
      field: string;
      operator: 'equals' | 'greater_than' | 'less_than' | 'greater_equal' | 'less_equal' | 'contains';
      value: unknown;
      result: unknown;
    } | {
      operator: 'and' | 'or';
      conditions: {
        field: string;
        operator: 'equals' | 'greater_than' | 'less_than' | 'greater_equal' | 'less_equal' | 'contains';
        value: unknown;
      }[];
      result: unknown;
    })[];
    defaultValue?: unknown;
    calculation?: string;
    sourceField?: string;
    referenceDate?: string;
    unit?: string;
    type?: string;
    rules?: ValidationRule[];
    expression?: string;
    context?: Record<string, unknown>;
  };
}

export interface ValidationRule {
  field: string;
  type: 'required' | 'pattern' | 'length' | 'range' | 'custom' | 'format';
  value?: {
    pattern?: string;
    min?: number;
    max?: number;
  };
  message: string;
}

export type AuthenticationType = 'oauth1' | 'oauth2' | 'api_key' | 'basic' | 'token';

export interface AuthenticationConfig {
  type: AuthenticationType;
  credentials: {
    clientId?: string;
    clientSecret?: string;
    consumerKey?: string;
    consumerSecret?: string;
    tokenId?: string;
    tokenSecret?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    accountId?: string;
    tokenUrl?: string;
    scope?: string;
    tenantId?: string;
    resourceUrl?: string;
    baseUrl?: string;
    // System-specific fields
    environment?: string;
    companyId?: string;
    host?: string;
    port?: number;
    serviceId?: string;
    [key: string]: unknown; // Allow additional system-specific fields
  };
  refreshable?: boolean;
  expiresAt?: Date;
}

export interface OAuth2Credentials {
  clientId: string;
  clientSecret: string;
  tenantId?: string;
  tenant_id?: string;
  resourceUrl?: string;
  resource_url?: string;
  baseUrl?: string;
  base_url?: string;
}

export interface ODataResponse {
  value: unknown[];
}

export interface FilterValue {
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'startswith';
  value: unknown;
}

export type FilterOptions = Record<string, FilterValue | string | number | boolean | Date>;

export type AuthConfig = AuthenticationConfig;

export interface SystemInfo {
  name: string;
  version: string;
  type: string;
  capabilities: string[];
  /** Optional list of supported modules for this system */
  modules?: string[];
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  endpoints: {
    baseUrl: string;
    authUrl: string;
    webhookUrl: string;
  };
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
  accountId: string;
  baseUrl?: string;
  base_url?: string;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

export interface ApiKeyCredentials {
  apiKey: string;
  keyName?: string;
  keyLocation?: 'header' | 'query' | 'body';
}

export interface SyncError {
  recordId: string;
  errorCode: string;
  errorMessage: string;
  severity: 'error' | 'warn';
}

export interface ConnectionStatus {
  systemType: string;
  systemId: string;
  isConnected: boolean;
  lastTestTime: Date;
  latency?: number;
  errorMessage?: string;
  // Optional metadata that some connector implementations populate on the
  // ConnectionStatus they return from testConnection(). Specifically consumed
  // by the NetSuite branch of src/routes/connectorTest.ts (the real-connector
  // path reads testResult.version / .permissions / .rateLimits directly — the
  // mock-connector path takes a different route through testResult.details).
  version?: string;
  permissions?: string[];
  rateLimits?: string | { remaining: number; reset: number };
}

export interface DataRecord {
  id?: string;
  externalId?: string;
  [key: string]: unknown;
}

export interface SyncResult {
  integrationId: string;
  syncId: string;
  status: 'success' | 'partial' | 'failed';
  success: boolean;
  recordsProcessed: number;
  recordsSuccessful: number;
  recordsFailed: number;
  errors: string[];
  /** Optional warnings encountered during sync */
  warnings?: string[];
  startTime: Date;
  endTime: Date;
  /** Human-friendly processing duration string, e.g. '4.7s' */
  processingTime?: string;
  /** Processing duration in milliseconds */
  processingMs?: number;
  /** Optional metadata for flow-specific details (e.g., payouts) */
  metadata?: Record<string, unknown>;
  dryRun?: boolean;
  batchSize?: number;
  syncDirection?: string;
}

// Business Metrics Types
export interface BusinessMetrics {
  activeIntegrations: number;
  syncSuccessRate: number;
  averageProcessingTime: number;
  totalRecordsProcessed: number;
  errorsByType: Record<string, number>;
  systemsConnected: string[];
  lastSyncTimes: Record<string, Date>;
}

export interface PerformanceMetrics {
  responseTime: {
    p50: number;
    p95: number;
    p99: number;
  };
  throughput: {
    requestsPerSecond: number;
    recordsPerMinute: number;
  };
  errorRate: number;
  availability: number;
}

export interface SecurityMetrics {
  failedLoginAttempts: number;
  suspiciousRequests: number;
  blockedIPs: string[];
  lastSecurityScan: Date;
  certificateExpiry: Date | null;
}

export interface TransformationResult {
  success: boolean;
  transformedData: DataRecord;
  errors: { message: string; field?: string }[];
  warnings?: { message: string; field?: string }[];
}
