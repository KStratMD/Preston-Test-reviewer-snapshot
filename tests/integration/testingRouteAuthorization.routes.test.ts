// Real-JWT integration coverage for the testing-route admin boundary (PR-C).
//
// Mounts /api/testing exactly as production does — the router carries its own
// route-level authMiddleware + requirePlatformAdmin on POST /run — and drives
// it with JWTs signed against the real test secret. Handler-only tests with
// mocked pass-through middleware cannot prove this ordering; these can.
//
// jest.slow.config.cjs runs tests/integration/setupEnv.ts BEFORE this module
// loads, setting process.env.JWT_SECRET ← STRONG_TEST_JWT_SECRET, which
// authMiddleware captures via env.JWT_SECRET on its first resolveServices()
// call. Signing here with the same secret keeps verification deterministic.

import { EventEmitter } from 'events';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import { createTestingRouter } from '../../src/routes/testing';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const mockedSpawn = spawn as unknown as jest.Mock;

const JWT_SECRET = STRONG_TEST_JWT_SECRET;

function signJwt(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
}

const userToken = signJwt({ sub: 'user-1', tenantId: 'tenant-a', roles: ['user'], permissions: [] });
const adminToken = signJwt({ sub: 'admin-1', tenantId: 'platform', roles: ['admin'], permissions: ['*'] });

function mockSuccessfulSpawn(): void {
  mockedSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: jest.Mock;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = jest.fn();

    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('Tests: 1 passed, 1 total'));
      child.emit('close', 0);
    });

    return child;
  });
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Production mount shape (RouteSetup.ts): no mount-level auth — the router
  // gates POST /run internally and leaves POST /mcp-schema anonymous.
  app.use('/api/testing', createTestingRouter());
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });
  return app;
}

describe('testing route authorization — real JWT admin boundary', () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('rejects an anonymous /run with 401 before any process is spawned', async () => {
    await request(app).post('/api/testing/run').send({ suite: 'fast' }).expect(401);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('forbids an authenticated non-admin /run with 403', async () => {
    await request(app)
      .post('/api/testing/run')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ suite: 'fast' })
      .expect(403);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('allows a platform admin to run the suite', async () => {
    mockSuccessfulSpawn();
    const res = await request(app)
      .post('/api/testing/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ suite: 'fast' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('keeps /mcp-schema reachable anonymously for the AI config dashboard', async () => {
    const res = await request(app)
      .post('/api/testing/mcp-schema')
      .send({ entityType: 'customer' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
