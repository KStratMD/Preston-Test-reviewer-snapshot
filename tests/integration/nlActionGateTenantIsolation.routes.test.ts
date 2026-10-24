/**
 * Integration (F4): /api/nl-action-gate tenant isolation through the REAL
 * router + REAL NLActionGateService + production mount helper, with real
 * HS256 JWTs. Tenant B can neither see, approve, reject, nor execute
 * tenant A's proposed action (fail-closed not-found — existence never
 * revealed).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// Everything lives INSIDE the factory: jest.mock is hoisted above imports,
// and the factory runs while the router module is being imported — any
// out-of-scope const (even `mock`-prefixed) would hit the TDZ.
// TOKEN-AWARE (Codex R4/R5): mountNlActionGateRoutes runs authMiddleware,
// which resolves AND CACHES TYPES.AuthService through this container
// (auth.ts:57-61) — a blanket `get: () => logger` would 401 every request.
// Same symbol-discriminating stub as metricsNLQTenantPropagation.
jest.mock('../../src/inversify/inversify.config', () => {
  const { NLActionGateService } = jest.requireActual('../../src/services/ai/NLActionGateService');
  const realJwt = jest.requireActual('jsonwebtoken') as typeof import('jsonwebtoken');
  const logger: Record<string, unknown> = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  logger.child = () => logger;
  const authService = {
    verifyJWT(token: string): Record<string, unknown> {
      const decoded = realJwt.verify(token, process.env.JWT_SECRET as string, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('Invalid JWT payload format');
      return decoded as Record<string, unknown>;
    },
    generateJWT(): string { throw new Error('not used in this fixture'); },
  };
  const svc = new NLActionGateService(logger);
  return {
    container: {
      get: (type: symbol) => (String(type).includes('AuthService') ? authService : logger),
      getAsync: async () => svc,
    },
  };
});

import nlRouter from '../../src/routes/NLActionGateRouter';
import { mountNlActionGateRoutes } from '../../src/middleware/setup/RouteSetup';

const fakeTenantService = { requireActive: jest.fn(async () => undefined) } as never;

function token(tenantId: string, sub: string): string {
  return jwt.sign({ sub, tenantId }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

describe('/api/nl-action-gate — tenant-A/B isolation (F4)', () => {
  let app: express.Application;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    mountNlActionGateRoutes(app, fakeTenantService, nlRouter);
  });

  it("B cannot list, approve, reject, or execute A's action; A can", async () => {
    const propose = await request(app).post('/api/nl-action-gate/propose')
      .set('Authorization', `Bearer ${token('tenant-a', 'user-a')}`)
      .send({ input: 'Refund this customer $50.00' });
    expect(propose.status).toBe(200);
    const id = propose.body.proposedAction.id as string;

    const bPending = await request(app).get('/api/nl-action-gate/pending')
      .set('Authorization', `Bearer ${token('tenant-b', 'user-b')}`);
    expect(bPending.body.actions.map((a: { id: string }) => a.id)).not.toContain(id);

    const bApprove = await request(app).post(`/api/nl-action-gate/actions/${id}/approve`)
      .set('Authorization', `Bearer ${token('tenant-b', 'user-b')}`).send({});
    expect(bApprove.status).toBe(404);

    const bReject = await request(app).post(`/api/nl-action-gate/actions/${id}/reject`)
      .set('Authorization', `Bearer ${token('tenant-b', 'user-b')}`).send({});
    expect(bReject.status).toBe(404);

    const bExecute = await request(app).post(`/api/nl-action-gate/actions/${id}/execute`)
      .set('Authorization', `Bearer ${token('tenant-b', 'user-b')}`);
    expect(bExecute.status).toBe(404);
    expect(bExecute.body.errorCode).toBe('not_found');

    const aApprove = await request(app).post(`/api/nl-action-gate/actions/${id}/approve`)
      .set('Authorization', `Bearer ${token('tenant-a', 'user-a')}`).send({ userId: 'forged' });
    expect(aApprove.status).toBe(200);
    expect(aApprove.body.action.approvedBy).toBe('user-a');

    // A's execute must NOT be tenant-blocked: any status EXCEPT not_found
    // proves the tenant match passed (dispatch itself may 501 — no backing
    // services are wired in this fixture).
    const aExecute = await request(app).post(`/api/nl-action-gate/actions/${id}/execute`)
      .set('Authorization', `Bearer ${token('tenant-a', 'user-a')}`);
    expect(aExecute.body.errorCode).not.toBe('not_found');
  });
});
