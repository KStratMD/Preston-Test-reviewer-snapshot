// A3 (defense-in-depth): authMiddleware verifies with jwt.verify pinned to
// HS256. A token signed with any other algorithm — including the alg:none
// confusion vector — must be rejected at the middleware even though it carries
// a structurally valid payload. The fast unit suite stubs AuthService, so this
// pinning is only observable end-to-end with the real verifier (integration).
//
// setupEnv.ts sets process.env.JWT_SECRET ← STRONG_TEST_JWT_SECRET before this
// module loads, and authMiddleware captures env.JWT_SECRET on first use.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import { authMiddleware } from '../../src/middleware/auth';

const JWT_SECRET = STRONG_TEST_JWT_SECRET;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/probe', authMiddleware, (req, res) => {
    res.json({ ok: true, user: (req as express.Request & { user?: { id?: string } }).user?.id ?? null });
  });
  return app;
}

describe('JWT algorithm pinning at authMiddleware (A3)', () => {
  const app = buildApp();

  it('accepts a correctly HS256-signed token', async () => {
    const token = jwt.sign({ sub: 'user-1', id: 'user-1' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    await request(app).get('/probe').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('rejects a token signed with a non-HS256 algorithm (HS384)', async () => {
    const token = jwt.sign({ sub: 'user-1', id: 'user-1' }, JWT_SECRET, { algorithm: 'HS384', expiresIn: '1h' });
    await request(app).get('/probe').set('Authorization', `Bearer ${token}`).expect(401);
  });

  it('rejects an unsigned alg:none token', async () => {
    const token = jwt.sign({ sub: 'user-1', id: 'user-1' }, '', { algorithm: 'none' });
    await request(app).get('/probe').set('Authorization', `Bearer ${token}`).expect(401);
  });
});
