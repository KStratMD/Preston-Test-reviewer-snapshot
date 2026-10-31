import type { IConnector } from '../interfaces/IConnector';
import type { SystemConfig } from './index';

/**
 * Domain types for the NetSuite serialized-asset execution profile (Task 1,
 * 2026-07-27 NetSuite serialized-asset sync plan). Pure data contracts only —
 * no logging, persistence, connector I/O, clock reads, or environment access.
 *
 * `IntegrationConfig` gains two optional fields (declared on that interface
 * in `./index`, imported back here for the validator's structural input
 * type): `executionProfile` and `executionProfileConfig`. `undefined` and
 * `'standard'` preserve current (non-specialized) behavior — see
 * `src/services/serializedAsset/SerializedAssetProfileValidator.ts` for the
 * pure rule set shared by schema parsing, activation readiness, and runtime
 * fail-closed checks.
 */

/** Execution profiles a persisted `IntegrationConfig` may declare. */
export type IntegrationExecutionProfile = 'standard' | 'netsuite_serialized_asset';

/**
 * Specialized-profile configuration as it may exist on an inactive draft:
 * discovered field names and mappings may still be incomplete. Only
 * `executionProfile` itself is required (it doubles as the nested
 * discriminator — it must agree with the outer `IntegrationConfig.executionProfile`,
 * enforced by the schema's `superRefine`, not by this type).
 */
export interface SerializedAssetProfileDraftConfig {
  executionProfile: 'netsuite_serialized_asset';
  /**
   * Salesforce Product2 external-ID field API name used to resolve the
   * Asset's `Product2Id` lookup. NOT itself a `fieldMappings` target — it is
   * metadata the executor uses directly for a native lookup (Task 4/7), so
   * it is deliberately absent from the `requiredTargets` mapping-count list.
   */
  productExternalIdField?: string;
  /** Salesforce Asset external-ID field API name used for the native upsert (decision 4). */
  assetExternalIdField?: string;
  /** Fixed: the only Asset field the profile ever writes the serial number to. */
  serialNumberTargetField?: 'SerialNumber';
  /** Fixed: the only Asset field the profile ever writes the product lookup to. */
  productReferenceTargetField?: 'Product2Id';
  /** Optional Salesforce Asset field API name to receive the source status, if configured. */
  statusTargetField?: string;
  /** Optional Salesforce Asset field API name to receive the source location, if configured. */
  locationTargetField?: string;
}

/**
 * The complete, activation/runtime-ready shape. Every field `requireReadySerializedAssetProfile`
 * treats as mandatory for a `netsuite_serialized_asset` profile is required here.
 */
export interface ReadySerializedAssetProfileConfig extends SerializedAssetProfileDraftConfig {
  productExternalIdField: string;
  assetExternalIdField: string;
  serialNumberTargetField: 'SerialNumber';
  productReferenceTargetField: 'Product2Id';
}

/** One normalized source-of-truth row: a physical serialized unit (NetSuite `inventorynumber`). */
export interface SerializedUnit {
  tenantId: string;
  configurationId: string;
  inventoryNumberId: string;
  serialNumber: string;
  itemId: string;
  status?: string;
  location?: string;
}

/**
 * The only two `FieldMapping` properties the profile validator reads (target-
 * field matching + non-empty source-path checks). Deliberately narrower than
 * the full `FieldMapping` interface — `IntegrationConfigSchema`'s zod-inferred
 * `transformationConfig.type` is optional where the hand-written `FieldMapping`
 * type marks it required, and the validator has no business depending on that
 * (or any other mapping property it never reads) anyway. Any real
 * `FieldMapping` structurally satisfies this.
 */
export interface SerializedAssetProfileMappingRef {
  sourceField: string;
  targetField: string;
}

/**
 * The structural subset of `IntegrationConfig` the pure profile validator
 * needs. Declared here (rather than importing `IntegrationConfig` directly)
 * so the validator has no dependency on the full type — any object shaped
 * like this (including a real `IntegrationConfig`, and the zod-inferred
 * intermediate object seen inside `IntegrationConfigSchema`'s `superRefine`)
 * satisfies it structurally.
 */
export interface SerializedAssetProfileValidationSubject {
  sourceSystem: string | SystemConfig;
  targetSystem: string | SystemConfig;
  sourceEntity: string;
  targetEntity: string;
  syncDirection: string;
  syncMode: string;
  isActive: boolean;
  fieldMappings?: SerializedAssetProfileMappingRef[];
  executionProfile?: IntegrationExecutionProfile;
  executionProfileConfig?: SerializedAssetProfileDraftConfig;
}

/**
 * One Salesforce object-describe field entry (Task 4). Mirrors the subset of
 * Salesforce's real `/sobjects/{name}/describe` field-describe response this
 * codebase actually consumes: `createable`/`updateable`/`queryable` gate
 * whether the profile can write/read the field at all, `externalId`/`unique`
 * are read by Task 6's activation readiness (the configured Product2 lookup
 * field must be both), and `referenceTo` identifies lookup/master-detail
 * fields such as `Asset.Product2Id`.
 */
export interface SalesforceFieldDescription {
  readonly name: string;
  readonly type: string;
  readonly createable: boolean;
  readonly updateable: boolean;
  readonly queryable: boolean;
  readonly externalId: boolean;
  readonly unique: boolean;
  readonly referenceTo: readonly string[];
}

/** Salesforce object-level describe metadata (Task 4/6). */
export interface SalesforceObjectDescription {
  readonly name: string;
  readonly createable: boolean;
  readonly updateable: boolean;
  readonly queryable: boolean;
  readonly fields: readonly SalesforceFieldDescription[];
}

/**
 * Live Salesforce read capabilities the `netsuite_serialized_asset`
 * execution profile needs before its native Asset upsert (Task 4): object
 * metadata for activation readiness (Task 6), and an exact Product2
 * External-ID lookup for the write path (Task 7). Deliberately read-only —
 * the mutation stays on `IConnector.upsert` so both static write scanners
 * (`check-guarded-writes.mjs`, `check-write-descriptor-equivalence.mjs`) can
 * see a plain property-access call on a base-typed `IConnector` receiver;
 * see `assertSalesforceSerializedAssetReadCapabilities` (Task 7), which
 * narrows a base `IConnector` down to `IConnector & SalesforceSerializedAssetReadCapabilities`
 * for reads only, never for the write.
 */
export interface SalesforceSerializedAssetReadCapabilities {
  describeSObject(entityType: 'Product2' | 'Asset'): Promise<SalesforceObjectDescription>;
  findProduct2ByExternalId(field: string, value: string): Promise<readonly { Id: string }[]>;
}

/**
 * Narrows a base-typed `IConnector` to the serialized-asset READ surface.
 *
 * Deliberately an assertion function rather than a cast at the call site:
 * consumers (Task 6 activation readiness, Task 7 execution) receive connectors
 * from `ConnectorManager`, which is typed to the base `IConnector` contract, so
 * without this the read capabilities would have to be reached through an
 * escape-hatch cast. Throwing on a connector that does not implement them keeps
 * a misconfigured target system a loud, determinable failure instead of a
 * silently skipped check.
 *
 * The WRITE path is intentionally NOT narrowed here — the Asset mutation stays
 * on the plain `IConnector.upsert` receiver so both static write scanners can
 * still see it (see this interface's doc comment).
 *
 * `IConnector` is imported type-only, so this module gains no runtime edge to
 * the connector layer (which imports back through `src/types/index.ts`).
 */
export function assertSalesforceSerializedAssetReadCapabilities(
  connector: IConnector,
): asserts connector is IConnector & SalesforceSerializedAssetReadCapabilities {
  const candidate = connector as Partial<SalesforceSerializedAssetReadCapabilities> | null | undefined;
  if (
    !candidate ||
    typeof candidate.describeSObject !== 'function' ||
    typeof candidate.findProduct2ByExternalId !== 'function'
  ) {
    throw new Error(
      'Connector does not provide the Salesforce serialized-asset read capabilities (describeSObject / findProduct2ByExternalId)',
    );
  }
}
