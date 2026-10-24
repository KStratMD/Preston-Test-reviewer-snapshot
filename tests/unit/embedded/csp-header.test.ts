import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  embeddedCspMiddleware,
  EMBEDDED_CSP_POLICY,
  EMBEDDED_BOOTSTRAP_SHA256,
  EMBEDDED_SESSION_EXPIRED_SCRIPT_SHA256,
} from '../../../src/middleware/embeddedCspMiddleware';

function buildApp(): express.Express {
  const app = express();
  app.use(embeddedCspMiddleware);
  app.get('/test/embedded-route', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('embeddedCspMiddleware — CSP header drift tripwire', () => {
  it('emits the EXACT EMBEDDED_CSP_POLICY string', async () => {
    const app = buildApp();
    const response = await request(app).get('/test/embedded-route');
    expect(response.status).toBe(200);
    // Exact-string match — any silent policy mutation requires intentional re-stamp.
    expect(response.headers['content-security-policy']).toBe(EMBEDDED_CSP_POLICY);
  });

  it('frame-ancestors directive contains exactly NetSuite + BC origins', async () => {
    const app = buildApp();
    const response = await request(app).get('/test/embedded-route');
    const csp = response.headers['content-security-policy'] as string;
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-ancestors'));
    expect(directive).toBeDefined();
    expect(directive).toBe('frame-ancestors https://*.netsuite.com https://*.dynamics.com');
  });

  it('script-src includes BOTH the bootstrap-script hash AND the session-expired-script hash', async () => {
    const app = buildApp();
    const response = await request(app).get('/test/embedded-route');
    const csp = response.headers['content-security-policy'] as string;
    // Round-2 fix: the session-expired interstitial's inline reload-button
    // handler needs its hash in script-src or the browser blocks it.
    expect(csp).toContain(`'${EMBEDDED_BOOTSTRAP_SHA256}'`);
    expect(csp).toContain(`'${EMBEDDED_SESSION_EXPIRED_SCRIPT_SHA256}'`);
  });

  it('EMBEDDED_BOOTSTRAP_SHA256 is base64-shaped (sha256-<43chars>=)', () => {
    expect(EMBEDDED_BOOTSTRAP_SHA256).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });

  it('EMBEDDED_SESSION_EXPIRED_SCRIPT_SHA256 is base64-shaped', () => {
    expect(EMBEDDED_SESSION_EXPIRED_SCRIPT_SHA256).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });
});
