import { ForbiddenAppError, ServiceUnavailableAppError } from '../../errors/AppError';
import type { Logger } from '../../utils/Logger';

/**
 * Tenant ownership registry for MANAGED (`credentialSource: 'secret_manager'`)
 * system references.
 *
 * **Why this exists.** `SecureCredentialManager.getCredentials(systemType, systemId)`
 * takes no tenantId — its secret key is `credentials_${systemType}_${systemId}`,
 * a platform-global namespace shared by the CLI, `POST /api/credentials`,
 * `migrateFromEnvironment`, and the embedded service-token repository. A stored
 * `IntegrationConfig`'s `systemId` is operator-authored free text (the schema
 * accepts any 1-200 character string). Without an ownership check, an
 * authenticated tenant-A user could save a DRAFT (drafts deliberately bypass
 * every activation gate) naming tenant B's `systemId`, then trigger activation
 * readiness — and the server would resolve tenant B's brokered credentials,
 * connect to tenant B's org, and return that org's metadata.
 *
 * **Why a registry rather than namespacing the secret key.** Rewriting the
 * resolved key to include the tenant would orphan every credential already
 * stored under the unnamespaced key by those other writers — including live
 * embedded service tokens — and there is no tenant dimension in
 * `CredentialMetadata` or `ICredentialMetadataStore` to migrate from. So
 * ownership is VERIFIED against a tenant-scoped registry instead, and the
 * key derivation is left exactly as it is.
 *
 * **Storage.** The existing tenant-settings table (`tenant_configurations`,
 * read through `TenantConfigurationRepository`) — no new migration. One
 * plaintext row per system type holds a JSON array of the `systemId`s that
 * tenant may use. Registration is an operator/provisioning action, exactly
 * like the `integration.netsuite_serialized_asset.enabled` capability flag,
 * and is likewise DEFAULT CLOSED.
 */

/** Tenant-settings key prefix for the managed-system ownership registry. */
export const MANAGED_SYSTEM_REGISTRY_KEY_PREFIX = 'integration.managed_systems.';

/**
 * `SecureCredentialManager.getCredentialKey` lowercases both the system type
 * and the systemId, so the ownership comparison MUST normalize identically —
 * a case-sensitive check would be bypassable by simply changing the casing of
 * another tenant's systemId while still resolving the same secret.
 */
function normalizeForKeyComparison(value: string): string {
  return value.toLowerCase();
}

/**
 * Lowercases but deliberately does NOT trim — `getCredentialKey` does not trim
 * either. Trimming here would let a whitespace-bearing `systemType` share a
 * registry entry with the clean spelling while resolving a DIFFERENT secret;
 * without it, the whitespace-bearing spelling simply has no registration and
 * is refused. Every normalization in this module must be exactly key-equal.
 */
export function managedSystemRegistryKey(systemType: string): string {
  return `${MANAGED_SYSTEM_REGISTRY_KEY_PREFIX}${systemType.toLowerCase()}`;
}

/**
 * The single tenant-settings read this registry performs.
 *
 * STRICT (plaintext-only) by design, mirroring the sibling capability flag's
 * use of `getBooleanStrict`: the ordinary `getString` collapses a SecretManager
 * failure on an encrypted row into `null`, which this registry would then read
 * as "not registered" — an outage silently becoming a denial. The strict read
 * throws instead, so the outage surfaces as 503 (undeterminable) and matches
 * the contract the resolver and the readiness service document.
 */
export interface TenantSystemSettingReader {
  getStringStrict(tenantId: string, settingKey: string): Promise<string | null>;
}

/** Lazy provider — keeps consumers (the credential resolver) sync-constructible. */
export type TenantSystemSettingReaderProvider = () => Promise<TenantSystemSettingReader>;

export interface TenantSystemCredentialRegistry {
  /**
   * Resolves when `systemId` is registered to `tenantId`; otherwise throws
   * `CrossTenantCredentialError`. A storage failure throws
   * `ServiceUnavailableAppError` — an inability to decide is never a denial
   * and never an allow.
   */
  assertSystemOwnedByTenant(tenantId: string, systemType: string, systemId: string): Promise<void>;
}

/**
 * 403. Message text is deliberately generic and NEVER echoes the requested
 * systemId or the registered set, so the refusal cannot be used to probe which
 * systemIds exist for other tenants.
 */
export class CrossTenantCredentialError extends ForbiddenAppError {}

const GENERIC_REFUSAL =
  'The configured managed system reference is not registered to this tenant';

function parseRegisteredSystemIds(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((entry): entry is string => typeof entry === 'string')) return null;
  return parsed;
}

export class TenantSettingSystemCredentialRegistry implements TenantSystemCredentialRegistry {
  constructor(
    private readonly settingsProvider: TenantSystemSettingReaderProvider,
    private readonly logger?: Logger,
  ) {}

  async assertSystemOwnedByTenant(tenantId: string, systemType: string, systemId: string): Promise<void> {
    // Fail closed BEFORE touching storage: an unattributed configuration can
    // never own a managed credential.
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new CrossTenantCredentialError(GENERIC_REFUSAL);
    }
    // The secret key derivation does NOT trim, so ' sf-prod' and 'sf-prod' are
    // different secrets. Refusing untrimmed spellings keeps the ownership
    // decision and the key derivation from ever disagreeing.
    if (typeof systemId !== 'string' || systemId !== systemId.trim() || systemId.length === 0) {
      throw new CrossTenantCredentialError(GENERIC_REFUSAL);
    }

    const settingKey = managedSystemRegistryKey(systemType);
    let raw: string | null;
    try {
      const reader = await this.settingsProvider();
      raw = await reader.getStringStrict(tenantId, settingKey);
    } catch (error) {
      this.logger?.error('Managed-system ownership registry read failed', {
        tenantId,
        settingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableAppError(
        'Managed system ownership could not be determined; refusing to resolve credentials',
      );
    }

    // Unregistered, unparseable, and empty registrations are all refusals —
    // a malformed row must never widen access.
    const registered = raw === null ? null : parseRegisteredSystemIds(raw);
    if (!registered) {
      throw new CrossTenantCredentialError(GENERIC_REFUSAL);
    }

    // No `.trim()` on the registered entry either: a registration of ' sf-prod'
    // names `credentials_salesforce_ sf-prod`, a DIFFERENT secret from the one
    // 'sf-prod' resolves. Trimming would grant the clean spelling access to a
    // secret the operator never registered. The decision is exactly key-equal.
    const wanted = normalizeForKeyComparison(systemId);
    const owned = registered.some((entry) => normalizeForKeyComparison(entry) === wanted);
    if (!owned) {
      throw new CrossTenantCredentialError(GENERIC_REFUSAL);
    }
  }
}
