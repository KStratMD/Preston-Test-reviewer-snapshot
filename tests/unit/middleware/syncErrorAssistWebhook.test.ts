// tests/unit/middleware/syncErrorAssistWebhook.test.ts
import * as crypto from 'crypto';
import { verifySuiteCentralWebhook } from '../../../src/middleware/syncErrorAssistWebhook';

const SECRET = 'a'.repeat(64);
const KEY_ID = 'tenant_acme';
const NOW_MS = 1_900_000_000_000; // 2030-03-17 in ms

function sign(rawBody: Buffer, secret: string, ts: number): string {
  return crypto.createHmac('sha256', secret).update(`${ts}.${rawBody.toString('utf8')}`).digest('hex');
}

describe('verifySuiteCentralWebhook', () => {
  const baseHeaders = (ts: number, sig: string, key = KEY_ID) => ({
    'x-suitecentral-key-id': key,
    'x-suitecentral-timestamp': String(ts),
    'x-suitecentral-signature': sig,
  });

  it('happy path: returns ok for matching signature within replay window', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    const sig = sign(body, SECRET, ts);
    const result = verifySuiteCentralWebhook(body, baseHeaders(ts, sig), SECRET, NOW_MS);
    expect(result).toEqual({ ok: true, tenantIdFromHeader: KEY_ID, timestamp: ts });
  });

  it.each(['x-suitecentral-key-id', 'x-suitecentral-timestamp', 'x-suitecentral-signature'])(
    'rejects when %s header missing',
    (missing) => {
      const ts = Math.floor(NOW_MS / 1000);
      const headers = baseHeaders(ts, sign(Buffer.from('{}', 'utf8'), SECRET, ts));
      delete (headers as Record<string, unknown>)[missing];
      const result = verifySuiteCentralWebhook(Buffer.from('{}', 'utf8'), headers, SECRET, NOW_MS);
      expect(result).toEqual({ ok: false, reason: 'missing_header' });
    },
  );

  // R18-8 — Verifier matrix MUST cover spec §8.1's zero-timestamp case. `"0"` parses to the
  // integer 0, which (after the parseInt-prefix guard) hits the `timestamp <= 0` check inside
  // the verifier and bucket as `malformed_timestamp` — NOT `replay_window_exceeded` (`Math.abs(0 - now_secs) > 300`
  // would otherwise pass through the replay-window check first and mis-classify). A regression
  // that flipped the order of those two checks would silently change the response label for
  // a common attacker probe (clock-reset / sentinel-zero), which alerting depends on.
  it.each([
    ['non-numeric', '123abc'],
    ['leading-plus', '+123'],
    ['decimal', '12.5'],
    ['negative-prefix', '-1'],
    ['empty', ''],
    ['zero', '0'],            // R18-8 — spec §8.1: explicit zero-timestamp coverage
  ])('rejects malformed timestamp (%s)', (_label, tsStr) => {
    const result = verifySuiteCentralWebhook(
      Buffer.from('{}', 'utf8'),
      { 'x-suitecentral-key-id': KEY_ID, 'x-suitecentral-timestamp': tsStr, 'x-suitecentral-signature': 'a'.repeat(64) },
      SECRET,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: 'malformed_timestamp' });
  });

  it('rejects timestamps outside the 5-minute replay window in either direction', () => {
    const body = Buffer.from('{}', 'utf8');
    const tsTooOld = Math.floor(NOW_MS / 1000) - 301;
    const tsTooNew = Math.floor(NOW_MS / 1000) + 301;
    expect(
      verifySuiteCentralWebhook(body, baseHeaders(tsTooOld, sign(body, SECRET, tsTooOld)), SECRET, NOW_MS),
    ).toEqual({ ok: false, reason: 'replay_window_exceeded' });
    expect(
      verifySuiteCentralWebhook(body, baseHeaders(tsTooNew, sign(body, SECRET, tsTooNew)), SECRET, NOW_MS),
    ).toEqual({ ok: false, reason: 'replay_window_exceeded' });
  });

  it('rejects signature length mismatch BEFORE timingSafeEqual would throw', () => {
    const body = Buffer.from('{}', 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    const result = verifySuiteCentralWebhook(body, baseHeaders(ts, 'short'), SECRET, NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  // R18-8 — Pin boundary behavior at exactly ±1 char from the canonical 64-char HMAC-SHA256
  // hex output length. The generic "short" test above covers the catastrophic case but not the
  // off-by-one boundary, which is where `Buffer.from(sig, 'hex').length !== 32` regressions
  // typically surface (e.g., a future implementer adding hex case-folding that accidentally
  // accepts 63 or 65 chars). Pre-`timingSafeEqual` length-mismatch guarding is the only thing
  // standing between a hostile client and a Node crash (`Input buffers must have the same byte length`)
  // here, so the boundary test is load-bearing for crash-resistance.
  it.each([
    ['63-char (one short of canonical 64)', 'a'.repeat(63)],
    ['65-char (one over canonical 64)',     'a'.repeat(65)],
  ])('rejects signature length mismatch at canonical-64 boundary (%s)', (_label, sig) => {
    const body = Buffer.from('{}', 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    const result = verifySuiteCentralWebhook(body, baseHeaders(ts, sig), SECRET, NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  // R20-4 — Pin the byte-vs-char vector closed. A 64-character non-ASCII string has
  // `.length === 64` but its UTF-8 byte length is 128 (or more for higher code points).
  // Pre-regex variants of this check used `.length` comparison and let the bytes through to
  // `crypto.timingSafeEqual(a, b)` which throws "Input buffers must have the same byte length",
  // crashing the route into a 500 instead of the canonical 401 `malformed_signature`. This
  // test inputs a 64-char string of multi-byte characters (here Latin-1-extended `é` × 64;
  // each `é` is 2 UTF-8 bytes → 128 total) and asserts the verifier never throws and returns
  // the contract-correct rejection reason.
  it.each([
    ['64 multi-byte chars (Latin-1 supplement)',  'é'.repeat(64)],
    ['64 mixed hex + non-hex (mostly hex)',       'a'.repeat(63) + 'g'],          // `g` is not in /[0-9a-f]/
    ['64 uppercase hex (canonical is lowercase)', 'A'.repeat(64)],                 // createHmac emits lowercase
  ])('R20-4 — rejects 64-char signature whose contents are not canonical lowercase hex (%s)', (_label, sig) => {
    const body = Buffer.from('{}', 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    expect(() => verifySuiteCentralWebhook(body, baseHeaders(ts, sig), SECRET, NOW_MS)).not.toThrow();
    const result = verifySuiteCentralWebhook(body, baseHeaders(ts, sig), SECRET, NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects signature value mismatch (constant-time)', () => {
    const body = Buffer.from('{}', 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    const wrong = 'b'.repeat(64);
    const result = verifySuiteCentralWebhook(body, baseHeaders(ts, wrong), SECRET, NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('round-trips multi-byte UTF-8 bodies', () => {
    const body = Buffer.from(JSON.stringify({ name: 'José 山田' }), 'utf8');
    const ts = Math.floor(NOW_MS / 1000);
    const sig = sign(body, SECRET, ts);
    expect(verifySuiteCentralWebhook(body, baseHeaders(ts, sig), SECRET, NOW_MS).ok).toBe(true);
  });
});
