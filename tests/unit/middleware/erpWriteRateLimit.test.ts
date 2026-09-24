import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import {
  createErpWriteRateLimit,
  integrationRateLimit,
  limitMutatingMethods,
} from '../../../src/middleware/rateLimit';

// Repo-review A1: the ERP write families (/api/integrations, the SuiteCentral
// sync routes) had no rate limiting — the global limiter never reaches them.
// limitMutatingMethods applies a dedicated limiter to mutating methods only, so
// read/poll traffic is never throttled while write floods are capped.

function makeReqRes(method: string) {
  const req = { method } as Request;
  const res = {} as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('limitMutatingMethods', () => {
  it('passes safe methods straight through without invoking the limiter', () => {
    const limiter = jest.fn();
    const gated = limitMutatingMethods(limiter as never);

    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) {
      const { req, res, next } = makeReqRes(method);
      gated(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(limiter).not.toHaveBeenCalled();
  });

  it('routes mutating methods through the limiter', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      const limiter = jest.fn();
      const gated = limitMutatingMethods(limiter as never);
      const { req, res, next } = makeReqRes(method);
      gated(req, res, next);
      expect(limiter).toHaveBeenCalledWith(req, res, next);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

// The shared rateLimitHandler + skipRateLimit fixes are exercised through
// integrationRateLimit, which (unlike createErpWriteRateLimit) is active in the
// unit env — it has no demo/RATE_LIMIT_ENABLED skip, only skipRateLimit — so a
// real 429 is reachable in ~11 requests.
describe('shared rate-limit handler (429 not 500)', () => {
  it('returns a well-formed 429 past the budget instead of crashing to 500', async () => {
    const app = express();
    app.use(express.json());
    app.post('/i', integrationRateLimit, (_req, res) => res.json({ ok: true }));

    let res;
    for (let i = 0; i < 11; i++) {
      res = await request(app).post('/i').send({});
    }
    // Before the fix, the Date-typed resetTime made toISOString throw
    // RangeError and the error handler returned 500 here.
    expect(res!.status).toBe(429);
    expect(res!.body.error).toBe('Too Many Requests');
    expect(typeof res!.body.retryAfter).toBe('number');
    expect(res!.body.retryAfter).toBeGreaterThanOrEqual(0);
    expect(typeof res!.body.resetTime).toBe('string');
    expect(Number.isNaN(Date.parse(res!.body.resetTime))).toBe(false);
  }, 30000);

  it('exempts a service account carrying roles: [service]', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { user?: unknown }).user = { id: 'svc-1', roles: ['service'] };
      next();
    });
    app.post('/i', integrationRateLimit, (_req, res) => res.json({ ok: true }));

    // Well past the 10/5min budget — the roles:[service] account must be
    // exempted (the check previously only read the singular `role`).
    for (let i = 0; i < 15; i++) {
      await request(app).post('/i').send({}).expect(200);
    }
  }, 30000);
});

describe('createErpWriteRateLimit skip gating', () => {
  it('stays dormant when RATE_LIMIT_ENABLED is disabled (unit/integration env)', async () => {
    // setupEnv/CI set RATE_LIMIT_ENABLED=0; with the env-parsing fix that is a
    // real false, so the ERP limiter skips and never throttles demo/test flows.
    const app = express();
    app.use(express.json());
    const gated = limitMutatingMethods(createErpWriteRateLimit());
    app.post('/w', gated, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 65; i++) {
      await request(app).post('/w').send({}).expect(200);
    }
  }, 30000);

  it('passes reads straight through regardless of budget', async () => {
    const app = express();
    const gated = limitMutatingMethods(createErpWriteRateLimit());
    app.get('/w', gated, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 80; i++) {
      await request(app).get('/w').expect(200);
    }
  }, 30000);
});
