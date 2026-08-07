// tests/integration/syncErrorAssistMiddleware.integration.test.ts
import request from 'supertest';

import { resetTenantPostAuthLimiterForTest } from '../../src/routes/syncErrorAssistRoutes';
// R18-4 — `container` + `Logger` are needed by the pre-auth IP rate-limit log-shape test
// below; without these imports tsconfig.test.json fails the file.
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { Logger } from '../../src/utils/Logger';

describe('sync-error-assist middleware chain (Task 11)', () => {
  // R10-4 / R21-1 — Task 13 Step 0 (the integration helper module) MUST land before this test runs.
  // Recommended implementation order: T10 Step 0 + T11 Step 0 (seam-export stubs) → T13 Step 0 (helper extension) →
  // T11 Steps 1–5 (this test + mounts middleware + writes real seam bodies) → T13 Step 1+ (full integration suite) → T10 Steps 1–4 (route).
  //
  // R11-3 — these tests MUST exercise the production `MiddlewareSetup` class so a regression
  // there fails the test. `buildIntegrationApp()` rolls its own middleware chain by hand;
  // for THIS file we instead build an app via the production `new MiddlewareSetup(app, config)`
  // path so the assertions cover what ships, not a hand-rolled mirror.
  let app: import('express').Express;

  beforeEach(async () => {
    resetTenantPostAuthLimiterForTest();
    // R15-3 — Both IP-limiter resets needed in tests that exercise the production
    // setupMiddleware() chain: `…ForTest` swaps a fresh-counter limiter (clears the
    // per-IP 30/min store), and `…DepsForTest` clears the cached metrics/logger DI
    // promise. Without the first, AC #7 (31st request → 429) becomes order-dependent
    // across the 413 / Buffer-type sibling tests in this describe block.
    const middlewareSetup = await import('../../src/middleware/setup/MiddlewareSetup');
    middlewareSetup.resetIpPreAuthLimiterForTest();
    middlewareSetup.resetIpPreAuthLimiterDepsForTest();
    const express = (await import('express')).default;
    app = express();
    // R12-1 — `new MiddlewareSetup(...)` ONLY stores config; the actual middleware mounts
    // happen inside `setupAll()` (which calls `setupBasicMiddleware()` and the IP-limiter
    // chain we add in Step 3). Use the `setupMiddleware` convenience export — it constructs
    // + awaits `setupAll()` in one call — and pass a real `MiddlewareConfig` (every field is
    // optional, so no `as any` needed). Disable global cors/helmet/compression/rateLimit so
    // the test stays focused on the sync-error-assist limiter + raw parser added inside
    // `setupBasicMiddleware()`. `setupStaticFiles` + `setupDocumentationRedirects` always
    // run but only respond to GET, so POST /api/sync-error-assist/ingest is unaffected.
    const { setupMiddleware } = middlewareSetup;
    const config: import('../../src/middleware/setup/MiddlewareSetup').MiddlewareConfig = {
      enableCors: false,
      enableHelmet: false,
      enableCompression: false,
      enableRateLimit: false,
    };
    await setupMiddleware(app, config);
    // mount the syncErrorAssistRoutes after setupAll() so the production chain (incl. the
    // sync-error-assist pre-auth IP limiter + raw parser) is in place when requests resolve.
    const { syncErrorAssistRoutes } = await import('../../src/routes/syncErrorAssistRoutes');
    app.use(syncErrorAssistRoutes);
  });

  it('AC #8 — body >256kb returns 413 BEFORE HMAC verification', async () => {
    const big = Buffer.alloc(257 * 1024, 'a').toString();
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', 'acme')
      .set('x-suitecentral-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('x-suitecentral-signature', 'a'.repeat(64))
      .send(big);
    expect(res.status).toBe(413);
  });

  it('AC #7 — pre-auth IP limiter triggers at 31 requests/min', async () => {
    let last429 = 0;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .send('{}');
      if (res.status === 429) last429 = i;
    }
    expect(last429).toBeGreaterThanOrEqual(30);   // 31st request must be 429
  });

  it('R18-4 — pre-auth IP rate-limited warn log includes correlationId (spec §7.1 contract)', async () => {
    // R18-4 — Sibling to R17-5's post-auth tenant-limiter coverage. The pre-auth IP limiter
    // runs BEFORE the route handler can mint a correlationId, so it mints one in the limiter
    // handler itself (see `createIpPreAuthLimiter()` in MiddlewareSetup.ts). Spec §7.1 requires
    // every "webhook validation failed" warn to carry `correlationId, reason, tenantId` — this
    // test pins the canonical shape for the pre-auth path.
    const logger = await container.getAsync<Logger>(TYPES.Logger);
    const warnSpy = jest.spyOn(logger, 'warn');
    try {
      for (let i = 0; i < 31; i++) {
        await request(app).post('/api/sync-error-assist/ingest')
          .set('Content-Type', 'application/json')
          .send('{}');
      }
      expect(warnSpy).toHaveBeenCalledWith(
        'webhook validation failed',
        expect.objectContaining({
          correlationId: expect.any(String),
          reason: 'rate_limited',
          tenantId: 'unknown',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('R5-4 + R11-3 + R12-1 — req.body arrives at the route as a Buffer (raw parser mounted before express.json by MiddlewareSetup)', async () => {
    // Build a fresh app via the REAL middleware setup so the assertion covers production
    // ordering, not a hand-rolled mirror. `new MiddlewareSetup(...)` alone only stores config —
    // mounts happen inside `setupAll()`. Use the `setupMiddleware` convenience export
    // (constructor + await setupAll() in one call) and pass a real `MiddlewareConfig`
    // (every field optional, no `as any`). Disable global cors/helmet/compression/rateLimit;
    // the assertion only depends on the sync-error-assist raw parser ordering inside
    // `setupBasicMiddleware()`. Mount a debug echo route AFTER setupAll() so the request
    // body's type can be inspected.
    const express = (await import('express')).default;
    const debugApp = express();
    const { setupMiddleware } = await import('../../src/middleware/setup/MiddlewareSetup');
    const config: import('../../src/middleware/setup/MiddlewareSetup').MiddlewareConfig = {
      enableCors: false,
      enableHelmet: false,
      enableCompression: false,
      enableRateLimit: false,
    };
    await setupMiddleware(debugApp, config);
    debugApp.post('/api/sync-error-assist/ingest', (req, res) => {
      res.status(200).json({
        isBuffer: Buffer.isBuffer(req.body),
        byteLength: Buffer.isBuffer(req.body) ? req.body.length : null,
      });
    });

    const res = await request(debugApp).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .send('{"hello":"world"}');
    expect(res.status).toBe(200);
    expect(res.body.isBuffer).toBe(true);
    expect(res.body.byteLength).toBe(17);          // length of '{"hello":"world"}' as UTF-8 bytes
  });
});
