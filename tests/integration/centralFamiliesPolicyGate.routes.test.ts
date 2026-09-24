import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  CENTRAL_FAMILY_DEMO_ALLOWLISTS,
  mountCentralTenantGate,
  mountCentralFamilyRoutes,
} from '../../src/middleware/setup/RouteSetup';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';
import { resolveCentralTenantId } from '../../src/routes/central/centralTenant';
import { CENTRAL_DEMO_TENANT_ID } from '../../src/services/governance/demoTenant';
import { optionalAuthMiddleware } from '../../src/middleware/auth';
import { classifyRoute } from '../../src/middleware/setup/routeManifest';
import { ROUTE_POLICY_MANIFEST, resolveRoutePolicy, type HttpMethod } from '../../src/middleware/setup/routePolicy';
import { resolveCentralTenantPreflight } from '../../src/middleware/setup/centralTenantPreflight';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

function createAppWithAllowlist(
  prefix: string,
  demo: boolean,
  allowlist: Parameters<typeof mountCentralFamilyRoutes>[4],
): { app: express.Application; routerHits: jest.Mock } {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });
  app.use(express.json());
  mountCentralFamilyRoutes(app, fakeTenantService, prefix, router, allowlist, {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

function createApp(prefix: string, demo: boolean): {
  app: express.Application;
  routerHits: jest.Mock;
} {
  return createAppWithAllowlist(prefix, demo, CENTRAL_FAMILY_DEMO_ALLOWLISTS[prefix]);
}

function createStrictComposedApp(prefix: string, demo: boolean): {
  app: express.Application;
  routerHits: jest.Mock;
} {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (req, res) => {
    routerHits();
    if (req.path.replace(/\/+$/, '') === '/health') {
      res.status(200).json({ reached: true });
      return;
    }
    const tenantId = resolveCentralTenantId(req, res);
    if (tenantId === null) return;
    res.status(200).json({ reached: true, tenantId });
  });
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => demo });
  mountCentralFamilyRoutes(app, fakeTenantService, prefix, router, CENTRAL_FAMILY_DEMO_ALLOWLISTS[prefix], {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

const ALL_HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

// The inventory is deliberately explicit rather than a best-effort regex
// string-munging routine. A new route-policy regex must add a representative
// here or this test fails loudly instead of silently dropping the policy.
const REPRESENTATIVE_SUBPATHS = new Map<string, string>([
  [String.raw`^\/provider-config(\/|$)`, '/provider-config'],
  [String.raw`^\/models(\/|$)`, '/models'],
  [String.raw`^\/providers(\/|$)`, '/providers'],
  [String.raw`^\/mapping\/suggestions(\/|$)`, '/mapping/suggestions'],
  [String.raw`^\/mapping\/feedback(\/|$)`, '/mapping/feedback'],
  [String.raw`^\/mapping\/schemas(\/|$)`, '/mapping/schemas'],
  [String.raw`^\/mapping\/transformation(\/|$)`, '/mapping/transformation'],
  [String.raw`^\/mapping\/validation(\/|$)`, '/mapping/validation'],
  [String.raw`^\/mapping\/defaultvalue(\/|$)`, '/mapping/defaultvalue'],
  [String.raw`^\/suggestions(\/|$)`, '/suggestions'],
  [String.raw`^\/mcp(\/|$)`, '/mcp'],
  [String.raw`^\/[^/]+\/serialized-assets\/retry-deferred(\/|$)`, '/sample/serialized-assets/retry-deferred'],
  [String.raw`^\/run(\/|$)`, '/run'],
  [String.raw`^\/mcp-schema(\/|$)`, '/mcp-schema'],
  [String.raw`^\/health\/?$`, '/health'],
  [String.raw`^\/(request-w9|pause-payments|send-reminder|escalate-csm|track-shipment|create-dispute)(\/|$)`, '/request-w9'],
  [String.raw`^\/dashboard(\/|$)`, '/dashboard'],
  [String.raw`^\/analytics(\/|$)`, '/analytics'],
  [String.raw`^\/processors(\/|$)`, '/processors'],
  [String.raw`^\/transactions(\/|$)`, '/transactions'],
  [String.raw`^\/invoices(\/|$)`, '/invoices'],
  [String.raw`^\/disputes(\/|$)`, '/disputes'],
  [String.raw`^\/credit-memos(\/|$)`, '/credit-memos'],
  [String.raw`^\/vendors(\/|$)`, '/vendors'],
  [String.raw`^\/?$`, ''],
  [String.raw`^\/chat(\/|$)`, '/chat'],
  [String.raw`^\/(audiences|status)(\/|$)`, '/audiences'],
  [String.raw`^\/reindex(\/|$)`, '/reindex'],
  [String.raw`^\/[^/]+\/(serialized-asset-readiness|activate)(\/|$)`, '/sample/serialized-asset-readiness'],
]);

function representativePath(policy: (typeof ROUTE_POLICY_MANIFEST)[number]): string {
  const subpath = policy.match.subpath;
  if (!subpath) return policy.match.pathPrefix;
  const suffix = REPRESENTATIVE_SUBPATHS.get(subpath.source);
  if (suffix === undefined) {
    throw new Error(`No Stage 5 sample registered for route-policy subpath ${subpath.source}`);
  }
  const path = `${policy.match.pathPrefix}${suffix}`;
  const remainder = path.slice(policy.match.pathPrefix.length) || '/';
  if (!subpath.test(remainder)) {
    throw new Error(`Stage 5 sample does not match route-policy subpath ${subpath.source}: ${path}`);
  }
  return path;
}

function representativeMethod(
  policy: (typeof ROUTE_POLICY_MANIFEST)[number],
  path: string,
): HttpMethod {
  const candidates = policy.match.methods ?? ALL_HTTP_METHODS;
  const method = candidates.find((candidate) => resolveRoutePolicy(path, candidate) === policy);
  if (!method) {
    throw new Error(`No Stage 5 sample method resolves to policy at ${path}`);
  }
  return method;
}

const READ_FAMILIES = [
  '/api/customer-central',
  '/api/quality-central',
  '/api/payout-central',
  '/api/installer-central',
  '/api/service-central',
  '/api/inventory-central',
  '/api/contract-central',
];

describe.each(READ_FAMILIES)('%s mount — F5b central-family policy gate', (prefix) => {
  it('allows the anonymous dashboard read in a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}/dashboard`);
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('rejects the anonymous dashboard read outside a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const res = await request(app).get(`${prefix}/dashboard`);
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an anonymous read outside the exact allowlist even in a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}/metrics`);
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an anonymous dashboard DESCENDANT (exact allowlist, not a subtree)', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}/dashboard/detail`);
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an anonymous POST to the allowlisted read path (reads-only rule)', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).post(`${prefix}/dashboard`).send({});
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('forces the auth path when a garbage credential is presented on a demo path', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}/dashboard`).set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('keeps the health probe public outside a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const res = await request(app).get(`${prefix}/health`);
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('blocks a suspended tenant before the router', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const token = signToken({ sub: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(app).get(`${prefix}/metrics`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows an active tenant to reach the router', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const token = signToken({ sub: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const res = await request(app).get(`${prefix}/metrics`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });
});

describe('/api/portal-central mount — empty allowlist (fully strict)', () => {
  it('rejects the anonymous dashboard read EVEN in a demo runtime', async () => {
    const { app, routerHits } = createApp('/api/portal-central', true);
    const res = await request(app).get('/api/portal-central/dashboard');
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('keeps the health probe public', async () => {
    const { app, routerHits } = createApp('/api/portal-central', false);
    const res = await request(app).get('/api/portal-central/health');
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('allows an active tenant to reach the router', async () => {
    const { app, routerHits } = createApp('/api/portal-central', false);
    const token = signToken({ sub: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const res = await request(app)
      .get('/api/portal-central/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });
});

const PHASE_TWO_FAMILIES = [
  '/api/payment-central',
  '/api/supplier-central',
  '/api/finance-central',
  '/api/workflow-central',
];

describe.each(PHASE_TWO_FAMILIES)('%s mount — F5b Phase 2 tenant-aware family gate', (prefix) => {
  it('allows the anonymous dashboard read in a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}/dashboard`);
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('rejects the anonymous dashboard read outside a demo runtime', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const res = await request(app).get(`${prefix}/dashboard`);
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an anonymous POST to the allowlisted read path (reads-only rule)', async () => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).post(`${prefix}/dashboard`).send({});
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('keeps the health probe public but NOT its descendants', async () => {
    const { app } = createApp(prefix, false);
    expect((await request(app).get(`${prefix}/health`)).status).toBe(200);
    expect((await request(app).get(`${prefix}/health/detail`)).status).toBe(401);
  });

  it('blocks a suspended tenant before the router', async () => {
    const { app, routerHits } = createApp(prefix, false);
    const token = signToken({ sub: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(app).get(`${prefix}/dashboard`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });
});

describe('non-allowlisted reads the handler suites simulate via attestation are 401 through the REAL gate', () => {
  // The bare-router suites attest these paths to test handler semantics
  // (centralRouterHarness is deliberately broader than the allowlists);
  // THIS block is the proof the production gate refuses them anonymously
  // even in a demo runtime (Codex review, PR #1081 R1).
  it.each([
    ['/api/finance-central', '/approvals'],
    ['/api/workflow-central', '/activity'],
    ['/api/workflow-central', '/tasks/T-1/render'],
    ['/api/payment-central', '/analytics/extra'],
    ['/api/supplier-central', '/vendors/v1/documents'],
  ])('anonymous GET %s%s is 401 in a demo runtime (outside the exact allowlist)', async (prefix, path) => {
    const { app, routerHits } = createApp(prefix, true);
    const res = await request(app).get(`${prefix}${path}`);
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });
});

describe('payment-central intentional demo breakage — retired anonymous writes 401 at the gate', () => {
  it.each([
    '/invoices/i1/approve',
    '/invoices/i1/dispute',
    '/transactions/bulk-sync',
    '/reconciliation/reports',
  ])('anonymous POST /api/payment-central%s is 401 even in a demo runtime', async (path) => {
    const { app, routerHits } = createApp('/api/payment-central', true);
    const res = await request(app).post(`/api/payment-central${path}`).send({});
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });
});

describe('teeth check — an empty injected allowlist closes the anonymous read', () => {
  it('is 200 with the real allowlist but 401 with an empty one (same request)', async () => {
    const withEntry = createAppWithAllowlist(
      '/api/customer-central',
      true,
      CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/customer-central'],
    );
    const withoutEntry = createAppWithAllowlist('/api/customer-central', true, []);

    expect((await request(withEntry.app).get('/api/customer-central/dashboard')).status).toBe(200);
    expect((await request(withoutEntry.app).get('/api/customer-central/dashboard')).status).toBe(
      401,
    );
    expect(withoutEntry.routerHits).not.toHaveBeenCalled();
  });
});

describe('strict central preflight composed with the family gate', () => {
  it('attests the demo runtime before resolveCentralTenantId', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', true);
    const res = await request(app).get('/api/customer-central/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(CENTRAL_DEMO_TENANT_ID);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('returns central TENANT_REQUIRED before the family gate outside demo runtime', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', false);
    const res = await request(app).get('/api/customer-central/dashboard');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('preserves malformed-credential 401 at the family auth layer', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', true);
    const res = await request(app)
      .get('/api/customer-central/dashboard')
      .set('Authorization', 'Bearer malformed');
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('preserves tenant_id_missing for a valid tenantless JWT', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', true);
    const res = await request(app)
      .get('/api/customer-central/dashboard')
      .set('Authorization', `Bearer ${signToken({ sub: 'u-no-tenant' })}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('refuses an anonymous central mutation at the strict boundary', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/finance-central', true);
    const res = await request(app)
      .post('/api/finance-central/approvals/a1/approve')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('defers a demo dashboard descendant to the family exact allowlist', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', true);
    const res = await request(app).get('/api/customer-central/dashboard/detail');
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('preserves tenant lifecycle outcomes for valid credentials', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/customer-central', false);
    const active = await request(app)
      .get('/api/customer-central/metrics')
      .set('Authorization', `Bearer ${signToken({ sub: 'u1', tenantId: 'tenant-active' })}`);
    expect(active.status).toBe(200);
    expect(active.body.tenantId).toBe('tenant-active');

    const suspended = await request(app)
      .get('/api/customer-central/metrics')
      .set('Authorization', `Bearer ${signToken({ sub: 'u1', tenantId: SUSPENDED_TENANT })}`);
    expect(suspended.status).toBe(403);
    expect(suspended.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('keeps the exact health probe public while protecting descendants', async () => {
    const { app, routerHits } = createStrictComposedApp('/api/payment-central', false);
    expect((await request(app).get('/api/payment-central/health')).status).toBe(200);
    expect((await request(app).head('/api/payment-central/health/')).status).toBe(200);
    const descendant = await request(app).get('/api/payment-central/health/detail');
    expect(descendant.status).toBe(401);
    expect(routerHits).toHaveBeenCalledTimes(2);
  });
});

describe('Stage 5 strict-flip input inventory', () => {
  it('prints a deterministic newly-403 list and the exact deferred public refinements', () => {
    const samples = new Map<string, string>();
    const tenantPolicies = ROUTE_POLICY_MANIFEST.filter(
      (policy) => classifyRoute(policy.match.pathPrefix) === 'tenant_required',
    );
    for (const policy of tenantPolicies) {
      const path = representativePath(policy);
      const method = representativeMethod(policy, path);
      const resolved = resolveRoutePolicy(path, method);
      expect(resolved).toBe(policy);
      const decision = resolveCentralTenantPreflight({
        path,
        method,
        isDemoRuntime: false,
        hasPresentedIdentity: false,
      });
      const line = `${method} ${path} [${policy.auth}; ${decision.action}; ${decision.reason}]`;
      samples.set(`${method} ${path}`, line);
    }

    expect(samples.size).toBe(tenantPolicies.length);

    const sorted = [...samples.values()].sort();
    const newly403 = sorted.filter((line) => line.includes('; isolate;'));
    const deferred = sorted.filter((line) => line.includes('; defer;'));
    const deferredPublic = deferred.filter((line) => line.includes('[public; defer;'));
    // This is intentionally console output: Stage 5 consumes the captured
    // sorted list, including ordinary tenant_required prefixes, platform-admin
    // refinements, and required health bases, rather than
    // relying on provisional design prose.
    console.log(
      `[stage5-input] newly-403\n${newly403.join('\n')}\n` +
        `[stage5-input] deferred\n${deferred.join('\n')}`,
    );
    expect(newly403.some((line) => line.includes('/api/customer-central/dashboard'))).toBe(true);
    expect(newly403.some((line) => line.includes('/api/actions/request-w9'))).toBe(true);
    expect(newly403.some((line) => line.includes('/api/help/audiences'))).toBe(true);
    expect(newly403.some((line) => line.includes('/api/ai/proxy/provider-config'))).toBe(true);
    expect(deferred.some((line) => line.includes('/api/customer-central/health [required; defer; health-subtree]'))).toBe(true);
    expect(deferredPublic.some((line) => line.includes('/api/testing/mcp-schema'))).toBe(true);
  });
});
