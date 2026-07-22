import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  requirePlatformAdmin,
  requireSuiteCentralTenantAdmin,
} from '../../../src/middleware/verifiedAdmin';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

interface RunResult {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
}

function runWith(middleware: RequestHandler, user: unknown): RunResult {
  const result: RunResult = { nextCalled: false };
  const req = { user } as unknown as Request;
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(payload: unknown) {
      result.body = payload;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = (() => {
    result.nextCalled = true;
  }) as NextFunction;
  middleware(req, res, next);
  return result;
}

function run(user: unknown): RunResult {
  return runWith(requirePlatformAdmin, user);
}

describe('requirePlatformAdmin', () => {
  it('rejects an anonymous request with 401', () => {
    const r = run(undefined);
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  it('rejects an authenticated non-admin with 403', () => {
    const r = run({ id: 'user-1', roles: ['user'], permissions: [] });
    expect(r.status).toBe(403);
    expect(r.nextCalled).toBe(false);
  });

  it('allows the admin role', () => {
    const r = run({ id: 'admin-1', roles: ['admin'], permissions: [] });
    expect(r.nextCalled).toBe(true);
    expect(r.status).toBeUndefined();
  });

  it('allows the wildcard permission', () => {
    const r = run({ id: 'admin-2', roles: ['user'], permissions: ['*'] });
    expect(r.nextCalled).toBe(true);
  });

  it('rejects an empty-string id as unauthenticated', () => {
    expect(run({ id: '', roles: ['admin'] }).status).toBe(401);
  });

  // A blank id is not a subject. `authMiddleware` already trims and rejects
  // one, so this is defense in depth — but these gates assert an identified
  // actor, and that assertion must not rest on an upstream normalization they
  // do not own. A blank id getting through would authorize the request and then
  // attribute it to nobody in the audit trail.
  it.each([['   '], ['\t'], ['\n']])('rejects a whitespace-only id (%j) as unauthenticated', (id) => {
    expect(run({ id, roles: ['admin'], permissions: ['*'] }).status).toBe(401);
  });

  it('ignores non-string entries in roles/permissions', () => {
    const r = run({ id: 'user-3', roles: [123, null], permissions: [{}] });
    expect(r.status).toBe(403);
  });
});

describe('requireSuiteCentralTenantAdmin', () => {
  const runTenant = (user: unknown) => runWith(requireSuiteCentralTenantAdmin, user);

  it('rejects an anonymous request with 401', () => {
    const r = runTenant(undefined);
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  it('allows the tenant_admin role', () => {
    const r = runTenant({ id: 'u1', tenantId: 't1', roles: ['tenant_admin'], permissions: [] });
    expect(r.nextCalled).toBe(true);
    expect(r.status).toBeUndefined();
  });

  it('allows the suitecentral:admin permission', () => {
    const r = runTenant({ id: 'u1', tenantId: 't1', roles: [], permissions: ['suitecentral:admin'] });
    expect(r.nextCalled).toBe(true);
  });

  it('rejects an authenticated tenant user without an admin claim', () => {
    const r = runTenant({ id: 'u1', tenantId: 't1', roles: ['user'], permissions: [] });
    expect(r.status).toBe(403);
    expect(r.nextCalled).toBe(false);
  });

  // Tenant identity is the target of every tenant-namespace operation. Without
  // it there is no scope to authorize against, so this is 401 (incomplete
  // identity) rather than 403 (identity understood, access denied).
  it('rejects an admin claim with no tenantId as unauthenticated', () => {
    const r = runTenant({ id: 'u1', roles: ['tenant_admin'], permissions: [] });
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  it.each([[''], ['   '], [null], [42], [{}]])(
    'rejects a non-usable tenantId (%p) as unauthenticated',
    (tenantId) => {
      const r = runTenant({ id: 'u1', tenantId, roles: ['tenant_admin'], permissions: [] });
      expect(r.status).toBe(401);
      expect(r.nextCalled).toBe(false);
    },
  );

  it('rejects an empty-string id as unauthenticated', () => {
    const r = runTenant({ id: '', tenantId: 't1', roles: ['tenant_admin'] });
    expect(r.status).toBe(401);
  });

  it.each([['   '], ['\t']])('rejects a whitespace-only id (%j) as unauthenticated', (id) => {
    const r = runTenant({ id, tenantId: 't1', roles: ['tenant_admin'] });
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  // The system sentinel is a fallback attribution for unauthenticated work, not
  // a tenant anyone may administer. A token minted with it must not be able to
  // read or write the system sandbox through the tenant namespace.
  it('rejects the system identity sentinel as a target tenant', () => {
    const r = runTenant({
      id: 'u1',
      tenantId: SYSTEM_IDENTITY.tenantId,
      roles: ['tenant_admin'],
      permissions: [],
    });
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });

  // A platform admin is not implicitly a tenant admin HERE by design: the
  // wildcard would let them act on the tenant namespace, where the audit row
  // records accessMode 'tenant_admin' against their own JWT tenantId. Platform
  // actors must use /api/admin/tenants/:tenantId/suitecentral so cross-tenant
  // access is audited as what it is.
  it('does not accept the platform wildcard permission', () => {
    const r = runTenant({ id: 'admin-1', tenantId: 't1', roles: ['admin'], permissions: ['*'] });
    expect(r.status).toBe(403);
    expect(r.nextCalled).toBe(false);
  });

  it('ignores non-string entries in roles/permissions', () => {
    const r = runTenant({ id: 'u1', tenantId: 't1', roles: [123, null], permissions: [{}] });
    expect(r.status).toBe(403);
  });
});
