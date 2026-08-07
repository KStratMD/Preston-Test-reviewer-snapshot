import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { makeTenantStatusGate } from '../../../src/middleware/tenantStatusGate';
import { TenantBlockedError } from '../../../src/services/tenants/TenantLifecycleService';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

// The gate matches exempt regexes against `req.originalUrl` (full request URL),
// not `req.path` (mount-relative). Set both so tests reflect production shape.
const mkReq = (tenantId?: string, originalUrl = '/api/anything'): Partial<Request> => ({
  auth: tenantId ? { tenantId, userId: 'u1' } : undefined,
  path: originalUrl,
  originalUrl,
} as any);

describe('tenantStatusGate', () => {
  let res: jest.Mocked<Response>;
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;
    next = jest.fn();
  });

  it('passes through requests with no tenantId (unauth paths)', async () => {
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    await gate(mkReq() as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('passes through active tenants', async () => {
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    await gate(mkReq('t1') as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('t1');
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 with reason for blocked tenants', async () => {
    const svc = { requireActive: jest.fn(async () => {
      throw new TenantBlockedError('t1', 'disabled', 'tenant_disabled');
    })} as any;
    const gate = makeTenantStatusGate(svc);
    await gate(mkReq('t1') as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'tenant_blocked', reason: 'tenant_disabled', status: 'disabled',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards unexpected errors to next()', async () => {
    const boom = new Error('db down');
    const svc = { requireActive: jest.fn(async () => { throw boom; }) } as any;
    const gate = makeTenantStatusGate(svc);
    await gate(mkReq('t1') as Request, res, next);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('skips service.requireActive for exempt full URLs (matched against req.originalUrl)', async () => {
    const svc = { requireActive: jest.fn() } as any;
    // Pattern is author-meaningful: it matches the full request URL exactly the
    // way a route map would describe it. No mount-relative gotchas.
    const gate = makeTenantStatusGate(svc, {
      exempt: [/^\/api\/admin\/tenants\/[^/]+\/status$/],
    });
    await gate(mkReq('t1', '/api/admin/tenants/some-id/status') as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('does NOT match exempt against mount-relative req.path when originalUrl differs', async () => {
    // Production shape: gate is composed inside a router mounted at /api/X.
    // req.path inside that router is the mount-relative subpath; originalUrl
    // is the full URL. A pattern intended to exempt the FULL URL must not be
    // accidentally satisfied by a coincidence in the subpath.
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc, {
      exempt: [/^\/api\/admin\/tenants\/[^/]+\/status$/],
    });
    const req: Partial<Request> = {
      auth: { tenantId: 't1', userId: 'u1' },
      // path is what Express sees inside a mount; originalUrl is the full URL
      path: '/some-id/status',
      originalUrl: '/api/payment-central/some-id/status',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('t1'); // gate did NOT bail
  });

  it('fails closed (403 tenant_id_missing) when req.user is set but identity is SYSTEM_IDENTITY', async () => {
    // Codex-caught BLOCKS-MERGE in R6: a JWT-authenticated request whose token
    // lacks a tenantId claim would otherwise bypass the kill switch via the
    // SYSTEM_IDENTITY short-circuit. The gate now distinguishes "no auth ran"
    // (pass-through) from "auth ran but no tenantId" (fail closed).
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      // Authenticated user shape, but no tenantId field — mirrors authMiddleware
      // populating req.user from a JWT whose claims are missing tenantId/tid/tenant_id.
      user: { id: 'u1', username: 'u1', roles: ['user'], permissions: [] },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'tenant_id_missing',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('also fails closed when req.auth is set but its tenantId is missing', async () => {
    // Same Codex-caught bypass on the OAuth/API-key path: extractIdentityContext
    // returns SYSTEM_IDENTITY for req.auth without tenantId; gate must NOT let
    // that traffic through. The "authenticated" flag covers both req.user and
    // req.auth so both source paths fail closed.
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      auth: { user: { sub: 'u1' } }, // present, but no tenantId field on auth
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'tenant_id_missing',
    }));
  });

  it('passes through req.user-authenticated request that DOES carry tenantId', async () => {
    // Sanity: with the fix, a properly-issued JWT (tenantId claim → req.user.tenantId)
    // still hits the normal requireActive path.
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { id: 'u1', username: 'u1', tenantId: 't1', roles: ['user'], permissions: [] },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('t1');
    expect(next).toHaveBeenCalledWith();
  });

  it('passes through when no identity source is present on the request', async () => {
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    // req with no auth, no user and no tenantContext → no identity source at all,
    // so the gate defers to the family gate rather than refusing. Stage 4 owns
    // any change to anonymous handling.
    const req: Partial<Request> = { path: '/api/anything', originalUrl: '/api/anything' } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    // Pin the sentinel the resolver rejects, so a future rename can't silently
    // turn the sentinel comparison into a no-op.
    expect(SYSTEM_IDENTITY.tenantId).toBe('__system__');
  });

  // ---- F6 PR4 Stage 2: explicit sentinel-rejecting tenant resolution -------
  // The gate no longer calls extractIdentityContext. It resolves the tenant
  // through a private resolver that keeps the same whole-source order
  // (req.auth → req.user → req.tenantContext) but trims claims, rejects the
  // system sentinel, and returns null instead of a sentinel identity.

  it('trims the first request tenant source and does not splice a later source', async () => {
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      auth: { tenantId: ' tenant-auth ', user: { sub: 'user-auth' } },
      user: { id: 'user-jwt', username: 'user-jwt', tenantId: 'tenant-jwt', roles: ['user'], permissions: [] },
      tenantContext: { tenantId: 'tenant-bridge' },
      path: '/api/anything',
      originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    // Whole-source-first: req.auth wins outright. The later sources must NOT be
    // spliced in, and the winning claim is returned trimmed so ' t1 ' and 't1'
    // cannot become two distinct tenant scopes.
    expect(svc.requireActive).toHaveBeenCalledWith('tenant-auth');
    expect(next).toHaveBeenCalledWith();
  });

  it('fails closed when a present JWT user has only a blank tenant claim', async () => {
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { id: 'user-jwt', username: 'user-jwt', tenantId: '   ', roles: ['user'], permissions: [] },
      path: '/api/anything',
      originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    // A whitespace-only claim is truthy, so the pre-Stage-2 extractor handed it
    // to requireActive as a real tenant scope. It must fail closed instead.
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'tenant_id_missing' }));
    expect(next).not.toHaveBeenCalled();
  });

  // ---- Source-order fidelity (Codex R2 on #1089) ------------------------
  // The resolver must reproduce extractIdentityContext's source order exactly,
  // INCLUDING its `id != null` condition on the req.user arm. Dropping that
  // condition widens the set of inputs reaching requireActive — which
  // auto-creates tenant rows via ensureExists — so these three shapes are
  // pinned rather than left to a reachability argument.

  it('falls through to the tenantContext bridge when req.user carries no usable tenant', async () => {
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { id: 'u1', username: 'u1', tenantId: '', roles: ['user'], permissions: [] },
      tenantContext: { tenantId: 'bridge-tenant' },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('bridge-tenant');
    expect(next).toHaveBeenCalledWith();
  });

  it('does NOT use a req.user tenant when the user has no id — falls through to the bridge', async () => {
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { username: 'u1', tenantId: 'user-tenant', roles: ['user'], permissions: [] },
      tenantContext: { tenantId: 'bridge-tenant' },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('bridge-tenant');
  });

  it('fails closed for an id-less req.user tenant with no bridge, instead of admitting it', async () => {
    // The regression that matters: without the id != null condition this
    // reached requireActive, which auto-creates the tenant row.
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { username: 'u1', tenantId: 'a'.repeat(65), roles: ['user'], permissions: [] },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'tenant_id_missing' }));
  });

  it('does not crash when req.auth is null — falls through to req.user like the old extractor', async () => {
    // Copilot R5: `auth !== undefined` is true for null, so reading auth.tenantId
    // threw a TypeError and turned this security gate into a 500. The old
    // extractor's `if (req.auth)` truthiness test skipped null entirely.
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      auth: null,
      user: { id: 'u1', username: 'u1', tenantId: 't1', roles: ['user'], permissions: [] },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).toHaveBeenCalledWith('t1');
    expect(next).toHaveBeenCalledWith();
  });

  it('treats a null req.auth with no other source as anonymous, not as a 500', async () => {
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      auth: null,
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses rather than crashing when req.auth is a non-object', async () => {
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      auth: 'not-an-object',
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'tenant_id_missing' }));
  });

  it('refuses a sentinel req.user tenant instead of falling through to a valid bridge', async () => {
    // Codex R3 (300-case matrix): rejecting the sentinel must REFUSE, never
    // hand the decision to a later source. The old extractor selected the
    // sentinel here and 403'd; falling through would ADMIT a request that used
    // to be refused — a widening dressed up as hardening. Any JWT_SECRET holder
    // can mint a sentinel-claiming token, so this is the shape that matters.
    const svc = { requireActive: jest.fn(async () => {}) } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      user: { id: 'u1', username: 'u1', tenantId: SYSTEM_IDENTITY.tenantId, roles: ['user'], permissions: [] },
      tenantContext: { tenantId: 'real-tenant' },
      path: '/api/anything', originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'tenant_id_missing' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when the only identity source is a sentinel-claiming tenantContext', async () => {
    // Unreachable in production (tenantIsolation's verified-user path already
    // rejects the sentinel), but the gate must not depend on that: a sentinel
    // tenant is never a real tenant scope, and an identity source IS present,
    // so this refuses rather than passing through as anonymous.
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    const req: Partial<Request> = {
      tenantContext: { tenantId: SYSTEM_IDENTITY.tenantId },
      path: '/api/anything',
      originalUrl: '/api/anything',
    } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'tenant_id_missing' }));
    expect(next).not.toHaveBeenCalled();
  });
});
