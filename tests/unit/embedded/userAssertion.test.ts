/**
 * A grant is keyed to a user id, and the bootstrap takes that user id from the
 * host's request body. The service token authenticates the ACCOUNT, not the
 * person — so if a grant were activated by user id alone, anyone holding the
 * account's service token could bootstrap as `alice` and inherit her approver
 * grant. Separation of duties would be decorative.
 *
 * The assertion closes that: the grant carries a secret only the granted user
 * receives, and the bootstrap must prove possession before the session is
 * marked `squire_verified`.
 *
 * Two properties are pinned hardest because they are the ones an attacker
 * would probe:
 *
 * An assertion is bound to ONE grant. A leaked viewer secret cannot activate
 * an approver grant the same person also holds — a user with two roles holds
 * two secrets and presents the one for the role they need.
 *
 * The nonce is consumed even when verification then fails. A ledger that only
 * recorded successes would let an attacker retry a captured nonce until it
 * landed inside the skew window.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { signUserAssertion, verifyUserAssertion } from '../../../src/embedded/userAssertion';
import {
  ASSERTION_CONFORMANCE_VECTOR,
  EXPECTED_HEADER,
  EXPECTED_HMAC_HEX,
  EXPECTED_MATERIAL,
} from '../../../src/embedded/userAssertionVector';
import type { EmbeddedRoleGrantRepository } from '../../../src/services/embedded/EmbeddedRoleGrantRepository';
import type { UserAssertionNonceRepository } from '../../../src/services/embedded/UserAssertionNonceRepository';
import type { EncryptionService } from '../../../src/services/security/EncryptionService';

const KEY = { tenantId: 't1', platform: 'netsuite', platformAccountId: 'a1', userId: 'alice' };
const TS = 1788350400; // 2026-09-02T12:00:00Z
const NOW = new Date(TS * 1000);

function makeGrants() {
  const rows: Record<string, Record<string, unknown>> = {
    g1: {
      id: 'g1',
      role: 'viewer',
      secret_enc: 'enc:s1',
      tenant_id: 't1',
      platform: 'netsuite',
      platform_account_id: 'a1',
      user_id: 'alice',
    },
    g2: {
      id: 'g2',
      role: 'approver',
      secret_enc: 'enc:s2',
      tenant_id: 't1',
      platform: 'netsuite',
      platform_account_id: 'a1',
      user_id: 'alice',
    },
    g3: {
      id: 'g3',
      role: 'approver',
      secret_enc: 'enc:s3',
      tenant_id: 't1',
      platform: 'netsuite',
      platform_account_id: 'OTHER',
      user_id: 'alice',
    },
  };
  return {
    getActiveGrant: jest.fn(async (id: string) => rows[id] ?? null),
  } as unknown as EmbeddedRoleGrantRepository;
}

function makeNonces() {
  const used = new Set<string>();
  return {
    // Insert-first ledger: false models the primary-key violation.
    consume: jest.fn(async (nonce: string) => {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    }),
  } as unknown as UserAssertionNonceRepository;
}

const encryption = {
  decryptFromStorage: async (value: string) => value.replace(/^enc:/, ''),
} as unknown as EncryptionService;

describe('user assertion', () => {
  let grants: EmbeddedRoleGrantRepository;
  let nonces: UserAssertionNonceRepository;
  let seq = 0;

  beforeEach(() => {
    grants = makeGrants();
    nonces = makeNonces();
  });

  // 16 bytes base64url is 22 characters, which is the floor the header format
  // specifies and the parser enforces. The old fixture produced 20 and would
  // have been rejected as malformed by a correct parser.
  const freshNonce = (): string => `bm9uY2Vfbm9uY2U${String((seq += 1)).padStart(8, '0')}`;

  const header = (
    over: Partial<{ grantId: string; secret: string; ts: number; nonce: string; userId: string }> = {},
  ): string =>
    signUserAssertion({
      tenantId: KEY.tenantId,
      platform: KEY.platform,
      platformAccountId: KEY.platformAccountId,
      userId: over.userId ?? KEY.userId,
      grantId: over.grantId ?? 'g1',
      secret: over.secret ?? 's1',
      ts: over.ts ?? TS,
      nonce: over.nonce ?? freshNonce(),
    });

  const verify = (h: string | undefined) =>
    verifyUserAssertion({ header: h, ...KEY, grants, nonces, encryption, now: NOW });

  it('no header → host_asserted, and nothing activates', async () => {
    expect(await verify(undefined)).toEqual({ identity: 'host_asserted' });
    expect(grants.getActiveGrant as jest.Mock).not.toHaveBeenCalled();
  });

  it('a valid assertion for g1 verifies that grant and only its role', async () => {
    expect(await verify(header())).toEqual({ identity: 'squire_verified', grantId: 'g1', role: 'viewer' });
  });

  it('the viewer secret cannot activate the approver grant; the approver grant needs its own', async () => {
    expect(await verify(header({ grantId: 'g2', secret: 's1' }))).toEqual({
      identity: 'invalid',
      reason: 'no_matching_grant',
    });
    expect(await verify(header({ grantId: 'g2', secret: 's2' }))).toEqual({
      identity: 'squire_verified',
      grantId: 'g2',
      role: 'approver',
    });
  });

  it('rejects a wrong secret, a different user, an unknown grant, a stale timestamp and a malformed header', async () => {
    const cases: [string, string][] = [
      [header({ secret: 'wrong' }), 'no_matching_grant'],
      [header({ userId: 'mallory' }), 'no_matching_grant'],
      [header({ grantId: 'g9' }), 'no_matching_grant'],
      [header({ ts: TS - 301 }), 'stale'],
      [header({ ts: TS + 301 }), 'stale'],
      ['v1.garbage', 'malformed'],
      ['', 'malformed'],
      ['v2.g1.1.n.aa', 'malformed'],
      ['v1.g1.notanumber.n.aa', 'malformed'],
    ];
    for (const [h, reason] of cases) {
      expect(await verify(h)).toEqual({ identity: 'invalid', reason });
    }
  });

  it('rejects a grant scoped to a different platform account, even with the right secret', async () => {
    expect(await verify(header({ grantId: 'g3', secret: 's3' }))).toEqual({
      identity: 'invalid',
      reason: 'no_matching_grant',
    });
  });

  it('accepts a timestamp at the edge of the skew window', async () => {
    expect(await verify(header({ ts: TS - 300 }))).toEqual({
      identity: 'squire_verified',
      grantId: 'g1',
      role: 'viewer',
    });
    expect(await verify(header({ ts: TS + 300 }))).toEqual({
      identity: 'squire_verified',
      grantId: 'g1',
      role: 'viewer',
    });
  });

  it('consumes the nonce exactly once, even when the first use failed the HMAC', async () => {
    const n = freshNonce();
    expect(await verify(header({ nonce: n, secret: 'wrong' }))).toEqual({
      identity: 'invalid',
      reason: 'no_matching_grant',
    });
    expect(await verify(header({ nonce: n }))).toEqual({ identity: 'invalid', reason: 'replayed' });
  });

  it('does not consume a nonce for a stale or malformed header', async () => {
    // Nothing was verified, so nothing should be spent — otherwise an attacker
    // could burn a legitimate user's nonce by replaying it out of window.
    await verify(header({ ts: TS - 900 }));
    await verify('v1.garbage');
    expect((nonces.consume as jest.Mock).mock.calls).toHaveLength(0);
  });

  describe('the parse is bounded to the database column widths', () => {
    // embedded_user_assertion_nonces.nonce is VARCHAR(128) on Postgres, and the
    // ledger is written BEFORE the HMAC is checked. An over-long nonce raises a
    // database error that is not a uniqueness violation, so it propagates out of
    // verification rather than becoming a 401 — and the bootstrap has no catch
    // around this call, so a crafted header would answer 500. Every bound is
    // therefore checked before anything touches the database.
    const over = (n: number) => 'a'.repeat(n);

    it('rejects an over-long nonce as malformed WITHOUT consuming it', async () => {
      const h = header({ nonce: over(129) });
      expect(await verify(h)).toEqual({ identity: 'invalid', reason: 'malformed' });
      expect((nonces.consume as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('rejects an over-long grant id without loading it', async () => {
      const h = header({ grantId: over(65) });
      expect(await verify(h)).toEqual({ identity: 'invalid', reason: 'malformed' });
      expect(grants.getActiveGrant as jest.Mock).not.toHaveBeenCalled();
    });

    it('rejects a nonce shorter than 16 bytes of entropy', async () => {
      expect(await verify(header({ nonce: 'short' }))).toEqual({ identity: 'invalid', reason: 'malformed' });
    });

    it('rejects an HMAC that is not exactly 64 hex characters', async () => {
      const valid = header();
      const [v, g, ts, n, mac] = valid.split('.');
      expect(mac).toHaveLength(64);
      expect(await verify([v, g, ts, n, mac.slice(0, 63)].join('.'))).toEqual({
        identity: 'invalid',
        reason: 'malformed',
      });
      expect(await verify([v, g, ts, n, mac + 'ab'].join('.'))).toEqual({ identity: 'invalid', reason: 'malformed' });
    });

    it('rejects a timestamp long enough to lose precision in Number()', async () => {
      expect(await verify(header({ ts: 12345678901234 }))).toEqual({ identity: 'invalid', reason: 'malformed' });
    });

    it('rejects grant ids and nonces outside the base64url alphabet', async () => {
      expect(await verify(header({ grantId: 'erg_../etc' }))).toEqual({ identity: 'invalid', reason: 'malformed' });
      expect(await verify(header({ nonce: 'nonce with spaces!!!!!!' }))).toEqual({
        identity: 'invalid',
        reason: 'malformed',
      });
    });

    it('still accepts a nonce at the maximum width', async () => {
      // 128 is the column width, so it must pass rather than be rejected by an
      // off-by-one — a bound that refuses the legal maximum is its own bug.
      const maxNonce = 'n'.repeat(128);
      expect(await verify(header({ nonce: maxNonce }))).toEqual({
        identity: 'squire_verified',
        grantId: 'g1',
        role: 'viewer',
      });
    });
  });

  it('signs HMAC-SHA256 over the pipe-joined material, including the grant id', () => {
    const h = header();
    const [v, grantId, ts, nonce, mac] = h.split('.');
    expect(v).toBe('v1');
    expect(grantId).toBe('g1');
    expect(mac).toBe(createHmac('sha256', 's1').update(`g1|t1|netsuite|a1|alice|${ts}|${nonce}`).digest('hex'));
  });

  describe('the published conformance vector', () => {
    // The vector is what a NetSuite Suitelet or a BC codeunit is checked
    // against, and its expected hex is a hard-coded literal. These cases assert
    // the SERVER still reproduces it, so a change to the material format breaks
    // here rather than silently invalidating every already-deployed producer —
    // which would fail closed and look exactly like a wrong secret.
    it('signUserAssertion reproduces the published header exactly', () => {
      const produced = signUserAssertion({
        tenantId: ASSERTION_CONFORMANCE_VECTOR.tenantId,
        platform: ASSERTION_CONFORMANCE_VECTOR.platform,
        platformAccountId: ASSERTION_CONFORMANCE_VECTOR.platformAccountId,
        userId: ASSERTION_CONFORMANCE_VECTOR.userId,
        grantId: ASSERTION_CONFORMANCE_VECTOR.grantId,
        secret: ASSERTION_CONFORMANCE_VECTOR.secret,
        ts: ASSERTION_CONFORMANCE_VECTOR.ts,
        nonce: ASSERTION_CONFORMANCE_VECTOR.nonce,
      });
      expect(produced).toBe(EXPECTED_HEADER);
      expect(produced.split('.')[4]).toBe(EXPECTED_HMAC_HEX);
    });

    it('the runbook quotes the CURRENT vector, not a stale copy of it', () => {
      // The runbook is what a platform engineer pastes into NetSuite or BC. If
      // the vector changes here and the doc keeps the old hex, they verify
      // against a value nothing produces any more and conclude the platform is
      // broken. Cheap to pin, and impossible to notice otherwise.
      const runbook = readFileSync(
        joinPath(__dirname, '../../../docs/runbooks/embedded-user-assertion-producers.md'),
        'utf8',
      );
      expect(runbook).toContain(EXPECTED_HMAC_HEX);
      expect(runbook).toContain(EXPECTED_MATERIAL);
      expect(runbook).toContain(ASSERTION_CONFORMANCE_VECTOR.secret);
    });

    it('the published material is the material actually signed', () => {
      // Independently recomputed from the documented field order, so the
      // constant cannot drift away from what signUserAssertion joins.
      const recomputed = createHmac('sha256', ASSERTION_CONFORMANCE_VECTOR.secret)
        .update(EXPECTED_MATERIAL, 'utf8')
        .digest('hex');
      expect(recomputed).toBe(EXPECTED_HMAC_HEX);
    });
  });

  it('a signature over different material does not verify — the material binding is real', async () => {
    const other = signUserAssertion({
      tenantId: 'DIFFERENT',
      platform: KEY.platform,
      platformAccountId: KEY.platformAccountId,
      userId: KEY.userId,
      grantId: 'g1',
      secret: 's1',
      ts: TS,
      nonce: freshNonce(),
    });
    expect(await verify(other)).toEqual({ identity: 'invalid', reason: 'no_matching_grant' });
  });
});
