// A6 — the global limiter through the REAL setupMiddleware composition.
//
// The unit suite proves the matcher; this proves the limiter is actually
// wired to it and that an ordinary route now returns 429. That distinction
// matters here more than usual: before A6 the matcher logic "worked" in the
// sense that it ran, and every request still sailed through, because '/' was
// a startsWith prefix. Only an end-to-end request can catch that class of
// defect, so these tests go through `setupMiddleware`, not a hand-rolled chain.
//
// Env is read at module scope (DEFAULT_CONFIG calls isHostedDemo(), and the
// request handler reads env.HOSTED_DEMO), so each mode resets the module
// registry and re-imports rather than mutating a live binding.

import request from 'supertest';

const ORIGINAL_ENV = { ...process.env };

async function buildApp(opts: {
  hosted: boolean;
  demo?: boolean;
  maxRequests?: number;
  rateLimitEnabled?: boolean;
}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.HOSTED_DEMO = opts.hosted ? 'true' : 'false';
  process.env.RATE_LIMIT_ENABLED = (opts.rateLimitEnabled ?? true) ? 'true' : 'false';
  // isDemoMode() compares DEMO_MODE to the literal '1' — 'true' does NOT
  // enable demo mode. Setting the wrong spelling here would make the bypass
  // test silently assert nothing.
  if (opts.demo !== undefined) process.env.DEMO_MODE = opts.demo ? '1' : '0';

  const express = (await import('express')).default;
  const { setupMiddleware } = await import('../../src/middleware/setup/MiddlewareSetup');
  const app = express();
  await setupMiddleware(app, {
    enableCors: false,
    enableHelmet: false,
    enableCompression: false,
    enableRateLimit: true,
    rateLimitOptions: {
      windowMs: 60 * 1000,
      maxRequests: opts.maxRequests ?? 2,
    },
  });

  // Ordinary, non-exempt routes plus the specific paths the policy table names.
  for (const p of [
    '/api/configurations',
    '/api/integrations',
    '/publicity',
    '/vendor/app.js',
    '/index.html',
    '/health',
    '/',
  ]) {
    app.get(p, (_req, res) => { res.status(200).json({ ok: true, path: p }); });
  }
  return app;
}

afterAll(() => { process.env = { ...ORIGINAL_ENV }; });

describe('global rate limiter — hosted', () => {
  it('returns 429 with rate-limit headers on the third request to an ordinary route (limit 2)', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.10';

    const first = await request(app).get('/api/configurations').set('X-Real-IP', ip);
    const second = await request(app).get('/api/configurations').set('X-Real-IP', ip);
    const third = await request(app).get('/api/configurations').set('X-Real-IP', ip);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The assertion the whole PR exists for: before A6 this was 200, because
    // the '/' prefix exempted every path.
    expect(third.status).toBe(429);
    expect(third.headers).toHaveProperty('ratelimit-limit');
    expect(third.headers).toHaveProperty('x-ratelimit-limit');
  });

  it('leaves an exact HTML entry point and a static prefix unmetered past the limit', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.11';
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/index.html').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/vendor/app.js').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/health').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
  });

  it('meters /publicity — the static prefix is boundary-aware, not startsWith', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.12';
    await request(app).get('/publicity').set('X-Real-IP', ip);
    await request(app).get('/publicity').set('X-Real-IP', ip);
    const third = await request(app).get('/publicity').set('X-Real-IP', ip);
    expect(third.status).toBe(429);
  });

  it('meters /api/integrations when hosted — no broad /api/* exclusions in hosted', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.13';
    await request(app).get('/api/integrations').set('X-Real-IP', ip);
    await request(app).get('/api/integrations').set('X-Real-IP', ip);
    const third = await request(app).get('/api/integrations').set('X-Real-IP', ip);
    expect(third.status).toBe(429);
  });

  it('meters the root path — / is no longer exempt', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.14';
    await request(app).get('/').set('X-Real-IP', ip);
    await request(app).get('/').set('X-Real-IP', ip);
    const third = await request(app).get('/').set('X-Real-IP', ip);
    expect(third.status).toBe(429);
  });
});

describe('global rate limiter — non-hosted', () => {
  it('preserves the /api/integrations exemption when not hosted', async () => {
    const app = await buildApp({ hosted: false, demo: false, maxRequests: 2 });
    const ip = '203.0.113.20';
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/integrations').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
  });

  it('still meters an ordinary non-API route when not hosted', async () => {
    const app = await buildApp({ hosted: false, demo: false, maxRequests: 2 });
    const ip = '203.0.113.21';
    await request(app).get('/publicity').set('X-Real-IP', ip);
    await request(app).get('/publicity').set('X-Real-IP', ip);
    const third = await request(app).get('/publicity').set('X-Real-IP', ip);
    expect(third.status).toBe(429);
  });
});

describe('global rate limiter — demo bypass is preserved in full', () => {
  it('short-circuits entirely when isDemo() && !HOSTED_DEMO', async () => {
    const app = await buildApp({ hosted: false, demo: true, maxRequests: 2 });
    const ip = '203.0.113.30';
    // Well past the limit on an ordinary route: the bypass runs before any
    // matching, so nothing is metered.
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get('/api/configurations').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
  });
});

describe('global rate limiter — client identity is per-client, not per-proxy', () => {
  // Without these, an IP-keyed limiter behind Railway could silently collapse
  // every client into one bucket (a global limit) or let a client mint
  // unlimited buckets. Neither shows up in a "does it 429?" test.

  it('gives two different X-Real-IP values INDEPENDENT buckets', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    // Exhaust client A.
    await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.50');
    await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.50');
    const aThird = await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.50');
    expect(aThird.status).toBe(429);

    // Client B is unaffected — this is what fails if everyone shares the
    // proxy's socket address.
    const bFirst = await request(app).get('/api/configurations').set('X-Real-IP', '198.51.100.60');
    expect(bFirst.status).toBe(200);
  });

  it('exhausts exactly one bucket for repeated requests from one X-Real-IP', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 3 });
    const ip = '203.0.113.51';
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/configurations').set('X-Real-IP', ip)).status).toBe(200);
    }
    expect((await request(app).get('/api/configurations').set('X-Real-IP', ip)).status).toBe(429);
  });

  // NOTE on the shape of the next three tests. A "shared bucket" assertion
  // alone passes VACUOUSLY when keying is completely broken — if every client
  // collapses into one bucket, "the third request 429s" is true for the wrong
  // reason. Verified: with the key generator removed, only the two
  // independence tests above failed. So each of these pairs its shared-bucket
  // assertion with a contrast that must still get its own budget.

  it('CANNOT mint a new bucket by varying X-Forwarded-For, though X-Real-IP still can', async () => {
    // The forgery path. XFF is client-controlled; if identity derived from it,
    // rotating it would reset the budget on every request.
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    const ip = '203.0.113.52';
    await request(app).get('/api/configurations').set('X-Real-IP', ip).set('X-Forwarded-For', '1.1.1.1');
    await request(app).get('/api/configurations').set('X-Real-IP', ip).set('X-Forwarded-For', '2.2.2.2');
    const third = await request(app)
      .get('/api/configurations').set('X-Real-IP', ip).set('X-Forwarded-For', '3.3.3.3');
    expect(third.status).toBe(429);

    // Contrast: identity DOES track X-Real-IP, so this is not just one global
    // bucket swallowing everything.
    const other = await request(app)
      .get('/api/configurations').set('X-Real-IP', '203.0.113.99').set('X-Forwarded-For', '3.3.3.3');
    expect(other.status).toBe(200);
  });

  it('treats an IPv4-mapped IPv6 address as the same client as the plain IPv4', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.53');
    await request(app).get('/api/configurations').set('X-Real-IP', '::ffff:203.0.113.53');
    const third = await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.53');
    expect(third.status).toBe(429);

    // Contrast: an unrelated address is untouched.
    expect((await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.54')).status)
      .toBe(200);
  });

  it('shares one bucket across addresses in the SAME IPv6 /64', async () => {
    // The rotation bypass: express-rate-limit 7.5.1 has no ipKeyGenerator, so
    // without masking each address here would get its own budget.
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:bbbb::1');
    await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:bbbb::2');
    const third = await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:bbbb::3');
    expect(third.status).toBe(429);

    // Contrast: an IPv4 client is unaffected, so this is real aggregation and
    // not a single global bucket.
    expect((await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.55')).status)
      .toBe(200);
  });

  it('gives DIFFERENT IPv6 /64s independent buckets', async () => {
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:cccc::1');
    await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:cccc::2');
    expect((await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:cccc::3')).status)
      .toBe(429);
    // A neighbouring /64 is a different customer and must not be punished.
    expect((await request(app).get('/api/configurations').set('X-Real-IP', '2001:db8:aaaa:dddd::1')).status)
      .toBe(200);
  });

  it('falls back to ONE conservative shared bucket for missing or malformed X-Real-IP', async () => {
    // A malformed header must not hand out a free budget per request.
    const app = await buildApp({ hosted: true, maxRequests: 2 });
    await request(app).get('/api/configurations').set('X-Real-IP', 'not-an-ip');
    await request(app).get('/api/configurations').set('X-Real-IP', 'also-garbage');
    const third = await request(app).get('/api/configurations'); // header absent entirely
    expect(third.status).toBe(429);

    // Contrast: a well-formed client still gets its own budget, so the
    // fallback is one shared bucket rather than a broken global one.
    expect((await request(app).get('/api/configurations').set('X-Real-IP', '203.0.113.56')).status)
      .toBe(200);
  });
});

describe('global rate limiter — initialization failures fail CLOSED where it is required', () => {
  // The catch in setupRateLimit was written for a missing optional dependency,
  // but it also swallowed every init/config error and continued unthrottled.
  // Once hosted/production is expected to mount the limiter, that path is the
  // original no-op reached by another route.

  async function buildWithBrokenLimiter(opts: { hosted: boolean }) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.HOSTED_DEMO = opts.hosted ? 'true' : 'false';
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.DEMO_MODE = '0';

    // The mock must fail at limiter CONSTRUCTION, not at module load.
    // MiddlewareSetup statically imports express-rate-limit at line 4, so a
    // factory that throws breaks that import instead — outside the try/catch
    // under test. The first version of this test did exactly that, and the
    // hosted case passed for the wrong reason.
    jest.doMock('express-rate-limit', () => ({
      __esModule: true,
      default: () => { throw new Error('simulated express-rate-limit initialization failure'); },
    }));

    const express = (await import('express')).default;
    const { setupMiddleware } = await import('../../src/middleware/setup/MiddlewareSetup');
    return setupMiddleware(express(), {
      enableCors: false,
      enableHelmet: false,
      enableCompression: false,
      enableRateLimit: true,
      rateLimitOptions: { windowMs: 60_000, maxRequests: 2 },
    });
  }

  afterEach(() => { jest.dontMock('express-rate-limit'); });

  it('REFUSES to start when hosted and the limiter cannot initialize', async () => {
    await expect(buildWithBrokenLimiter({ hosted: true })).rejects.toThrow(/simulated/);
  });

  it('still tolerates a missing limiter in local dev/test', async () => {
    // NODE_ENV=test and HOSTED_DEMO=false → not required → tolerant path.
    await expect(buildWithBrokenLimiter({ hosted: false })).resolves.toBeUndefined();
  });
});

describe('global rate limiter — test-environment limits', () => {
  it('honors a configured limit under NODE_ENV=test when rate limiting is enabled', async () => {
    // Guards the newly-metered '/': the E2E suite hits it repeatedly, and the
    // configured TEST_RATE_LIMIT_* budget is what keeps that from 429ing.
    expect(process.env.NODE_ENV).toBe('test');
    const app = await buildApp({ hosted: true, maxRequests: 4 });
    const ip = '203.0.113.40';
    for (let i = 0; i < 4; i++) {
      const res = await request(app).get('/').set('X-Real-IP', ip);
      expect(res.status).toBe(200);
    }
    const fifth = await request(app).get('/').set('X-Real-IP', ip);
    expect(fifth.status).toBe(429);
  });
});
