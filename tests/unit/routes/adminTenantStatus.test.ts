// tests/unit/routes/adminTenantStatus.test.ts
//
// Unit tests for the admin tenant-status route. We exercise the REAL router
// from src/routes/adminTenantStatus.ts (via the factory's optional-service
// param) instead of replicating its logic — so any change to the typed-error
// dispatch, length cap, or 404 logic is covered by this suite without
// needing to boot Inversify. rbac + asyncHandler are still mocked because
// they're orthogonal to the route's own behavior.

import 'reflect-metadata';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Mock rbac so requireAdmin is a pass-through in unit tests
jest.mock('../../../src/middleware/rbac', () => ({
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Mock asyncHandler to simply invoke the handler (unit tests don't need
// Express error propagation through its internal wrapper).
jest.mock('../../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: (...args: unknown[]) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    },
}));

import { createAdminTenantStatusRouter } from '../../../src/routes/adminTenantStatus';
import {
  InvalidTenantStatusTransitionError,
  TenantStatusConcurrencyError,
  PartialTenantRevocationError,
  TenantNotFoundError,
  type TenantLifecycleService,
} from '../../../src/services/tenants/TenantLifecycleService';

const MAX_REASON_LENGTH = 1024;

// Minimal mock of TenantLifecycleService — only the methods the route calls.
interface MockSvc {
  // peekStatus is the read-only GET path — does NOT auto-register unknown tenants.
  peekStatus: jest.Mock;
  // getStatus is used by POST AFTER setStatus succeeds to return the updated state.
  getStatus: jest.Mock;
  listAudit: jest.Mock;
  setStatus: jest.Mock;
}

// Build an Express app wrapping the REAL admin router, with rbac + asyncHandler
// mocked (above) and a synthetic admin user injected so the route's
// `req.user.id` fallback resolves to 'admin1'.
async function buildApp(svc: MockSvc) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      id: 'admin1', roles: ['admin'], permissions: ['*'],
    };
    next();
  });
  const router = await createAdminTenantStatusRouter(svc as unknown as TenantLifecycleService);
  app.use('/api/admin/tenants', router);

  // Error handler so asyncHandler rejections don't crash the test process.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });

  return app;
}

// --- Tests ---

describe('GET /api/admin/tenants/:tenantId/status', () => {
  it('returns tenantId, status, and audit array on success', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn().mockResolvedValue('active'),
      getStatus: jest.fn().mockResolvedValue('active'),
      listAudit: jest.fn().mockResolvedValue([{ seq: 1, id: 'a' }]),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc)).get('/api/admin/tenants/t1/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: 't1', status: 'active' });
    expect(res.body.audit).toHaveLength(1);
    expect(svc.peekStatus).toHaveBeenCalledWith('t1');
    expect(svc.listAudit).toHaveBeenCalledWith('t1');
  });

  it('returns 200 with empty audit array when no history exists', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn().mockResolvedValue('suspended'),
      getStatus: jest.fn().mockResolvedValue('suspended'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc)).get('/api/admin/tenants/t2/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: 't2', status: 'suspended', audit: [] });
  });

  it('GET uses peekStatus and does NOT call the auto-registering getStatus', async () => {
    // Regression-pin for C2: a GET on an unknown tenant id must NOT cause the
    // service to insert a `tenants` row. peekStatus is the side-effect-free
    // read path; getStatus is the auto-registering read path.
    const svc: MockSvc = {
      peekStatus: jest.fn().mockResolvedValue('active'),
      getStatus: jest.fn(),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn(),
    };
    await request(await buildApp(svc)).get('/api/admin/tenants/never-seen-before/status');
    expect(svc.peekStatus).toHaveBeenCalledWith('never-seen-before');
    expect(svc.getStatus).not.toHaveBeenCalled();
  });

  it('GET returns 404 when peekStatus reports the tenant does not exist', async () => {
    // R2-1: distinguish "no such tenant" from "tenant is active". Returning
    // 200 with synthetic `status: active` would mislead the operator.
    const svc: MockSvc = {
      peekStatus: jest.fn().mockResolvedValue(null),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc)).get('/api/admin/tenants/typo-tenant/status');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'tenant_not_found', tenantId: 'typo-tenant' });
    // listAudit must not be called for a non-existent tenant.
    expect(svc.listAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/tenants/:tenantId/status', () => {
  it('flips status and returns updated state + audit', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('disabled'),
      listAudit: jest.fn().mockResolvedValue([{ seq: 1, newStatus: 'disabled' }]),
      setStatus: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t-flip/status')
      .send({ status: 'disabled', reason: 'test kill' });
    expect(res.status).toBe(200);
    expect(svc.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't-flip',
        newStatus: 'disabled',
        actorUserId: 'admin1',
        actorSource: 'admin_route',
        reason: 'test kill',
      }),
    );
    expect(res.body.status).toBe('disabled');
    expect(res.body.audit).toHaveLength(1);
  });

  it('passes undefined reason when reason is omitted', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('suspended'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t3/status')
      .send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect(svc.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ reason: undefined }),
    );
  });

  it('returns 400 for a completely unknown status value', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
    expect(res.body.allowed).toEqual(expect.arrayContaining(['active', 'suspended', 'disabled', 'trial_expired']));
    expect(svc.setStatus).not.toHaveBeenCalled();
  });

  it('returns 400 when status is missing from body', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
    expect(svc.setStatus).not.toHaveBeenCalled();
  });

  it('returns 400 when status is a number (wrong type)', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn(),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({ status: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  it('returns 400 for InvalidTenantStatusTransitionError from service', async () => {
    // Use the typed error directly — the route narrows on instanceof, not on
    // an error-message regex, so this regression-pins the actual dispatch.
    const txErr = new InvalidTenantStatusTransitionError('t1', 'active', 'active');
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('active'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockRejectedValue(txErr),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({ status: 'active' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      from: 'active', to: 'active',
      // R7-1: machine-readable code for API consumers to dispatch on,
      // consistent with sibling errors (concurrent_status_change, partial_revocation_failed).
      code: 'invalid_transition',
    });
    expect(res.body.error).toMatch(/invalid transition/i);
  });

  it('does NOT 400 on a generic Error whose message contains "invalid transition" (typed-narrowing guard)', async () => {
    // The earlier implementation used a regex match against err.message and
    // would have 400'd on this; the typed narrowing makes it surface as 500.
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('active'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockRejectedValue(new Error('invalid transition smuggled in a generic Error')),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({ status: 'suspended' });
    expect(res.status).toBe(500);
  });

  it('rethrows non-transition errors (surfaces as 500)', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('active'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockRejectedValue(new Error('DB connection lost')),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status')
      .send({ status: 'suspended' });
    expect(res.status).toBe(500);
  });

  it('returns 409 Conflict on TenantStatusConcurrencyError (CAS race)', async () => {
    // R2-3: a concurrent admin action that flipped the row between read and
    // write surfaces as 409 with code=concurrent_status_change, not opaque 500.
    const conflictErr = new TenantStatusConcurrencyError('t1', 'active');
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('active'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockRejectedValue(conflictErr),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status').send({ status: 'disabled' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'concurrent_status_change', expectedFrom: 'active',
    });
  });

  it('returns 500 actor_unidentified when req.user.id is missing (R4-4)', async () => {
    // R4-4: requireAdmin should always populate req.user.id; if it ever
    // doesn't, fail loudly instead of writing 'unknown' into the audit table.
    // Hand-roll a buildApp variant without the synthetic-user middleware.
    const svc: MockSvc = {
      peekStatus: jest.fn(), getStatus: jest.fn(), listAudit: jest.fn(), setStatus: jest.fn(),
    };
    const app = express();
    app.use(express.json());
    const router = await createAdminTenantStatusRouter(svc as unknown as TenantLifecycleService);
    app.use('/api/admin/tenants', router);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
    });
    const res = await request(app)
      .post('/api/admin/tenants/t1/status').send({ status: 'disabled' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('actor_unidentified');
    expect(svc.setStatus).not.toHaveBeenCalled();
  });

  it('returns 404 on TenantNotFoundError (POST against unknown tenant id)', async () => {
    // R3-5: setStatus now uses peekStatus internally (not getStatus), so an
    // admin POST against a typo'd tenant id surfaces as 404 instead of
    // silently materializing a tenants row via ensureExists.
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn().mockRejectedValue(new TenantNotFoundError('typo-tenant')),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/typo-tenant/status').send({ status: 'disabled' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'tenant_not_found', tenantId: 'typo-tenant' });
  });

  it('returns 500 with code=partial_revocation_failed on PartialTenantRevocationError', async () => {
    // R2-2: status flipped but token revocation failed. Distinguishable error
    // code so the operator can re-attempt revocation.
    const partial = new PartialTenantRevocationError('t1', 'disabled', new Error('token store down'));
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('disabled'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockRejectedValue(partial),
    };
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status').send({ status: 'disabled' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'partial_revocation_failed', tenantId: 't1', newStatus: 'disabled',
    });
  });

  it('returns 400 when reason exceeds the length cap (DoS guard)', async () => {
    // R2-5: cap operator-supplied reason strings before they hit the audit table.
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn(),
      listAudit: jest.fn(),
      setStatus: jest.fn(),
    };
    const huge = 'x'.repeat(MAX_REASON_LENGTH + 1);
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status').send({ status: 'disabled', reason: huge });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'reason too long',
      maxLength: MAX_REASON_LENGTH,
      actualLength: huge.length,
    });
    expect(svc.setStatus).not.toHaveBeenCalled();
  });

  it('accepts reason at exactly the length cap', async () => {
    const svc: MockSvc = {
      peekStatus: jest.fn(),
      getStatus: jest.fn().mockResolvedValue('disabled'),
      listAudit: jest.fn().mockResolvedValue([]),
      setStatus: jest.fn().mockResolvedValue(undefined),
    };
    const exact = 'x'.repeat(MAX_REASON_LENGTH);
    const res = await request(await buildApp(svc))
      .post('/api/admin/tenants/t1/status').send({ status: 'disabled', reason: exact });
    expect(res.status).toBe(200);
    expect(svc.setStatus).toHaveBeenCalledWith(expect.objectContaining({ reason: exact }));
  });
});
