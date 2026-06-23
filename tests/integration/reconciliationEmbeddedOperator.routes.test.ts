/**
 * Integration: the embedded reconciliation HTML page must be served through
 * embeddedCspMiddleware so it carries the frame-ancestors gate (mirrors the
 * sync-error-triage CSP coverage). Uses a SCOPED app that mounts only the HTML
 * route exactly as RouteSetup does — no express.static — so the test verifies
 * the CSP wiring without the unrelated static-shadowing of /embedded/*.html.
 */
import express from 'express';
import request from 'supertest';
import { embeddedCspMiddleware } from '../../src/middleware/embeddedCspMiddleware';
import { sendEmbeddedHtml } from '../../src/middleware/embeddedHtmlHandler';

const HOST = 'app.example.com';

describe('GET /embedded/reconciliation.html', () => {
  let app: express.Express;
  beforeAll(() => {
    app = express();
    app.get(
      '/embedded/reconciliation.html',
      embeddedCspMiddleware,
      sendEmbeddedHtml('reconciliation.html'),
    );
  });

  it('emits the embedded CSP frame-ancestors header', async () => {
    const res = await request(app)
      .get('/embedded/reconciliation.html')
      .set('Host', HOST);
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/frame-ancestors\s+https:\/\/\*\.netsuite\.com\s+https:\/\/\*\.dynamics\.com/);
  });
});
