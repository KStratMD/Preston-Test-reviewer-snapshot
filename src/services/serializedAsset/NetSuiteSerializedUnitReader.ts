import { requireReadySerializedAssetProfile } from './SerializedAssetProfileValidator';
import { DANGEROUS_PATH_SEGMENTS } from './readerSourceField';
import { canonicalJson, sha256Hex } from '../cardinality/fingerprint';
import type { DataRecord, FieldMapping, IntegrationConfig } from '../../types';
import type { SerializedUnit } from '../../types/serializedAsset';

/**
 * Normalizes already-fetched NetSuite `inventorynumber` records into the
 * plan's `SerializedUnit` shape (Task 3, 2026-07-27 NetSuite serialized-asset
 * sync plan). Pure: no logging, persistence, connector I/O, or clock reads —
 * the same discipline as `SerializedAssetProfileValidator`, and for the same
 * reason (decision 8): a serial number legitimately flows through here, so
 * nothing in this module may echo one into a log, metric, or exception
 * message. The only place a serial number appears in this module's output is
 * `SerializedUnit.serialNumber` itself.
 *
 * Source grain (decision 3): one `inventorynumber` row is one physical unit.
 * `normalizeBatch` never merges or splits rows — each input record produces
 * at most one `SerializedUnit` or exactly one `SerializedAssetFailure`,
 * never both and never neither.
 *
 * Trusts, but re-verifies, its inputs:
 *  - `context.tenantId`/`context.configurationId` must agree with the
 *    config's own `tenantId`/`id`. This mirrors
 *    `DeferredSerializedUnitRepository.upsertDeferred`'s guard: a caller
 *    passing a context that disagrees with the config it is reading from is
 *    a caller bug, not a per-record data problem, so it throws instead of
 *    silently trusting one side.
 *  - `config` itself is re-validated via `requireReadySerializedAssetProfile`
 *    on every call. Task 6's activation-readiness gate is expected to have
 *    already confirmed this, but this reader never assumes that happened —
 *    it throws `SerializedAssetProfileNotReadyError` itself if not.
 */

/** Closed set of reasons a single record was rejected. Never a field name or value. */
export type SerializedAssetFailureCategory = 'missing_required_field' | 'invalid_scalar_value';

/**
 * One rejected input record. Deliberately carries nothing but a positional
 * index, an opaque one-way hash of the whole raw record, and a closed-set
 * category — never a field name, a source value, or any excerpt of the
 * record (decision 8). `recordHash` is a SHA-256 digest (see
 * `../cardinality/fingerprint.ts`), so even a record whose only fault was a
 * structured `item` value can never leak anything reversible through this
 * type.
 */
export interface SerializedAssetFailure {
  recordIndex: number;
  recordHash: string;
  category: SerializedAssetFailureCategory;
}

/** Trusted run context the caller asserts this batch is being normalized under. */
export interface NormalizeBatchContext {
  tenantId: string;
  configurationId: string;
}

export interface NormalizeBatchResult {
  units: SerializedUnit[];
  invalid: SerializedAssetFailure[];
}

// Both live in the zero-import leaf module `readerSourceField.ts` so that
// `SerializedAssetProfileValidator.ts` can enforce the same path rules at
// activation time without closing an import cycle (this module already
// imports the validator). Re-exported here so existing importers are
// unchanged.
export { DANGEROUS_PATH_SEGMENTS, isReaderResolvableSourceField } from './readerSourceField';

/** Top-level `DataRecord` properties a single-segment sourceField may fall back to when absent from `fields`. */
const TOP_LEVEL_FALLBACK_KEYS: ReadonlySet<string> = new Set(['id', 'externalId']);

type ScalarResult = { ok: true; value: string } | { ok: false; category: SerializedAssetFailureCategory };

/**
 * Safe own-property lookup: refuses the three dangerous segment names
 * unconditionally, and otherwise refuses anything not an own property of
 * `source` — so a lookup can never walk onto `Object.prototype` (e.g.
 * `toString`, `constructor`) via ordinary prototype-chain inheritance
 * either.
 */
function ownProperty(source: unknown, segment: string): unknown {
  if (DANGEROUS_PATH_SEGMENTS.has(segment)) {
    return undefined;
  }
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(source, segment)) {
    return undefined;
  }
  return (source as Record<string, unknown>)[segment];
}

/**
 * Resolves one dotted `sourceField` path against a `DataRecord`. The first
 * segment is looked up in `record.fields` first (the shape every connector
 * populates); a single-segment path that misses there falls back to the
 * record's own `id`/`externalId` (the two identity properties
 * `NetSuiteConnector.formatDataFromNetSuite` promotes out of `fields`).
 * Every remaining segment walks strictly inside whatever value the previous
 * segment resolved to, via `ownProperty` — so a nested reference object
 * (NetSuite's `{ id, refName }` shape for lookup fields) can be pierced down
 * to its scalar `id`, but no path segment can ever escape onto a prototype.
 */
function resolveSourceValue(record: DataRecord, sourceField: string): unknown {
  const [firstSegment, ...restSegments] = sourceField.split('.');
  const fields = record.fields;

  let current = ownProperty(fields, firstSegment);
  if (current === undefined && restSegments.length === 0 && TOP_LEVEL_FALLBACK_KEYS.has(firstSegment)) {
    current = ownProperty(record, firstSegment);
  }

  for (const segment of restSegments) {
    current = ownProperty(current, segment);
  }

  return current;
}

/**
 * Accepts only non-empty (after trimming) strings and finite numbers
 * (converted with `String(value)`); rejects everything else, including
 * arrays, objects, booleans, symbols, functions, and non-finite numbers.
 * `undefined`/`null` (a genuinely absent value, including anything
 * `resolveSourceValue` blocked for safety) is reported as
 * `missing_required_field`; any other rejected shape is
 * `invalid_scalar_value`. A whitespace-only string is treated the same as an
 * empty one (`missing_required_field`, not coerced) — `inventoryNumberId`
 * becomes both the Salesforce upsert external-ID key (decision 4) and the
 * deferred-work uniqueness key (decision 9), so a blank-ish value must never
 * pass as "valid". Accepted strings are returned TRIMMED (matches
 * `normalizeEntityIdentifier`'s and `SerializedAssetProfileValidator`'s
 * existing trim convention), so `SerializedUnit` fields never carry
 * incidental leading/trailing whitespace either.
 */
function normalizeScalar(value: unknown): ScalarResult {
  if (value === undefined || value === null) {
    return { ok: false, category: 'missing_required_field' };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false, category: 'missing_required_field' };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value: String(value) }
      : { ok: false, category: 'invalid_scalar_value' };
  }
  return { ok: false, category: 'invalid_scalar_value' };
}

/**
 * Finds the single `FieldMapping` targeting `targetField`. Task 1's
 * `evaluateSerializedAssetProfile` already guarantees exactly one such
 * mapping exists whenever `requireReadySerializedAssetProfile` (called
 * before this) returns successfully — this is defense-in-depth, not a path
 * this reader expects to exercise. Its error names only the schema-level
 * target field, never a record value.
 *
 * Returns the sourceField TRIMMED. Task 1's validator only checks
 * `sourceField.trim().length > 0` (never rewrites the stored value), so a
 * configured path like `' id '` passes activation as-is. Left untrimmed
 * here, that padding would make `resolveSourceValue`'s path-segment lookup
 * miss on every single record (since `record.fields` is never keyed with
 * leading/trailing whitespace) — and because failures deliberately carry no
 * field name (decision 8), that would be silent and effectively
 * undiagnosable in production. Trimming is applied only at this use site,
 * never persisted back onto the stored `IntegrationConfig`.
 */
function requireMappingSourceField(fieldMappings: readonly FieldMapping[], targetField: string): string {
  const match = fieldMappings.find((mapping) => mapping.targetField === targetField);
  if (!match || typeof match.sourceField !== 'string' || match.sourceField.trim().length === 0) {
    throw new Error(`NetSuiteSerializedUnitReader: no field mapping targets '${targetField}'`);
  }
  return match.sourceField.trim();
}

/** Opaque, one-way identifier for a raw record. Never reversible; safe to carry alongside a category in diagnostics. */
function hashRecord(record: DataRecord): string {
  return sha256Hex(canonicalJson(record));
}

/**
 * Normalizes a batch of already-fetched NetSuite `inventorynumber` records
 * into `SerializedUnit`s. See the module doc comment for the context-
 * agreement and profile-readiness preconditions (both throw rather than
 * silently proceeding); per-record problems land in `invalid` instead.
 */
export function normalizeBatch(
  records: readonly DataRecord[],
  config: IntegrationConfig,
  context: NormalizeBatchContext,
): NormalizeBatchResult {
  if (config.tenantId !== context.tenantId || config.id !== context.configurationId) {
    throw new Error('NetSuiteSerializedUnitReader: context does not match configuration');
  }

  const readyProfile = requireReadySerializedAssetProfile(config);
  const fieldMappings = config.fieldMappings ?? [];

  const inventoryNumberIdSource = requireMappingSourceField(fieldMappings, readyProfile.assetExternalIdField);
  const serialNumberSource = requireMappingSourceField(fieldMappings, readyProfile.serialNumberTargetField);
  const itemIdSource = requireMappingSourceField(fieldMappings, readyProfile.productReferenceTargetField);
  const statusSource =
    readyProfile.statusTargetField !== undefined
      ? requireMappingSourceField(fieldMappings, readyProfile.statusTargetField)
      : undefined;
  const locationSource =
    readyProfile.locationTargetField !== undefined
      ? requireMappingSourceField(fieldMappings, readyProfile.locationTargetField)
      : undefined;

  const units: SerializedUnit[] = [];
  const invalid: SerializedAssetFailure[] = [];

  records.forEach((record, recordIndex) => {
    const inventoryNumberId = normalizeScalar(resolveSourceValue(record, inventoryNumberIdSource));
    if (inventoryNumberId.ok === false) {
      invalid.push({ recordIndex, recordHash: hashRecord(record), category: inventoryNumberId.category });
      return;
    }
    const serialNumber = normalizeScalar(resolveSourceValue(record, serialNumberSource));
    if (serialNumber.ok === false) {
      invalid.push({ recordIndex, recordHash: hashRecord(record), category: serialNumber.category });
      return;
    }
    const itemId = normalizeScalar(resolveSourceValue(record, itemIdSource));
    if (itemId.ok === false) {
      invalid.push({ recordIndex, recordHash: hashRecord(record), category: itemId.category });
      return;
    }

    const unit: SerializedUnit = {
      tenantId: context.tenantId,
      configurationId: context.configurationId,
      inventoryNumberId: inventoryNumberId.value,
      serialNumber: serialNumber.value,
      itemId: itemId.value,
    };

    if (statusSource !== undefined) {
      const status = normalizeScalar(resolveSourceValue(record, statusSource));
      if (status.ok === true) {
        unit.status = status.value;
      }
    }
    if (locationSource !== undefined) {
      const location = normalizeScalar(resolveSourceValue(record, locationSource));
      if (location.ok === true) {
        unit.location = location.value;
      }
    }

    units.push(unit);
  });

  return { units, invalid };
}
