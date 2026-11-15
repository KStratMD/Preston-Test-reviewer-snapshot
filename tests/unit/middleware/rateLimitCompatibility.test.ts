import express, { type RequestHandler } from 'express';
import request from 'supertest';
import {
  authRateLimit,
  createAiDemoRateLimit,
  createMcpSchemaRateLimit,
  createTestingRunRateLimit,
} from '../../../src/middleware/rateLimit';

function appFor(limiter: RequestHandler, missingAddress = false) {
  const app = express();
  // Only this synthetic app trusts its loopback test client. Production proxy
  // policy is exercised separately through the real MiddlewareSetup tests.
  app.set('trust proxy', 'loopback');
  app.use((req, _res, next) => {
    // Synthetic authenticated identity, not a production authentication path.
    const userId = req.get('x-test-user');
    if (userId) Object.defineProperty(req, 'user', { value: { id: userId } });
    if (missingAddress) {
      Object.defineProperty(req, 'ip', { value: undefined });
      Object.defineProperty(req.socket, 'remoteAddress', { value: undefined });
    }
    next();
  });
  app.post('/work', limiter, (req, res) => {
    res.status(req.get('x-test-failure') ? 400 : 200).json({ ok: true });
  });
  return app;
}

function hit(app: express.Express, ip: string, user = 'user-a') {
  return request(app).post('/work').set('X-Forwarded-For', ip).set('x-test-user', user);
}

describe('real rate limiter compatibility', () => {
  beforeAll(() => { jest.useRealTimers(); });
  afterAll(() => { jest.useFakeTimers(); });

  it('constructs both custom-key factories without the IPv6 fallback diagnostic', () => {
    // The package catches and logs validation errors. Capture BEFORE creating
    // the instances: the diagnostic self-disables after its first invocation.
    const errors = jest.spyOn(console, 'error');
    try {
      createTestingRunRateLimit();
      createMcpSchemaRateLimit();
      const ipv6Diagnostics = errors.mock.calls.flat().filter((error: unknown) =>
        typeof error === 'object' && error !== null &&
        'code' in error && error.code === 'ERR_ERL_KEY_GEN_IPV6');
      expect(ipv6Diagnostics).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('shares the custom-key budget across one user rotating within an IPv6 /64', async () => {
    const app = appFor(createTestingRunRateLimit());
    for (let i = 1; i <= 10; i++) {
      await hit(app, `2001:db8:aaaa:bbbb::${i.toString(16)}`).expect(200);
    }
    const blocked = await hit(app, '2001:db8:aaaa:bbbb::ff');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('Too Many Requests');
    expect(Number.isFinite(Number(blocked.headers['retry-after']))).toBe(true);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(blocked.body.resetTime))).toBe(true);
    expect(blocked.body.used).toBe(11);
  });

  it('keeps different users and neighboring /64s separate in a custom-key budget', async () => {
    const app = appFor(createTestingRunRateLimit());
    for (let i = 0; i < 10; i++) await hit(app, '2001:db8:aaaa:bb01::1').expect(200);
    await hit(app, '2001:db8:aaaa:bb01::1').expect(429);
    await hit(app, '2001:db8:aaaa:bb01::1', 'user-b').expect(200);
    // Same /56 but a different /64: explicit custom-key policy stays /64.
    await hit(app, '2001:db8:aaaa:bb02::1').expect(200);
  });

  it.each(['::ffff:203.0.113.9', '::ffff:cb00:7109'])(
    'treats mapped IPv4 %s as the same custom-key client', async (mapped) => {
      const app = appFor(createTestingRunRateLimit());
      for (let i = 0; i < 10; i++) await hit(app, '203.0.113.9').expect(200);
      await hit(app, mapped).expect(429);
      await hit(app, '203.0.113.10').expect(200);
    },
  );

  it('keeps a stable custom-key bucket when both address sources are absent', async () => {
    const app = appFor(createTestingRunRateLimit(), true);
    for (let i = 0; i < 10; i++) await hit(app, `203.0.113.${i + 1}`).expect(200);
    await hit(app, '198.51.100.1').expect(429);
    await hit(app, '198.51.100.1', 'user-b').expect(200);
  });

  it('keeps the MCP budget IP-only while grouping rotating IPv6 addresses', async () => {
    const app = appFor(createMcpSchemaRateLimit());
    for (let i = 0; i < 30; i++) await hit(app, '2001:db8:aaaa:bb01::1').expect(200);
    await hit(app, '2001:db8:aaaa:bb01::1', 'user-b').expect(429);
    await hit(app, '2001:db8:aaaa:bb01::2', 'user-c').expect(429);
    await hit(app, '2001:db8:aaaa:bb02::1', 'user-c').expect(200);
  });

  it('uses upstream /56 grouping for the default-key anonymous demo limiter', async () => {
    const app = appFor(createAiDemoRateLimit());
    for (let i = 0; i < 30; i++) await hit(app, '2001:db8:aaaa:bb01::1').expect(200);
    // A different /64 inside the same /56 still spends the same default budget.
    await hit(app, '2001:db8:aaaa:bb02::1', 'user-b').expect(429);
    await hit(app, '2001:db8:aaaa:bc01::1').expect(200);
  });

  it('does not charge successful responses against the authentication failure budget', async () => {
    const app = appFor(authRateLimit);
    for (let i = 0; i < 7; i++) await hit(app, '198.51.100.27').expect(200);
    for (let i = 0; i < 5; i++) {
      await hit(app, '198.51.100.27').set('x-test-failure', 'true').expect(400);
    }
    await hit(app, '198.51.100.27').set('x-test-failure', 'true').expect(429);
  });
});
