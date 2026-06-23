// src/middleware/syncErrorAssistWebhook.ts
import * as crypto from 'crypto';

const REPLAY_WINDOW_SECONDS = 300; // 5 minutes
const SIG_HEADER = 'x-suitecentral-signature';
const TS_HEADER = 'x-suitecentral-timestamp';
const KEY_ID_HEADER = 'x-suitecentral-key-id';
// R20-4 — Canonical SHA-256 hex output: 64 lowercase hex chars. Pre-`timingSafeEqual` guard
// against non-ASCII / non-hex characters whose `.length` happens to be 64 but byte length isn't.
const HEX_SIGNATURE_REGEX = /^[0-9a-f]{64}$/;

export type VerifyResult =
  | { ok: true; tenantIdFromHeader: string; timestamp: number }
  | {
      ok: false;
      reason:
        | 'missing_header'
        | 'malformed_timestamp'
        | 'replay_window_exceeded'
        | 'signature_mismatch'
        | 'malformed_signature';
    };

export function verifySuiteCentralWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowMs: number = Date.now(),
): VerifyResult {
  const sigHeader = headers[SIG_HEADER];
  const tsHeader = headers[TS_HEADER];
  const keyIdHeader = headers[KEY_ID_HEADER];

  if (typeof sigHeader !== 'string' || typeof tsHeader !== 'string' || typeof keyIdHeader !== 'string') {
    return { ok: false, reason: 'missing_header' };
  }

  // R12-3 — digit-only pre-check; parseInt('123abc', 10) === 123 is the trap we close.
  if (!/^\d+$/.test(tsHeader)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  const timestamp = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // ABSOLUTE difference guards against future-dated spoofing (gotcha #4).
  // Floor nowMs/1000 before subtraction — keeping the fractional millisecond component
  // shrinks the effective window by up to ~1s and can reject otherwise-valid timestamps
  // (e.g., nowMs=1234567890_500 → 1234567890.5; sub timestamp=1234567290 → 600.5 > 300).
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'replay_window_exceeded' };
  }

  const signedString = `${tsHeader}.${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', secret).update(signedString).digest('hex');

  // R20-4 — Reject any non-hex signature BEFORE building Buffers. The prior
  // `sigHeader.length !== computed.length` check compared JS string char counts (64), which
  // a hostile 64-char non-ASCII string can pass while having a UTF-8 byte length > 64 — and
  // then `crypto.timingSafeEqual(a, b)` throws "Input buffers must have the same byte length",
  // crashing the route into a 500 instead of the canonical 401 `malformed_signature`. The
  // canonical SHA-256 hex output is exactly 64 lowercase hex chars; anything else is malformed.
  // The regex check rejects (a) wrong char count, (b) non-hex characters (including UTF-8
  // multi-byte), and (c) mixed case — though createHmac always emits lowercase, so the regex
  // is constrained to lowercase only to avoid accepting a hex-shape that diverges from what
  // `computed` returned.
  if (!HEX_SIGNATURE_REGEX.test(sigHeader)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  // R20-4 — Defense-in-depth: even after regex screening, compare BYTE lengths (not JS
  // string `.length`) before timingSafeEqual. The regex above already enforces 64 ASCII hex
  // chars (so byte length == 64), but this check is the contract documentation: timingSafeEqual
  // requires equal byte lengths and the bug class is severe enough to warrant the redundant
  // guard. Future regex changes (e.g., relaxing to uppercase) would still be safe.
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(sigHeader, 'utf8');
  if (a.length !== b.length) {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true, tenantIdFromHeader: keyIdHeader, timestamp };
}
