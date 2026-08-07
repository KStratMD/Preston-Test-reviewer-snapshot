// tests/unit/routes/syncErrorAssistWebhookSchema.test.ts
import {
  WebhookPayloadSchema,
  objectDepth,
  MAX_SOURCE_PAYLOAD_DEPTH,
} from '../../../src/routes/syncErrorAssistWebhookSchema';

const validBase = () => ({
  tenantId: 'acme',
  errorRecordId: 'err-1',
  lastModified: '2026-05-10T00:00:00.000Z',
  errorType: 'sync_failure',
  errorMessage: 'NS error',
});

describe('objectDepth (R11-2 / gotcha #39)', () => {
  it('primitives + null are depth 0', () => {
    expect(objectDepth('foo')).toBe(0);
    expect(objectDepth(42)).toBe(0);
    expect(objectDepth(null)).toBe(0);
    expect(objectDepth(true)).toBe(0);
  });
  it('empty containers are depth 1 (the container itself counts as depth 1; no children)', () => {
    expect(objectDepth({})).toBe(1);
    expect(objectDepth([])).toBe(1);
  });
  it('container with primitive children is depth 1 (1 + max(child depths) = 1 + 0)', () => {
    // R4-2 corrected: per impl, container=1 + max(child depths). Primitives are depth 0,
    // so {a:1} is 1 + 0 = 1, NOT 2. A nested-object child makes the parent depth 2+.
    expect(objectDepth({ a: 1 })).toBe(1);
    expect(objectDepth([1, 2, 3])).toBe(1);
  });
  it('container nested 1 level: depth 2', () => {
    expect(objectDepth({ a: { b: 1 } })).toBe(2);
    expect(objectDepth([[1, 2]])).toBe(2);
  });
  it('depth-6 boundary: primitive nested 6 deep is depth 6; empty {} nested 5 deep is depth 6', () => {
    // Path A: primitive leaf wrapped N times = depth N (each wrap adds 1; primitive contributes 0).
    let pA: unknown = 'leaf';
    for (let i = 0; i < 6; i++) pA = { x: pA };
    expect(objectDepth(pA)).toBe(6);

    // Path B: empty {} (depth 1) wrapped 5 times = 1 + 5 = 6.
    let pB: unknown = {};
    for (let i = 0; i < 5; i++) pB = { x: pB };
    expect(objectDepth(pB)).toBe(6);
  });
  it('depth-7 boundary: primitive nested 7 deep is depth 7 (rejected by schema)', () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 7; i++) v = { x: v };
    expect(objectDepth(v)).toBe(7);
  });

  it('R19-1 — deeply nested input under the 256KB raw cap does NOT stack-overflow', () => {
    // R19-1 — Before the iterative rewrite, a recursive `objectDepth` would throw
    // `RangeError: Maximum call stack size exceeded` for deeply nested inputs (V8's default
    // stack budget is on the order of ~10K frames, regardless of Node major). A valid JSON
    // body under the route's 256KB raw cap can contain 5K+ levels of nesting (each `{"x":`
    // plus closer is 5 bytes → 25K bytes for 5K levels), so this is reachable from a hostile
    // but well-formed request. The iterative form short-circuits at MAX+1, never recurses,
    // and returns deterministically.
    let deepInput: unknown = 'leaf';
    for (let i = 0; i < 5000; i++) deepInput = { x: deepInput };
    expect(() => objectDepth(deepInput)).not.toThrow();
    expect(objectDepth(deepInput)).toBe(MAX_SOURCE_PAYLOAD_DEPTH + 1);
    // The schema MUST reject the deeply-nested payload as `invalid_payload` (not crash with 500).
    expect(WebhookPayloadSchema.safeParse({
      ...validBase(),
      sourcePayload: deepInput as Record<string, unknown>,
    }).success).toBe(false);
  });
});

describe('WebhookPayloadSchema (R11-1 / R11-3 / AC #17–19)', () => {
  it('AC #17 — UTF-8 byte cap: a 32K-character payload of ASCII passes; 32K-char of 4-byte chars rejects', () => {
    const ascii = { big: 'a'.repeat(32 * 1024 - 200) };
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), sourcePayload: ascii }).success).toBe(true);
    const heavy = { big: '𝓐'.repeat(8 * 1024) };       // 4-byte UTF-8 chars × 8K ≈ 32 KB but 8K JS chars
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), sourcePayload: heavy }).success).toBe(false);
  });

  it('AC #18 — depth=6 accepted, depth=7 rejected (using empty-{} starting point: depth = 1 + wraps)', () => {
    // depth-6 = {} (depth 1) wrapped 5 times.
    let depth6: unknown = {};
    for (let i = 0; i < 5; i++) depth6 = { x: depth6 };
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), sourcePayload: depth6 as Record<string, unknown> }).success).toBe(true);
    // depth-7 = {} (depth 1) wrapped 6 times.
    let depth7: unknown = {};
    for (let i = 0; i < 6; i++) depth7 = { x: depth7 };
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), sourcePayload: depth7 as Record<string, unknown> }).success).toBe(false);
  });

  it('AC #19 / R19-4 — tenantId regex: rejects colons + dots + over-length AND the reserved `__system__` sentinel; underscores ARE valid charset', () => {
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), tenantId: 'has:colon' }).success).toBe(false);
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), tenantId: 'has.dot' }).success).toBe(false);
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), tenantId: 'a'.repeat(65) }).success).toBe(false);
    // R19-4 — The literal `__system__` string is rejected at the SCHEMA level (not just by
    // tenantIsolation middleware), because the SuiteCentral webhook bypasses tenantIsolation
    // (HMAC auth, not session/JWT). Per-character underscores in non-sentinel positions are
    // still valid (e.g., `tenant_a` accepted).
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), tenantId: '__system__' }).success).toBe(false);
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), tenantId: 'tenant_a' }).success).toBe(true);
  });

  it('AC #19 — errorRecordId regex: ≤128 chars, same charset', () => {
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), errorRecordId: 'has:colon' }).success).toBe(false);
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), errorRecordId: 'a'.repeat(129) }).success).toBe(false);
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), errorRecordId: 'a'.repeat(128) }).success).toBe(true);
  });

  it('rejects malformed lastModified', () => {
    expect(WebhookPayloadSchema.safeParse({ ...validBase(), lastModified: 'not-iso' }).success).toBe(false);
  });
});
