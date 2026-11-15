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

describe('validateSampleSafety — rows must be plain objects', () => {
  it('rejects a scalar (string) row', () => {
    const result = validateSampleSafety(['not-a-row']);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.code === 'invalid_value' && v.path === '[0]'),
    ).toBe(true);
  });

  it('rejects a scalar (number) row', () => {
    const result = validateSampleSafety([42]);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.code === 'invalid_value' && v.path === '[0]'),
    ).toBe(true);
  });

  it('rejects a null row', () => {
    const result = validateSampleSafety([null]);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.code === 'invalid_value' && v.path === '[0]'),
    ).toBe(true);
  });

  it('rejects an array row', () => {
    const result = validateSampleSafety([['a', 'b']]);
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((v) => v.code === 'invalid_value' && v.path === '[0]'),
    ).toBe(true);
  });

  it('reports one violation per malformed row and still validates well-formed rows in the same payload', () => {
    const result = validateSampleSafety([{ id: '1' }, 'bad-row', { id: '2' }, ['also-bad']]);
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.code === 'invalid_value')).toHaveLength(2);
    expect(result.violations.some((v) => v.path === '[1]')).toBe(true);
    expect(result.violations.some((v) => v.path === '[3]')).toBe(true);
  });

  it('does not leak the offending row value into the violation message', () => {
    const result = validateSampleSafety(['super-secret-token-value']);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.violations)).not.toContain('super-secret-token-value');
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

describe('validateSampleSafety — totality against non-JSON values, cycles, and unsafe traversal', () => {
  const SENTINEL = 'PLANTED_SENTINEL_DO_NOT_LEAK';

  function assertBounded(result: ReturnType<typeof validateSampleSafety>) {
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    for (const v of result.violations) {
      expect(typeof v.path).toBe('string');
      expect(v.message).not.toContain(SENTINEL);
      expect(v.message.length).toBeLessThan(200);
    }
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  }

  it('never throws and stays bounded for a top-level BigInt field', () => {
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([{ id: '1', amount: BigInt(9007199254740993) }]);
    }).not.toThrow();
    assertBounded(result!);
    expect(result!.violations.some((v) => v.code === 'invalid_value')).toBe(true);
  });

  it('never throws and stays bounded for a nested BigInt field', () => {
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([{ id: '1', nested: { amount: BigInt(1) } }]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('rejects a Symbol value', () => {
    const result = validateSampleSafety([{ id: '1', tag: Symbol('x') }]);
    assertBounded(result);
  });

  it('rejects an explicit undefined element inside an array', () => {
    const result = validateSampleSafety([{ id: '1', tags: ['a', undefined, 'b'] }]);
    assertBounded(result);
  });

  it.each([Infinity, -Infinity])('rejects the non-finite number %p', (n) => {
    const result = validateSampleSafety([{ id: '1', amount: n }]);
    assertBounded(result);
  });

  it('rejects a class instance (not a plain object)', () => {
    class AccountRecord {
      id = '1';
    }
    const result = validateSampleSafety([{ id: '1', record: new AccountRecord() }]);
    assertBounded(result);
  });

  it('never throws and reports a bounded violation for a self-cycle', () => {
    const row: Record<string, unknown> = { id: '1' };
    row.self = row;
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([row]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('never throws and reports a bounded violation for a two-object cycle', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b' };
    a.partner = b;
    b.partner = a;
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([a]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('accepts a shared-but-acyclic object referenced from two branches', () => {
    const shared = { region: 'west' };
    const row = { id: '1', primary: shared, secondary: shared };
    const result = validateSampleSafety([row]);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('never throws and stays bounded when a property getter throws', () => {
    const row: Record<string, unknown> = { id: '1' };
    Object.defineProperty(row, 'boom', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL);
      },
    });
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([row]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('still validates the rest of a row when one field getter throws', () => {
    const row: Record<string, unknown> = { id: '1' };
    Object.defineProperty(row, 'boom', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL);
      },
    });
    Object.defineProperty(row, 'password', { enumerable: true, value: 'hunter2' });
    const result = validateSampleSafety([row]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'credential_like_key')).toBe(true);
  });

  it('never throws and stays bounded for a Proxy with a throwing get trap', () => {
    const target = { id: '1', account: 'A' };
    const proxy = new Proxy(target, {
      get() {
        throw new Error(SENTINEL);
      },
    });
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([proxy]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('never throws and stays bounded for a Proxy with a throwing ownKeys trap', () => {
    const target = { id: '1', account: 'A' };
    const proxy = new Proxy(target, {
      ownKeys() {
        throw new Error(SENTINEL);
      },
    });
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([proxy]);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('never throws and stays bounded for a Proxy array with a throwing get trap on elements', () => {
    const target = ['a', 'b', 'c'];
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === '1') throw new Error(SENTINEL);
        return Reflect.get(t, prop, receiver);
      },
    });
    const result = validateSampleSafety([{ id: '1', tags: proxy }]);
    assertBounded(result);
  });

  it('reports byteLength as the zero sentinel, not an approximation, when content is unsafe', () => {
    const result = validateSampleSafety([{ id: '1', amount: BigInt(1) }]);
    expect(result.ok).toBe(false);
    expect(result.byteLength).toBe(0);
  });

  it('still computes an accurate byteLength when the only violation is a forbidden/credential key', () => {
    const result = validateSampleSafety([{ id: '1', password: 'hunter2' }]);
    expect(result.ok).toBe(false);
    expect(result.violations.every((v) => v.code === 'credential_like_key')).toBe(true);
    expect(result.byteLength).toBe(Buffer.byteLength(JSON.stringify([{ id: '1', password: 'hunter2' }]), 'utf8'));
  });

  it('never throws and stays bounded for a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({ id: '1' }, {});
    revoke();
    const result = validateSampleSafety([{ id: '1', nested: proxy }]);
    assertBounded(result);
  });

  it('never throws when the top-level samples argument itself is a hostile proxy', () => {
    const proxy = new Proxy([{ id: '1' }], {
      get(t, prop, receiver) {
        if (prop === 'length') throw new Error(SENTINEL);
        return Reflect.get(t, prop, receiver);
      },
    });
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety(proxy);
    }).not.toThrow();
    assertBounded(result!);
  });

  it('measures byteLength from the real enumerable data, not a hostile toJSON that shrinks it', () => {
    const row: Record<string, unknown> = { id: '1', blob: 'x'.repeat(600_000) };
    Object.defineProperty(row, 'toJSON', {
      value: () => ({ id: '1' }),
      enumerable: false,
    });
    const result = validateSampleSafety([row]);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'payload_too_large')).toBe(true);
    expect(result.byteLength).toBeGreaterThan(MAX_SAMPLE_BYTES);
  });

  it('never throws and stays bounded when a non-enumerable toJSON throws during what would be serialization', () => {
    const row: Record<string, unknown> = { id: '1' };
    Object.defineProperty(row, 'toJSON', {
      value: () => {
        throw new Error(SENTINEL);
      },
      enumerable: false,
    });
    let result: ReturnType<typeof validateSampleSafety>;
    expect(() => {
      result = validateSampleSafety([row]);
    }).not.toThrow();
    expect(result!.ok).toBe(true);
    expect(result!.violations).toHaveLength(0);
    expect(result!.byteLength).toBe(Buffer.byteLength(JSON.stringify([{ id: '1' }]), 'utf8'));
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
