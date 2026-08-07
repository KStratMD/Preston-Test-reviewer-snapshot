/**
 * Prerequisite PR C — operator identity must be established BEFORE any response
 * that depends on whether a configuration exists.
 *
 * Copilot round 3 found this on `POST /:id/activate` and it was fixed there.
 * Codex round 4 found the fix had closed one of FOUR handlers carrying the same
 * shape: `POST /` (create), `PUT /:id` (update) and `POST /import` ran their
 * cross-tenant id-collision precheck ahead of
 * `requireConfigurationCommandContext`.
 *
 * The leak: a caller holding a JWT with a valid tenantId claim but no usable
 * `req.user.id` got
 *
 *   id owned by ANOTHER tenant -> 404 Configuration not found
 *   any other id               -> 401 operator_identity_required
 *
 * Those differ, so the pair is an existence oracle for configuration IDs across
 * the whole store — readable with a credential that is not authorized to perform
 * the action at all. The two cases must be indistinguishable by status, by body,
 * AND by service side effect (the existence lookup must not even run, or a
 * timing/telemetry channel survives).
 *
 * Each handler is asserted on all three axes. The activation route keeps its own
 * coverage in `configuration.activation.test.ts`.
 */

import request from 'supertest';
import express from 'express';

import { createConfigurationRouter } from '../../../src/routes/configuration';
import type { ConfigurationService } from '../../../src/services/ConfigurationService';
import { fakeAuthMiddleware, type FakeUserOverrides } from './_helpers/routerTestAuth';

function createMockConfigService(): jest.Mocked<ConfigurationService> {
  return {
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    getAllConfigurationsForTenant: jest.fn().mockReturnValue([]),
    saveConfiguration: jest.fn().mockResolvedValue(undefined),
    deleteConfiguration: jest.fn(),
    deleteConfigurationForTenant: jest.fn(),
    validateConfiguration: jest.fn(),
    exportConfigurationForTenant: jest.fn(),
    importConfiguration: jest.fn().mockResolvedValue({ imported: true }),
    activateConfigurationForTenant: jest.fn().mockResolvedValue(undefined),
    getConfigurationHistory: jest.fn(),
    restoreConfiguration: jest.fn(),
    duplicateConfiguration: jest.fn(),
  } as unknown as jest.Mocked<ConfigurationService>;
}

function makeApp(configurationService: ConfigurationService, authOverrides: FakeUserOverrides = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/configurations',
    fakeAuthMiddleware(authOverrides),
    createConfigurationRouter({ configurationService }),
  );
  return app;
}

const UNAUTHORIZED = { error: 'unauthorized', reason: 'operator_identity_required' };

/** A complete, valid create/update body — so a 400 can never stand in for the 401. */
const validBody = {
  id: 'cfg-1',
  name: 'SF to NS',
  sourceSystem: 'salesforce',
  targetSystem: 'netsuite',
};

/**
 * The three mutating handlers that build a ConfigurationCommandContext, each
 * exercised (a) against an id owned by ANOTHER tenant — the case that used to
 * return 404 — and (b) against an id that exists nowhere.
 *
 * `getConfigurationForTenant` returning undefined while `getAllConfigurations`
 * contains the id is exactly how the route sees a cross-tenant collision.
 */
const HANDLERS = [
  {
    name: 'POST / (create)',
    send: (app: express.Application, id: string) =>
      request(app).post('/api/configurations').send({ ...validBody, id }),
    serviceCall: 'saveConfiguration' as const,
  },
  {
    name: 'PUT /:id (update)',
    send: (app: express.Application, id: string) =>
      request(app).put(`/api/configurations/${id}`).send({ ...validBody, id: undefined }),
    serviceCall: 'saveConfiguration' as const,
  },
  {
    name: 'POST /import',
    send: (app: express.Application, id: string) =>
      request(app)
        .post('/api/configurations/import')
        .send({ configuration: { ...validBody, id } }),
    serviceCall: 'importConfiguration' as const,
  },
];

describe('configuration routes — identity precedes every existence-dependent reply', () => {
  let configService: jest.Mocked<ConfigurationService>;

  beforeEach(() => {
    configService = createMockConfigService();
    jest.clearAllMocks();
  });

  describe.each(HANDLERS)('$name', ({ send, serviceCall }) => {
    it('returns 401 — not 404 — for a CROSS-TENANT id when the actor id is absent', async () => {
      // Owned by someone else: tenant-scoped lookup misses, global lookup hits.
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([{ id: 'other-tenants-cfg' }]);

      const res = await send(makeApp(configService, { id: '' }), 'other-tenants-cfg');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
      // The existence lookups never ran, so nothing observable distinguishes
      // this from the unknown-id case below.
      expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
      expect(configService.getAllConfigurations).not.toHaveBeenCalled();
      expect(configService[serviceCall]).not.toHaveBeenCalled();
    });

    it('returns the IDENTICAL 401 for an id that exists nowhere', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([]);

      const res = await send(makeApp(configService, { id: '' }), 'does-not-exist-anywhere');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
      expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
      expect(configService.getAllConfigurations).not.toHaveBeenCalled();
      expect(configService[serviceCall]).not.toHaveBeenCalled();
    });

    it('returns the IDENTICAL 401 for an id the caller DOES own', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({
        id: 'cfg-mine',
        tenantId: 'test-tenant',
      });
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([{ id: 'cfg-mine' }]);

      const res = await send(makeApp(configService, { id: '' }), 'cfg-mine');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
      expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
      expect(configService[serviceCall]).not.toHaveBeenCalled();
    });

    it('tenant_required still outranks operator identity when BOTH claims are absent', async () => {
      const res = await send(makeApp(configService, { tenantId: undefined, id: '' }), 'cfg-1');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
    });
  });

  // Body validation sits behind identity for the same reason the existence check
  // does: an unauthorized caller must not learn whether their payload would have
  // been accepted. Create is the only one of the three that can 400 on shape
  // before reaching the service (import's own 400 is asserted alongside it).
  it('create refuses with 401 even for a malformed body, so a 400 cannot leak validity', async () => {
    const res = await request(makeApp(configService, { id: '' }))
      .post('/api/configurations')
      .send({ nonsense: true });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it('import refuses with 401 even for a malformed body', async () => {
    const res = await request(makeApp(configService, { id: '' }))
      .post('/api/configurations/import')
      .send({ notAConfiguration: true });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  // The control: with a full identity the handlers still behave exactly as
  // before — a cross-tenant id is a 404 and an owned id proceeds. Without this,
  // moving the guard to the top of every handler would "pass" even if it had
  // broken the 404 semantics the precheck exists for.
  describe('control — an authorized caller keeps the pre-existing behavior', () => {
    it('create still 404s on a cross-tenant id collision', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([{ id: 'taken' }]);

      const res = await request(makeApp(configService))
        .post('/api/configurations')
        .send({ ...validBody, id: 'taken' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Configuration not found' });
      expect(configService.saveConfiguration).not.toHaveBeenCalled();
    });

    it('update still 404s on a cross-tenant id collision', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([{ id: 'taken' }]);

      const res = await request(makeApp(configService))
        .put('/api/configurations/taken')
        .send({ name: 'x' });

      expect(res.status).toBe(404);
      expect(configService.saveConfiguration).not.toHaveBeenCalled();
    });

    it('import still 404s on a cross-tenant id collision', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([{ id: 'taken' }]);

      const res = await request(makeApp(configService))
        .post('/api/configurations/import')
        .send({ configuration: { ...validBody, id: 'taken' } });

      expect(res.status).toBe(404);
      expect(configService.importConfiguration).not.toHaveBeenCalled();
    });

    it('create still succeeds for an owned id, carrying the operator command context', async () => {
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);
      (configService.getAllConfigurations as jest.Mock).mockReturnValue([]);

      const res = await request(makeApp(configService))
        .post('/api/configurations')
        .send({ ...validBody, id: 'cfg-new' });

      expect(res.status).toBe(201);
      expect(configService.saveConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cfg-new', tenantId: 'test-tenant' }),
        expect.objectContaining({ tenantId: 'test-tenant', operation: 'create' }),
      );
    });
  });
});
