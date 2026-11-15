/**
 * `NetSuiteSerializedUnitReader`'s source-field path rules, extracted as their
 * own leaf module for the same reason as `salesforceFieldName.ts`: deliberately
 * ZERO imports, so that both the reader AND
 * `SerializedAssetProfileValidator.ts` can depend on one definition of "a path
 * this reader could ever resolve" without closing an import cycle. The reader
 * already imports `requireReadySerializedAssetProfile` FROM the validator, so
 * the validator can never import back from the reader.
 *
 * `NetSuiteSerializedUnitReader.ts` re-exports both symbols, so existing
 * importers (`FieldMappingAgent.ts`, the reader's own unit test) are unchanged.
 */

/**
 * Path segments that must never be followed, even when they exist as a real
 * own property. `JSON.parse('{"__proto__": ...}')` creates a genuine own
 * enumerable data property literally named `__proto__` (the JSON.parse
 * algorithm uses CreateDataProperty, not the `[[Set]]` accessor an object
 * literal or assignment would trigger) — so an own-property check alone is
 * not sufficient; these three names are refused unconditionally.
 */
export const DANGEROUS_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Structural predicate for a source field path this reader's own safety rules
 * would ever attempt to resolve — a NECESSARY, not sufficient, condition:
 * whether a given path actually yields a value still depends on the real
 * record shape, which this function never sees. It rejects:
 *   - a non-string, empty, or whitespace-only value;
 *   - any segment with leading/trailing whitespace (e.g. `item . id` —
 *     `resolveSourceValue`'s `ownProperty` lookup is an exact key match, so a
 *     padded segment can never hit a real `fields` key);
 *   - an empty segment (a leading/trailing/doubled `.`);
 *   - a `DANGEROUS_PATH_SEGMENTS` segment anywhere (`__proto__`, `prototype`,
 *     `constructor`);
 *   - a path whose FIRST segment is the literal string `fields`. This is the
 *     one convention-divergence case that is always wrong, not merely
 *     record-dependent: the AI layer's `getRecordValue`
 *     (`src/services/ai/utils/dataRecord.ts`) resolves a dotted path by
 *     walking from the record ROOT, so `'fields.something'` resolves (from
 *     the AI's perspective) to `record.fields.something` — a real value, since
 *     `fields` genuinely is a root-level `DataRecord` property. But the
 *     reader's `resolveSourceValue` treats `'fields'` as an ordinary first
 *     segment name to look up INSIDE `record.fields` (i.e.
 *     `ownProperty(record.fields, 'fields')`), which is never a real key —
 *     so a model that reasons in the AI layer's convention would confidently
 *     recommend a path that silently invalidates every single record.
 *
 * Deliberately does NOT reject dotted (multi-segment) paths in general:
 * piercing a NetSuite lookup/reference field (e.g. `item.id`, `location.id`)
 * is the reader's normal, expected shape for the `parent_item_id`/`location`
 * roles (see `NetSuiteSerializedUnitReader.test.ts`'s fixtures), and the
 * reader resolves those from `fields[firstSegment]` inward — not from the
 * record root. A residual, record-dependent gap remains and is NOT covered
 * by this predicate: a value living at a record's top level OUTSIDE `fields`
 * (and outside the `id`/`externalId` single-segment fallback) would still
 * resolve under the AI layer's root-walk convention but never under the
 * reader's — detecting that requires a real sample record, which this
 * function does not have.
 *
 * Consumed at BOTH ends of the profile lifecycle:
 *   - `FieldMappingAgent`'s advisory recommendation projector, so the AI layer
 *     never recommends a categorically-unresolvable path; and
 *   - `evaluateSerializedAssetProfile`, so activation REFUSES one. Without the
 *     second call site, a profile mapping e.g. `fields.id` evaluated as ready,
 *     every record then failed `missing_required_field` inside `normalizeBatch`
 *     and landed in `invalid` (which is NOT deferred), while the sweep cursor
 *     had already advanced past that window — silent, unrecoverable whole-window
 *     data loss with a green readiness check.
 */
export function isReaderResolvableSourceField(sourceField: unknown): boolean {
  if (typeof sourceField !== 'string') {
    return false;
  }
  const trimmed = sourceField.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const segments = trimmed.split('.');
  return segments.every((segment, index) => {
    if (segment.length === 0 || segment !== segment.trim()) {
      return false;
    }
    if (DANGEROUS_PATH_SEGMENTS.has(segment)) {
      return false;
    }
    if (index === 0 && segment === 'fields') {
      return false;
    }
    return true;
  });
}
