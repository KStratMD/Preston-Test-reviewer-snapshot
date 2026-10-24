// The SuiteCentral control plane must not be coupled to the legacy sync flag,
// and each namespace must be mounted behind its own guard, in order (PR-A6).
//
// `setupSuiteCentralRoutes()` opens with `if (!enableSuiteCentralSync) return;`,
// and the control-plane mount originally sat AFTER it — so a deployment that
// turned off legacy sync also silently lost the tenant control plane, the
// platform namespace, and the platform-admin egress allowlist, while the comment
// beside the mount claimed there was no feature flag. The flag defaults true, so
// nothing observed it: no test named this, which is why it shipped.
//
// The routers themselves are stubbed — what is pinned here is the mount
// DECISION: exact path, exact middleware order, both flag states. An earlier
// version of this file asserted only that some mounted path contained the
// substring "suitecentral", which a wrong path or a missing guard would have
// satisfied just as well.

import express, { type Application, type Router } from 'express';

const tenantRouter = express.Router();
const platformRouter = express.Router();
const allowedHostsRouter = express.Router();

jest.mock('../../../src/routes/suiteCentralControlPlane', () => ({
  createSuiteCentralControlPlaneRouter: jest.fn(async ({ accessMode }: { accessMode: string }) =>
    (accessMode === 'tenant_admin' ? tenantRouter : platformRouter) as Router),
  createSuiteCentralAllowedHostsRouter: jest.fn(async () => allowedHostsRouter as Router),
}));

jest.mock('../../../src/middleware/verifiedAdmin', () => ({
  requirePlatformAdmin: jest.fn((_req, _res, next) => next()),
  requireSuiteCentralTenantAdmin: jest.fn((_req, _res, next) => next()),
}));

interface Mount {
  path: string;
  handlers: unknown[];
}

/**
 * Record every `app.use(path, ...handlers)` this call makes.
 *
 * Reading `app._router.stack` back only exposes Express's compiled regexes, so
 * it can confirm that something was mounted but not that the guard is present
 * or that it runs before the router. Recording the call itself keeps both.
 */
function recordMounts(app: Application): Mount[] {
  const mounts: Mount[] = [];
  const realUse = app.use.bind(app);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).use = (...args: any[]) => {
    if (typeof args[0] === 'string') mounts.push({ path: args[0], handlers: args.slice(1) });
    return realUse(...(args as Parameters<typeof realUse>));
  };
  return mounts;
}

describe('SuiteCentral control-plane mount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['enabled', true],
    ['disabled', false],
  ])('mounts all three namespaces when legacy sync is %s', async (_label, enableSuiteCentralSync) => {
    const { RouteSetup } = await import('../../../src/middleware/setup/RouteSetup');
    const { authMiddleware } = await import('../../../src/middleware/auth');
    const { requirePlatformAdmin, requireSuiteCentralTenantAdmin } =
      await import('../../../src/middleware/verifiedAdmin');
    const app = express();
    const mounts = recordMounts(app);

    await new RouteSetup(app, { enableSuiteCentralSync }).setupSuiteCentralRoutes();

    // The control plane is authenticated and tenant-scoped; it does not need a
    // flag to be safe, and it must not inherit one that means something else.
    const byPath = (path: string) => mounts.find((m) => m.path === path);

    const tenant = byPath('/api/suitecentral/prod');
    expect(tenant).toBeDefined();
    // authMiddleware first: both guards read only the claims it installs, so an
    // anonymous request has to 401 there rather than reach a guard that would
    // report 403.
    expect(tenant!.handlers[0]).toBe(authMiddleware);
    expect(tenant!.handlers[1]).toBe(requireSuiteCentralTenantAdmin);
    expect(tenant!.handlers[2]).toBe(tenantRouter);

    const platform = byPath('/api/admin/tenants/:tenantId/suitecentral');
    expect(platform).toBeDefined();
    expect(platform!.handlers[0]).toBe(authMiddleware);
    expect(platform!.handlers[1]).toBe(requirePlatformAdmin);
    expect(platform!.handlers[2]).toBe(platformRouter);

    const allowlist = byPath('/api/admin/suitecentral/allowed-hosts');
    expect(allowlist).toBeDefined();
    expect(allowlist!.handlers[0]).toBe(authMiddleware);
    expect(allowlist!.handlers[1]).toBe(requirePlatformAdmin);
    expect(allowlist!.handlers[2]).toBe(allowedHostsRouter);

    // The tenant namespace never gets the platform guard: it would authorize a
    // platform admin where the audit row records accessMode 'tenant_admin'.
    expect(tenant!.handlers).not.toContain(requirePlatformAdmin);

    const { createSuiteCentralControlPlaneRouter, createSuiteCentralAllowedHostsRouter } =
      await import('../../../src/routes/suiteCentralControlPlane');
    expect(createSuiteCentralControlPlaneRouter).toHaveBeenCalledWith({ accessMode: 'tenant_admin' });
    expect(createSuiteCentralControlPlaneRouter).toHaveBeenCalledWith({ accessMode: 'platform_admin' });
    expect(createSuiteCentralAllowedHostsRouter).toHaveBeenCalled();
  });

  // The flag still governs what it was always about.
  it('mounts the legacy sync routers only when the flag is on', async () => {
    const { RouteSetup } = await import('../../../src/middleware/setup/RouteSetup');
    const off = express();
    const offMounts = recordMounts(off);
    await new RouteSetup(off, { enableSuiteCentralSync: false }).setupSuiteCentralRoutes();
    expect(offMounts.find((m) => m.path === '/api/suitecentral/sync')).toBeUndefined();
  });
});
