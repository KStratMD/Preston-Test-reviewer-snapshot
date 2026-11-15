/**
 * Direct unit tests for the role helpers in `_governanceAuth.ts`.
 *
 * This file originally existed to hold a coverage floor: the integration
 * suites reach these helpers through `validateGuestContext` mocks that
 * short-circuit them, so without direct tests the module's line coverage fell
 * to ~51% and tripped the Phase-5b core-coverage ratchet.
 *
 * It now also pins the security property the module was rewritten for. The
 * gates used to read `embedded_sessions.user_roles`, written verbatim from the
 * host-bootstrap request body — so a host asserting `["admin","approver"]`
 * authorized itself over its own tenant's governance queue (measured
 * 2026-09-03: HTTP 200, both predicates true). The first test below is that
 * exact attack, now refused.
 */
import 'reflect-metadata';
import type { EmbeddedSession } from '../../../../src/database/types';
import type { NextFunction, Request, Response } from 'express';
import {
  ADMIN_ROLES,
  APPROVER_ROLES,
  hasVerifiedRole,
  parseHostAssertedRoles,
  readEmbeddedSession,
  attachEmbeddedPrincipal,
  requireAdminRole,
  requireApproverRole,
  resolvePrincipal,
  type EmbeddedPrincipal,
} from '../../../../src/routes/governance/_governanceAuth';
import type { EmbeddedRoleGrantRepository } from '../../../../src/services/embedded/EmbeddedRoleGrantRepository';
import type { EmbeddedRoleGrant } from '../../../../src/database/types';
import { container } from '../../../../src/inversify/inversify.config';
import { TYPES } from '../../../../src/inversify/types';

function makeSession(overrides: Partial<EmbeddedSession> = {}): EmbeddedSession {
  return {
    session_id: 'session-1',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    platform: 'netsuite',
    platform_account_id: 'acct-a',
    csrf_token: 'csrf',
    expected_host_origin: 'https://12345.app.netsuite.com',
    expires_at: '2099-01-01T00:00:00.000Z',
    last_rotation_at: null,
    erp_record_type: null,
    erp_record_id: null,
    erp_record_url: null,
    user_roles: null,
    user_identity: 'host_asserted',
    verified_grant_id: null,
    created_at: '2026-09-03T00:00:00.000Z',
    ...overrides,
  } as EmbeddedSession;
}

function makeGrant(overrides: Partial<EmbeddedRoleGrant> = {}): EmbeddedRoleGrant {
  return {
    id: 'erg_1',
    tenant_id: 'tenant-a',
    platform: 'netsuite',
    platform_account_id: 'acct-a',
    user_id: 'user-a',
    role: 'approver',
    source: 'squire_operator',
    granted_by: 'op',
    granted_at: '2026-09-03T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    secret_enc: '{"v":1}',
    ...overrides,
  } as EmbeddedRoleGrant;
}

/** A grant repository that returns one row (or none) for getActiveGrant. */
function fakeGrants(grant: EmbeddedRoleGrant | null): EmbeddedRoleGrantRepository {
  return {
    getActiveGrant: jest.fn(async () => grant),
  } as unknown as EmbeddedRoleGrantRepository;
}

function makeRes(session: EmbeddedSession | null | undefined): Response & {
  statusCode?: number;
  body?: unknown;
} {
  const res = {
    locals: { embeddedSession: session ?? undefined },
    headersSent: false,
  } as unknown as Response & { statusCode?: number; body?: unknown };
  (res as unknown as { status: (c: number) => unknown }).status = (code: number) => {
    res.statusCode = code;
    (res as { headersSent: boolean }).headersSent = true;
    return {
      json: (b: unknown) => {
        res.body = b;
      },
    };
  };
  return res;
}

/** Drive a middleware to completion — it resolves its work asynchronously. */
async function runGate(
  gate: (req: Request, res: Response, next: NextFunction) => void,
  res: Response,
): Promise<{ nextCalled: boolean; nextError: unknown }> {
  let nextCalled = false;
  let nextError: unknown = null;
  const next: NextFunction = ((err?: unknown) => {
    nextCalled = true;
    if (err) nextError = err;
  }) as NextFunction;

  gate({} as Request, res, next);
  // Let the gate's internal promise chain settle.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise(r => setImmediate(r));
  return { nextCalled, nextError };
}

function bindGrants(repo: EmbeddedRoleGrantRepository): void {
  if (container.isBound(TYPES.EmbeddedRoleGrantRepository)) {
    container.unbind(TYPES.EmbeddedRoleGrantRepository);
  }
  container.bind<EmbeddedRoleGrantRepository>(TYPES.EmbeddedRoleGrantRepository).toConstantValue(repo);
}

describe('the escalation this module exists to refuse', () => {
  it('a host asserting admin and approver gets neither', async () => {
    bindGrants(fakeGrants(null));
    const session = makeSession({ user_roles: JSON.stringify(['admin', 'approver']) });
    const res = makeRes(session);

    const { nextCalled } = await runGate(requireApproverRole, res);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'insufficient_role' });

    // The claim is still visible for display — it is simply not authority.
    const principal = await resolvePrincipal(session, fakeGrants(null));
    expect(principal.hostAssertedRoles).toEqual(['admin', 'approver']);
    expect(principal.verifiedRoles).toEqual([]);
  });
});

describe('_governanceAuth role sets', () => {
  it('APPROVER_ROLES includes approver and admin', () => {
    expect([...APPROVER_ROLES].sort()).toEqual(['admin', 'approver']);
  });
  it('ADMIN_ROLES is admin-only', () => {
    expect([...ADMIN_ROLES]).toEqual(['admin']);
  });
});

describe('readEmbeddedSession', () => {
  it('returns the session when populated', () => {
    const s = makeSession();
    expect(readEmbeddedSession(makeRes(s))).toBe(s);
  });
  it('returns null when missing', () => {
    expect(readEmbeddedSession(makeRes(undefined))).toBeNull();
  });
  it('returns null when not an object', () => {
    const res = { locals: { embeddedSession: 'nope' } } as unknown as Response;
    expect(readEmbeddedSession(res)).toBeNull();
  });
});

describe('parseHostAssertedRoles', () => {
  it('parses a JSON string array', () => {
    expect(parseHostAssertedRoles(makeSession({ user_roles: '["viewer","requester"]' }))).toEqual([
      'viewer',
      'requester',
    ]);
  });
  it('returns [] for null, empty, invalid JSON, and non-array JSON', () => {
    expect(parseHostAssertedRoles(makeSession({ user_roles: null }))).toEqual([]);
    expect(parseHostAssertedRoles(makeSession({ user_roles: '' }))).toEqual([]);
    expect(parseHostAssertedRoles(makeSession({ user_roles: '{oops' }))).toEqual([]);
    expect(parseHostAssertedRoles(makeSession({ user_roles: '{"a":1}' }))).toEqual([]);
  });
  it('drops non-string entries', () => {
    expect(parseHostAssertedRoles(makeSession({ user_roles: '["viewer",42,null]' }))).toEqual(['viewer']);
  });
});

describe('resolvePrincipal', () => {
  it('activates only the proved grant’s own role', async () => {
    const session = makeSession({
      user_identity: 'squire_verified',
      verified_grant_id: 'erg_1',
      user_roles: JSON.stringify(['requester']),
    });
    const p = await resolvePrincipal(session, fakeGrants(makeGrant({ role: 'viewer' })));

    expect(p.verifiedRoles).toEqual(['viewer']);
    expect(hasVerifiedRole(p, 'viewer')).toBe(true);
    // A viewer grant plus a host-asserted requester is not a verified requester.
    expect(hasVerifiedRole(p, 'requester')).toBe(false);
    expect(hasVerifiedRole(p, 'approver')).toBe(false);
  });

  it('refuses a grant belonging to a different user', async () => {
    const session = makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' });
    const p = await resolvePrincipal(session, fakeGrants(makeGrant({ user_id: 'someone-else' })));
    expect(p.verifiedRoles).toEqual([]);
  });

  it('refuses a grant belonging to a different tenant', async () => {
    // The session's own verified_grant_id is the only thing pointing at the
    // grant, and nothing else re-checks the pair — so without this, a session
    // naming a grant from another tenant would activate that grant's role.
    const session = makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' });
    const p = await resolvePrincipal(session, fakeGrants(makeGrant({ tenant_id: 'tenant-other' })));
    expect(p.verifiedRoles).toEqual([]);
  });

  it('refuses a grant issued for a different platform', async () => {
    const session = makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' });
    const p = await resolvePrincipal(session, fakeGrants(makeGrant({ platform: 'business_central' })));
    expect(p.verifiedRoles).toEqual([]);
  });

  it('refuses a grant scoped to a different platform account', async () => {
    const session = makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' });
    const p = await resolvePrincipal(session, fakeGrants(makeGrant({ platform_account_id: 'acct-other' })));
    expect(p.verifiedRoles).toEqual([]);
  });

  it('matches a standalone session, whose platform account is null, against a grant scoped to the empty string', async () => {
    // Standalone sessions carry a NULL platform account while the grant column
    // is NOT NULL, so both sides are normalised. Without that, every legitimate
    // standalone grant failed its own scope check — a gate rejecting the
    // legitimate case is as broken as one admitting the illegitimate.
    const session = makeSession({
      platform: 'standalone',
      platform_account_id: null,
      user_identity: 'squire_verified',
      verified_grant_id: 'erg_1',
    });
    const p2 = await resolvePrincipal(
      session,
      fakeGrants(makeGrant({ platform: 'standalone', platform_account_id: '', role: 'approver' })),
    );

    expect(p2.verifiedRoles).toEqual(['approver']);
    expect(p2.platformAccountId).toBe('');
  });

  it('refuses when the grant is no longer active', async () => {
    const session = makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' });
    const p = await resolvePrincipal(session, fakeGrants(null));
    expect(p.verifiedRoles).toEqual([]);
  });

  it('does not consult the repository when the session is only host-asserted', async () => {
    const grants = fakeGrants(makeGrant({ role: 'admin' }));
    const session = makeSession({ verified_grant_id: 'erg_1' }); // identity still host_asserted
    const p = await resolvePrincipal(session, grants);

    expect(p.verifiedRoles).toEqual([]);
    expect(grants.getActiveGrant as jest.Mock).not.toHaveBeenCalled();
  });

  it('carries the session scope onto the principal', async () => {
    const p = await resolvePrincipal(makeSession(), fakeGrants(null));
    expect(p).toMatchObject({ userId: 'user-a', platform: 'netsuite', platformAccountId: 'acct-a' });
  });
});

describe('attachEmbeddedPrincipal', () => {
  // Exercised directly: the gates resolve the principal themselves now, so this
  // middleware is only reached by routers that mount it on its own — and an
  // untested authorization-adjacent middleware is exactly the shape that let
  // the original bypass survive.
  it('populates the principal and continues, requiring no role of its own', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'viewer' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));

    const { nextCalled } = await runGate((req, r, next) => {
      void attachEmbeddedPrincipal(req, r, next);
    }, res);

    expect(nextCalled).toBe(true);
    expect((res.locals as { embeddedPrincipal?: EmbeddedPrincipal }).embeddedPrincipal?.verifiedRoles).toEqual([
      'viewer',
    ]);
  });

  it('500s and does NOT continue when the session was never populated', async () => {
    bindGrants(fakeGrants(null));
    const res = makeRes(undefined);

    const { nextCalled } = await runGate((req, r, next) => {
      void attachEmbeddedPrincipal(req, r, next);
    }, res);

    // Continuing here would run the handler on a request that was refused.
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'session_not_populated' });
  });

  it('forwards a resolution failure rather than continuing', async () => {
    bindGrants({
      getActiveGrant: jest.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as EmbeddedRoleGrantRepository);
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));

    const { nextError } = await runGate((req, r, next) => {
      void attachEmbeddedPrincipal(req, r, next);
    }, res);

    expect(nextError).toBeInstanceOf(Error);
  });

  it('reuses an already-resolved principal without re-reading the grant', async () => {
    const grants = fakeGrants(makeGrant({ role: 'admin' }));
    bindGrants(grants);
    const res = makeRes(makeSession());
    (res.locals as { embeddedPrincipal?: EmbeddedPrincipal }).embeddedPrincipal = {
      userId: 'user-a',
      platform: 'netsuite',
      platformAccountId: 'acct-a',
      hostAssertedRoles: [],
      verifiedRoles: ['admin'],
    };

    const { nextCalled } = await runGate((req, r, next) => {
      void attachEmbeddedPrincipal(req, r, next);
    }, res);

    expect(nextCalled).toBe(true);
    expect(grants.getActiveGrant as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('requireApproverRole', () => {
  it('calls next() for a verified approver grant', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'approver' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextCalled } = await runGate(requireApproverRole, res);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it('calls next() for a verified admin grant, since admin implies approver-grade access', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'admin' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextCalled } = await runGate(requireApproverRole, res);
    expect(nextCalled).toBe(true);
  });

  it('403s a verified viewer grant', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'viewer' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextCalled } = await runGate(requireApproverRole, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('500s when the session was never populated (defensive)', async () => {
    bindGrants(fakeGrants(null));
    const res = makeRes(undefined);
    const { nextCalled } = await runGate(requireApproverRole, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'session_not_populated' });
  });

  it('fails closed by forwarding the error when grant resolution throws', async () => {
    bindGrants({
      getActiveGrant: jest.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as EmbeddedRoleGrantRepository);
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextError } = await runGate(requireApproverRole, res);

    expect(nextError).toBeInstanceOf(Error);
    expect(res.statusCode).not.toBe(200);
  });
});

describe('requireAdminRole', () => {
  it('calls next() for a verified admin grant', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'admin' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextCalled } = await runGate(requireAdminRole, res);
    expect(nextCalled).toBe(true);
  });

  it('403s a verified approver grant, because admin is stricter', async () => {
    bindGrants(fakeGrants(makeGrant({ role: 'approver' })));
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    const { nextCalled } = await runGate(requireAdminRole, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('500s when the session is missing (defensive)', async () => {
    bindGrants(fakeGrants(null));
    const res = makeRes(undefined);
    await runGate(requireAdminRole, res);
    expect(res.statusCode).toBe(500);
  });

  it('reuses an already-resolved principal instead of re-reading the grant', async () => {
    const grants = fakeGrants(makeGrant({ role: 'admin' }));
    bindGrants(grants);
    const res = makeRes(makeSession({ user_identity: 'squire_verified', verified_grant_id: 'erg_1' }));
    (res.locals as { embeddedPrincipal?: EmbeddedPrincipal }).embeddedPrincipal = {
      userId: 'user-a',
      platform: 'netsuite',
      platformAccountId: 'acct-a',
      hostAssertedRoles: [],
      verifiedRoles: ['admin'],
    };

    const { nextCalled } = await runGate(requireAdminRole, res);
    expect(nextCalled).toBe(true);
    expect(grants.getActiveGrant as jest.Mock).not.toHaveBeenCalled();
  });
});
