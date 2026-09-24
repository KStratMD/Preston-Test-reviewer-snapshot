/**
 * Integration (F4, design D5-F4): platform-global ERP surfaces (hubspot,
 * shipstation, three SuiteCentral sync mounts) sit behind authMiddleware +
 * requirePlatformAdmin; /api/nl-action-gate sits behind authMiddleware +
 * the tenant-lifecycle kill switch. The shared erp-write limiter runs AFTER
 * auth/authz on every mount (rejected traffic never consumes budget). REAL
 * HS256 JWTs (D6). Pins the exported production wiring helpers.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import {
  mountHubSpotRoutes,
  mountShipStationRoutes,
  mountSuiteCentralSyncRoutes,
  mountNlActionGateRoutes,
  mountIntegrationRoutes,
  mountFullPipelineDemoRoutes,
} from '../../src/middleware/setup/RouteSetup';
import { limitMutatingMethods } from '../../src/middleware/rateLimit';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}
const adminToken = (): string => signToken({ sub: 'admin-1', tenantId: 'tenant-admin', roles: ['admin'] });
const tenantToken = (tenantId = 'tenant-a'): string => signToken({ sub: 'user-1', tenantId });

interface Spy { router: express.Router; hits: jest.Mock }
function makeSpyRouter(): Spy {
  const hits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => { hits(); res.status(200).json({ ok: true }); });
  return { router, hits };
}
function makeSpyLimiter(): { limiter: express.RequestHandler; limiterHits: jest.Mock } {
  const limiterHits = jest.fn();
  const limiter: express.RequestHandler = (_req, _res, next) => { limiterHits(); next(); };
  return { limiter, limiterHits };
}

describe('F4 ERP write families — mount composition', () => {
  let app: express.Application;
  const spy = {
    hubspot: makeSpyRouter(), shipstation: makeSpyRouter(), nlActionGate: makeSpyRouter(),
    sync: makeSpyRouter(), netsuiteSync: makeSpyRouter(), squireNetsuiteSync: makeSpyRouter(),
    integrations: makeSpyRouter(),
    fullPipeline: makeSpyRouter(),
  };
  const hubspotLim = makeSpyLimiter();
  const shipstationLim = makeSpyLimiter();
  const nlLim = makeSpyLimiter();
  const syncLim = makeSpyLimiter(); // ONE spy shared by all three sync mounts (mirrors production)
  const integrationsLim = makeSpyLimiter();
  const fpLim = makeSpyLimiter();

  beforeAll(() => {
    app = express();
    app.use(express.json());
    mountHubSpotRoutes(app, spy.hubspot.router, hubspotLim.limiter);
    mountShipStationRoutes(app, spy.shipstation.router, shipstationLim.limiter);
    mountSuiteCentralSyncRoutes(app, {
      sync: spy.sync.router, netsuiteSync: spy.netsuiteSync.router, squireNetsuiteSync: spy.squireNetsuiteSync.router,
    }, syncLim.limiter);
    mountNlActionGateRoutes(app, fakeTenantService, spy.nlActionGate.router, nlLim.limiter);
    mountIntegrationRoutes(app, fakeTenantService, spy.integrations.router, integrationsLim.limiter);
    mountFullPipelineDemoRoutes(app, spy.fullPipeline.router, limitMutatingMethods(fpLim.limiter));
  });
  beforeEach(() => jest.clearAllMocks());

  const ADMIN_CASES: Array<[Spy, jest.Mock, string]> = [
    [spy.hubspot, hubspotLim.limiterHits, '/api/hubspot/contacts'],
    [spy.shipstation, shipstationLim.limiterHits, '/api/shipstation/orders'],
    [spy.sync, syncLim.limiterHits, '/api/suitecentral/sync/status'],
    [spy.netsuiteSync, syncLim.limiterHits, '/api/suitecentral/netsuite/sync/sync/status'],
    [spy.squireNetsuiteSync, syncLim.limiterHits, '/api/squire/suitecentral/netsuite/sync/sync/status'],
  ];

  for (const [routerSpy, limiterHits, path] of ADMIN_CASES) {
    it(`${path}: anonymous → 401; router+limiter unreached`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(routerSpy.hits).not.toHaveBeenCalled();
      expect(limiterHits).not.toHaveBeenCalled();
    });

    it(`${path}: active NON-admin tenant → 403 platform-admin required; router+limiter unreached`, async () => {
      const res = await request(app).get(path).set('Authorization', `Bearer ${tenantToken()}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'Platform administrator access required' });
      expect(routerSpy.hits).not.toHaveBeenCalled();
      expect(limiterHits).not.toHaveBeenCalled();
    });

    it(`${path}: admin JWT → limiter then router`, async () => {
      const res = await request(app).post(path).set('Authorization', `Bearer ${adminToken()}`).send({});
      expect(res.status).toBe(200);
      expect(limiterHits).toHaveBeenCalledTimes(1);
      expect(routerSpy.hits).toHaveBeenCalledTimes(1);
    });
  }

  describe('/api/nl-action-gate (tenant shape)', () => {
    const path = '/api/nl-action-gate/pending';

    it('anonymous → 401; router+limiter unreached', async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(spy.nlActionGate.hits).not.toHaveBeenCalled();
      expect(nlLim.limiterHits).not.toHaveBeenCalled();
    });

    it('tenant-less JWT → 403 tenant_id_missing (fail-closed)', async () => {
      const res = await request(app).get(path).set('Authorization', `Bearer ${signToken({ sub: 'user-1' })}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
      expect(nlLim.limiterHits).not.toHaveBeenCalled();
    });

    it('suspended tenant → 403 tenant_blocked; limiter unreached', async () => {
      const res = await request(app).get(path).set('Authorization', `Bearer ${tenantToken(SUSPENDED_TENANT)}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
      expect(nlLim.limiterHits).not.toHaveBeenCalled();
    });

    it('active tenant → limiter then router', async () => {
      const res = await request(app).post(path).set('Authorization', `Bearer ${tenantToken()}`).send({});
      expect(res.status).toBe(200);
      expect(nlLim.limiterHits).toHaveBeenCalledTimes(1);
      expect(spy.nlActionGate.hits).toHaveBeenCalledTimes(1);
    });
  });

  // Codex R1+R2 (#1055): /api/integrations previously mounted the limiter
  // BEFORE authMiddleware (keying every write `anonymous`, fragmenting the
  // shared budget) and had NO tenant-lifecycle kill switch despite the
  // routePolicy row declaring lifecycle: 'enforce'. Pin the full nl-action-
  // gate-shaped chain: auth → kill switch → limiter → router.
  describe('/api/integrations (tenant shape, shared erp-write budget)', () => {
    const path = '/api/integrations/some-config';

    it('anonymous mutating request → 401; router+limiter unreached (never consumes budget)', async () => {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(401);
      expect(spy.integrations.hits).not.toHaveBeenCalled();
      expect(integrationsLim.limiterHits).not.toHaveBeenCalled();
    });

    it('tenant-less JWT → 403 tenant_id_missing (fail-closed)', async () => {
      const res = await request(app).post(path).set('Authorization', `Bearer ${signToken({ sub: 'user-1' })}`).send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
      expect(spy.integrations.hits).not.toHaveBeenCalled();
      expect(integrationsLim.limiterHits).not.toHaveBeenCalled();
    });

    it('suspended tenant → 403 tenant_blocked; router+limiter unreached', async () => {
      const res = await request(app).post(path).set('Authorization', `Bearer ${tenantToken(SUSPENDED_TENANT)}`).send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
      expect(spy.integrations.hits).not.toHaveBeenCalled();
      expect(integrationsLim.limiterHits).not.toHaveBeenCalled();
    });

    it('active tenant → limiter (post-auth, keyed by verified user) then router', async () => {
      const res = await request(app).post(path).set('Authorization', `Bearer ${tenantToken()}`).send({});
      expect(res.status).toBe(200);
      expect(integrationsLim.limiterHits).toHaveBeenCalledTimes(1);
      expect(spy.integrations.hits).toHaveBeenCalledTimes(1);
    });
  });

  // The production limiter is `limitMutatingMethods(createErpWriteRateLimit())`
  // — ALREADY wrapped at RouteSetup.ts:31. Injecting a RAW spy here would fire
  // on GET, and a suite built on that would "prove" safe methods consume write
  // budget, which production does not do. Wrap the spy exactly as the real
  // instance is wrapped so the seam matches what it stands in for.
  describe('/api/full-pipeline-demo (platform-global, F4 shape)', () => {
    const ENDPOINTS: Array<[string, string]> = [
      ['post', '/api/full-pipeline-demo/execute'],
      ['get', '/api/full-pipeline-demo/status/pipeline_1'],
      ['get', '/api/full-pipeline-demo/configurations'],
      ['get', '/api/full-pipeline-demo/metrics'],
    ];

    for (const [method, path] of ENDPOINTS) {
      it(`${method.toUpperCase()} ${path}: anonymous → 401; router+limiter unreached`, async () => {
        const res = await (method === 'post'
          ? request(app).post(path).send({})
          : request(app).get(path));
        expect(res.status).toBe(401);
        expect(spy.fullPipeline.hits).not.toHaveBeenCalled();
        expect(fpLim.limiterHits).not.toHaveBeenCalled();
      });

      it(`${method.toUpperCase()} ${path}: active NON-admin tenant → 403; router+limiter unreached`, async () => {
        const res = await (method === 'post'
          ? request(app).post(path).set('Authorization', `Bearer ${tenantToken()}`).send({})
          : request(app).get(path).set('Authorization', `Bearer ${tenantToken()}`));
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'Platform administrator access required' });
        expect(spy.fullPipeline.hits).not.toHaveBeenCalled();
        expect(fpLim.limiterHits).not.toHaveBeenCalled();
      });
    }

    it('admin mutating request → limiter then router', async () => {
      const res = await request(app)
        .post('/api/full-pipeline-demo/execute')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({});
      expect(res.status).toBe(200);
      expect(fpLim.limiterHits).toHaveBeenCalledTimes(1);
      expect(spy.fullPipeline.hits).toHaveBeenCalledTimes(1);
    });

    it('admin safe-method request → router reached, write budget untouched', async () => {
      const res = await request(app)
        .get('/api/full-pipeline-demo/configurations')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(spy.fullPipeline.hits).toHaveBeenCalledTimes(1);
      expect(fpLim.limiterHits).not.toHaveBeenCalled();
    });
  });
});
