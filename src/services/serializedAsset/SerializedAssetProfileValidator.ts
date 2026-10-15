import { connectorKeyForSystem } from '../../connectors/connectorIdentity';
import { SALESFORCE_FIELD_NAME_PATTERN } from './salesforceFieldName';
import { isReaderResolvableSourceField } from './readerSourceField';
import type {
  ReadySerializedAssetProfileConfig,
  SerializedAssetProfileDraftConfig,
  SerializedAssetProfileValidationSubject,
} from '../../types/serializedAsset';

/**
 * Pure validator for the `netsuite_serialized_asset` execution profile
 * (Task 1, 2026-07-27 NetSuite serialized-asset sync plan). No logging,
 * persistence, connector I/O, clock reads, or environment access — the same
 * rules here are reused by:
 *   - `src/schemas/configurationSchemas.ts`'s `superRefine` (active configs only),
 *   - `requireReadySerializedAssetProfile` (activation readiness, Task 6),
 *   - runtime fail-closed checks (Task 7).
 *
 * `connectorKeyForSystem` (Prerequisite PR A) throws on an unrecognized
 * system alias — `resolveConnectorKey` below converts that throw into an
 * `undefined` so an unknown system yields a clean validation issue instead
 * of an unhandled exception surfacing through `safeParse`.
 */

/**
 * Re-exported from the leaf `salesforceFieldName.ts` module (Task 4 fix-up)
 * so `src/schemas/configurationSchemas.ts` and any other existing importer
 * of `SALESFORCE_FIELD_NAME_PATTERN` from THIS module keeps working
 * unchanged. `SalesforceConnector.ts` imports the leaf module directly
 * instead of from here — see that module's doc comment for why.
 */
export { SALESFORCE_FIELD_NAME_PATTERN };

/** One validation failure, shaped so callers can forward it directly to a Zod `ctx.addIssue`. */
export interface SerializedAssetProfileIssue {
  path: (string | number)[];
  message: string;
}

export type SerializedAssetProfileEvaluation =
  | { ok: true; profile: ReadySerializedAssetProfileConfig }
  | { ok: false; issues: SerializedAssetProfileIssue[] };

/**
 * Entity/profile-name comparison rule shared with `RelationshipEvidenceProvider`
 * and `CardinalityAnalysisService`: trim + locale-lowercase so NetSuite REST's
 * `inventoryNumber` spelling and the trusted catalog's lowercase `inventorynumber`
 * key both validate.
 */
export function normalizeEntityIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function resolveConnectorKey(
  system: SerializedAssetProfileValidationSubject['sourceSystem'],
): string | undefined {
  try {
    return connectorKeyForSystem(system);
  } catch {
    return undefined;
  }
}

/**
 * Deterministic, model-independent input for the Task 10 ADVISORY profile
 * recommendation (`FieldMappingAgent.buildExecutionProfileRecommendation`).
 * Structurally identical to the four fields `evaluateSerializedAssetProfile`
 * checks, but kept as its own type: the advisory surface never touches an
 * `IntegrationConfig`, `fieldMappings`, or anything else that function's
 * subject type carries.
 */
export interface SerializedAssetAdvisoryHint {
  sourceSystem: string;
  targetSystem: string;
  sourceEntity: string;
  targetEntity: string;
}

/**
 * Exact-match test for the netsuite_serialized_asset ADVISORY recommendation
 * (Task 10, decision 10: "AI may recommend the profile ... but cannot ...
 * bypass readiness"). Reuses `resolveConnectorKey`/`normalizeEntityIdentifier`
 * — the same projections `evaluateSerializedAssetProfile`'s system/entity
 * block uses — so the advisory surface can never recommend a pair the
 * activation-time gate would itself refuse. Never throws: an unresolved
 * system alias or a non-string field is simply a non-match, exactly like
 * `resolveConnectorKey`'s own fail-closed behavior.
 */
export function matchesSerializedAssetAdvisoryPair(hint: SerializedAssetAdvisoryHint): boolean {
  if (typeof hint.sourceSystem !== 'string' || resolveConnectorKey(hint.sourceSystem) !== 'netsuite') {
    return false;
  }
  if (typeof hint.targetSystem !== 'string' || resolveConnectorKey(hint.targetSystem) !== 'salesforce') {
    return false;
  }
  if (typeof hint.sourceEntity !== 'string' || normalizeEntityIdentifier(hint.sourceEntity) !== 'inventorynumber') {
    return false;
  }
  if (typeof hint.targetEntity !== 'string' || normalizeEntityIdentifier(hint.targetEntity) !== 'asset') {
    return false;
  }
  return true;
}

/**
 * Type guard, not a plain string check: this function (and every other
 * `.trim()`/pattern check below) may run against a config loaded from raw,
 * unvalidated on-disk JSON (`ConfigurationService.loadConfigurations` reads
 * `${id}.json` without re-running it through the Zod schema), where a field
 * the TS type claims is `string` can actually be `undefined` or some other
 * JSON value. Accepting `unknown` and checking `typeof` here — rather than
 * trusting the declared type — turns a malformed value into a normal
 * validation issue instead of a thrown TypeError. See `evaluateSerializedAssetProfile`'s
 * doc comment: this function must never throw.
 */
function isSalesforceFieldName(value: unknown): value is string {
  return typeof value === 'string' && SALESFORCE_FIELD_NAME_PATTERN.test(value);
}

/** One profile field slot eligible to be a `fieldMappings` target. */
interface RequiredTargetEntry {
  key: string;
  target: string;
}

/**
 * The always-required target slots plus whichever optional slots
 * (`statusTargetField` / `locationTargetField`) are configured. Deliberately
 * excludes `productExternalIdField` — that field is executor lookup metadata,
 * never a `fieldMappings` target (see the type's doc comment).
 */
function collectRequiredTargets(profile: SerializedAssetProfileDraftConfig): RequiredTargetEntry[] {
  const entries: RequiredTargetEntry[] = [];
  if (profile.assetExternalIdField !== undefined) {
    entries.push({ key: 'assetExternalIdField', target: profile.assetExternalIdField });
  }
  if (profile.serialNumberTargetField !== undefined) {
    entries.push({ key: 'serialNumberTargetField', target: profile.serialNumberTargetField });
  }
  if (profile.productReferenceTargetField !== undefined) {
    entries.push({ key: 'productReferenceTargetField', target: profile.productReferenceTargetField });
  }
  if (profile.statusTargetField !== undefined) {
    entries.push({ key: 'statusTargetField', target: profile.statusTargetField });
  }
  if (profile.locationTargetField !== undefined) {
    entries.push({ key: 'locationTargetField', target: profile.locationTargetField });
  }
  return entries;
}

/**
 * Pure evaluator: the same rule set the Zod schema and `requireReadySerializedAssetProfile`
 * both call. Never throws — an unresolvable system alias becomes an issue, not
 * an exception. Assumes base-schema-level constraints (string lengths, etc.)
 * already passed; this function focuses on the profile-specific contract.
 */
export function evaluateSerializedAssetProfile(
  config: SerializedAssetProfileValidationSubject,
): SerializedAssetProfileEvaluation {
  const issues: SerializedAssetProfileIssue[] = [];
  const profile = config.executionProfileConfig;

  if (!profile) {
    return {
      ok: false,
      issues: [{
        path: ['executionProfileConfig'],
        message: 'executionProfileConfig is required for the netsuite_serialized_asset execution profile',
      }],
    };
  }

  // The NESTED discriminator must agree with the outer one. The Zod schema
  // pins it with `z.literal(...)`, but this evaluator explicitly also runs
  // against raw persisted JSON that never passed Zod — and the success branch
  // below hardcodes `executionProfile: 'netsuite_serialized_asset'` in the
  // returned profile, so an unchecked contradictory inner value (outer
  // `netsuite_serialized_asset`, inner `standard`) would be silently rewritten
  // rather than refused.
  if (profile.executionProfile !== 'netsuite_serialized_asset') {
    issues.push({
      path: ['executionProfileConfig', 'executionProfile'],
      message: "executionProfileConfig.executionProfile must be 'netsuite_serialized_asset'",
    });
  }

  // System/entity/direction/mode contract (decision: NetSuite -> Salesforce,
  // inventorynumber -> Asset, source_to_target, batch/manual).
  if (resolveConnectorKey(config.sourceSystem) !== 'netsuite') {
    issues.push({
      path: ['sourceSystem'],
      message: 'netsuite_serialized_asset profile requires sourceSystem to resolve to the netsuite connector',
    });
  }
  if (resolveConnectorKey(config.targetSystem) !== 'salesforce') {
    issues.push({
      path: ['targetSystem'],
      message: 'netsuite_serialized_asset profile requires targetSystem to resolve to the salesforce connector',
    });
  }
  // typeof guards (not the declared `string` type): `config` may come from
  // raw, unvalidated on-disk JSON, so a missing/malformed sourceEntity or
  // targetEntity must become an issue here, never a thrown TypeError from
  // normalizeEntityIdentifier's `.trim()`.
  if (typeof config.sourceEntity !== 'string') {
    issues.push({
      path: ['sourceEntity'],
      message: 'netsuite_serialized_asset profile requires sourceEntity to be a string',
    });
  } else if (normalizeEntityIdentifier(config.sourceEntity) !== 'inventorynumber') {
    issues.push({
      path: ['sourceEntity'],
      message: "netsuite_serialized_asset profile requires sourceEntity to be 'inventorynumber'",
    });
  }
  if (typeof config.targetEntity !== 'string') {
    issues.push({
      path: ['targetEntity'],
      message: 'netsuite_serialized_asset profile requires targetEntity to be a string',
    });
  } else if (normalizeEntityIdentifier(config.targetEntity) !== 'asset') {
    issues.push({
      path: ['targetEntity'],
      message: "netsuite_serialized_asset profile requires targetEntity to be 'Asset'",
    });
  }
  if (config.syncDirection !== 'source_to_target') {
    issues.push({
      path: ['syncDirection'],
      message: "netsuite_serialized_asset profile requires syncDirection to be 'source_to_target'",
    });
  }
  if (config.syncMode !== 'batch' && config.syncMode !== 'manual') {
    issues.push({
      path: ['syncMode'],
      message: "netsuite_serialized_asset profile requires syncMode to be 'batch' or 'manual'",
    });
  }

  // Required profile field presence + Salesforce field-name format.
  const { productExternalIdField, assetExternalIdField, statusTargetField, locationTargetField } = profile;

  if (productExternalIdField === undefined) {
    issues.push({
      path: ['executionProfileConfig', 'productExternalIdField'],
      message: 'productExternalIdField is required to activate the netsuite_serialized_asset profile',
    });
  } else if (!isSalesforceFieldName(productExternalIdField)) {
    issues.push({
      path: ['executionProfileConfig', 'productExternalIdField'],
      message: 'productExternalIdField must be a valid Salesforce field API name',
    });
  }

  if (assetExternalIdField === undefined) {
    issues.push({
      path: ['executionProfileConfig', 'assetExternalIdField'],
      message: 'assetExternalIdField is required to activate the netsuite_serialized_asset profile',
    });
  } else if (!isSalesforceFieldName(assetExternalIdField)) {
    issues.push({
      path: ['executionProfileConfig', 'assetExternalIdField'],
      message: 'assetExternalIdField must be a valid Salesforce field API name',
    });
  }

  if (profile.serialNumberTargetField !== 'SerialNumber') {
    issues.push({
      path: ['executionProfileConfig', 'serialNumberTargetField'],
      message: "serialNumberTargetField must be 'SerialNumber'",
    });
  }

  if (profile.productReferenceTargetField !== 'Product2Id') {
    issues.push({
      path: ['executionProfileConfig', 'productReferenceTargetField'],
      message: "productReferenceTargetField must be 'Product2Id'",
    });
  }

  if (statusTargetField !== undefined && !isSalesforceFieldName(statusTargetField)) {
    issues.push({
      path: ['executionProfileConfig', 'statusTargetField'],
      message: 'statusTargetField must be a valid Salesforce field API name',
    });
  }

  if (locationTargetField !== undefined && !isSalesforceFieldName(locationTargetField)) {
    issues.push({
      path: ['executionProfileConfig', 'locationTargetField'],
      message: 'locationTargetField must be a valid Salesforce field API name',
    });
  }

  // Required mapping targets: duplicates within the profile itself, then
  // exactly-one-mapping-per-target, then a closed whitelist rejecting any
  // mapping whose target isn't one of these slots (this is what makes an
  // unconfigured optional target's mapping an error too: it simply is not
  // part of the whitelist).
  const requiredTargets = collectRequiredTargets(profile);
  const targetToKeys = new Map<string, string[]>();
  for (const entry of requiredTargets) {
    const keys = targetToKeys.get(entry.target) ?? [];
    keys.push(entry.key);
    targetToKeys.set(entry.target, keys);
  }
  for (const [target, keys] of targetToKeys) {
    if (keys.length > 1) {
      issues.push({
        path: ['executionProfileConfig'],
        message: `duplicate required target '${target}' used by both ${keys.join(' and ')}`,
      });
    }
  }

  // `?? []` alone is not enough: this evaluator explicitly accepts raw,
  // unvalidated on-disk JSON, where `fieldMappings` can be a non-array (e.g.
  // `{}`). `.filter()` on that throws a TypeError, which would break the
  // documented "never throws" contract and turn readiness/activation into an
  // unclassified 500 instead of a closed validation result.
  const fieldMappings = Array.isArray(config.fieldMappings) ? config.fieldMappings : [];
  if (config.fieldMappings !== undefined && !Array.isArray(config.fieldMappings)) {
    issues.push({
      path: ['fieldMappings'],
      message: 'fieldMappings must be an array',
    });
  }
  const whitelistedTargets = new Set(requiredTargets.map(entry => entry.target));

  for (const entry of requiredTargets) {
    const matches = fieldMappings.filter(mapping => mapping.targetField === entry.target);
    if (matches.length === 0) {
      issues.push({
        path: ['fieldMappings'],
        message: `no field mapping targets ${entry.key} ('${entry.target}')`,
      });
    } else if (matches.length > 1) {
      issues.push({
        path: ['fieldMappings'],
        message: `multiple field mappings target ${entry.key} ('${entry.target}') — ambiguous source`,
      });
    } else if (!isReaderResolvableSourceField(matches[0].sourceField)) {
      // Stricter than "non-empty string" on purpose, and it must be the
      // reader's OWN rule set rather than a second, drifting copy. A path the
      // reader can never resolve (a `fields.`-rooted path, a padded or empty
      // segment, a dangerous segment) previously passed activation, and then
      // every record failed `missing_required_field` inside `normalizeBatch`
      // and landed in `invalid` — which is NOT deferred — while the sweep
      // cursor had already advanced past that window. Refusing at activation
      // is the only point where that is still recoverable.
      issues.push({
        path: ['fieldMappings'],
        message: `sourceField for ${entry.key} must be a non-empty scalar path the reader can resolve`,
      });
    }
  }

  fieldMappings.forEach((mapping, index) => {
    if (!whitelistedTargets.has(mapping.targetField)) {
      issues.push({
        path: ['fieldMappings', index, 'targetField'],
        message: `field mapping targets '${mapping.targetField}', which is not part of the netsuite_serialized_asset profile`,
      });
    }
  });

  if (
    issues.length > 0 ||
    productExternalIdField === undefined ||
    assetExternalIdField === undefined
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    profile: {
      executionProfile: 'netsuite_serialized_asset',
      productExternalIdField,
      assetExternalIdField,
      serialNumberTargetField: 'SerialNumber',
      productReferenceTargetField: 'Product2Id',
      statusTargetField,
      locationTargetField,
    },
  };
}

/** Thrown by `requireReadySerializedAssetProfile` when the profile is not activation/runtime ready. */
export class SerializedAssetProfileNotReadyError extends Error {
  public readonly issues: SerializedAssetProfileIssue[];

  constructor(issues: SerializedAssetProfileIssue[]) {
    super(
      `netsuite_serialized_asset profile is not ready: ${issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'SerializedAssetProfileNotReadyError';
    this.issues = issues;
  }
}

/**
 * Enforces the complete NetSuite -> Salesforce, inventorynumber -> Asset,
 * source_to_target, batch/manual contract and returns the ready, activation/
 * runtime-usable profile. Active specialized persistence always uses this
 * strict path (via the schema's `superRefine`); Task 6's activation guard and
 * Task 7's runtime fail-closed checks call it directly.
 */
export function requireReadySerializedAssetProfile(
  config: SerializedAssetProfileValidationSubject,
): ReadySerializedAssetProfileConfig {
  if (config.executionProfile !== 'netsuite_serialized_asset') {
    throw new SerializedAssetProfileNotReadyError([{
      path: ['executionProfile'],
      message: "executionProfile must be 'netsuite_serialized_asset'",
    }]);
  }

  const evaluation = evaluateSerializedAssetProfile(config);
  // `=== false` (not `!evaluation.ok`): with this repo's `strictNullChecks: false`
  // main tsconfig, TS's control-flow narrowing of a discriminated union does not
  // reliably propagate through a bare `!` negation or an `if/else` split, but an
  // explicit literal-equality guard narrows correctly (verified in isolation).
  if (evaluation.ok === false) {
    throw new SerializedAssetProfileNotReadyError(evaluation.issues);
  }
  return evaluation.profile;
}
