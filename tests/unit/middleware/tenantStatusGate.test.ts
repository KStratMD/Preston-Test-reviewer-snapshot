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

  it('passes through when extractIdentityContext returns SYSTEM_IDENTITY (no auth on request)', async () => {
    const svc = { requireActive: jest.fn() } as any;
    const gate = makeTenantStatusGate(svc);
    // req with no auth and no user → extractIdentityContext returns SYSTEM_IDENTITY
    const req: Partial<Request> = { path: '/api/anything', originalUrl: '/api/anything' } as any;
    await gate(req as Request, res, next);
    expect(svc.requireActive).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    // Verify the sentinel value that triggered the pass-through
    expect(SYSTEM_IDENTITY.tenantId).toBe('__system__');
  });
});
