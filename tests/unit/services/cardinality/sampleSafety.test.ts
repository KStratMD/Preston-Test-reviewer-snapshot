import {
  validateSampleSafety,
  MAX_SAMPLE_ROWS,
  MAX_SAMPLE_BYTES,
  MAX_SAMPLE_DEPTH,
  MAX_FIELDS_PER_ROW,
} from '../../../../src/services/cardinality/sampleSafety';

/**
 * The one sample-payload validator shared by the preflight route and the
 * `_cardinality` active-save envelope (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md "Preflight API" request limits): 1,000 rows,
 * 512 KiB serialized (measured in UTF-8 bytes, not characters), nesting depth
 * 6, 200 fields per row, plain JSON values only, and forbidden/credential-like
 * keys rejected.
 */

/** Builds an object nested `levels` deep: buildNested(1) === { leaf: 1 }. */
function buildNested(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) {
    value = { level: value };
  }
  return value;
}

describe('validateSampleSafety — bounds', () => {
  it('accepts undefined samples (none supplied)', () => {
    const result = validateSampleSafety(undefined);
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(0);
  });

  it('accepts a well-formed, bounded sample array', () => {
    const result = validateSampleSafety([
      { id: '1', accountId: 'A', nested: { region: 'west' } },
      { id: '2', accountId: 'B', nested: { region: 'east' } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects a non-array payload', () => {
    const result = validateSampleSafety({ id: '1' });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'not_an_array')).toBe(true);
  });

  it('accepts exactly 1,000 rows', () => {
    const rows = Array.from({ length: MAX_SAMPLE_ROWS }, (_, i) => ({ id: String(i) }));
    expect(validateSampleSafety(rows).ok).toBe(true);
  });

  it('rejects more than 1,000 rows', () => {
    const rows = Array.from({ length: MAX_SAMPLE_ROWS + 1 }, (_, i) => ({ id: String(i) }));
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'too_many_rows')).toBe(true);
  });

  it('rejects a payload whose serialized size exceeds 512 KiB', () => {
    const rows = [{ blob: 'x'.repeat(MAX_SAMPLE_BYTES + 1) }];
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'payload_too_large')).toBe(true);
  });

  it('measures the byte limit in UTF-8 bytes, not JS string length (multi-byte characters)', () => {
    // Each CJK character is 1 UTF-16 code unit (counted by .length) but 3 UTF-8
    // bytes. 200,000 chars => .length well under the byte cap, but
    // Buffer.byteLength(...) => 600,000 bytes, over the 512 KiB (524,288 byte) cap.
    const multiByteChar = '中';
    const rows = [{ blob: multiByteChar.repeat(200_000) }];
    const serializedLength = JSON.stringify(rows).length;
    expect(serializedLength).toBeLessThan(MAX_SAMPLE_BYTES);
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'payload_too_large')).toBe(true);
  });

  it(`accepts nesting exactly ${MAX_SAMPLE_DEPTH} levels deep`, () => {
    const rows = [{ nested: buildNested(MAX_SAMPLE_DEPTH - 1) }];
    expect(validateSampleSafety(rows).ok).toBe(true);
  });

  it(`rejects nesting deeper than ${MAX_SAMPLE_DEPTH} levels`, () => {
    const rows = [{ nested: buildNested(MAX_SAMPLE_DEPTH) }];
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'too_deep')).toBe(true);
  });

  it(`accepts exactly ${MAX_FIELDS_PER_ROW} fields in one row`, () => {
    const row: Record<string, number> = {};
    for (let i = 0; i < MAX_FIELDS_PER_ROW; i++) row[`f${i}`] = i;
    expect(validateSampleSafety([row]).ok).toBe(true);
  });

  it(`rejects more than ${MAX_FIELDS_PER_ROW} fields in one row`, () => {
    const row: Record<string, number> = {};
    for (let i = 0; i < MAX_FIELDS_PER_ROW + 1; i++) row[`f${i}`] = i;
    const result = validateSampleSafety([row]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'too_many_fields')).toBe(true);
  });
});

describe('validateSampleSafety — plain JSON values only', () => {
  it('rejects a function value', () => {
    const result = validateSampleSafety([{ id: '1', handler: () => 'x' }]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'invalid_value')).toBe(true);
  });

  it('rejects a NaN value', () => {
    const result = validateSampleSafety([{ id: '1', amount: NaN }]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'invalid_value')).toBe(true);
  });

  it('rejects a Date instance', () => {
    const result = validateSampleSafety([{ id: '1', createdAt: new Date() }]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'invalid_value')).toBe(true);
  });

  it('accepts plain primitives, arrays, nulls, and nested objects', () => {
    const result = validateSampleSafety([
      { id: '1', tags: ['a', 'b'], count: 3, active: true, note: null },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('validateSampleSafety — forbidden and credential-like keys', () => {
  it('rejects a parsed own __proto__ key', () => {
    const rows = JSON.parse('[{"__proto__": {"admin": true}, "id": "1"}]');
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'forbidden_key')).toBe(true);
  });

  it('rejects a literal constructor key', () => {
    const rows = JSON.parse('[{"constructor": {"polluted": true}, "id": "1"}]');
    const result = validateSampleSafety(rows);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'forbidden_key')).toBe(true);
  });

  it.each(['password', 'apiKey', 'api_key', 'ssn', 'creditCardNumber', 'accessToken', 'secretValue'])(
    'rejects the credential-like key "%s"',
    (key) => {
      const result = validateSampleSafety([{ id: '1', [key]: 'value' }]);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === 'credential_like_key')).toBe(true);
    },
  );

  it('accepts ordinary field names that are not credential-shaped', () => {
    const result = validateSampleSafety([{ id: '1', accountId: 'A', firstName: 'Jane' }]);
    expect(result.ok).toBe(true);
  });
});
