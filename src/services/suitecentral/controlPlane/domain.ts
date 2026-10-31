/**
 * SuiteCentral control-plane domain types.
 *
 * Request contexts, mutation inputs, and REDACTED read models. No persisted row
 * or response type may carry `clientSecret` / raw secret material — credential
 * views expose only `secretConfigured` and a rotation timestamp.
 */

export type SuiteCentralAccessMode = 'tenant_admin' | 'platform_admin';
export type SuiteCentralEnvironmentTier = 'sandbox' | 'production';
export type SuiteCentralAllowedHostStatus = 'active' | 'revoked';

export interface SuiteCentralControlPlaneContext {
  readonly actorUserId: string;
  readonly targetTenantId: string;
  readonly accessMode: SuiteCentralAccessMode;
  readonly correlationId: string;
}

// ----- Environments --------------------------------------------------------

export interface EnvironmentView {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  environmentTier: SuiteCentralEnvironmentTier;
  apiVersion: string | null;
  timeoutMs: number;
  retryAttempts: number;
  rateLimitConfig: Record<string, unknown> | null;
  securityConfig: Record<string, unknown> | null;
  featureConfig: Record<string, unknown> | null;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnvironmentInput {
  name: string;
  baseUrl: string;
  environmentTier?: SuiteCentralEnvironmentTier;
  apiVersion?: string | null;
  timeoutMs?: number;
  retryAttempts?: number;
  rateLimitConfig?: Record<string, unknown> | null;
  securityConfig?: Record<string, unknown> | null;
  featureConfig?: Record<string, unknown> | null;
}

export type UpdateEnvironmentPatch = Partial<CreateEnvironmentInput>;

// ----- Credential profiles (secret material NEVER exposed) -----------------

export interface CredentialProfileView {
  id: string;
  environmentId: string;
  name: string;
  clientId: string;
  companyId: string | null;
  scopes: string[];
  isActive: boolean;
  secretConfigured: boolean;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  version: number;
}

/**
 * Internal metadata row for a credential profile. Includes `secretRef` (a
 * deterministic, PII-free reference resolved through SecretManager) but never
 * the secret value itself. Used by the service/connector layers; not returned
 * to clients.
 */
export interface CredentialMetadataRow {
  id: string;
  tenantId: string;
  environmentId: string;
  name: string;
  clientId: string;
  secretRef: string;
  companyId: string | null;
  scopes: string[];
  isActive: boolean;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  version: number;
}

export interface CreateCredentialInput {
  environmentId: string;
  name: string;
  clientId: string;
  companyId?: string | null;
  scopes?: string[];
}

// ----- Templates -----------------------------------------------------------

export interface TemplateView {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  sourceSystem: string;
  targetEntities: unknown[];
  fieldMappings: Record<string, unknown>;
  businessRules: unknown[];
  syncSettings: Record<string, unknown>;
  version: number;
  builtIn: boolean;
}

export interface CreateTemplateInput {
  name: string;
  description?: string | null;
  sourceSystem: string;
  targetEntities?: unknown[];
  fieldMappings?: Record<string, unknown>;
  businessRules?: unknown[];
  syncSettings?: Record<string, unknown>;
}

// ----- Monitoring ----------------------------------------------------------

export interface MonitoringConfigView {
  id: string;
  tenantId: string;
  environmentId: string;
  enabled: boolean;
  intervalMs: number;
  thresholds: Record<string, unknown> | null;
  version: number;
}

export interface UpsertMonitoringInput {
  enabled: boolean;
  intervalMs?: number;
  thresholds?: Record<string, unknown> | null;
}

// ----- Allowed hosts (platform-scoped) -------------------------------------

export interface AllowedHostView {
  id: string;
  hostname: string;
  allowedPorts: number[];
  status: SuiteCentralAllowedHostStatus;
  justification: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAllowedHostInput {
  hostname: string;
  allowedPorts?: number[];
  justification?: string | null;
}
