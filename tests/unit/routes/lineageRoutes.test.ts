import express from 'express';
import request from 'supertest';
import { lineageRouter } from '../../../src/routes/lineageRoutes';
import type { LineageQueryService } from '../../../src/services/lineage/LineageQueryService';

function mountWithIdentity(
  svc: LineageQueryService,
  tenantId?: string,
  userId: string = 'u_ops',
) {
  const app = express();
  app.use((req, _res, next) => {
    if (tenantId) {
      (req as unknown as { user: { tenantId: string; id: string } }).user = {
        tenantId,
        id: userId,
      };
    }
    next();
  });
  app.use('/api/lineage', lineageRouter(svc));
  return app;
}

describe('GET /api/lineage/records/:system/:entityType/:entityId', () => {
  it('returns tenant-scoped chain for a record lookup', async () => {
    const svc = {
      chainForRecord: jest.fn(async () => [{ id: 'lin_1', eventType: 'source_read' }]),
    } as unknown as LineageQueryService;
    const app = mountWithIdentity(svc, 't_squire');

    const res = await request(app).get('/api/lineage/records/netsuite/customer/123');
    expect(res.status).toBe(200);
    expect(res.body.events[0].id).toBe('lin_1');
    expect((svc.chainForRecord as jest.Mock)).toHaveBeenCalledWith({
      tenantId: 't_squire',
      system: 'netsuite',
      entityType: 'customer',
      entityId: '123',
    });
  });

  it('returns 200 with empty events when no chain matches', async () => {
    const svc = {
      chainForRecord: jest.fn(async () => []),
    } as unknown as LineageQueryService;
    const app = mountWithIdentity(svc, 't_squire');

    const res = await request(app).get('/api/lineage/records/netsuite/customer/missing');
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('returns 401 when identity context is absent', async () => {
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;
    const app = mountWithIdentity(svc, undefined);

    const res = await request(app).get('/api/lineage/records/netsuite/customer/123');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('operator_identity_required');
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });

  // PR 12 R9 — additional fail-closed checks for synthetic operator userIds.
  // The proof card promises an operator-level read; tenant alone is not enough.
  it.each([
    ['__system__', 'SYSTEM_IDENTITY.userId synthetic'],
    ['unknown', "auth.ts JWT-without-sub/id fallback"],
  ])('returns 401 when userId is the synthetic sentinel %s (%s)', async (userId) => {
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;
    const app = mountWithIdentity(svc, 't_real_tenant', userId);

    const res = await request(app).get('/api/lineage/records/netsuite/customer/123');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('operator_identity_required');
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });
});
