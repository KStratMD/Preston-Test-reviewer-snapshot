/**
 * Test doubles for the verified-grant path in `_governanceAuth.ts`.
 *
 * The governance role gates no longer read `embedded_sessions.user_roles` —
 * that column is written verbatim from the host-bootstrap request body, so a
 * host asserting `["admin","approver"]` authorized itself over its own
 * tenant's queue (measured 2026-09-03). The gates now require a VERIFIED role,
 * proved against an `embedded_role_grants` row.
 *
 * Unit suites that stub `validateGuestContext` and run the real gate therefore
 * need two things a plain session object no longer supplies: session fields
 * marking the identity as verified, and a bound grant repository for the gate
 * to resolve against. These helpers provide both, so each suite states which
 * role it is testing rather than restating the mechanism.
 *
 * Suites that want a DENIAL should keep the plain host-asserted session and not
 * call `bindStubGrants` — that is now the realistic shape of an unauthorized
 * caller.
 */
import type { EmbeddedRoleGrant } from '../../../src/database/types';
import type { EmbeddedRoleGrantRepository } from '../../../src/services/embedded/EmbeddedRoleGrantRepository';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';

export const STUB_GRANT_ID = 'erg_stub_1';

/**
 * Session columns that mark the caller as having proved `STUB_GRANT_ID`.
 * Spread these into a stubbed `res.locals.embeddedSession`.
 */
export const verifiedSessionFields = {
  user_identity: 'squire_verified' as const,
  verified_grant_id: STUB_GRANT_ID,
};

/**
 * Bind a grant repository that returns one open grant for `role`.
 *
 * `userId` and `platformAccountId` must match the stubbed session, because
 * `resolvePrincipal` re-checks the grant against the session it is used on —
 * a grant proved in one account must not carry into another. The defaults
 * match the conventional stub session (`u-1`, standalone with no account).
 */
export function bindStubGrants(
  role: 'viewer' | 'requester' | 'approver' | 'admin',
  opts: { userId?: string; platformAccountId?: string; tenantId?: string; platform?: string } = {},
): void {
  const grant = {
    id: STUB_GRANT_ID,
    // resolvePrincipal checks all FOUR parts of the grant key against the
    // session — tenant and platform included — so a stub whose tenant differs
    // from its session activates nothing. Overridable for exactly that reason.
    tenant_id: opts.tenantId ?? 't-1',
    platform: opts.platform ?? 'standalone',
    platform_account_id: opts.platformAccountId ?? '',
    user_id: opts.userId ?? 'u-1',
    role,
    source: 'squire_operator',
    granted_by: 'test-operator',
    granted_at: '2026-09-03T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    secret_enc: 'test-ciphertext-not-decrypted-on-this-path',
  } as EmbeddedRoleGrant;

  const repo = {
    getActiveGrant: async (id: string) => (id === STUB_GRANT_ID ? grant : null),
  } as unknown as EmbeddedRoleGrantRepository;

  if (container.isBound(TYPES.EmbeddedRoleGrantRepository)) {
    container.unbind(TYPES.EmbeddedRoleGrantRepository);
  }
  container.bind<EmbeddedRoleGrantRepository>(TYPES.EmbeddedRoleGrantRepository).toConstantValue(repo);
}
