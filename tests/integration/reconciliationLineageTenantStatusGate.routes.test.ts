/**
 * Integration (F3, design D5-F3): /api/reconciliation-center and /api/lineage
 * must sit behind authMiddleware AND the tenant-lifecycle kill switch —
 * unconditionally (the REQUIRE_CENTRAL_AUTH=false demo relaxation no longer
 * applies to these operator surfaces). Pins the COMPOSITION via the exported
 * production wiring helpers (same pattern as mountMcpPolicyRoutes /
 * mcpPoliciesTenantStatusGate.routes.test.ts), with REAL HS256 JWTs (D6).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mountReconciliationCenterRoutes, mountLineageRoutes } from '../../src/middleware/setup/RouteSetup';
import { reconciliationCenterRouter } from '../../src/routes/reconciliationCenterRoutes';
import { lineageRouter } from '../../src/routes/lineageRoutes';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';
import type { ReconciliationCenterService } from '../../src/services/reconciliationCenter/ReconciliationCenterService';
import type { LineageQueryService } from '../../src/services/lineage/LineageQueryService';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

const reconciliationService = {
  listOpen: jest.fn(async () => []),
  resolveException: jest.fn(),
  createSchedule: jest.fn(),
  listSchedules: jest.fn(async () => []),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
} as unknown as ReconciliationCenterService;

const lineageService = {
  chainForRecord: jest.fn(async () => []),
} as unknown as LineageQueryService;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  mountReconciliationCenterRoutes(app, fakeTenantService, reconciliationCenterRouter(reconciliationService));
  mountLineageRoutes(app, fakeTenantService, lineageRouter(lineageService));
  return app;
}

describe('/api/reconciliation-center + /api/lineage — strict auth + kill-switch wiring (F3)', () => {
  let app: express.Application;
  beforeAll(() => { app = createApp(); });
  beforeEach(() => jest.clearAllMocks());

  const CASES: Array<[string, string]> = [
    ['reconciliation-center list', '/api/reconciliation-center/exceptions'],
    ['lineage record read', '/api/lineage/records/netsuite/customer/42'],
  ];

  for (const [label, path] of CASES) {
    it(`${label}: anonymous → 401, never reaches the service`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(reconciliationService.listOpen).not.toHaveBeenCalled();
      expect(lineageService.chainForRecord).not.toHaveBeenCalled();
    });

    it(`${label}: tenant-less JWT → 403 tenant_id_missing (fail-closed)`, async () => {
      const res = await request(app).get(path).set('Authorization', `Bearer ${signToken({ sub: 'user-1' })}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
    });

    it(`${label}: suspended tenant → 403 tenant_blocked`, async () => {
      const res = await request(app).get(path)
        .set('Authorization', `Bearer ${signToken({ sub: 'user-1', tenantId: SUSPENDED_TENANT })}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    });
  }

  it('active tenant reaches the reconciliation service scoped to the JWT tenant only', async () => {
    const res = await request(app).get('/api/reconciliation-center/exceptions')
      .set('Authorization', `Bearer ${signToken({ sub: 'user-1', tenantId: 'tenant-a' })}`);
    expect(res.status).toBe(200);
    expect(reconciliationService.listOpen).toHaveBeenCalledWith('tenant-a');
  });

  it('active tenant reaches the lineage service scoped to the JWT tenant only', async () => {
    const res = await request(app).get('/api/lineage/records/netsuite/customer/42')
      .set('Authorization', `Bearer ${signToken({ sub: 'user-1', tenantId: 'tenant-a' })}`);
    expect(res.status).toBe(200);
    expect(lineageService.chainForRecord).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
  });
});
