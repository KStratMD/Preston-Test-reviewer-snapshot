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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
 * Depth-first walk of one row (or nested value) collecting every violation
 * rather than stopping at the first. `depth` counts container (array/object)
 * nesting only — the row object itself is depth 1 — so a scalar leaf never
 * trips the depth limit on its own.
 */
function walk(value: unknown, path: string, depth: number, violations: SampleSafetyViolation[]): void {
  const isArray = Array.isArray(value);
  const isObject = !isArray && isPlainObject(value);

  if ((isArray || isObject) && depth > MAX_SAMPLE_DEPTH) {
    violations.push({
      code: 'too_deep',
      path,
      message: `Nesting exceeds ${MAX_SAMPLE_DEPTH} levels`,
    });
    return;
  }

  if (isArray) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, violations));
    return;
  }

  if (isObject) {
    const keys = Object.keys(value);
    if (keys.length > MAX_FIELDS_PER_ROW) {
      violations.push({
        code: 'too_many_fields',
        path,
        message: `Row has more than ${MAX_FIELDS_PER_ROW} fields`,
      });
    }
    for (const key of keys) {
      const fieldPath = `${path}.${key}`;
      if (FORBIDDEN_SAMPLE_KEYS.has(key)) {
        violations.push({ code: 'forbidden_key', path: fieldPath, message: `Forbidden key "${key}"` });
        continue;
      }
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        violations.push({
          code: 'credential_like_key',
          path: fieldPath,
          message: `Credential-like key "${key}" is not allowed in sample data`,
        });
        continue;
      }
      walk(value[key], fieldPath, depth + 1, violations);
    }
    return;
  }

  if (!isPlainScalar(value)) {
    violations.push({ code: 'invalid_value', path, message: 'Value is not a plain JSON primitive' });
  }
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

  if (!Array.isArray(samples)) {
    return {
      ok: false,
      violations: [{ code: 'not_an_array', path: '', message: 'Samples must be an array of rows' }],
      rowCount: 0,
      byteLength: 0,
    };
  }

  const violations: SampleSafetyViolation[] = [];
  const json = JSON.stringify(samples);
  const byteLength = Buffer.byteLength(json, 'utf8');

  if (samples.length > MAX_SAMPLE_ROWS) {
    violations.push({
      code: 'too_many_rows',
      path: '',
      message: `Cannot supply more than ${MAX_SAMPLE_ROWS} sample rows`,
    });
  }

  if (byteLength > MAX_SAMPLE_BYTES) {
    violations.push({
      code: 'payload_too_large',
      path: '',
      message: `Serialized sample payload exceeds ${MAX_SAMPLE_BYTES} bytes`,
    });
  }

  samples.forEach((row, index) => walk(row, `[${index}]`, 1, violations));

  return { ok: violations.length === 0, violations, rowCount: samples.length, byteLength };
}
