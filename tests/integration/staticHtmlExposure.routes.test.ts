import 'reflect-metadata';
import request from 'supertest';
import type express from 'express';
import { App } from '../../src/app';

/**
 * Pins the static-HTML exposure defects recorded as facts F8 and F9 in the
 * 2026-09-02 governed-assurance control-plane design spec (tranche-1 Workstream A).
 * The spec is named rather than linked: the reviewer-mirror reproducibility gate
 * treats a repo-relative path in this file as a file the test reads, and pulling an
 * internal planning doc into the public mirror to satisfy that would be the wrong fix.
 *
 *  - the customer-payment-portal.html demo page collected PAN/CVV, was served by
 *    the root `express.static` mount, and posted to a route that does not exist.
 *  - The 116-entry `htmlFiles` list only added no-cache headers; it restricted
 *    nothing, so every HTML file under `public/` was reachable, and a second list
 *    (`EXEMPT`) existed only to keep the sync gate quiet about the gap.
 *
 * The denial cases below name files that exist on disk, so a regression serves
 * them again rather than merely 404ing because the file is gone. The last three
 * guard against over-correction.
 */
describe('static HTML exposure', () => {
  let app: App;
  let expressApp: express.Application;

  beforeAll(async () => {
    app = new App();
    await app.waitForInitialization();
    expressApp = app.getExpressApp();
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it('does not serve the deleted customer payment portal from the root mount', async () => {
    expect((await request(expressApp).get('/customer-payment-portal.html')).status).toBe(404);
  });

  it('does not serve the deleted customer payment portal from the /public mount', async () => {
    expect((await request(expressApp).get('/public/customer-payment-portal.html')).status).toBe(404);
  });

  it('does not serve an unlisted top-level page that exists on disk', async () => {
    // public/metrics-viewer.html is present; it is deliberately absent from the
    // whitelist, and the EXEMPT bypass that used to reach it is retired.
    expect((await request(expressApp).get('/metrics-viewer.html')).status).toBe(404);
  });

  it('does not serve the superseded top-level vendor portal that exists on disk', async () => {
    // public/vendor-portal.html is present but unlisted; the live portal is the
    // nested vendor-portal/index.html asserted below.
    expect((await request(expressApp).get('/vendor-portal.html')).status).toBe(404);
  });

  it('does not serve a directory index through the /public mount', async () => {
    // Without index/redirect disabled, this served vendor-portal/index.html and
    // bypassed the HTML policy, because a directory request carries no extension.
    expect((await request(expressApp).get('/public/vendor-portal/')).status).toBe(404);
  });

  it('does not serve an unlisted page reached through a percent-encoded extension', async () => {
    // req.path is NOT decoded, so a policy that tests the raw path sees
    // ".%68tml", classifies it as non-HTML, and lets express.static decode it
    // back to metrics-viewer.html and serve it. That bypasses the whole control.
    expect((await request(expressApp).get('/metrics-viewer.%68tml')).status).toBe(404);
  });

  it('does not serve an unlisted page reached through encoded traversal out of an allowlisted directory', async () => {
    // "wiki" is the one bulk-allowlisted directory; encoded dot segments must not
    // let a request borrow that allowance and land on an unlisted page.
    expect([404, 400]).toContain((await request(expressApp).get('/wiki/%2e%2e/metrics-viewer.html')).status);
  });

  it('does not serve the deleted payment portal through a percent-encoded extension', async () => {
    expect((await request(expressApp).get('/customer-payment-portal.%68tml')).status).toBe(404);
  });

  it('still serves a nested page named in the whitelist', async () => {
    // vendor-portal/index.html is whitelisted and linked from the integration
    // hub; a directory-only policy would have denied it.
    expect((await request(expressApp).get('/vendor-portal/index.html')).status).toBe(200);
  });

  it('still serves a whitelisted page', async () => {
    const res = await request(expressApp).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('still serves non-HTML static assets from the root mount', async () => {
    expect([200, 304]).toContain((await request(expressApp).get('/js/platform-detector.js')).status);
  });
});
