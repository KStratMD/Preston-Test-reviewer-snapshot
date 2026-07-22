import type { AuthConfig } from '../../types';
import { netsuiteConfig } from '../../config/env';

/**
 * Thrown when the deployment-wide NetSuite env credentials
 * (NETSUITE_ACCOUNT_ID / NETSUITE_CONSUMER_KEY / NETSUITE_CONSUMER_SECRET /
 * NETSUITE_TOKEN_ID / NETSUITE_TOKEN_SECRET) are missing or empty.
 *
 * Sync Error Assist has no per-tenant NetSuite credential store — it
 * resolves its connector via `ConnectorManager.getConnector()`, which only
 * constructs+caches a bare, never-initialized connector (see
 * `ConnectorManager.getConnector`, PR: Fix B). SEA therefore authenticates
 * against the same deployment-wide env credentials the install guide's
 * Part 2 configures. A deployment that omits them degrades to the SAME
 * observable behavior as before this fix (connector calls fail before any
 * network I/O) — just with a clearer, typed error instead of the connector's
 * raw `TokenError: Missing required OAuth1 credentials`.
 */
export class NetSuiteEnvCredentialsMissingError extends Error {
  constructor(missingKeys: string[]) {
    super(
      `NetSuite env credentials missing/empty: ${missingKeys.join(', ')}. ` +
      'Configure NETSUITE_ACCOUNT_ID, NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET, ' +
      'NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET.',
    );
    this.name = 'NetSuiteEnvCredentialsMissingError';
  }
}

/**
 * Builds the OAuth1 `AuthConfig` that `NetSuiteConnector.initialize()`
 * expects, from the deployment-wide env credentials
 * (`src/config/env.ts:netsuiteConfig`). Callers pass the result to
 * `connector.initialize(...)` immediately after
 * `ConnectorManager.getConnector('netsuite', ...)` — see
 * SyncErrorAssistService/-OperatorService call sites.
 *
 * Throws `NetSuiteEnvCredentialsMissingError` (fail-closed, never a silent
 * empty-credentials connector) if any of the four required secrets or the
 * account id is missing/empty. `baseUrl` is optional — NetSuiteConnector
 * derives it from `accountId` when omitted.
 */
export function buildNetSuiteEnvAuthConfig(): AuthConfig {
  const { accountId, consumerKey, consumerSecret, tokenId, tokenSecret, baseUrl } = netsuiteConfig;

  const missingKeys: string[] = [];
  if (!accountId) missingKeys.push('accountId');
  if (!consumerKey) missingKeys.push('consumerKey');
  if (!consumerSecret) missingKeys.push('consumerSecret');
  if (!tokenId) missingKeys.push('tokenId');
  if (!tokenSecret) missingKeys.push('tokenSecret');

  if (missingKeys.length > 0) {
    throw new NetSuiteEnvCredentialsMissingError(missingKeys);
  }

  return {
    type: 'oauth1',
    credentials: {
      accountId,
      consumerKey,
      consumerSecret,
      tokenId,
      tokenSecret,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

/**
 * Thrown when a tenant's recorded NetSuite account (the embedded
 * service-token row's `platform_account_id`, written by
 * `scripts/rotate-embedded-service-token.ts` during provisioning) differs
 * from the deployment-wide env `NETSUITE_ACCOUNT_ID`. Codex PR #966 P1:
 * without this guard, every tenant's Sync Error Assist connector would
 * read/write the SINGLE env-configured NetSuite account — tenant B's
 * suggestions would land in tenant A's ERP. Fail closed instead: the throw
 * degrades to the same `connector_unavailable` / aborted-cycle paths as a
 * missing-env deployment.
 */
export class NetSuiteTenantAccountMismatchError extends Error {
  constructor(tenantId: string, storedAccountId: string, envAccountId: string) {
    super(
      `Tenant '${tenantId}' is provisioned for NetSuite account '${storedAccountId}' but this ` +
      `deployment's env credentials target account '${envAccountId}'. Sync Error Assist uses ` +
      'deployment-wide NetSuite credentials; do not enable sync_error_assist for tenants on a ' +
      'different NetSuite account than NETSUITE_ACCOUNT_ID.',
    );
    this.name = 'NetSuiteTenantAccountMismatchError';
  }
}

/**
 * Thrown when a tenant has `sync_error_assist.enabled=true` but NO embedded
 * service-token row recording which NetSuite account it belongs to (Codex
 * R3 P1 on PR #966): with no binding on file the mismatch guard has nothing
 * to compare, and silently handing such a tenant the deployment-wide env
 * credentials would recreate the cross-account hole for exactly the tenants
 * that skipped provisioning. Fail closed instead — the fix is to run the
 * provisioning flow (`npm run rotate-embedded-service-token`, or
 * `scripts/provision-pilot-tenant.mjs` which wraps it), which the install
 * guide (Part 4 §4.2) already sequences before enabling Sync Error Assist.
 */
export class NetSuiteTenantUnprovisionedError extends Error {
  constructor(tenantId: string) {
    super(
      `Tenant '${tenantId}' has no provisioned NetSuite account binding (no embedded ` +
      'service-token row), so Sync Error Assist cannot verify it belongs to this ' +
      "deployment's NETSUITE_ACCOUNT_ID. Provision one via 'npm run " +
      "rotate-embedded-service-token -- --tenant <id> --platform netsuite " +
      "--platform-account-id <account>' before enabling sync_error_assist.",
    );
    this.name = 'NetSuiteTenantUnprovisionedError';
  }
}

/**
 * NetSuite account ids appear in two spellings: the account form
 * (`1234567_SB1`) and the URL/subdomain form (`1234567-sb1`). Uppercase +
 * hyphen→underscore makes the two comparable.
 */
function normalizeNetSuiteAccountId(id: string): string {
  return id.trim().toUpperCase().replace(/-/g, '_');
}

/**
 * Minimal seam for the tenant→platform-account lookup so this module stays
 * DB-free. Structurally satisfied by
 * `SyncErrorAssistRepository.getEmbeddedPlatformAccountId`.
 */
export interface EmbeddedPlatformAccountLookup {
  getEmbeddedPlatformAccountId(tenantId: string, platform: string): Promise<string | null>;
}

/**
 * Tenant-checked variant of `buildNetSuiteEnvAuthConfig` — the ONLY entry
 * point Sync Error Assist call sites should use (the unchecked builder stays
 * exported for its own tests). Reads the tenant's recorded NetSuite account
 * and fails closed on BOTH bad states: no binding row at all
 * (`NetSuiteTenantUnprovisionedError` — Codex R3 P1; the pilot flow always
 * provisions one via `scripts/provision-pilot-tenant.mjs` before enabling
 * the feature) and a binding that differs from the env account
 * (`NetSuiteTenantAccountMismatchError`). A lookup failure (DB down)
 * propagates — fail closed, same degradation path.
 */
export async function buildNetSuiteEnvAuthConfigForTenant(
  tenantId: string,
  lookup: EmbeddedPlatformAccountLookup,
): Promise<AuthConfig> {
  const storedAccountId = await lookup.getEmbeddedPlatformAccountId(tenantId, 'netsuite');
  if (storedAccountId === null) {
    throw new NetSuiteTenantUnprovisionedError(tenantId);
  }
  const envAccountId = netsuiteConfig.accountId;
  if (
    envAccountId &&
    normalizeNetSuiteAccountId(storedAccountId) !== normalizeNetSuiteAccountId(envAccountId)
  ) {
    throw new NetSuiteTenantAccountMismatchError(tenantId, storedAccountId, envAccountId);
  }
  // Missing env credentials (including empty accountId) still throw the
  // typed missing-creds error here, after the mismatch check is skipped.
  return buildNetSuiteEnvAuthConfig();
}
