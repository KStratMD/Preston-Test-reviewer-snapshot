/**
 * F2 gate dispatch unit tests. Full-wiring evidence (real JWTs through
 * mountAiProxyRoutes) is tests/integration/aiProxyPolicyGate.routes.test.ts —
 * these pin the DISPATCH LOGIC: policy resolution → demo vs platform-admin vs
 * auth path, credential detection, and the header-independent payload cap.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// fastMocks.ts globally mocks AuthService with a verifyJWT stub that ignores
// the token (returns { user: 'demo' } — no subject), which would 401 every
// signed token below. These tests are real-JWT evidence for the gate's
// credential dispatch, so restore the real HS256 verification path BEFORE the
// gate wires it. jest.unmock is hoisted above imports by the transform;
// keeping it above the gate import in source makes the ordering explicit.
jest.unmock('../../../src/services/AuthService');

// F2: sign with the SAME secret authMiddleware verifies against. Set it BEFORE
// importing the gate (which transitively imports config/env + AuthService and
// captures the secret) so signing and verification share one value — the unit
// profile loads no .env, so in CI process.env.JWT_SECRET is otherwise unset and
// the token would be signed with a value that doesn't match the env default.
// ts-jest emits the require at this import's position, so this assignment runs
// first. (beforeAll was too late: env was already parsed at import time.)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ai-proxy-gate-unit-secret';

// eslint-disable-next-line import/first
import {
  createAiProxyPolicyGate,
  createDemoFamilyPolicyGate,
  hasPresentedIdentity,
  isDemoAnonymousAdmitted,
} from '../../../src/middleware/aiProxyPolicyGate';

function makeApp(opts: { demo: boolean; gateImpl?: jest.Mock }) {
  const tenantStatusGate =
    opts.gateImpl ?? jest.fn(async (_req: any, _res: any, next: any) => next());
  const app = express();
  app.use(express.json({ limit: '10mb' })); // mirrors production MiddlewareSetup
  app.use(
    '/api/ai/proxy',
    createAiProxyPolicyGate({
      tenantStatusGate: tenantStatusGate as any,
      isDemoRuntime: () => opts.demo,
    }),
    (req, res) => { res.json({ reached: true, path: req.path }); },
  );
  return { app, tenantStatusGate };
}

function makeFamilyApp(opts: {
  mountPath: string;
  demo: boolean;
  demoAllowlist?: readonly { methods: readonly ('GET' | 'HEAD' | 'POST')[]; pattern: RegExp }[];
}) {
  const tenantStatusGate = jest.fn(async (_req: any, _res: any, next: any) => next());
  const router = jest.fn((req: express.Request, res: express.Response) => {
    res.json({ reached: true, path: req.path });
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    opts.mountPath,
    createDemoFamilyPolicyGate({
      tenantStatusGate: tenantStatusGate as any,
      isDemoRuntime: () => opts.demo,
      demoAllowlist: opts.demoAllowlist ?? [],
    }),
    router,
  );
  return { app, router, tenantStatusGate };
}

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

describe('createAiProxyPolicyGate (F2)', () => {
  it('demo runtime OFF: anonymous request to a demo-declared path → 401', async () => {
    const { app } = makeApp({ demo: false });
    const res = await request(app).get('/api/ai/proxy/providers');
    expect(res.status).toBe(401);
  });

  it('demo runtime ON: anonymous demo-declared path passes without auth', async () => {
    const { app } = makeApp({ demo: true });
    const res = await request(app).post('/api/ai/proxy/mapping/suggestions').send({});
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('demo runtime ON: anonymous NON-demo path still → 401 (no family-wide leak)', async () => {
    const { app } = makeApp({ demo: true });
    const res = await request(app).post('/api/ai/proxy/orchestrate').send({});
    expect(res.status).toBe(401);
  });

  it('demo runtime ON: subtree descendants, near-misses, and undeclared methods → 401 (exact allowlist)', async () => {
    const { app } = makeApp({ demo: true });
    for (const [method, path] of [
      ['post', '/api/ai/proxy/mapping/suggestions/extra'],   // descendant of a demo path
      ['get', '/api/ai/proxy/providers/openai'],             // not /providers, not /:id/test
      ['get', '/api/ai/proxy/mcp/tools/extra'],              // descendant of /mcp/tools
      ['post', '/api/ai/proxy/suggestions/s-1/reject'],      // only /:id/accept is declared
      ['get', '/api/ai/proxy/mapping/schemas'],              // param segment is REQUIRED
      ['delete', '/api/ai/proxy/providers'],                 // method not declared
      ['put', '/api/ai/proxy/mcp'],                          // method not declared
    ] as const) {
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).toBe(401);
    }
  });

  it('every DEMO_EXACT_ALLOWLIST entry is covered by a hosted_demo_public policy (table↔manifest lockstep)', async () => {
    const { DEMO_EXACT_ALLOWLIST } = await import('../../../src/middleware/aiProxyPolicyGate');
    const { resolveRoutePolicy } = await import('../../../src/middleware/setup/routePolicy');
    for (const entry of DEMO_EXACT_ALLOWLIST) {
      // Build a representative concrete path from the pattern by replacing
      // param wildcards with a literal segment.
      const sample = entry.pattern.source
        .replace(/^\^/, '').replace(/\$$/, '')
        .replace(/\[\^\/\]\+/g, 'sample')
        .replace(/\(([a-z]+)\|[a-z|]+\)/g, '$1')
        .replace(/\\\//g, '/');
      for (const method of entry.methods) {
        const p = resolveRoutePolicy(`/api/ai/proxy${sample}`, method);
        expect(p?.auth).toBe('hosted_demo_public');
      }
    }
  });

  it('demo runtime ON: a PRESENTED credential forces the auth path even on a demo path', async () => {
    const gateImpl = jest.fn(async (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'tenant_blocked' });
    });
    const { app } = makeApp({ demo: true, gateImpl });
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 't-suspended', roles: ['user'] });
    const res = await request(app)
      .post('/api/ai/proxy/mapping/suggestions')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_blocked');
  });

  it('demo runtime ON: an INVALID credential on a demo path → 401, not anonymous fallback', async () => {
    const { app } = makeApp({ demo: true });
    const res = await request(app)
      .post('/api/ai/proxy/mapping/suggestions')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({});
    expect(res.status).toBe(401);
  });

  it('demo path: oversized parsed body → 413 even when Content-Length lies (header-independent)', async () => {
    const spoofApp = (() => {
      const tenantStatusGate = jest.fn(async (_req: any, _res: any, next: any) => next());
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      // Simulate a chunked/lying transport: the header says 10 bytes but the
      // parsed body is ~70KiB. Enforcement must measure the BODY, not the header.
      app.use((req, _res, next) => { req.headers['content-length'] = '10'; next(); });
      app.use(
        '/api/ai/proxy',
        createAiProxyPolicyGate({ tenantStatusGate: tenantStatusGate as any, isDemoRuntime: () => true }),
        (_req, res) => { res.json({ reached: true }); },
      );
      return app;
    })();
    const res = await request(spoofApp)
      .post('/api/ai/proxy/mapping/suggestions')
      .send({ pad: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('demo_payload_too_large');
  });

  it('platform_admin policy: ordinary tenant JWT → 403; admin-role JWT passes', async () => {
    const { app, tenantStatusGate } = makeApp({ demo: false });
    const tenantToken = signToken({ id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    const denied = await request(app)
      .put('/api/ai/proxy/provider-config')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ mode: 'cloud-api' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Platform administrator access required');

    const adminToken = signToken({ id: 'a1', username: 'a1', tenantId: 't-1', roles: ['admin'] });
    const allowed = await request(app)
      .put('/api/ai/proxy/provider-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'cloud-api' });
    expect(allowed.status).toBe(200);
    expect(tenantStatusGate).not.toHaveBeenCalled();
  });

  it('auth path: valid tenant JWT runs the tenant status gate then proceeds', async () => {
    const { app, tenantStatusGate } = makeApp({ demo: false });
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 't-1', roles: ['user'] });
    const res = await request(app)
      .get('/api/ai/proxy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(tenantStatusGate).toHaveBeenCalled();
  });

  it('anonymous demo path skips the tenant status gate (no tenant to check)', async () => {
    const { app, tenantStatusGate } = makeApp({ demo: true });
    await request(app).get('/api/ai/proxy/mcp/tools');
    expect(tenantStatusGate).not.toHaveBeenCalled();
  });
});

describe('createDemoFamilyPolicyGate (F5 generalization)', () => {
  const actionDemoAllowlist = [{ methods: ['POST'] as const, pattern: /^\/request-w9$/ }];

  it('treats a non-empty x-api-key header as presented credentials on a demo allowlist path', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/actions',
      demo: true,
      demoAllowlist: actionDemoAllowlist,
    });

    const res = await request(app)
      .post('/api/actions/request-w9')
      .set('x-api-key', 'presented-key')
      .send({});

    expect(res.status).toBe(401);
    expect(router).not.toHaveBeenCalled();
  });

  it('treats a non-empty api_key query parameter as presented credentials on a demo allowlist path', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/actions',
      demo: true,
      demoAllowlist: actionDemoAllowlist,
    });

    const res = await request(app).post('/api/actions/request-w9?api_key=presented-key').send({});

    expect(res.status).toBe(401);
    expect(router).not.toHaveBeenCalled();
  });

  it('treats presence of an empty api_key query parameter as presented credentials', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/actions',
      demo: true,
      demoAllowlist: actionDemoAllowlist,
    });

    const res = await request(app).post('/api/actions/request-w9?api_key=').send({});

    expect(res.status).toBe(401);
    expect(router).not.toHaveBeenCalled();
  });

  it('allows an anonymous public route without demo runtime or an allowlist entry', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/cost-transparency',
      demo: false,
      demoAllowlist: [],
    });

    const res = await request(app).get('/api/cost-transparency/health');

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
    expect(router).toHaveBeenCalled();
  });

  it('allows a public route when a garbage Bearer credential is presented', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/cost-transparency',
      demo: false,
      demoAllowlist: [],
    });

    const res = await request(app)
      .get('/api/cost-transparency/health')
      .set('Authorization', 'Bearer not-a-jwt');

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
    expect(router).toHaveBeenCalled();
  });

  it('still requires authentication for a non-public route in the same family', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/cost-transparency',
      demo: false,
      demoAllowlist: [],
    });

    const res = await request(app).get('/api/cost-transparency/dashboard');

    expect(res.status).toBe(401);
    expect(router).not.toHaveBeenCalled();
  });

  it('uses the injected demo allowlist instead of the AI proxy module constant', async () => {
    const { app, router } = makeFamilyApp({
      mountPath: '/api/ai/proxy',
      demo: true,
      demoAllowlist: [],
    });

    const res = await request(app).post('/api/ai/proxy/mapping/suggestions').send({});

    expect(res.status).toBe(401);
    expect(router).not.toHaveBeenCalled();
  });

  it('matches a stateful injected allowlist regex consistently across requests', async () => {
    const pattern = /^\/mapping\/suggestions$/g;
    const { app, router } = makeFamilyApp({
      mountPath: '/api/ai/proxy',
      demo: true,
      demoAllowlist: [{ methods: ['POST'], pattern }],
    });

    const first = await request(app).post('/api/ai/proxy/mapping/suggestions').send({});
    const lastIndexAfterFirst = pattern.lastIndex;
    const second = await request(app).post('/api/ai/proxy/mapping/suggestions').send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(router).toHaveBeenCalledTimes(2);
    expect(lastIndexAfterFirst).toBe(0);
    expect(pattern.lastIndex).toBe(0);
  });

  it('keeps createAiProxyPolicyGate parity with the existing demo allowlist', async () => {
    const { app } = makeApp({ demo: true });

    const res = await request(app).post('/api/ai/proxy/mapping/suggestions').send({});

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('treats an ARRAY-valued x-api-key header as presented credentials (per-element non-empty check)', () => {
    // Node's HTTP layer folds duplicate custom headers into one string, so the
    // Array.isArray branch is unreachable through supertest — pin the exported
    // predicate directly.
    const base = { query: {}, auth: undefined, user: undefined, tenantContext: undefined };
    expect(
      hasPresentedIdentity({ ...base, headers: { 'x-api-key': ['', 'real-key'] } } as never),
    ).toBe(true);
    expect(
      hasPresentedIdentity({ ...base, headers: { 'x-api-key': ['', '   '] } } as never),
    ).toBe(false);
  });

  it('demo path: an unserializable parsed body fails closed as oversized → 413', async () => {
    const tenantStatusGate = jest.fn(async (_req: any, _res: any, next: any) => next());
    const router = jest.fn((_req: express.Request, res: express.Response) => {
      res.json({ reached: true });
    });
    const app = express();
    // No json parser: install a circular req.body directly, upstream of the gate,
    // so parsedBodyBytes' JSON.stringify throws (→ POSITIVE_INFINITY, fail closed).
    app.use((req, _res, next) => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      (req as express.Request & { body: unknown }).body = circular;
      next();
    });
    app.use(
      '/api/ai/proxy',
      createDemoFamilyPolicyGate({
        tenantStatusGate: tenantStatusGate as any,
        isDemoRuntime: () => true,
        demoAllowlist: [{ methods: ['POST'], pattern: /^\/mapping\/suggestions$/ }],
      }),
      router,
    );

    const res = await request(app).post('/api/ai/proxy/mapping/suggestions').send();

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('demo_payload_too_large');
    expect(router).not.toHaveBeenCalled();
  });
});

describe('anonymous demo attestation (F5b)', () => {
  const actionDemoAllowlist = [{ methods: ['POST'] as const, pattern: /^\/request-w9$/ }];

  function makeAttestationApp(opts: {
    mountPath: string;
    demo: boolean;
    demoAllowlist?: readonly { methods: readonly ('GET' | 'HEAD' | 'POST')[]; pattern: RegExp }[];
  }) {
    const tenantStatusGate = jest.fn(async (_req: any, _res: any, next: any) => next());
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(
      opts.mountPath,
      createDemoFamilyPolicyGate({
        tenantStatusGate: tenantStatusGate as any,
        isDemoRuntime: () => opts.demo,
        demoAllowlist: opts.demoAllowlist ?? [],
      }),
      (req: express.Request, res: express.Response) => {
        res.json({ attested: isDemoAnonymousAdmitted(req) });
      },
    );
    return { app, tenantStatusGate };
  }

  it('is set when the gate admits the anonymous demo branch', async () => {
    const { app } = makeAttestationApp({
      mountPath: '/api/actions',
      demo: true,
      demoAllowlist: actionDemoAllowlist,
    });

    const res = await request(app).post('/api/actions/request-w9').send({});

    expect(res.status).toBe(200);
    expect(res.body.attested).toBe(true);
  });

  it('is NOT set on the authenticated path', async () => {
    const { app } = makeAttestationApp({
      mountPath: '/api/actions',
      demo: true,
      demoAllowlist: actionDemoAllowlist,
    });
    const token = signToken({ sub: 'user-1', tenantId: 'tenant-a', roles: ['user'] });

    const res = await request(app)
      .post('/api/actions/request-w9')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.attested).toBe(false);
  });

  it('is NOT set on a `public` policy path', async () => {
    // The public branch short-circuits before the demo branch ever runs.
    const { app } = makeAttestationApp({
      mountPath: '/api/cost-transparency',
      demo: true,
      demoAllowlist: [],
    });

    const res = await request(app).get('/api/cost-transparency/health');

    expect(res.status).toBe(200);
    expect(res.body.attested).toBe(false);
  });

  it('is NOT set when the demo runtime is off', async () => {
    const { app } = makeAttestationApp({
      mountPath: '/api/actions',
      demo: false,
      demoAllowlist: actionDemoAllowlist,
    });

    const res = await request(app).post('/api/actions/request-w9').send({});

    expect(res.status).toBe(401);
  });
});
