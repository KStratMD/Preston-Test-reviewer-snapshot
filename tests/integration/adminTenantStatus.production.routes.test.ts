/**
 * Integration: the tenant kill-switch operator API must work against the gate
 * production actually runs.
 *
 * `src/routes/adminTenantStatus.ts` gated both endpoints with `requireAdmin`
 * from `src/middleware/rbac.ts`, which resolves a module-global RBAC singleton.
 * Nothing in `src/` ever calls `setRBACServiceInstance()` — only
 * `tests/unit/middleware/rbac.test.ts` does — so in production that gate always
 * threw "RBAC service not initialized" and the operator API for suspending a
 * tenant was inoperable.
 *
 * The operator saw HTTP 500. `src/middleware/rbac.ts` catches the throw and
 * calls `next(new ForbiddenAppError('Access control error'))`, which declares
 * status 403 — but `src/middleware/errorHandler.ts`, the only error handler the
 * app registers, answers every `next(err)` with 500 and never reads
 * `err.statusCode`. Measured 2026-09-03 by driving the unfixed gate through the
 * registered handler. The repository
 * documents the alternative in `src/middleware/verifiedAdmin.ts`, which exists
 * precisely because the singleton gates cannot authorize a real request.
 *
 * The route's own behaviour is unit-tested in
 * tests/unit/routes/adminTenantStatus.test.ts with the admin gate mocked out.
 * That is exactly why the defect survived: mocking the gate hides the only
 * thing that was broken. This suite mounts the REAL gate.
 *
 * The tenant repository is a fake of the same shape the TenantLifecycleService
 * unit suite uses. The audit ROW is written atomically inside
 * TenantLifecycleRepository.updateStatus and is covered by that repository's own
 * suite; what matters here is that the handler attributes the transition to the
 * authenticated actor, so this asserts the actor reaching the repository rather
 * than duplicating the row-level test.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';

import { createAdminTenantStatusRouter } from '../../src/routes/adminTenantStatus';
import { TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';
import type {
  TenantLifecycleRepository,
  TenantRow,
  UpdateStatusInput,
} from '../../src/services/tenants/TenantLifecycleRepository';
import type { TenantStatus } from '../../src/services/tenants/TenantStatus';

// The fake is typed against the repository's own exported contract rather than a
// local copy of it, so a change to UpdateStatusInput or TenantRow fails this
// suite at compile time instead of leaving it asserting a shape production no
// longer uses.
function mkRepo(statusByTenant: Record<string, TenantStatus>) {
  const state: Record<string, TenantStatus> = { ...statusByTenant };
  const repo = {
    findById: jest.fn(async (id: string): Promise<TenantRow | undefined> =>
      state[id]
        ? {
            id,
            status: state[id],
            statusChangedAt: null,
            statusChangedBy: null,
            statusReason: null,
            createdAt: '',
            updatedAt: '',
          }
        : undefined),
    ensureExists: jest.fn(async (): Promise<void> => {}),
    updateStatus: jest.fn(async (input: UpdateStatusInput): Promise<void> => {
      state[input.tenantId] = input.newStatus;
    }),
    recordAuditOnly: jest.fn(async (_input: UpdateStatusInput): Promise<void> => {}),
    listAudit: jest.fn(async () => []),
  };
  return repo as unknown as jest.Mocked<TenantLifecycleRepository> & typeof repo;
}

async function appWithUser(
  user: Record<string, unknown> | undefined,
  service: TenantLifecycleService,
): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  // createAdminTenantStatusRouter is async and the mutation route is POST.
  app.use('/api/admin/tenants', await createAdminTenantStatusRouter(service));
  return app;
}

const ADMIN = { id: 'op1', roles: ['admin'], permissions: [] };
const NON_ADMIN = { id: 'u1', roles: ['user'], permissions: [] };

describe('tenant kill-switch operator API against the production admin gate', () => {
  it('lets a platform admin read and change tenant status', async () => {
    const repo = mkRepo({ t_ks: 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 0, missTtlMs: 0 });
    const app = await appWithUser(ADMIN, svc);

    expect((await request(app).get('/api/admin/tenants/t_ks/status')).status).toBe(200);

    const res = await request(app)
      .post('/api/admin/tenants/t_ks/status')
      .send({ status: 'suspended', reason: 'incident' });
    expect(res.status).toBe(200);
    expect(repo.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-admin with 403 and an unauthenticated caller with 401', async () => {
    const repo = mkRepo({ t_ks: 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 0, missTtlMs: 0 });

    expect(
      (await request(await appWithUser(NON_ADMIN, svc)).get('/api/admin/tenants/t_ks/status')).status,
    ).toBe(403);
    expect(
      (await request(await appWithUser(undefined, svc)).get('/api/admin/tenants/t_ks/status')).status,
    ).toBe(401);
  });

  it('attributes the transition to the authenticated actor', async () => {
    const repo = mkRepo({ t_ks2: 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 0, missTtlMs: 0 });
    const app = await appWithUser(ADMIN, svc);

    await request(app)
      .post('/api/admin/tenants/t_ks2/status')
      .send({ status: 'suspended', reason: 'incident' });

    expect(repo.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_ks2',
        previousStatus: 'active',
        newStatus: 'suspended',
        actorUserId: 'op1',
        actorSource: 'admin_route',
        reason: 'incident',
      }),
    );
  });
});
