/**
 * Unit tests for the embedded lineage operator surface
 * (`/api/embedded/lineage/records/:system/:entityType/:entityId`).
 *
 * The route auths via `validateGuestContext` (embedded session + same-origin)
 * rather than the Bearer-JWT chain used by the operator API at
 * `src/routes/lineageRoutes.ts`. Tenant identity comes from the embedded
 * session, not from `req.user`/`req.auth`.
 *
 * Tests jest.mock `validateGuestContext` so the route's middleware chain can
 * be exercised without seeding a real DB session. The mock either populates
 * `res.locals.embeddedSession` from a test-controlled global or short-circuits
 * with the relevant HTTP status the real middleware would have produced.
 */
import 'reflect-metadata';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

// Test-controlled session shape. Set by individual tests before issuing the
// request. The mock below reads this on every middleware invocation.
let mockSession: Partial<{
  tenant_id: string;
  user_id: string;
  expires_at: string;
}> | null = null;
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
import { embeddedLineageRouter } from '../../../../src/routes/embedded/embeddedLineageRouter';
// eslint-disable-next-line import/first
import type { LineageQueryService } from '../../../../src/services/lineage/LineageQueryService';

function mount(svc: LineageQueryService) {
  const app = express();
  app.use('/api/embedded/lineage', embeddedLineageRouter(svc));
  return app;
}

beforeEach(() => {
  mockSession = null;
  mockMiddlewareStatus = null;
  mockMiddlewareError = null;
});

describe('GET /api/embedded/lineage/records/:system/:entityType/:entityId', () => {
  it('returns tenant-scoped chain when embedded session is valid', async () => {
    mockSession = { tenant_id: 't_squire', user_id: 'u_ops' };
    const svc = {
      chainForRecord: jest.fn(async () => [
        { id: 'lin_1', eventType: 'source_read', sequence: 1 },
        { id: 'lin_2', eventType: 'transform', sequence: 2 },
      ]),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/123',
    );

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].id).toBe('lin_1');
    expect((svc.chainForRecord as jest.Mock)).toHaveBeenCalledWith({
      tenantId: 't_squire',
      system: 'netsuite',
      entityType: 'customer',
      entityId: '123',
    });
  });

  it('returns 200 with empty events when no chain matches', async () => {
    mockSession = { tenant_id: 't_squire' };
    const svc = {
      chainForRecord: jest.fn(async () => []),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/missing',
    );

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it('returns 400 when validateGuestContext rejects (missing session header)', async () => {
    mockMiddlewareStatus = 400;
    mockMiddlewareError = 'missing_x_embedded_session_id';
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/123',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_x_embedded_session_id');
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });

  it('returns 403 when validateGuestContext rejects cross-origin', async () => {
    mockMiddlewareStatus = 403;
    mockMiddlewareError = 'cross_origin_rejected';
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/123',
    );

    expect(res.status).toBe(403);
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });

  it('returns 401 when middleware passed but session is missing tenant_id', async () => {
    // Defensive — `validateGuestContext` should never pass without a valid
    // tenant_id, but the type system can't prove it (res.locals is `any`).
    // Keep the explicit handler-level guard so a future middleware regression
    // can't silently leak cross-tenant lookups.
    mockSession = {};
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/123',
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('embedded_session_required');
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });

  it('returns 401 when middleware passed but tenant_id is empty string', async () => {
    mockSession = { tenant_id: '' };
    const svc = {
      chainForRecord: jest.fn(),
    } as unknown as LineageQueryService;

    const res = await request(mount(svc)).get(
      '/api/embedded/lineage/records/netsuite/customer/123',
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('embedded_session_required');
    expect(svc.chainForRecord).not.toHaveBeenCalled();
  });
});
