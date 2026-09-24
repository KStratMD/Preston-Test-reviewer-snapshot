// tests/integration/embeddedHtmlCspGuard.routes.test.ts
/**
 * Cross-surface proof that the root express.static handler no longer shadows the
 * CSP-routed embedded HTML pages. Reproduces production wiring order: the
 * skip-wrapped static is registered FIRST (as in MiddlewareSetup), then the
 * CSP-wrapped route handlers (as in RouteSetup). Uses the real public/ dir so
 * the embedded files exist on disk.
 */
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { skipEmbeddedHtml } from '../../src/middleware/embeddedHtmlRoutes';
import { embeddedCspMiddleware, sessionExpiredHandler } from '../../src/middleware/embeddedCspMiddleware';
import { sendEmbeddedHtml } from '../../src/middleware/embeddedHtmlHandler';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const HOST = 'app.example.com';

// The four disk-backed CSP-routed pages (served via sendEmbeddedHtml).
const DISK_BACKED_CSP_PAGES = [
  'reconciliation.html',
  'approvals.html',
  'lineage.html',
  'sync-error-triage.html',
] as const;

function buildApp(): express.Express {
  const app = express();
  app.use(skipEmbeddedHtml(express.static(PUBLIC_DIR, { index: false })));
  for (const page of DISK_BACKED_CSP_PAGES) {
    app.get(`/embedded/${page}`, embeddedCspMiddleware, sendEmbeddedHtml(page));
  }
  app.get('/embedded/session-expired.html', embeddedCspMiddleware, sessionExpiredHandler);
  return app;
}

describe('embedded HTML CSP guard (cross-surface)', () => {
  const app = buildApp();

  it.each(DISK_BACKED_CSP_PAGES)('serves disk-backed %s WITH the CSP frame-ancestors header', async (page) => {
    const res = await request(app).get(`/embedded/${page}`).set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors/);
  });

  it('covers the string-served session-expired.html (no disk file)', async () => {
    const res = await request(app).get('/embedded/session-expired.html').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors/);
  });

  it('still serves embedded JS as a static asset (no CSP punt)', async () => {
    const res = await request(app).get('/embedded/reconciliation.js').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('leaves host-reference.html as a plain static file (dev-only exemption)', async () => {
    const res = await request(app).get('/embedded/host-reference.html').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
