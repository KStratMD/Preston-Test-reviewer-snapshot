/**
 * Centralized runtime flag helpers to avoid scattering environment checks.
 * Demo mode should only activate when explicitly requested.
 */

import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

let demoModeOverride: boolean | undefined;

function isEnabled(flag: string | undefined): boolean {
  if (!flag) {
    return false;
  }
  const normalized = flag.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Returns true when the application should operate in demo mode.
 * Prefers runtime overrides (e.g., DemoModeService) before falling back to env variables.
 */
export function isDemoMode(): boolean {
  if (typeof demoModeOverride === 'boolean') {
    // console.log(`[DEBUG] isDemoMode: returning override ${demoModeOverride}`);
    return demoModeOverride;
  }
  const val = process.env.DEMO_MODE === '1';
  // console.log(`[DEBUG] isDemoMode: returning env check ${val} (DEMO_MODE=${process.env.DEMO_MODE})`);
  return val;
}

/**
 * Tenant-configuration key for the per-tenant half of the ephemeral
 * payload gate. Read via the plaintext-only
 * `TenantConfigurationRepository.getBooleanStrict` (async, DB-backed) —
 * NOT the default `getBoolean`. The strict path is mandatory for this
 * key so SecretManager outages on an encrypted row cannot collapse
 * into a silent false/deny (which would translate an infra failure
 * into a 403 policy denial). New callers MUST use `getBooleanStrict`
 * and store the row as plaintext. Co-located here with the env-flag
 * helper so the policy surface lives in one file.
 */
export const WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD_SETTING_KEY =
  'workflow.allow_ephemeral_payload';

/**
 * Env half of the ephemeral payload gate (ADR-019 / governance-without-
 * hosting-data Phase 1). When set, ALL tenants are allowed to render
 * EphemeralWorkflowPayload at the operator boundary — a global override.
 * The per-tenant half is `workflow.allow_ephemeral_payload` checked via
 * TenantConfigurationRepository at the call site (see
 * WorkflowCentralOperatorService.getTaskForOperator). Either gate
 * opens; both closed (policy denial) → EphemeralPayloadNotAllowedError
 * → 403. Distinct from infra failure during the per-tenant lookup:
 * tenant-setting DB throws propagate unchanged → 500 at the route
 * layer (fail-closed; infra errors are not translated to policy
 * denials so real bugs surface as bugs, not as 403s).
 */
export function isEphemeralWorkflowPayloadAllowed(): boolean {
  return isEnabled(process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD);
}

export type OwnershipDemoTenantStatus =
  | { active: true; tenantId: string }
  | { active: false; reason: 'unset' | 'invalid' | 'production_blocked' };

/**
 * Demo-tenant ownership override (unblocks the SuiteCentral→NetSuite demo
 * sync flow — see runSuiteCentralNetSuiteSync). When OWNERSHIP_DEMO_TENANT_ID
 * names a tenant, OwnershipResolver allows that tenant's non-owner writes
 * under `reject_with_alert` with the distinct decision reason
 * 'demo_tenant_override' (audited via the 'ownership_demo_tenant_override'
 * flag) instead of throwing OwnershipViolationError. Default closed: unset,
 * empty, or whitespace-only → inactive → no override anywhere.
 *
 * **Tenant-scoped, NOT flow-scoped — by design.** The override applies to
 * ANY write path running as the designated tenant, across every
 * reject_with_alert manifest entity, because the designated tenant is a demo
 * sandbox identity. NEVER set this to a production tenant's id: doing so
 * strips reject_with_alert protection for that tenant everywhere (each
 * bypass is still warn-logged + HIGH-risk audited, but the writes proceed).
 *
 * **Production double opt-in (fail closed).** Under NODE_ENV=production the
 * override additionally requires OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION
 * (truthy: 1/true/yes/on) — a docs-only safeguard can't prevent the
 * misconfig above, so production deployments must state the intent twice.
 *
 * The SYSTEM identity's tenant id is deliberately un-designatable: honoring
 * it would bypass ownership policy for EVERY background/system write (all of
 * which run under SYSTEM_IDENTITY), not just the demo flow. Read per-call —
 * never cached — so tests and operators can flip it without a restart.
 */
export function ownershipDemoTenantStatus(): OwnershipDemoTenantStatus {
  const raw = process.env.OWNERSHIP_DEMO_TENANT_ID;
  const trimmed = raw?.trim();
  if (!trimmed) return { active: false, reason: 'unset' };
  if (trimmed === SYSTEM_IDENTITY.tenantId) return { active: false, reason: 'invalid' };
  if (
    process.env.NODE_ENV === 'production' &&
    !isEnabled(process.env.OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION)
  ) {
    return { active: false, reason: 'production_blocked' };
  }
  return { active: true, tenantId: trimmed };
}

/** Convenience accessor: the active demo tenant id, or null when inactive. */
export function ownershipDemoTenantId(): string | null {
  const status = ownershipDemoTenantStatus();
  return status.active ? status.tenantId : null;
}

/**
 * Override demo mode state at runtime (e.g., when updated via API).
 * Pass undefined to clear override and fall back to env defaults.
 */
export function setDemoModeOverride(value: boolean | undefined): void {
  // Debug logging removed for ESLint compliance
  demoModeOverride = typeof value === 'boolean' ? value : undefined;
}

/**
 * Provides the current override value, if any.
 */
export function getDemoModeOverride(): boolean | undefined {
  return demoModeOverride;
}

/**
 * Indicates whether the current process runs under automated tests.
 */
export function isTestEnvironment(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'test';
}

/**
 * NetSuite MCP Integration Feature Flags (Phase 2)
 * Enable/disable MCP features independently for gradual rollout
 */

/**
 * Returns true if NetSuite MCP schema discovery is enabled.
 * Requires ENABLE_NETSUITE_MCP_SCHEMA=1 in environment.
 */
export function isNetSuiteMCPSchemaEnabled(): boolean {
  return process.env.ENABLE_NETSUITE_MCP_SCHEMA === '1';
}

/**
 * Returns true if NetSuite MCP validation is enabled.
 * Requires ENABLE_NETSUITE_MCP_VALIDATION=1 in environment.
 * (Reserved for Phase 4 implementation)
 */
export function isNetSuiteMCPValidationEnabled(): boolean {
  return process.env.ENABLE_NETSUITE_MCP_VALIDATION === '1';
}

/**
 * Returns true if NetSuite MCP AI context enhancement is enabled.
 * Requires ENABLE_NETSUITE_MCP_AI_CONTEXT=1 in environment.
 * (Reserved for Phase 3 implementation)
 */
export function isNetSuiteMCPAIContextEnabled(): boolean {
  return process.env.ENABLE_NETSUITE_MCP_AI_CONTEXT === '1';
}

/**
 * Returns true if cross-system MCP gateway features are enabled.
 * Requires MCP_GATEWAY_ENABLED to be truthy.
 */
export function isMCPGatewayEnabled(): boolean {
  return isEnabled(process.env.MCP_GATEWAY_ENABLED);
}

/**
 * Returns true if Business Central MCP adapter is enabled.
 * Requires MCP gateway enabled and BC_MCP_ENDPOINT configured.
 */
export function isBusinessCentralMCPEnabled(): boolean {
  if (!isMCPGatewayEnabled()) {
    return false;
  }
  return !!(process.env.BC_MCP_ENDPOINT && process.env.BC_MCP_ENDPOINT.trim().length > 0);
}
