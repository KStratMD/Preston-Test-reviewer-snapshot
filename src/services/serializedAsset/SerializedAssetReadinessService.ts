import { connectorKeyForSystem } from '../../connectors/connectorIdentity';
import { ServiceUnavailableAppError } from '../../errors/AppError';
import {
  isNetSuiteSerializedAssetSyncGloballyEnabled,
  NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY,
} from '../../config/runtimeFlags';
import { assertSalesforceSerializedAssetReadCapabilities } from '../../types/serializedAsset';
import { evaluateSerializedAssetProfile } from './SerializedAssetProfileValidator';
import { errorNameOf } from './errorName';
import { CrossTenantCredentialError } from '../integration/TenantSystemCredentialRegistry';
import type { IConnector } from '../../interfaces/IConnector';
import type { IntegrationConfig, SystemConfig } from '../../types';
import type {
  SalesforceFieldDescription,
  SalesforceObjectDescription,
  SerializedAssetProfileDraftConfig,
} from '../../types/serializedAsset';
import type { Logger } from '../../utils/Logger';

/**
 * Live activation readiness for the `netsuite_serialized_asset` execution
 * profile (Task 6, 2026-07-27 NetSuite serialized-asset sync plan).
 *
 * Everything this service inspects comes from a STORED, tenant-owned
 * `IntegrationConfig`. Nothing here may ever be handed request-supplied
 * systems, credentials, mappings, or hosts: `SalesforceConnector.initialize`
 * assigns `credentials.instanceUrl` to its HTTP client's `baseURL` and builds
 * its OAuth token endpoint from `credentials.loginUrl`, so initializing from a
 * request body would let an authenticated caller aim the server's outbound
 * HTTP at an arbitrary host AND post the client secret / username / password
 * there. The route resolves the configuration by ID; this service consumes it.
 *
 * Fail-closed rules:
 *   - a tenant-setting STORAGE failure PROPAGATES as `ServiceUnavailableAppError`.
 *     "We could not read the gate" is never collapsed into `ready: false` and
 *     never into an implicit allow.
 *   - the rollout, tenant, and managed-credential checks run BEFORE any network
 *     I/O, so an unmanaged credential reference can never reach connector
 *     initialization.
 *   - the result carries sanitized blocker messages and field-NAME choices only;
 *     the raw describe payload never leaves this module.
 */

/** The reasons activation can be refused. Closed set — the route echoes these verbatim. */
export type SerializedAssetReadinessBlockerCode =
  | 'global_capability_disabled'
  | 'tenant_capability_disabled'
  | 'profile_invalid'
  | 'managed_credentials_required'
  | 'discovery_unavailable'
  | 'object_not_writable'
  | 'field_missing'
  | 'field_not_external_id'
  | 'field_not_unique'
  | 'relationship_invalid'
  | 'permission_denied';

export interface SerializedAssetReadinessBlocker {
  code: SerializedAssetReadinessBlockerCode;
  message: string;
}

export interface SerializedAssetReadinessResult {
  ready: boolean;
  checkedAt: string;
  blockers: SerializedAssetReadinessBlocker[];
  productExternalIdFields: string[];
  assetExternalIdFields: string[];
}

/** The single strict tenant-setting read this service performs. */
export interface SerializedAssetTenantSettingReader {
  getBooleanStrict(tenantId: string, settingKey: string): Promise<boolean>;
}

/**
 * Lazy provider so this service stays synchronously constructible: the real
 * `TenantConfigurationRepository` is async-bound, while `ConfigurationService`
 * (which reaches this service through the activation guard) is resolved with a
 * synchronous `container.get`. Mirrors `TenantConfigurationRepositoryProvider`.
 */
export type SerializedAssetTenantSettingReaderProvider = () => Promise<SerializedAssetTenantSettingReader>;

/**
 * The `ConnectorManager` surface this service uses. Narrowed to the two
 * methods so readiness can never reach for a write method, and so tests can
 * supply a double without constructing the whole manager.
 */
export interface SerializedAssetConnectorProvisioner {
  initializeConnectorsForConfig(config: IntegrationConfig): Promise<void>;
  getConnector(systemType: string, systemId: string): Promise<IConnector>;
}

/**
 * Optional caller-supplied context for `evaluate`.
 *
 * `targetConnector` lets a caller that ALREADY holds an initialized target
 * connector have readiness inspect THAT instance. This matters at runtime
 * (Task 7): the readiness check is the gate protecting decision 4's
 * External-ID-uniqueness assumption, so it has to describe the same connector
 * the Asset upsert will go through. Without it, readiness resolves its own
 * second connector and proves nothing about the write path if the two ever
 * diverge — besides costing a second construction, auth, and two describes per
 * run.
 *
 * It does NOT bypass credential ownership: `evaluate` still runs
 * `initializeConnectorsForConfig` (prerequisite B's resolver, and therefore
 * `TenantSystemCredentialRegistry`'s cross-tenant check) before describing.
 * The supplied connector replaces only the RETRIEVAL of the already-initialized
 * instance, never the ownership funnel.
 */
export interface SerializedAssetReadinessOptions {
  targetConnector?: IConnector;
}

/** The narrow contract the activation guard depends on. */
export interface SerializedAssetReadinessEvaluator {
  evaluate(
    config: IntegrationConfig,
    options?: SerializedAssetReadinessOptions,
  ): Promise<SerializedAssetReadinessResult>;
}

/** Blockers that stop the sequence BEFORE any network I/O (plan step ordering). */
const PRE_DISCOVERY_BLOCKER_CODES: ReadonlySet<SerializedAssetReadinessBlockerCode> = new Set([
  'global_capability_disabled',
  'tenant_capability_disabled',
  'managed_credentials_required',
]);

/**
 * Salesforce spells an authorization refusal several ways depending on the
 * layer that rejects (object-level CRUD vs. field-level security vs. API
 * enablement). Matching these lets readiness say "the connected principal is
 * not permitted" instead of the vaguer "discovery unavailable" — the operator
 * fix differs (grant the permission set vs. investigate connectivity).
 */
const PERMISSION_REFUSAL_PATTERNS: readonly RegExp[] = [
  /INSUFFICIENT_ACCESS/i,
  /INSUFFICIENT_PERMISSIONS/i,
  /\bstatus code 403\b/i,
  /API_DISABLED_FOR_ORG/i,
  /NOT_FOUND_OR_NO_ACCESS/i,
];

/**
 * Reads the message to CLASSIFY, which is legitimate and deliberately not
 * routed through `errorNameOf`: telling a permission refusal from an outage is
 * only possible from the text. The message never escapes this function — the
 * boolean it returns is all the caller sees.
 */
function isPermissionRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PERMISSION_REFUSAL_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * A system reference is "managed" only as a strict `SystemConfig` object with
 * `credentialSource: 'secret_manager'` and a non-empty `systemId` — the exact
 * shape prerequisite B's `ConnectorCredentialResolver` can resolve to real
 * credentials. A legacy string reference, an inline object, or an environment
 * reference all mean activation would run on credentials this platform did not
 * broker, so readiness refuses them before touching the network.
 */
function isManagedSystemReference(system: string | SystemConfig | undefined): boolean {
  if (!system || typeof system === 'string') return false;
  if (system.credentialSource !== 'secret_manager') return false;
  return typeof system.systemId === 'string' && system.systemId.trim().length > 0;
}

/** External-ID key candidates: the operator may only choose an External ID + unique field. */
function externalIdChoices(description: SalesforceObjectDescription): string[] {
  return description.fields
    .filter((field) => field.externalId && field.unique)
    .map((field) => field.name)
    .sort((left, right) => left.localeCompare(right));
}

function findField(
  description: SalesforceObjectDescription,
  name: string,
): SalesforceFieldDescription | undefined {
  return description.fields.find((field) => field.name === name);
}

export class SerializedAssetReadinessService implements SerializedAssetReadinessEvaluator {
  constructor(
    private readonly tenantSettingsProvider: SerializedAssetTenantSettingReaderProvider,
    private readonly connectors: SerializedAssetConnectorProvisioner,
    private readonly logger?: Logger,
  ) {}

  async evaluate(
    config: IntegrationConfig,
    options?: SerializedAssetReadinessOptions,
  ): Promise<SerializedAssetReadinessResult> {
    const checkedAt = new Date().toISOString();
    const blockers: SerializedAssetReadinessBlocker[] = [];

    // --- Step 1: rollout gate (both halves default closed, decision 7) ---
    if (!isNetSuiteSerializedAssetSyncGloballyEnabled()) {
      blockers.push({
        code: 'global_capability_disabled',
        message: 'NetSuite serialized-asset sync is not enabled for this deployment',
      });
    }
    if (!(await this.readTenantFlag(config.tenantId))) {
      blockers.push({
        code: 'tenant_capability_disabled',
        message: `Tenant setting '${NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY}' is not enabled`,
      });
    }

    // --- Step 2: managed credential references on BOTH systems ---
    if (!isManagedSystemReference(config.sourceSystem)) {
      blockers.push({
        code: 'managed_credentials_required',
        message: 'sourceSystem must be a managed system reference (credentialSource: secret_manager with a systemId)',
      });
    }
    if (!isManagedSystemReference(config.targetSystem)) {
      blockers.push({
        code: 'managed_credentials_required',
        message: 'targetSystem must be a managed system reference (credentialSource: secret_manager with a systemId)',
      });
    }

    // The pure profile contract is evaluated here but is NOT allowed to stop
    // discovery: an inactive draft with missing field selections must still
    // receive the filtered field-name choices it needs to complete itself.
    const evaluation = evaluateSerializedAssetProfile(config);
    if (evaluation.ok === false) {
      for (const issue of evaluation.issues) {
        blockers.push({
          code: 'profile_invalid',
          message: `${issue.path.join('.')}: ${issue.message}`,
        });
      }
    }

    if (blockers.some((blocker) => PRE_DISCOVERY_BLOCKER_CODES.has(blocker.code))) {
      return this.result(checkedAt, blockers, [], []);
    }

    // --- Steps 3-4: initialize from the STORED config, then describe ---
    let describes: { product: SalesforceObjectDescription; asset: SalesforceObjectDescription };
    try {
      describes = await this.discover(config, options);
    } catch (error) {
      // An INABILITY TO DECIDE is not a blocker. The ownership registry (and
      // anything else in this chain) raises ServiceUnavailableAppError when it
      // could not read the state it needed; classifying that as
      // `discovery_unavailable` would report an outage as a DENY —
      // indistinguishable from a real Salesforce discovery failure, and a 409
      // instead of a 503 at activation. `readTenantFlag` above already keeps
      // this distinction by throwing before the try; this re-throw preserves it
      // for the rest of the sequence.
      if (error instanceof ServiceUnavailableAppError) {
        throw error;
      }
      blockers.push(this.classifyDiscoveryFailure(error));
      return this.result(checkedAt, blockers, [], []);
    }

    const productExternalIdFields = externalIdChoices(describes.product);
    const assetExternalIdFields = externalIdChoices(describes.asset);

    // --- Steps 5-8 ---
    this.checkObjectCapabilities(describes, blockers);
    this.checkConfiguredFields(config.executionProfileConfig, describes, blockers);

    return this.result(checkedAt, blockers, productExternalIdFields, assetExternalIdFields);
  }

  /**
   * Strict tenant-setting read. A missing row is a legitimate `false`
   * (default-closed); a STORAGE failure is an inability to evaluate the gate
   * and must surface as 503 rather than as "not ready" — otherwise an outage
   * would be indistinguishable from a deliberately disabled tenant, and the
   * operator would chase the wrong fix. The underlying error text is logged,
   * never surfaced (it can carry connection strings).
   */
  private async readTenantFlag(tenantId: string): Promise<boolean> {
    try {
      const reader = await this.tenantSettingsProvider();
      return await reader.getBooleanStrict(tenantId, NETSUITE_SERIALIZED_ASSET_SYNC_SETTING_KEY);
    } catch (error) {
      this.logger?.error('Serialized-asset readiness: tenant capability read failed', {
        tenantId,
        errorName: errorNameOf(error),
      });
      throw new ServiceUnavailableAppError(
        'NetSuite serialized-asset readiness could not be determined: the tenant capability setting is unavailable',
      );
    }
  }

  /**
   * Initializes both connectors through prerequisite B's resolver (managed
   * references become real credentials there, and a lookup failure propagates
   * rather than initializing with nothing), then describes the TARGET connector.
   *
   * `initializeConnectorsForConfig` runs UNCONDITIONALLY, even when the caller
   * supplied a connector: that call is the single funnel through which
   * `TenantSystemCredentialRegistry`'s cross-tenant ownership check runs, and a
   * caller-supplied instance must never become a way around it.
   *
   * Only the RETRIEVAL is caller-overridable. With no override, the connector
   * is fetched under the same cache key `initializeConnectorsForConfig` used, so
   * the describes run on the instance that actually received the credentials.
   * With an override, they run on the instance the caller will WRITE through —
   * which is what makes this a gate on the real write path rather than on a
   * second connector that merely resolves from the same references.
   */
  private async discover(
    config: IntegrationConfig,
    options?: SerializedAssetReadinessOptions,
  ): Promise<{ product: SalesforceObjectDescription; asset: SalesforceObjectDescription }> {
    await this.connectors.initializeConnectorsForConfig(config);
    const targetKey = connectorKeyForSystem(config.targetSystem);
    const connector = options?.targetConnector
      ?? (await this.connectors.getConnector(targetKey, `${targetKey}_${config.id}`));
    assertSalesforceSerializedAssetReadCapabilities(connector);
    const [product, asset] = await Promise.all([
      connector.describeSObject('Product2'),
      connector.describeSObject('Asset'),
    ]);
    return { product, asset };
  }

  private classifyDiscoveryFailure(error: unknown): SerializedAssetReadinessBlocker {
    // Class name only. This module's own header promises decision-8 privacy,
    // but these two log sites emitted the raw message — and the error here comes
    // from a caller-overridable connector, so its text is not ours to vouch for.
    this.logger?.warn('Serialized-asset readiness: Salesforce discovery failed', {
      errorName: errorNameOf(error),
    });
    // The configuration named a managed system reference that is not
    // registered to its own tenant. Reported as a credential-configuration
    // blocker (actionable for the operator) with a fixed message that reveals
    // nothing about whether that systemId exists for any other tenant — the
    // refusal must not be usable as a cross-tenant existence oracle.
    if (error instanceof CrossTenantCredentialError) {
      return {
        code: 'managed_credentials_required',
        message: 'The configured managed system reference is not registered to this tenant',
      };
    }
    if (isPermissionRefusal(error)) {
      return {
        code: 'permission_denied',
        message: 'The connected Salesforce principal is not permitted to read Product2/Asset metadata',
      };
    }
    return {
      code: 'discovery_unavailable',
      message: 'Salesforce object metadata could not be retrieved for this configuration',
    };
  }

  /** Step 5 (object writability/accessibility) + step 8's Product2 queryability. */
  private checkObjectCapabilities(
    describes: { product: SalesforceObjectDescription; asset: SalesforceObjectDescription },
    blockers: SerializedAssetReadinessBlocker[],
  ): void {
    if (!describes.asset.createable) {
      blockers.push({ code: 'object_not_writable', message: 'Salesforce Asset is not createable' });
    }
    if (!describes.asset.updateable) {
      blockers.push({ code: 'object_not_writable', message: 'Salesforce Asset is not updateable' });
    }
    // Product2 is read-only for this profile (the executor resolves the lookup
    // by External ID), so a non-queryable Product2 is a principal permission
    // problem, not a writability problem.
    if (!describes.product.queryable) {
      blockers.push({
        code: 'permission_denied',
        message: 'The connected Salesforce principal cannot query Product2',
      });
    }
  }

  /** Steps 6-8 against whichever field selections the draft has made so far. */
  private checkConfiguredFields(
    profile: SerializedAssetProfileDraftConfig | undefined,
    describes: { product: SalesforceObjectDescription; asset: SalesforceObjectDescription },
    blockers: SerializedAssetReadinessBlocker[],
  ): void {
    if (!profile) return;

    this.checkExternalIdKey(describes.product, 'Product2', profile.productExternalIdField, blockers);
    this.checkExternalIdKey(describes.asset, 'Asset', profile.assetExternalIdField, blockers);

    // Step 7: the product lookup must actually reference Product2.
    const productReferenceField = profile.productReferenceTargetField;
    if (productReferenceField) {
      const lookup = findField(describes.asset, productReferenceField);
      if (!lookup) {
        blockers.push({
          code: 'field_missing',
          message: `Salesforce Asset has no field '${productReferenceField}'`,
        });
      } else if (!lookup.referenceTo.includes('Product2')) {
        blockers.push({
          code: 'relationship_invalid',
          message: `Asset.${productReferenceField} does not reference Product2`,
        });
      }
    }

    // Step 8: every Asset field this profile WRITES must be create/updateable
    // for the connected principal (field-level security is principal-specific).
    const writtenFields = [
      profile.assetExternalIdField,
      profile.serialNumberTargetField,
      profile.productReferenceTargetField,
      profile.statusTargetField,
      profile.locationTargetField,
    ].filter((name): name is string => typeof name === 'string' && name.length > 0);

    for (const name of writtenFields) {
      const field = findField(describes.asset, name);
      if (!field) {
        // Reported once — the external-ID / lookup checks above already emit a
        // `field_missing` for their own slots.
        if (name !== profile.assetExternalIdField && name !== profile.productReferenceTargetField) {
          blockers.push({ code: 'field_missing', message: `Salesforce Asset has no field '${name}'` });
        }
        continue;
      }
      if (!field.createable || !field.updateable) {
        blockers.push({
          code: 'permission_denied',
          message: `The connected Salesforce principal cannot create/update Asset.${name}`,
        });
      }
    }
  }

  /** Steps 6: the configured key field must exist, be an External ID, and be unique. */
  private checkExternalIdKey(
    description: SalesforceObjectDescription,
    objectName: 'Product2' | 'Asset',
    fieldName: string | undefined,
    blockers: SerializedAssetReadinessBlocker[],
  ): void {
    if (!fieldName) return; // absence is already a `profile_invalid` blocker.
    const field = findField(description, fieldName);
    if (!field) {
      blockers.push({
        code: 'field_missing',
        message: `Salesforce ${objectName} has no field '${fieldName}'`,
      });
      return;
    }
    if (!field.externalId) {
      blockers.push({
        code: 'field_not_external_id',
        message: `${objectName}.${fieldName} is not marked as an External ID`,
      });
    }
    if (!field.unique) {
      blockers.push({
        code: 'field_not_unique',
        message: `${objectName}.${fieldName} is not unique`,
      });
    }
  }

  private result(
    checkedAt: string,
    blockers: SerializedAssetReadinessBlocker[],
    productExternalIdFields: string[],
    assetExternalIdFields: string[],
  ): SerializedAssetReadinessResult {
    return {
      ready: blockers.length === 0,
      checkedAt,
      blockers,
      productExternalIdFields,
      assetExternalIdFields,
    };
  }
}
