/**
 * Unit tests for the embedded reconciliation operator surface
 * (`/api/embedded/reconciliation/*`). Auths via `validateGuestContext`
 * (embedded session) — tenant + actor come from the session, never the JWT.
 * jest.mock `validateGuestContext` so the chain runs without a real DB session.
 */
import 'reflect-metadata';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

let mockSession: Partial<{ tenant_id: string; user_id: string; expires_at: string }> | null = null;
let mockMiddlewareStatus: number | null = null;
let mockMiddlewareError: string | null = null;

jest.mock('../../../../src/middleware/embeddedAuthMiddleware', () => ({
  validateGuestContext: (_req: Request, res: Response, next: NextFunction) => {
    if (mockMiddlewareStatus !== null) {
      res.status(mockMiddlewareStatus).json({ error: mockMiddlewareError ?? 'session_invalid' });
      return;
    }
    res.locals.embeddedSession = mockSession;
    next();
  },
}));

// eslint-disable-next-line import/first
import { embeddedReconciliationRouter } from '../../../../src/routes/embedded/embeddedReconciliationRouter';
// eslint-disable-next-line import/first
import { ReconciliationExceptionNotFoundError } from '../../../../src/services/reconciliationCenter/ReconciliationExceptionRepository';
// eslint-disable-next-line import/first
import { SYNTHETIC_EMBEDDED_OPERATOR_USER_IDS } from '../../../../src/routes/embedded/embeddedSessionUserId';
// eslint-disable-next-line import/first
import type { ReconciliationCenterService } from '../../../../src/services/reconciliationCenter/ReconciliationCenterService';

function mount(svc: ReconciliationCenterService) {
  const app = express();
  app.use(express.json());
  app.use('/api/embedded/reconciliation', embeddedReconciliationRouter(svc));
  return app;
}

beforeEach(() => {
  mockSession = null;
  mockMiddlewareStatus = null;
  mockMiddlewareError = null;
});

describe('GET /api/embedded/reconciliation/exceptions', () => {
  it('returns tenant-scoped open exceptions when the session is valid', async () => {
    mockSession = { tenant_id: 't_squire', user_id: 'u_ops' };
    const svc = {
      listOpen: jest.fn(async () => [{ id: 'rex_1' }, { id: 'rex_2' }]),
    } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc)).get('/api/embedded/reconciliation/exceptions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exceptions: [{ id: 'rex_1' }, { id: 'rex_2' }] });
    expect(svc.listOpen).toHaveBeenCalledWith('t_squire');
  });

  it('propagates a validateGuestContext rejection (400) without reaching the service', async () => {
    mockMiddlewareStatus = 400;
    mockMiddlewareError = 'missing_x_embedded_session_id';
    const svc = { listOpen: jest.fn() } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc)).get('/api/embedded/reconciliation/exceptions');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'missing_x_embedded_session_id' });
    expect(svc.listOpen).not.toHaveBeenCalled();
  });

  it('401s when the embedded session is underspecified (no tenant_id)', async () => {
    mockSession = { user_id: 'u_ops' };
    const svc = { listOpen: jest.fn() } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc)).get('/api/embedded/reconciliation/exceptions');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'embedded_session_required' });
    expect(svc.listOpen).not.toHaveBeenCalled();
  });
});

describe('POST /api/embedded/reconciliation/exceptions/:id/resolve', () => {
  it('resolves with the session user_id as actor and 204s', async () => {
    mockSession = { tenant_id: 't_squire', user_id: 'u_ops' };
    const svc = {
      resolveException: jest.fn(async () => undefined),
    } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
      .send({ note: 'matched manually' });

    expect(res.status).toBe(204);
    expect(svc.resolveException).toHaveBeenCalledWith({
      tenantId: 't_squire',
      exceptionId: 'rex_1',
      actorUserId: 'u_ops',
      note: 'matched manually',
    });
  });

  it('404s when the service throws ReconciliationExceptionNotFoundError', async () => {
    mockSession = { tenant_id: 't_squire', user_id: 'u_ops' };
    const svc = {
      resolveException: jest.fn(async () => {
        throw new ReconciliationExceptionNotFoundError('t_squire', 'rex_x');
      }),
    } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_x/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'exception_not_found' });
  });

  it('401s operator_identity_required when the session has no user_id', async () => {
    mockSession = { tenant_id: 't_squire' };
    const svc = { resolveException: jest.fn() } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'operator_identity_required' });
    expect(svc.resolveException).not.toHaveBeenCalled();
  });

  it.each([...SYNTHETIC_EMBEDDED_OPERATOR_USER_IDS])(
    '401s operator_identity_required when the session carries the synthetic user_id %p',
    async (syntheticUserId) => {
      // hostBootstrapRouter persists any non-empty body.userId verbatim, so a
      // misconfigured host can land any of these placeholders in the session;
      // resolving as one would write a non-real operator into resolved_by and
      // break the attribution claim. Covers the embedded host-bootstrap sentinel
      // plus the '__system__'/'unknown' markers (Bearer-route parity).
      mockSession = { tenant_id: 't_squire', user_id: syntheticUserId };
      const svc = { resolveException: jest.fn() } as unknown as ReconciliationCenterService;

      const res = await request(mount(svc))
        .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
        .send({ note: 'x' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'operator_identity_required' });
      expect(svc.resolveException).not.toHaveBeenCalled();
    },
  );

  it('propagates a validateGuestContext rejection (403) without reaching the service', async () => {
    mockMiddlewareStatus = 403;
    mockMiddlewareError = 'cross_origin_rejected';
    const svc = { resolveException: jest.fn() } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'cross_origin_rejected' });
    expect(svc.resolveException).not.toHaveBeenCalled();
  });

  it('401s embedded_session_required when tenant_id is an empty string', async () => {
    mockSession = { tenant_id: '', user_id: 'u_ops' };
    const svc = { resolveException: jest.fn() } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
      .send({ note: 'x' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'embedded_session_required' });
    expect(svc.resolveException).not.toHaveBeenCalled();
  });

  it('coerces a non-string note to empty string', async () => {
    mockSession = { tenant_id: 't_squire', user_id: 'u_ops' };
    const svc = {
      resolveException: jest.fn(async () => undefined),
    } as unknown as ReconciliationCenterService;

    const res = await request(mount(svc))
      .post('/api/embedded/reconciliation/exceptions/rex_1/resolve')
      .send({ note: 12345 });

    expect(res.status).toBe(204);
    expect(svc.resolveException).toHaveBeenCalledWith(
      expect.objectContaining({ note: '' }),
    );
  });
});
