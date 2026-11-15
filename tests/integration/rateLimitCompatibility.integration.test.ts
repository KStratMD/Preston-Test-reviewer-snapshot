import express from 'express';
import request from 'supertest';
import {
  resetIpPreAuthLimiterForTest,
  resetIpPreAuthLimiterDepsForTest,
  setupMiddleware,
} from '../../src/middleware/setup/MiddlewareSetup';
import { enhancedRateLimit } from '../../src/middleware/validation';

describe('rate-limit migration at production middleware boundaries', () => {
  it('groups IPv6 /56 addresses in the real pre-auth middleware mount', async () => {
    resetIpPreAuthLimiterForTest();
    resetIpPreAuthLimiterDepsForTest();
    const app = express();
    await setupMiddleware(app, {
      enableCors: false,
      enableHelmet: false,
      enableCompression: false,
      enableRateLimit: false,
    });
    // Synthetic loopback proxy supplies req.ip to the actual pre-auth limiter.
    // This does not change or claim to test production proxy configuration.
    app.set('trust proxy', 'loopback');
    const path = '/api/sync-error-assist/ingest';
    // Terminal fixture after the real middleware; HMAC/tenant handling is
    // exercised separately by the existing webhook integration suite.
    app.post(path, (_req, res) => { res.sendStatus(204); });
    for (let i = 0; i < 30; i++) {
      await request(app).post(path).set('X-Forwarded-For', '2001:db8:aaaa:bb01::1').expect(204);
    }
    const blocked = await request(app).post(path)
      .set('X-Forwarded-For', '2001:db8:aaaa:bb02::1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    await request(app).post(path).set('X-Forwarded-For', '2001:db8:aaaa:bc01::1').expect(204);
  });

  it('emits legacy and draft-6 headers from validation.ts middleware', async () => {
    const app = express();
    // Avoid the existing test-only /api exemption so the actual limiter runs.
    app.post('/validation-headers', enhancedRateLimit, (_req, res) => { res.sendStatus(204); });
    const response = await request(app).post('/validation-headers').expect(204);
    expect(Number(response.headers['ratelimit-limit'])).toBeGreaterThan(0);
    expect(response.headers['x-ratelimit-limit']).toBe(response.headers['ratelimit-limit']);
    expect(response.headers['x-ratelimit-remaining']).toBe(response.headers['ratelimit-remaining']);
    const absoluteReset = Number(response.headers['x-ratelimit-reset']);
    const remainingSeconds = Number(response.headers['ratelimit-reset']);
    expect(Number.isFinite(absoluteReset)).toBe(true);
    expect(Number.isFinite(remainingSeconds)).toBe(true);
    expect(remainingSeconds).toBeGreaterThanOrEqual(0);
    expect(absoluteReset).toBeGreaterThan(remainingSeconds);
  });
});
