import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EmbeddedRoleGrantRepository } from '../services/embedded/EmbeddedRoleGrantRepository';
import type { UserAssertionNonceRepository } from '../services/embedded/UserAssertionNonceRepository';
import type { EncryptionService } from '../services/security/EncryptionService';

/**
 * Proof that the person a host names actually holds the grant being claimed.
 *
 * The bootstrap persists whatever `userId` the host puts in the request body,
 * and the service token authenticates the ACCOUNT, not the person. If a grant
 * activated on user id alone, anyone holding the account's service token could
 * bootstrap as a granted approver, and separation of duties would be
 * decorative. So each grant carries a secret only the granted user receives,
 * and the bootstrap must prove possession before marking the session
 * `squire_verified`.
 *
 * ## The header
 *
 *   X-Squire-User-Assertion: v1.<grantId>.<ts>.<nonce>.<hmacHex>
 *
 * `hmacHex = HMAC-SHA256(secret, "grantId|tenantId|platform|platformAccountId|userId|ts|nonce")`
 *
 * Every field the assertion is about is inside the signed material, so a
 * captured assertion cannot be re-pointed at another tenant, account, user or
 * grant.
 *
 * ## One assertion, one grant
 *
 * The header names the grant it exercises, and only that grant's role
 * activates. A user holding both a viewer and an approver grant holds two
 * secrets and presents the one for the role they need — so a leaked viewer
 * secret can never turn on the approver grant.
 *
 * ## Failure is never a downgrade
 *
 * No header means `host_asserted`: the host named someone, nothing activates,
 * and that is a legitimate state. But a header that is PRESENT and does not
 * verify returns `invalid`, and the caller must reject the bootstrap. Falling
 * back to `host_asserted` on a bad signature would let an attacker strip the
 * proof requirement by sending garbage.
 *
 * ## Threat boundary
 *
 * This defends against a holder of the account service token alone, and
 * against a host that does not hold the user's secret. It does NOT defend
 * against a host operator who also controls the user's secret store — that is
 * the customer's own administrator, the same trust boundary as the host
 * installation itself.
 */

/** Accepted clock skew, in seconds, between the producer and this server. */
export const ASSERTION_MAX_SKEW_SECONDS = 300;

export type UserAssertionResult =
  | { identity: 'host_asserted' }
  | { identity: 'squire_verified'; grantId: string; role: string }
  | { identity: 'invalid'; reason: 'malformed' | 'stale' | 'no_matching_grant' | 'replayed' };

export interface SignUserAssertionArgs {
  tenantId: string;
  platform: string;
  platformAccountId: string;
  userId: string;
  grantId: string;
  secret: string;
  ts: number;
  nonce: string;
}

/**
 * The signed material. Pipe-joined because every component is an opaque
 * identifier without pipes; keeping it a single fixed order means the producer
 * and verifier cannot disagree about field boundaries.
 */
function assertionMaterial(args: {
  grantId: string;
  tenantId: string;
  platform: string;
  platformAccountId: string;
  userId: string;
  ts: number;
  nonce: string;
}): string {
  return [
    args.grantId,
    args.tenantId,
    args.platform,
    args.platformAccountId,
    args.userId,
    String(args.ts),
    args.nonce,
  ].join('|');
}

/**
 * Build a header. Exported so the host adapters and their conformance tests
 * sign exactly what this module verifies, rather than reimplementing the
 * material and drifting.
 */
export function signUserAssertion(args: SignUserAssertionArgs): string {
  const mac = createHmac('sha256', args.secret)
    .update(assertionMaterial({ ...args }))
    .digest('hex');
  return `v1.${args.grantId}.${args.ts}.${args.nonce}.${mac}`;
}

/** Constant-time compare of two hex strings, false on any length mismatch. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

interface ParsedAssertion {
  grantId: string;
  ts: number;
  nonce: string;
  mac: string;
}

/**
 * Column widths from migration 065. The parse is bounded to them because the
 * nonce reaches `embedded_user_assertion_nonces.nonce`, which is VARCHAR(128)
 * on Postgres: an over-long value raises a database error that is NOT a
 * uniqueness violation, so it propagates out of verification instead of
 * becoming a 401. The bootstrap has no catch around this call, so a crafted
 * header would answer 500 — turning a controlled rejection into an unhandled
 * error on a path any host can reach.
 */
const MAX_GRANT_ID_LENGTH = 64;
const MAX_NONCE_LENGTH = 128;
/** 16 bytes base64url is 22 characters; anything shorter is not a nonce. */
const MIN_NONCE_LENGTH = 22;
/** SHA-256 hex is exactly 64 characters — a different length cannot verify. */
const HMAC_HEX_LENGTH = 64;

function parseHeader(header: string): ParsedAssertion | null {
  const parts = header.split('.');
  if (parts.length !== 5) return null;
  const [version, grantId, ts, nonce, mac] = parts;
  if (version !== 'v1') return null;

  // Every bound is checked here, before anything reaches the database.
  if (grantId.length === 0 || grantId.length > MAX_GRANT_ID_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(grantId)) return null;

  // 12 digits covers Unix seconds well past any plausible clock; longer is a
  // probe, and Number() would silently lose precision on it.
  if (!/^\d{1,12}$/.test(ts)) return null;

  if (nonce.length < MIN_NONCE_LENGTH || nonce.length > MAX_NONCE_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) return null;

  if (mac.length !== HMAC_HEX_LENGTH || !/^[0-9a-f]+$/i.test(mac)) return null;

  return { grantId, ts: Number(ts), nonce, mac };
}

export interface VerifyUserAssertionArgs {
  header: string | undefined;
  tenantId: string;
  platform: string;
  platformAccountId: string;
  userId: string;
  grants: EmbeddedRoleGrantRepository;
  nonces: UserAssertionNonceRepository;
  encryption: EncryptionService;
  now: Date;
}

export async function verifyUserAssertion(args: VerifyUserAssertionArgs): Promise<UserAssertionResult> {
  const { header } = args;
  if (header === undefined) return { identity: 'host_asserted' };

  const parsed = parseHeader(header);
  if (parsed === null) return { identity: 'invalid', reason: 'malformed' };

  const skew = Math.abs(Math.floor(args.now.getTime() / 1000) - parsed.ts);
  if (skew > ASSERTION_MAX_SKEW_SECONDS) return { identity: 'invalid', reason: 'stale' };

  // Consume the nonce BEFORE verifying. A ledger that recorded only successes
  // would let an attacker retry a captured nonce until one landed inside the
  // skew window. Spending it here means one attempt per nonce, whatever the
  // outcome. Malformed and stale headers are rejected above precisely so they
  // cannot burn a legitimate user's nonce.
  const fresh = await args.nonces.consume(parsed.nonce, parsed.grantId, args.now);
  if (!fresh) return { identity: 'invalid', reason: 'replayed' };

  const grant = await args.grants.getActiveGrant(parsed.grantId, args.now);
  if (
    grant === null ||
    grant.tenant_id !== args.tenantId ||
    grant.platform !== args.platform ||
    (grant.platform_account_id ?? '') !== (args.platformAccountId ?? '') ||
    grant.user_id !== args.userId
  ) {
    return { identity: 'invalid', reason: 'no_matching_grant' };
  }

  let secret: string;
  try {
    secret = await args.encryption.decryptFromStorage(grant.secret_enc);
  } catch {
    // A grant whose secret cannot be decrypted cannot be proved. Reported as
    // no_matching_grant rather than a distinct code: the caller rejects either
    // way, and a separate code would tell a prober which grant ids exist.
    return { identity: 'invalid', reason: 'no_matching_grant' };
  }

  const expected = createHmac('sha256', secret)
    .update(
      assertionMaterial({
        grantId: parsed.grantId,
        tenantId: args.tenantId,
        platform: args.platform,
        platformAccountId: args.platformAccountId,
        userId: args.userId,
        ts: parsed.ts,
        nonce: parsed.nonce,
      }),
    )
    .digest('hex');

  if (!hexEquals(expected, parsed.mac)) {
    return { identity: 'invalid', reason: 'no_matching_grant' };
  }

  return { identity: 'squire_verified', grantId: grant.id, role: grant.role };
}
