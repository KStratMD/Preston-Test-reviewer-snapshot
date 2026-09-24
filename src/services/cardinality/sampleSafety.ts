/**
 * Shared sample-payload safety limits for the cardinality preflight and
 * activation gate — one validator used identically by the preflight route
 * (`POST /api/configurations/cardinality-preflight`) and the `_cardinality`
 * active-save envelope, so the two paths can never drift.
 *
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Preflight API" request limits: at most 1,000 sample rows, 512 KiB
 * serialized (measured in UTF-8 bytes, not characters), nesting depth 6, 200
 * fields per row, plain JSON primitives/arrays/objects only, and rejection of
 * forbidden (prototype-pollution) and credential-like keys.
 *
 * This module is pure and never logs, persists, or returns the raw sample
 * values it inspects — violations carry only a row/field-path location.
 */

export const MAX_SAMPLE_ROWS = 1000;
export const MAX_SAMPLE_BYTES = 512 * 1024;
export const MAX_SAMPLE_DEPTH = 6;
export const MAX_FIELDS_PER_ROW = 200;

/** Own-property names that could repoint or pollute an object's prototype. */
const FORBIDDEN_SAMPLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Field names that look like they carry a secret rather than business data.
 * Intentionally broad (a false positive just means renaming a sample field);
 * a missed credential leaking into a preflight/save request is the worse
 * failure mode.
 */
const CREDENTIAL_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|ssn|social[_-]?security|credit[_-]?card|card[_-]?number|cvv|cvc|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key)/i;

export type SampleSafetyViolationCode =
  | 'not_an_array'
  | 'too_many_rows'
  | 'payload_too_large'
  | 'too_deep'
  | 'too_many_fields'
  | 'invalid_value'
  | 'forbidden_key'
  | 'credential_like_key';

/** One violation. `path` locates the row/field; it never carries the value. */
export interface SampleSafetyViolation {
  code: SampleSafetyViolationCode;
  path: string;
  message: string;
}

export interface SampleSafetyResult {
  ok: boolean;
  violations: SampleSafetyViolation[];
  rowCount: number;
  byteLength: number;
}

/** Fixed, non-leaking messages for traversal/serialization failures. Never interpolate the offending value or a caught error into these. */
const UNSAFE_TRAVERSAL_MESSAGE = 'Value could not be inspected safely';
const CIRCULAR_REFERENCE_MESSAGE = 'Value contains a circular reference';
const UNSAFE_SERIALIZATION_MESSAGE = 'Sample payload could not be serialized safely';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/** A JSON primitive: string, finite number, boolean, or null. */
function isPlainScalar(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Result of walking one node: `clone` is an inert plain-data reconstruction
 * built only from values already read during traversal (never re-read from
 * the original), and `unsafe` marks that the node contained something that
 * makes byte-length measurement meaningless (an invalid scalar, unreadable
 * property, or cycle) — the caller collapses the whole payload's byteLength
 * to the documented zero sentinel when any node reports unsafe.
 */
interface WalkOutcome {
  clone: unknown;
  unsafe: boolean;
}

const UNSAFE_OUTCOME: WalkOutcome = { clone: null, unsafe: true };

/**
 * Depth-first walk of one row (or nested value) collecting every violation
 * rather than stopping at the first. `depth` counts container (array/object)
 * nesting only — the row object itself is depth 1 — so a scalar leaf never
 * trips the depth limit on its own.
 *
 * Every inspection step (type check, key enumeration, property access) runs
 * traversal-first and is individually guarded: a throwing getter, a revoked
 * proxy, or a hostile ownKeys/get trap degrades to one bounded `invalid_value`
 * violation at that node instead of propagating. `active` is the current
 * call-stack's set of containers being walked — checked on entry and removed
 * on unwind — so a cycle is reported once and a shared-but-acyclic reference
 * is still accepted.
 *
 * Each safely-read value is copied into a freshly-built plain object/array
 * (`clone`) rather than left on the original. The caller measures byte length
 * from that clone, never from the original samples array — a hostile
 * `toJSON` (even a non-enumerable one, invisible to the `Object.keys` walk)
 * has no chance to rewrite or blow up what gets measured, because the clone
 * carries no `toJSON` of its own and nothing ever reads the original object
 * a second time.
 */
function walk(
  value: unknown,
  path: string,
  depth: number,
  violations: SampleSafetyViolation[],
  active: Set<unknown>,
): WalkOutcome {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    violations.push({ code: 'invalid_value', path, message: UNSAFE_TRAVERSAL_MESSAGE });
    return UNSAFE_OUTCOME;
  }
  const isObject = !isArray && isPlainObject(value);

  if ((isArray || isObject) && depth > MAX_SAMPLE_DEPTH) {
    violations.push({
      code: 'too_deep',
      path,
      message: `Nesting exceeds ${MAX_SAMPLE_DEPTH} levels`,
    });
    return UNSAFE_OUTCOME;
  }

  if (isArray || isObject) {
    if (active.has(value)) {
      violations.push({ code: 'invalid_value', path, message: CIRCULAR_REFERENCE_MESSAGE });
      return UNSAFE_OUTCOME;
    }
    active.add(value);
    try {
      return isArray
        ? walkArray(value as unknown[], path, depth, violations, active)
        : walkObject(value as Record<string, unknown>, path, depth, violations, active);
    } finally {
      active.delete(value);
    }
  }

  if (!isPlainScalar(value)) {
    violations.push({ code: 'invalid_value', path, message: 'Value is not a plain JSON primitive' });
    return UNSAFE_OUTCOME;
  }

  return { clone: value, unsafe: false };
}

function walkArray(
  value: unknown[],
  path: string,
  depth: number,
  violations: SampleSafetyViolation[],
  active: Set<unknown>,
): WalkOutcome {
  let length: number;
  try {
    length = value.length;
  } catch {
    violations.push({ code: 'invalid_value', path, message: UNSAFE_TRAVERSAL_MESSAGE });
    return UNSAFE_OUTCOME;
  }
  const clone: unknown[] = [];
  let unsafe = false;
  for (let index = 0; index < length; index++) {
    const itemPath = `${path}[${index}]`;
    let item: unknown;
    try {
      item = value[index];
    } catch {
      violations.push({ code: 'invalid_value', path: itemPath, message: UNSAFE_TRAVERSAL_MESSAGE });
      unsafe = true;
      clone.push(null);
      continue;
    }
    const outcome = walk(item, itemPath, depth + 1, violations, active);
    if (outcome.unsafe) unsafe = true;
    clone.push(outcome.clone);
  }
  return { clone, unsafe };
}

function walkObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  violations: SampleSafetyViolation[],
  active: Set<unknown>,
): WalkOutcome {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    violations.push({ code: 'invalid_value', path, message: UNSAFE_TRAVERSAL_MESSAGE });
    return UNSAFE_OUTCOME;
  }

  if (keys.length > MAX_FIELDS_PER_ROW) {
    violations.push({
      code: 'too_many_fields',
      path,
      message: `Row has more than ${MAX_FIELDS_PER_ROW} fields`,
    });
  }

  const clone: Record<string, unknown> = {};
  let unsafe = false;

  for (const key of keys) {
    const fieldPath = `${path}.${key}`;
    const forbidden = FORBIDDEN_SAMPLE_KEYS.has(key);
    const credential = !forbidden && CREDENTIAL_KEY_PATTERN.test(key);

    if (forbidden || credential) {
      violations.push(
        forbidden
          ? { code: 'forbidden_key', path: fieldPath, message: `Forbidden key "${key}"` }
          : {
              code: 'credential_like_key',
              path: fieldPath,
              message: `Credential-like key "${key}" is not allowed in sample data`,
            },
      );
      // Already rejected outright — still read once (for byte-length
      // fidelity) but discard any nested structural findings rather than
      // compounding them onto an already-failed field.
      let fieldValue: unknown;
      try {
        fieldValue = value[key];
      } catch {
        unsafe = true;
        clone[key] = null;
        continue;
      }
      const scratch: SampleSafetyViolation[] = [];
      const outcome = walk(fieldValue, fieldPath, depth + 1, scratch, active);
      if (outcome.unsafe) unsafe = true;
      clone[key] = outcome.clone;
      continue;
    }

    let fieldValue: unknown;
    try {
      fieldValue = value[key];
    } catch {
      violations.push({ code: 'invalid_value', path: fieldPath, message: UNSAFE_TRAVERSAL_MESSAGE });
      unsafe = true;
      clone[key] = null;
      continue;
    }
    const outcome = walk(fieldValue, fieldPath, depth + 1, violations, active);
    if (outcome.unsafe) unsafe = true;
    clone[key] = outcome.clone;
  }

  return { clone, unsafe };
}

/**
 * Validates a candidate sample-rows payload. `undefined` (no samples
 * supplied) is valid. Anything else must be an array of plain-object rows
 * within the bounds above.
 */
export function validateSampleSafety(samples: unknown): SampleSafetyResult {
  if (samples === undefined) {
    return { ok: true, violations: [], rowCount: 0, byteLength: 0 };
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(samples);
  } catch {
    return {
      ok: false,
      violations: [{ code: 'invalid_value', path: '', message: UNSAFE_TRAVERSAL_MESSAGE }],
      rowCount: 0,
      byteLength: 0,
    };
  }

  if (!isArray) {
    return {
      ok: false,
      violations: [{ code: 'not_an_array', path: '', message: 'Samples must be an array of rows' }],
      rowCount: 0,
      byteLength: 0,
    };
  }

  // Everything below inspects and serializes untrusted, possibly hostile
  // input (throwing getters, revoked proxies, traps on .length/ownKeys).
  // Individual nodes are guarded inside walk(); this is the last-resort
  // backstop — anything that still escapes collapses to one fixed violation
  // and the documented byte-length sentinel rather than throwing or leaking
  // the offending value/caught error.
  try {
    const samplesArray = samples as unknown[];
    const violations: SampleSafetyViolation[] = [];
    const rowCount = samplesArray.length;

    if (rowCount > MAX_SAMPLE_ROWS) {
      violations.push({
        code: 'too_many_rows',
        path: '',
        message: `Cannot supply more than ${MAX_SAMPLE_ROWS} sample rows`,
      });
    }

    const active = new Set<unknown>();
    const clones: unknown[] = [];
    let anyUnsafe = false;
    for (let index = 0; index < rowCount; index++) {
      const rowPath = `[${index}]`;
      let row: unknown;
      try {
        row = samplesArray[index];
      } catch {
        violations.push({ code: 'invalid_value', path: rowPath, message: UNSAFE_TRAVERSAL_MESSAGE });
        anyUnsafe = true;
        clones.push(null);
        continue;
      }
      // Each row must itself be a plain object — a scalar or array at the
      // top level would otherwise pass through walk() as a valid leaf/array
      // value even though every downstream consumer treats a row as a field
      // map.
      if (!isPlainObject(row)) {
        violations.push({ code: 'invalid_value', path: rowPath, message: 'Sample row must be a plain object' });
        anyUnsafe = true;
        clones.push(null);
        continue;
      }
      const outcome = walk(row, rowPath, 1, violations, active);
      if (outcome.unsafe) anyUnsafe = true;
      clones.push(outcome.clone);
    }

    // Measured from `clones` — an inert reconstruction built only from
    // values already read above — never from `samplesArray` itself, so a
    // hostile `toJSON` on the original input cannot rewrite or throw during
    // measurement. `anyUnsafe` already forces the documented zero sentinel
    // for any row that couldn't be safely and completely captured.
    let byteLength = 0;
    if (!anyUnsafe) {
      try {
        const json = JSON.stringify(clones);
        byteLength = Buffer.byteLength(json, 'utf8');
        if (byteLength > MAX_SAMPLE_BYTES) {
          violations.push({
            code: 'payload_too_large',
            path: '',
            message: `Serialized sample payload exceeds ${MAX_SAMPLE_BYTES} bytes`,
          });
        }
      } catch {
        byteLength = 0;
        violations.push({ code: 'invalid_value', path: '', message: UNSAFE_SERIALIZATION_MESSAGE });
      }
    }

    return { ok: violations.length === 0, violations, rowCount, byteLength };
  } catch {
    return {
      ok: false,
      violations: [{ code: 'invalid_value', path: '', message: UNSAFE_SERIALIZATION_MESSAGE }],
      rowCount: 0,
      byteLength: 0,
    };
  }
}
