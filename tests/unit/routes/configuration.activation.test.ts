/**
 * Prerequisite PR C — server-side activation of a stored draft configuration
 * by ID: `POST /api/configurations/:id/activate`.
 *
 * The route resolves its configuration from tenant-scoped storage, never the
 * request body: the body accepts ONLY the `_cardinality` authorization
 * envelope (mirroring create/update/import). Unknown and cross-tenant ids
 * return the identical 404 (no existence leak). Tenant/actor identity come
 * from verified request context (`requireTenantId` /
 * `requireConfigurationCommandContext`), never the body.
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
    importConfiguration: jest.fn(),
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

const activatePath = (id: string) => `/api/configurations/${id}/activate`;

describe('POST /api/configurations/:id/activate', () => {
  let configService: jest.Mocked<ConfigurationService>;

  beforeEach(() => {
    configService = createMockConfigService();
    jest.clearAllMocks();
  });

  it('activates a stored, tenant-owned draft and returns 200', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({
      id: 'cfg-1',
      tenantId: 'test-tenant',
      isActive: false,
    });

    const res = await request(makeApp(configService)).post(activatePath('cfg-1')).send({});

    expect(res.status).toBe(200);
    expect(configService.activateConfigurationForTenant).toHaveBeenCalledWith(
      'test-tenant',
      'cfg-1',
      expect.objectContaining({ tenantId: 'test-tenant', operation: 'admin_activation' }),
      undefined,
    );
  });

  it('returns 404 for an unknown configuration id and never calls the service', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

    const res = await request(makeApp(configService)).post(activatePath('missing')).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Configuration not found' });
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it('returns the IDENTICAL 404 for a cross-tenant configuration id as for an unknown one', async () => {
    // getConfigurationForTenant is itself tenant-scoped: a config owned by a
    // different tenant resolves to undefined exactly like an unknown id.
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

    const res = await request(makeApp(configService, { tenantId: 'other-tenant' }))
      .post(activatePath('cfg-owned-by-someone-else'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Configuration not found' });
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it('returns 401 tenant_required when the token carries no tenant claim', async () => {
    const res = await request(makeApp(configService, { tenantId: undefined }))
      .post(activatePath('cfg-1'))
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
    expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it('returns 401 operator_identity_required when the verified actor id is missing', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService, { id: '' })).post(activatePath('cfg-1')).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  // Copilot round 3: identity MUST be established before any response that
  // depends on whether the configuration exists. Otherwise a JWT carrying a
  // tenantId but no usable actor id gets 404 for an unknown id and 401 for a
  // real one — an existence oracle for configuration IDs, readable with a
  // credential that is not authorized to act at all. Both cases must be
  // indistinguishable, and the existence lookup must not even run.
  it('returns 401 — not 404 — for a MISSING id when the actor id is absent, so existence never leaks', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

    const res = await request(makeApp(configService, { id: '' })).post(activatePath('does-not-exist')).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
    // The identical response to the existing-id case above, and the existence
    // lookup never ran — so the two are indistinguishable by status, body, or
    // any service side effect.
    expect(configService.getConfigurationForTenant).not.toHaveBeenCalled();
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  // Copilot R4: `Object.keys()` is defined on every JSON value and returns []
  // for primitives and arrays, so a key-only check accepted a non-object body
  // and proceeded as if it were `{}` — contradicting the "body accepts ONLY the
  // _cardinality envelope" contract.
  //
  // Scoping the finding honestly: `express.json()` defaults to `strict: true`
  // and production mounts it that way (`express.json({ limit: '10mb' })`), so a
  // top-level PRIMITIVE never reaches the handler — body-parser 400s it first.
  // ARRAYS are what strict mode admits, and `[]` was the live hole: zero keys,
  // so it sailed through as `{}` and activated. The route guard covers both
  // regardless, since a router is only as safe as the parser it happens to be
  // mounted behind.
  it.each([
    ['an empty array', []],
    ['a populated array', [{ _cardinality: {} }]],
  ])('rejects %s body at the route with 400 and never activates', async (_label, payload) => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService))
      .post(activatePath('cfg-1'))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['a boolean', true],
    ['a number', 42],
    ['a string', 'activate'],
  ])('rejects %s body with 400 (body-parser strict mode) and never activates', async (_label, payload) => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService))
      .post(activatePath('cfg-1'))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(400);
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  // The control: an ABSENT body is the ordinary case — activation with no
  // `_cardinality` envelope must keep working.
  it('still accepts a request with no body at all', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService)).post(activatePath('cfg-1'));

    expect(res.status).toBe(200);
    expect(configService.activateConfigurationForTenant).toHaveBeenCalled();
  });

  it('rejects body content beyond the _cardinality envelope (systems/authentication/mappings/credentials)', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService))
      .post(activatePath('cfg-1'))
      .send({
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'sneaky-secret' } },
        fieldMappings: [],
        destinations: ['netsuite'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(JSON.stringify(res.body)).not.toContain('sneaky-secret');
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it('forwards the _cardinality envelope as the authorization argument', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });
    const override = {
      reason: 'Evidence is unavailable for this connector; accepted by the data owner.',
      findingKeys: ['relationship_evidence_unavailable|source_to_target|account'],
      reportFingerprint: 'fingerprint-a',
    };
    const samples = [{ accountId: 'a-1', externalId: 'e-1' }];

    const res = await request(makeApp(configService))
      .post(activatePath('cfg-1'))
      .send({ _cardinality: { override, samples } });

    expect(res.status).toBe(200);
    const [tenantId, id, context, authorization] = (configService.activateConfigurationForTenant as jest.Mock).mock
      .calls[0];
    expect(tenantId).toBe('test-tenant');
    expect(id).toBe('cfg-1');
    expect((context as { operation: string }).operation).toBe('admin_activation');
    expect(authorization).toEqual({ override, samples });
  });

  it('rejects an invalid _cardinality override with the strict envelope 400', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });

    const res = await request(makeApp(configService))
      .post(activatePath('cfg-1'))
      .send({
        _cardinality: {
          override: { reason: 'too short', findingKeys: ['k1'], reportFingerprint: 'fp' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(configService.activateConfigurationForTenant).not.toHaveBeenCalled();
  });

  it('returns 404 when the service reports the id as not found (defense in depth past the precheck)', async () => {
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'cfg-1', isActive: false });
    const { NotFoundError } = jest.requireActual('../../../src/errors/NotFoundError');
    (configService.activateConfigurationForTenant as jest.Mock).mockRejectedValue(
      new NotFoundError("Configuration 'cfg-1' not found"),
    );

    const res = await request(makeApp(configService)).post(activatePath('cfg-1')).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Configuration not found' });
  });
});
