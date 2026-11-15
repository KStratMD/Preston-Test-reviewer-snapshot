import { createHash, createHmac } from 'node:crypto';
import {
  APPROVAL_FINGERPRINT_KEY_ERROR,
  APPROVAL_FINGERPRINT_VALUE_ERROR,
  computeApprovalFingerprint,
  parseApprovalFingerprintKey,
  type ApprovalWriteIntent,
} from '../../../../src/services/governance/approvalFingerprint';

/**
 * Deterministic test key. Never a real one, and deliberately not derived from
 * JWT_SECRET, any webhook secret, or AI_CONFIG_ENCRYPTION_KEY — reusing those
 * is exactly what the design forbids.
 */
const TEST_KEY_HEX = 'a'.repeat(64);
const KEY = parseApprovalFingerprintKey(TEST_KEY_HEX);
const OTHER_KEY = parseApprovalFingerprintKey('b'.repeat(64));

function intent(overrides: Partial<ApprovalWriteIntent> = {}): ApprovalWriteIntent {
  return {
    tenantId: 'tenant-a',
    operationType: 'ownership_write',
    resourceType: 'contacts',
    resourceId: 'rec-1',
    callerSystem: 'netsuite',
    targetSystem: 'salesforce',
    entity: 'contacts',
    operation: 'update',
    descriptor: {
      targetSystemId: 'salesforce',
      operation: 'update',
      entityType: 'Contact',
      args: { firstName: 'Ada', lastName: 'Lovelace', tags: ['a', 'b'] },
    },
    ...overrides,
  };
}

describe('parseApprovalFingerprintKey', () => {
  it('accepts exactly 64 hexadecimal characters and decodes to 32 bytes', () => {
    expect(parseApprovalFingerprintKey(TEST_KEY_HEX)).toHaveLength(32);
    expect(parseApprovalFingerprintKey(TEST_KEY_HEX.toUpperCase())).toHaveLength(32);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex', `${'a'.repeat(63)}z`],
    ['hex with whitespace', ` ${'a'.repeat(64)} `],
  ])('rejects a %s key on fixed text that leaks no key material', (_label, raw) => {
    let thrown: Error | undefined;
    try {
      parseApprovalFingerprintKey(raw as string | undefined);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toBe(APPROVAL_FINGERPRINT_KEY_ERROR);
    // The rejected value must never reach the message — a near-miss key is
    // still key material.
    if (raw) expect(thrown?.message).not.toContain(raw.trim().slice(0, 8));
  });
});

describe('computeApprovalFingerprint', () => {
  it('returns exactly 64 lowercase hexadecimal characters', () => {
    const fingerprint = computeApprovalFingerprint(intent(), KEY);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches an independently computed HMAC-SHA-256 over the canonical form', () => {
    // Codex R1: without this, every other assertion here passes just as well
    // against SHA256(canonical + key) or any other keyed-looking construction.
    // The expected value is recomputed from primitives in-test rather than
    // pasted, so it pins the ALGORITHM and the exact canonical byte string —
    // a change to key ordering, delimiters, or field set fails here first.
    const canonical =
      '{"callerSystem":"netsuite","descriptor":{"args":{"n":1},"operation":"update"},'
      + '"entity":"contacts","operation":"update","operationType":"ownership_write",'
      + '"resourceId":"rec-1","resourceType":"contacts","targetSystem":"salesforce",'
      + '"tenantId":"tenant-a"}';
    const expected = createHmac('sha256', KEY).update(canonical, 'utf8').digest('hex');

    const actual = computeApprovalFingerprint(
      intent({ descriptor: { operation: 'update', args: { n: 1 } } }),
      KEY,
    );
    expect(actual).toBe(expected);
    // And it is genuinely HMAC, not a concatenated digest.
    expect(actual).not.toBe(createHash('sha256').update(canonical + KEY.toString('hex')).digest('hex'));
    expect(actual).not.toBe(createHash('sha256').update(KEY.toString('hex') + canonical).digest('hex'));
  });

  it('is stable across runs for the same intent', () => {
    expect(computeApprovalFingerprint(intent(), KEY)).toBe(computeApprovalFingerprint(intent(), KEY));
  });

  it('collapses descriptors that differ only in object key insertion order, at every depth', () => {
    const a = intent({
      descriptor: {
        targetSystemId: 'salesforce',
        operation: 'update',
        entityType: 'Contact',
        args: { firstName: 'Ada', lastName: 'Lovelace', nested: { x: 1, y: 2 } },
      },
    });
    const b = intent({
      descriptor: {
        args: { nested: { y: 2, x: 1 }, lastName: 'Lovelace', firstName: 'Ada' },
        entityType: 'Contact',
        operation: 'update',
        targetSystemId: 'salesforce',
      },
    });
    expect(computeApprovalFingerprint(a, KEY)).toBe(computeApprovalFingerprint(b, KEY));
  });

  it('keeps array order significant', () => {
    const forward = intent({ descriptor: { args: { tags: ['a', 'b'] } } });
    const reversed = intent({ descriptor: { args: { tags: ['b', 'a'] } } });
    expect(computeApprovalFingerprint(forward, KEY)).not.toBe(
      computeApprovalFingerprint(reversed, KEY),
    );
  });

  it('keeps number, numeric-string, boolean, and null distinct', () => {
    const variants = [1, '1', true, 'true', null, 'null', 0, '0', false].map((value) =>
      computeApprovalFingerprint(intent({ descriptor: { args: { v: value } } }), KEY),
    );
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('distinguishes a nested object from its stringified form', () => {
    const structured = intent({ descriptor: { args: { v: { a: 1 } } } });
    const stringified = intent({ descriptor: { args: { v: '{"a":1}' } } });
    expect(computeApprovalFingerprint(structured, KEY)).not.toBe(
      computeApprovalFingerprint(stringified, KEY),
    );
  });

  it.each([
    ['tenantId', { tenantId: 'tenant-b' }],
    ['operationType', { operationType: 'ai_call' }],
    ['resourceType', { resourceType: 'accounts' }],
    ['resourceId', { resourceId: 'rec-2' }],
    ['callerSystem', { callerSystem: 'shopify' }],
    ['targetSystem', { targetSystem: 'netsuite' }],
    ['entity', { entity: 'accounts' }],
    ['operation', { operation: 'create' }],
  ])('changes the digest when %s changes', (_field, override) => {
    expect(computeApprovalFingerprint(intent(override as Partial<ApprovalWriteIntent>), KEY)).not.toBe(
      computeApprovalFingerprint(intent(), KEY),
    );
  });

  it('changes the digest when descriptor content changes', () => {
    const changed = intent({
      descriptor: {
        targetSystemId: 'salesforce',
        operation: 'update',
        entityType: 'Contact',
        args: { firstName: 'Grace', lastName: 'Lovelace', tags: ['a', 'b'] },
      },
    });
    expect(computeApprovalFingerprint(changed, KEY)).not.toBe(computeApprovalFingerprint(intent(), KEY));
  });

  it('changes the digest when the key changes', () => {
    // Without this, the HMAC would be a plain digest and an attacker who can
    // guess an intent could precompute its fingerprint.
    expect(computeApprovalFingerprint(intent(), OTHER_KEY)).not.toBe(
      computeApprovalFingerprint(intent(), KEY),
    );
  });

  it('does NOT collapse two distinct create intents that share resourceId "new"', () => {
    // The whole reason the descriptor is inside the canonical intent: every
    // create arrives with the same placeholder resource id, so keying on
    // (tenant, resource) alone would dedupe unrelated creates into one
    // approval and silently drop real work.
    const first = intent({
      resourceId: 'new',
      descriptor: { operation: 'create', entityType: 'Contact', args: { email: 'ada@example.com' } },
    });
    const second = intent({
      resourceId: 'new',
      descriptor: { operation: 'create', entityType: 'Contact', args: { email: 'grace@example.com' } },
    });
    expect(computeApprovalFingerprint(first, KEY)).not.toBe(computeApprovalFingerprint(second, KEY));
  });

  it('collapses two identical create intents that share resourceId "new"', () => {
    const args = { email: 'ada@example.com', tags: ['x'] };
    const first = intent({ resourceId: 'new', descriptor: { operation: 'create', args } });
    const second = intent({ resourceId: 'new', descriptor: { operation: 'create', args: { ...args } } });
    expect(computeApprovalFingerprint(first, KEY)).toBe(computeApprovalFingerprint(second, KEY));
  });

  it('treats an absent optional field and an explicitly undefined one as the same intent', () => {
    const absent = intent({ descriptor: { operation: 'update', args: { a: 1 } } });
    const explicit = intent({
      descriptor: { operation: 'update', args: { a: 1 }, integrationConfigId: undefined },
    });
    expect(computeApprovalFingerprint(absent, KEY)).toBe(computeApprovalFingerprint(explicit, KEY));
  });

  it('rejects non-canonicalizable descriptor content on fixed text carrying no content', () => {
    const cyclic: Record<string, unknown> = { name: 'ada-secret-value' };
    cyclic.self = cyclic;

    let thrown: Error | undefined;
    try {
      computeApprovalFingerprint(intent({ descriptor: { args: cyclic } }), KEY);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(APPROVAL_FINGERPRINT_VALUE_ERROR);
    expect(thrown?.message).not.toContain('ada-secret-value');
    expect(thrown?.stack ?? '').not.toContain('ada-secret-value');
  });

  it('treats an absent descriptor as its own intent rather than failing', () => {
    // The intent root is always an object literal built inside the function,
    // so it always persists; only the descriptor can be missing.
    expect(() => computeApprovalFingerprint(intent({ descriptor: undefined }), KEY)).not.toThrow();
    expect(computeApprovalFingerprint(intent({ descriptor: undefined }), KEY)).not.toBe(
      computeApprovalFingerprint(intent({ descriptor: {} }), KEY),
    );
  });

  it('rejects a BigInt, which has no persisted form', () => {
    // BigInt is the one primitive JSON.stringify refuses outright, so there is
    // no round-tripped write to dedupe against. Symbols, functions, NaN and
    // Infinity are NOT rejected: JSON drops or nulls them, so the fingerprint
    // must follow suit or it would split one persisted write into two
    // approvals. That direction is pinned by the persistence-agreement table.
    expect(() =>
      computeApprovalFingerprint(intent({ descriptor: { args: { v: 10n } } }), KEY),
    ).toThrow(APPROVAL_FINGERPRINT_VALUE_ERROR);
  });

  describe('agreement with persistence (the invariant, Codex R1 + R2)', () => {
    const fp = (args: unknown) => computeApprovalFingerprint(intent({ descriptor: { args } }), KEY);

    /**
     * The whole contract in one property: two intents share a fingerprint if
     * and only if they persist identically. The descriptor reaches storage
     * through JSON.stringify and the resume handler re-dispatches whatever
     * survives that round trip, so anything JSON erases is already erased from
     * the write that will actually be replayed.
     *
     * Both blocking findings were failures of exactly this property, in
     * opposite directions — distinct persisted values sharing a fingerprint
     * (Date/Map/Set collapsing to {}, then two Dates behind a custom toJSON),
     * and identical persisted values getting different fingerprints (a Date
     * versus its own ISO string). Asserting the property directly catches both
     * without this test needing to know which JSON rule produced them.
     */
    const CASES: [string, () => unknown][] = [
      ['plain', () => ({ a: 1 })],
      ['plain reordered', () => ({ a: 1, b: 2 })],
      ['plain reordered mirror', () => ({ b: 2, a: 1 })],
      ['date 2020', () => ({ at: new Date('2020-01-01T00:00:00Z') })],
      ['date 2020 as iso string', () => ({ at: '2020-01-01T00:00:00.000Z' })],
      ['date 2021', () => ({ at: new Date('2021-01-01T00:00:00Z') })],
      ['empty object', () => ({ at: {} })],
      ['map', () => ({ at: new Map([['k', 'v']]) })],
      ['set', () => ({ at: new Set([1, 2]) })],
      ['buffer', () => ({ at: Buffer.from([1, 2]) })],
      ['uint8array', () => ({ at: new Uint8Array([1, 2]) })],
      ['class instance', () => ({ at: new (class P { public a = 1; })() })],
      ['null proto record', () => {
        const bare = Object.create(null) as Record<string, unknown>;
        bare.a = 1;
        return { at: bare };
      }],
      ['sparse array', () => ({ at: [1, , 3] as unknown[] })],
      ['array with null hole', () => ({ at: [1, null, 3] })],
      ['nan', () => ({ at: Number.NaN })],
      ['explicit null', () => ({ at: null })],
      ['function value', () => ({ at: 1, dropped: () => undefined })],
      ['symbol value', () => ({ at: 1, sym: Symbol('s') })],
      ['custom toJSON returning a date with own props', () => {
        const d = new Date(0) as Date & { extra?: number };
        d.extra = 1;
        return { at: { toJSON: () => d } };
      }],
      ['custom toJSON returning a date with a different own prop', () => {
        const d = new Date(0) as Date & { extra?: number };
        d.extra = 2;
        return { at: { toJSON: () => d } };
      }],
      // `JSON.parse` makes `__proto__` an OWN key rather than invoking the
      // setter, so it must reach the digest as data and must not merge with a
      // differently-valued sibling.
      ['proto own key a', () => JSON.parse('{"__proto__":{"p":1}}')],
      ['proto own key b', () => JSON.parse('{"__proto__":{"p":2}}')],
      ['plain p key', () => ({ p: 1 })],
      // Codex R3: number and text edge cases where JSON's own rules decide the
      // answer, and the fingerprint must not invent a different one.
      ['unicode nfc', () => ({ 'é': 1 })],
      ['unicode nfd', () => ({ 'é': 1 })],
      ['lone surrogate', () => ({ s: '\ud800' })],
      ['negative zero', () => ({ n: -0 })],
      ['positive zero', () => ({ n: 0 })],
      ['1e21', () => ({ n: 1e21 })],
      ['1e21 spelled out', () => ({ n: 1000000000000000000000 })],
      ['2^53', () => ({ n: 9007199254740992 })],
      ['2^53 plus one', () => ({ n: 9007199254740993 })],
      ['duplicate keys in source json', () => JSON.parse('{"d":1,"d":2}')],
      ['last duplicate wins', () => ({ d: 2 })],
    ];

    /**
     * Reference form: the persisted JSON with object keys sorted. Key ORDER is
     * the one difference the fingerprint is supposed to erase, so comparing
     * raw JSON text would wrongly demand that `{a,b}` and `{b,a}` fingerprint
     * differently. Written independently of the module under test — the exact
     * canonical bytes are pinned separately by the HMAC vector.
     */
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        // Object.fromEntries, NOT `acc[key] = …`. Assignment invokes the
        // `__proto__` setter, so a descriptor carrying that key would silently
        // set this object's prototype instead of becoming an own key — the
        // reference form would then be wrong for exactly the case most worth
        // testing, and the pollution would leak across cases in-process.
        return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
      }
      return value;
    };
    const persisted = (make: () => unknown): string | 'unpersistable' => {
      try {
        const json = JSON.stringify({ args: make() });
        if (typeof json !== 'string') return 'unpersistable';
        return JSON.stringify(sortKeys(JSON.parse(json)));
      } catch {
        return 'unpersistable';
      }
    };
    const digest = (make: () => unknown): string | 'unpersistable' => {
      try {
        return fp(make());
      } catch {
        return 'unpersistable';
      }
    };

    it.each(CASES.flatMap(([labelA, a], i) =>
      CASES.slice(i + 1).map(([labelB, b]) => [`${labelA} vs ${labelB}`, a, b] as const),
    ))('%s — fingerprints match exactly when persisted forms match', (_label, a, b) => {
      expect(digest(a) === digest(b)).toBe(persisted(a) === persisted(b));
    });

    it('has cases that actually persist differently, so the property is not vacuous', () => {
      // Guards the table itself: if every case persisted alike, the assertion
      // above would hold for a constant-output implementation.
      expect(new Set(CASES.map(([, make]) => persisted(make))).size).toBeGreaterThan(5);
    });

    it('reads each property exactly once per call, counted on a single object', () => {
      // Codex R3: the earlier version built a fresh object per call, so it
      // proved only that two objects agree — not that ONE invocation reads a
      // getter once. A second read is what would let a stateful getter give
      // two different values inside a single fingerprint.
      let reads = 0;
      const args: Record<string, unknown> = {};
      Object.defineProperty(args, 'v', {
        enumerable: true,
        get: () => {
          reads += 1;
          return 'x';
        },
      });

      fp(args);
      expect(reads).toBe(1);
    });

    it('contains a throwing getter, so payload-controlled text cannot escape', () => {
      const args: Record<string, unknown> = {};
      Object.defineProperty(args, 'email', {
        enumerable: true,
        get: () => {
          throw new Error('PII: alice@example.com');
        },
      });

      let thrown: Error | undefined;
      try {
        fp(args);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).toBe(APPROVAL_FINGERPRINT_VALUE_ERROR);
      expect(`${thrown?.message}${thrown?.stack ?? ''}`).not.toContain('alice@example.com');
      expect((thrown as { cause?: unknown } | undefined)?.cause).toBeUndefined();
    });

    it('rejects a cyclic descriptor, which has no persisted form at all', () => {
      const cyclic: Record<string, unknown> = { name: 'ada-secret-value' };
      cyclic.self = cyclic;
      expect(() => fp(cyclic)).toThrow(APPROVAL_FINGERPRINT_VALUE_ERROR);
    });
  });

  it('never puts the key, the canonical bytes, or the fingerprint into a thrown message', () => {
    let thrown: Error | undefined;
    try {
      computeApprovalFingerprint(intent({ descriptor: { args: { v: 10n } } }), KEY);
    } catch (error) {
      thrown = error as Error;
    }
    const surface = `${thrown?.message ?? ''}${thrown?.stack ?? ''}`;
    // Codex R1: this previously named the fingerprint without ever computing
    // one, so the claim in its title was untested. Compute a real digest from
    // the same intent shape and assert it is absent too.
    const realFingerprint = computeApprovalFingerprint(intent(), KEY);
    expect(surface).not.toContain(realFingerprint);
    expect(surface).not.toContain(TEST_KEY_HEX);
    expect(surface).not.toContain('Lovelace');
    expect(surface).not.toContain('tenant-a');
  });
});
