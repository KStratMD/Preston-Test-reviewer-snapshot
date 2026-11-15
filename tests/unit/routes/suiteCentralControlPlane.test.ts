// Router-layer contract tests for the SuiteCentral control plane (PR-A6).
//
// The router is the trust boundary: the service and repository below it accept
// typed inputs and do NOT re-check them at runtime, so everything asserted here
// about narrowing, tenant sourcing, and incompatible-input rejection is the
// only thing standing between a request body and a durable row.
//
// The service is mocked throughout — this suite pins what the router SENDS, not
// what the service does with it.

import express, { type Express } from 'express';
import request from 'supertest';
import { createSuiteCentralControlPlaneRouter, createSuiteCentralAllowedHostsRouter } from '../../../src/routes/suiteCentralControlPlane';
import type { SuiteCentralControlPlaneService } from '../../../src/services/suitecentral/controlPlane/SuiteCentralControlPlaneService';
import {
  SuiteCentralConflictError,
  SuiteCentralDependencyError,
  SuiteCentralDestinationRejectedError,
  SuiteCentralForbiddenError,
  SuiteCentralInternalError,
  SuiteCentralNotFoundError,
  SuiteCentralUpstreamError,
  SuiteCentralValidationError,
} from '../../../src/services/suitecentral/controlPlane/errors';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

type ServiceMock = { [K in keyof SuiteCentralControlPlaneService]: jest.Mock };

function serviceMock(): ServiceMock {
  const methods: (keyof SuiteCentralControlPlaneService)[] = [
    'listEnvironments', 'getEnvironment', 'createEnvironment', 'updateEnvironment',
    'listCredentials', 'getCredential', 'createCredential', 'rotateCredential', 'deleteCredential',
    'listTemplates', 'getTemplate', 'createTemplate',
    'getMonitoringConfig', 'setMonitoringConfig', 'startMonitoring', 'stopMonitoring',
    'getHealthReport', 'getHealthHistory', 'getPerformance', 'getAlerts', 'resolveAlert', 'getDashboard',
    'testConnection', 'getSystemInfo', 'bulkImport', 'getBulkOperation', 'createWebhook', 'deleteWebhook',
    'listAllowedHosts', 'createAllowedHost', 'revokeAllowedHost',
  ];
  const mock = {} as ServiceMock;
  for (const name of methods) {
    mock[name] = jest.fn().mockResolvedValue(undefined);
  }
  return mock;
}

/** Mount the tenant router with an injected `req.user`, as authMiddleware would. */
async function tenantApp(service: ServiceMock, user: unknown = { id: 'tenant-admin-1', tenantId: 'tenant-a' }): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user as Express.User;
    next();
  });
  app.use(
    '/api/suitecentral/prod',
    await createSuiteCentralControlPlaneRouter({
      accessMode: 'tenant_admin',
      service: service as unknown as SuiteCentralControlPlaneService,
    }),
  );
  return app;
}

/** Mount the platform router under the `:tenantId` path, as RouteSetup would. */
async function platformApp(service: ServiceMock, user: unknown = { id: 'platform-admin-1', tenantId: 'tenant-of-the-admin' }): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user as Express.User;
    next();
  });
  app.use(
    '/api/admin/tenants/:tenantId/suitecentral',
    await createSuiteCentralControlPlaneRouter({
      accessMode: 'platform_admin',
      service: service as unknown as SuiteCentralControlPlaneService,
    }),
  );
  return app;
}

const ENV_VIEW = {
  id: 'env-1', tenantId: 'tenant-a', name: 'Prod', baseUrl: 'https://suite.example.com',
  environmentTier: 'production', apiVersion: null, timeoutMs: 30000, retryAttempts: 3,
  rateLimitConfig: null, securityConfig: null, featureConfig: null, version: 1,
  createdBy: 'u1', updatedBy: 'u1', createdAt: 'now', updatedAt: 'now',
};

describe('createSuiteCentralControlPlaneRouter — tenant context', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it('sources the target tenant only from the verified JWT claim', async () => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await tenantApp(service);
    await request(app).get('/api/suitecentral/prod/environments').expect(200);

    expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'tenant-admin-1',
      targetTenantId: 'tenant-a',
      accessMode: 'tenant_admin',
    }));
  });

  it.each([
    ['header', (r: request.Test) => r.set('x-tenant-id', 'tenant-evil')],
    ['query', (r: request.Test) => r.query({ tenantId: 'tenant-evil' })],
  ])('ignores a tenant override supplied by %s', async (_label, apply) => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await tenantApp(service);
    await apply(request(app).get('/api/suitecentral/prod/environments')).expect(200);

    expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({ targetTenantId: 'tenant-a' }));
  });

  it('ignores a tenant override supplied in the body', async () => {
    service.createEnvironment.mockResolvedValue(ENV_VIEW);
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/environments')
      .send({ name: 'Prod', baseUrl: 'https://suite.example.com', tenantId: 'tenant-evil', targetTenantId: 'tenant-evil' })
      .expect(201);

    expect(service.createEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ targetTenantId: 'tenant-a' }),
      expect.objectContaining({ name: 'Prod' }),
    );
    // The parsed input carries only known fields — no tenant smuggled through.
    expect(service.createEnvironment.mock.calls[0][1]).not.toHaveProperty('tenantId');
    expect(service.createEnvironment.mock.calls[0][1]).not.toHaveProperty('targetTenantId');
  });

  it('fails closed with 500 when no actor id survived the middleware', async () => {
    const app = await tenantApp(service, { tenantId: 'tenant-a' });
    await request(app).get('/api/suitecentral/prod/environments').expect(500);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  // A blank actor is not an actor. The guard rejects one, but this is the trust
  // boundary and must not depend on that: an unusable id reaching the service
  // would be written to `audit_logs.user_id`, attributing a real mutation to
  // nobody.
  it.each([['   '], ['\t']])('fails closed on a whitespace-only actor id (%j)', async (id) => {
    const app = await tenantApp(service, { id, tenantId: 'tenant-a' });
    await request(app).get('/api/suitecentral/prod/environments').expect(500);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  it('fails closed on a whitespace-only tenant claim', async () => {
    const app = await tenantApp(service, { id: 'tenant-admin-1', tenantId: '   ' });
    await request(app).get('/api/suitecentral/prod/environments').expect(500);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  // These apps mount the router WITHOUT requireSuiteCentralTenantAdmin — which
  // is precisely the scenario worth pinning. The guard rejects the sentinel, so
  // the only way it arrives here is a mis-mount or a future reuse of the router
  // without its guard, and a trust boundary has to survive that rather than hand
  // the system sandbox to a tenant caller.
  it('fails closed on the system sentinel as a tenant claim', async () => {
    const app = await tenantApp(service, { id: 'u1', tenantId: SYSTEM_IDENTITY.tenantId });
    await request(app).get('/api/suitecentral/prod/environments').expect(500);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when no tenant claim survived the middleware', async () => {
    const app = await tenantApp(service, { id: 'tenant-admin-1' });
    await request(app).get('/api/suitecentral/prod/environments').expect(500);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });
});

describe('createSuiteCentralControlPlaneRouter — platform context', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it('sources the target tenant only from the path parameter', async () => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await platformApp(service);
    await request(app).get('/api/admin/tenants/tenant-b/suitecentral/environments').expect(200);

    expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'platform-admin-1',
      targetTenantId: 'tenant-b',
      accessMode: 'platform_admin',
    }));
  });

  it('does not fall back to the admin JWT tenant claim', async () => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await platformApp(service);
    await request(app).get('/api/admin/tenants/tenant-b/suitecentral/environments').expect(200);
    expect(service.listEnvironments).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetTenantId: 'tenant-of-the-admin' }),
    );
  });

  it('rejects the system sentinel as a target tenant', async () => {
    const app = await platformApp(service);
    await request(app)
      .get(`/api/admin/tenants/${SYSTEM_IDENTITY.tenantId}/suitecentral/environments`)
      .expect(400);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  // The target tenant is the one value on this namespace that decides WHOSE
  // data is served, so it is the last place to quietly rewrite. Trimming it
  // pointed `/tenants/%20tenant-b%20/` at tenant-b — the accept-and-transform
  // this module refuses everywhere else.
  it('rejects a padded target tenant rather than normalizing it', async () => {
    const app = await platformApp(service);
    const res = await request(app)
      .get('/api/admin/tenants/%20tenant-b%20/suitecentral/environments')
      .expect(400);
    expect(res.body.error).toBe('invalid_tenant');
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only target tenant', async () => {
    const app = await platformApp(service);
    await request(app).get('/api/admin/tenants/%20%20/suitecentral/environments').expect(400);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only target tenant in the path', async () => {
    const app = await platformApp(service);
    await request(app).get('/api/admin/tenants/%20%20/suitecentral/environments').expect(400);
    expect(service.listEnvironments).not.toHaveBeenCalled();
  });
});

describe('createSuiteCentralControlPlaneRouter — correlation id', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it('adopts a well-formed request correlation id', async () => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await tenantApp(service);
    await request(app)
      .get('/api/suitecentral/prod/environments')
      .set('x-correlation-id', 'abc-123')
      .expect(200);
    expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'abc-123' }));
  });

  it.each([
    ['prose with spaces', 'not a correlation id'],
    ['over the 128 cap', 'a'.repeat(129)],
    ['empty', ''],
  ])('generates a fresh id when the supplied one is %s', async (_label, supplied) => {
    service.listEnvironments.mockResolvedValue([]);
    const app = await tenantApp(service);
    await request(app)
      .get('/api/suitecentral/prod/environments')
      .set('x-correlation-id', supplied)
      .expect(200);

    const { correlationId } = service.listEnvironments.mock.calls[0][0];
    expect(correlationId).not.toBe(supplied);
    expect(correlationId).toMatch(/^[a-zA-Z0-9_.:-]{1,128}$/);
  });

  it('reports the same correlation id in an error body as it gave the service', async () => {
    service.getEnvironment.mockRejectedValue(new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.'));
    const app = await tenantApp(service);
    const res = await request(app)
      .get('/api/suitecentral/prod/environments/env-1')
      .set('x-correlation-id', 'trace-9')
      .expect(404);

    expect(res.body).toEqual({ error: 'environment_not_found', message: 'Environment not found.', correlationId: 'trace-9' });
    expect(service.getEnvironment).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'trace-9' }), 'env-1');
  });
});

describe('createSuiteCentralControlPlaneRouter — incompatible inputs', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it.each([
    ['/api/suitecentral/prod/credentials/prof-1'],
    ['/api/suitecentral/prod/environments/env-1/credentials'],
  ])('rejects a decrypt query on %s without reaching the service', async (path) => {
    const app = await tenantApp(service);
    const res = await request(app).get(path).query({ decrypt: 'true' }).expect(400);
    expect(res.body.error).toBe('decrypt_not_supported');
    expect(service.getCredential).not.toHaveBeenCalled();
    expect(service.listCredentials).not.toHaveBeenCalled();
  });

  it('rejects decrypt regardless of its value', async () => {
    const app = await tenantApp(service);
    await request(app).get('/api/suitecentral/prod/credentials/prof-1').query({ decrypt: 'false' }).expect(400);
    expect(service.getCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/suitecentral/prod/connector/test-connection'],
    ['/api/suitecentral/prod/connector/bulk-import'],
    ['/api/suitecentral/prod/connector/webhooks'],
  ])('rejects an inline authConfig on %s without reaching the service', async (path) => {
    const app = await tenantApp(service);
    const res = await request(app)
      .post(path)
      .send({ environmentId: 'env-1', credentialProfileId: 'prof-1', authConfig: { clientSecret: 'nope' } })
      .expect(400);

    expect(res.body.error).toBe('inline_auth_config_not_supported');
    expect(service.testConnection).not.toHaveBeenCalled();
    expect(service.bulkImport).not.toHaveBeenCalled();
    expect(service.createWebhook).not.toHaveBeenCalled();
  });

  it('does not mistake an inherited authConfig for an own property', async () => {
    service.testConnection.mockResolvedValue({ ok: true });
    const app = await tenantApp(service);
    // `__proto__` in a JSON body is not an own property of the parsed object.
    await request(app)
      .post('/api/suitecentral/prod/connector/test-connection')
      .set('Content-Type', 'application/json')
      .send('{"environmentId":"env-1","credentialProfileId":"prof-1","__proto__":{"authConfig":{}}}')
      .expect(200);
    expect(service.testConnection).toHaveBeenCalled();
  });

  // An empty filter is a malformed request, not a narrower or wider one.
  // Forwarding it made `where source_system = ''` answer "no templates"; folding
  // it to absent would have answered with every template. Both are confident
  // answers to a question nobody asked.
  it.each([
    ['/api/suitecentral/prod/templates', 'sourceSystem', 'listTemplates'],
    ['/api/suitecentral/prod/monitoring/alerts', 'environmentId', 'getAlerts'],
  ] as const)('rejects an empty %s filter instead of guessing', async (path, key, method) => {
    const app = await tenantApp(service);
    for (const raw of ['', '   ']) {
      const res = await request(app).get(path).query({ [key]: raw }).expect(400);
      expect(res.body.error).toBe('invalid_query');
    }
    expect(service[method]).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/suitecentral/prod/templates', 'sourceSystem', 'listTemplates'],
    ['/api/suitecentral/prod/monitoring/alerts', 'environmentId', 'getAlerts'],
  ] as const)('passes a real %s filter through, and undefined when absent', async (path, key, method) => {
    service[method].mockResolvedValue([]);
    const app = await tenantApp(service);

    await request(app).get(path).query({ [key]: 'netsuite' }).expect(200);
    expect(service[method]).toHaveBeenLastCalledWith(expect.anything(), 'netsuite');

    await request(app).get(path).expect(200);
    expect(service[method]).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });

  // The required connector pair rode a truthiness check, which catches '' but
  // NOT '   ' — a whitespace-only id is truthy, so it passed the guard and
  // reached a service that does not re-check it, on routes that drive outbound
  // calls. Blank is missing, not a value.
  it.each([
    ['/api/suitecentral/prod/connector/bulk-operations/op-1', 'getBulkOperation'],
    ['/api/suitecentral/prod/system/info', 'getSystemInfo'],
  ] as const)('rejects blank connector-target query values on GET %s', async (path, method) => {
    const app = await tenantApp(service);
    for (const query of [
      { environmentId: '   ', credentialProfileId: 'prof-1' },
      { environmentId: 'env-1', credentialProfileId: '   ' },
      { environmentId: '', credentialProfileId: 'prof-1' },
    ]) {
      const res = await request(app).get(path).query(query).expect(400);
      expect(res.body.error).toBe('invalid_query');
    }
    expect(service[method]).not.toHaveBeenCalled();
  });

  it('rejects blank connector-target query values on DELETE /connector/webhooks', async () => {
    const app = await tenantApp(service);
    await request(app)
      .delete('/api/suitecentral/prod/connector/webhooks/wh-1')
      .query({ environmentId: '  ', credentialProfileId: 'prof-1' })
      .expect(400);
    expect(service.deleteWebhook).not.toHaveBeenCalled();
  });

  // These two ids are pasted into an outbound URL rather than looked up in a
  // tenant-scoped table, so a blank one spends a real authenticated request on
  // a URL that cannot mean anything.
  it('rejects a blank operationId rather than sending it upstream', async () => {
    const app = await tenantApp(service);
    const res = await request(app)
      .get('/api/suitecentral/prod/connector/bulk-operations/%20%20')
      .query({ environmentId: 'env-1', credentialProfileId: 'prof-1' })
      .expect(400);
    expect(res.body.error).toBe('invalid_path');
    expect(service.getBulkOperation).not.toHaveBeenCalled();
  });

  it('rejects a blank webhookId rather than sending it upstream', async () => {
    const app = await tenantApp(service);
    await request(app)
      .delete('/api/suitecentral/prod/connector/webhooks/%20%20')
      .query({ environmentId: 'env-1', credentialProfileId: 'prof-1' })
      .expect(400);
    expect(service.deleteWebhook).not.toHaveBeenCalled();
  });

  // A blank entry is not a value the caller meant, and nothing below re-checks
  // it: `events: ['']` registered a meaningless upstream subscription.
  it('rejects blank entries in a required string array', async () => {
    const app = await tenantApp(service);
    for (const events of [[''], ['   '], ['valid', '  ']]) {
      const res = await request(app)
        .post('/api/suitecentral/prod/connector/webhooks')
        .send({ environmentId: 'env-1', credentialProfileId: 'prof-1', targetUrl: 'https://x.example.com', events })
        .expect(400);
      expect(res.body.error).toBe('invalid_field');
    }
    expect(service.createWebhook).not.toHaveBeenCalled();
  });

  it('rejects blank entries in an optional string array', async () => {
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 's', scopes: ['ok', ' '] })
      .expect(400);
    expect(service.createCredential).not.toHaveBeenCalled();
  });

  // Nothing here means one thing padded and another trimmed, and every consumer
  // compares exactly: `name` has a unique index on the raw value, so 'Prod' and
  // 'Prod ' are two environments an operator cannot tell apart and the 409 never
  // fires. Rejected rather than trimmed — storing something the caller did not
  // send is the transform this layer refuses.
  it.each([
    ['name', { name: 'Prod ', baseUrl: 'https://x.example.com' }],
    ['baseUrl', { name: 'Prod', baseUrl: ' https://x.example.com' }],
  ] as const)('rejects a padded %s on environment create', async (_label, body) => {
    const app = await tenantApp(service);
    const res = await request(app).post('/api/suitecentral/prod/environments').send(body).expect(400);
    expect(res.body.error).toBe('invalid_field');
    expect(service.createEnvironment).not.toHaveBeenCalled();
  });

  it('rejects a padded name on environment update', async () => {
    const app = await tenantApp(service);
    await request(app)
      .put('/api/suitecentral/prod/environments/env-1')
      .send({ expectedVersion: 1, name: 'Prod ' })
      .expect(400);
    expect(service.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rejects a padded sourceSystem on template create', async () => {
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/templates')
      .send({ name: 'T', sourceSystem: ' NetSuite ' })
      .expect(400);
    expect(service.createTemplate).not.toHaveBeenCalled();
  });

  // `?sourceSystem=%20NetSuite%20` filtered on the literal ' NetSuite ', which
  // the exact `where source_system = ?` never matches — a real tenant with real
  // templates told it has none.
  it('rejects a padded query filter instead of matching nothing', async () => {
    const app = await tenantApp(service);
    const res = await request(app)
      .get('/api/suitecentral/prod/templates')
      .query({ sourceSystem: ' NetSuite ' })
      .expect(400);
    expect(res.body.error).toBe('invalid_query');
    expect(service.listTemplates).not.toHaveBeenCalled();
  });

  // The padding rule covers values this system MATCHES on. A provider-issued
  // credential is opaque bytes forwarded verbatim upstream, and no provider
  // contract forbids surrounding whitespace — rejecting one is the same overreach
  // as trimming it, just louder: it makes a credential the operator legitimately
  // holds impossible to store.
  it('carries a padded provider credential byte-for-byte', async () => {
    service.createCredential.mockResolvedValue({ id: 'prof-1' });
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: ' cid ', clientSecret: ' secret ', companyId: ' co ' })
      .expect(201);
    expect(service.createCredential).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: ' cid ', clientSecret: ' secret ', companyId: ' co ' }),
    );
  });

  it('carries padded free prose byte-for-byte', async () => {
    service.createTemplate.mockResolvedValue({ id: 't1' });
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/templates')
      .send({ name: 'T', sourceSystem: 'NetSuite', description: ' spaced out ' })
      .expect(201);
    expect(service.createTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: ' spaced out ' }),
    );
  });

  // The array equivalent of every string's `max`: the 10mb body limit is an
  // aggregate bound, so without this a 1,001-entry targetEntities is serialized
  // into a durable row and an unbounded batch is forwarded upstream.
  it('bounds structured arrays by entry count', async () => {
    const app = await tenantApp(service);
    const res = await request(app)
      .post('/api/suitecentral/prod/templates')
      .send({ name: 'T', sourceSystem: 'NetSuite', targetEntities: Array.from({ length: 101 }, (_, i) => `e${i}`) })
      .expect(400);
    expect(res.body.error).toBe('invalid_field');
    expect(service.createTemplate).not.toHaveBeenCalled();
  });

  it('bounds a bulk import batch, above the default array bound', async () => {
    const app = await tenantApp(service);
    const record = { id: 1 };
    await request(app)
      .post('/api/suitecentral/prod/connector/bulk-import')
      .send({
        environmentId: 'env-1',
        credentialProfileId: 'prof-1',
        entityType: 'Customer',
        records: Array.from({ length: 1001 }, () => record),
      })
      .expect(400);
    expect(service.bulkImport).not.toHaveBeenCalled();

    // The volume path itself still works AT the bound — and every record
    // arrives. Asserting only the 202 would pass an implementation that
    // silently truncated the batch, which is the failure a bound invites.
    service.bulkImport.mockResolvedValue('op-1');
    await request(app)
      .post('/api/suitecentral/prod/connector/bulk-import')
      .send({
        environmentId: 'env-1',
        credentialProfileId: 'prof-1',
        entityType: 'Customer',
        records: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
      })
      .expect(202);
    const forwarded = service.bulkImport.mock.calls[0][4];
    expect(forwarded).toHaveLength(1000);
    expect(forwarded[0]).toEqual({ id: 0 });
    expect(forwarded[999]).toEqual({ id: 999 });
  });

  // `companyId: '   '` was persisted and then handed verbatim to
  // connector.initialize(), where it becomes an auth failure nobody can trace
  // back to a form. "None" already has a spelling: omit the key, or send null.
  it('rejects blank optional strings but still accepts null', async () => {
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 's', companyId: '   ' })
      .expect(400);
    expect(service.createCredential).not.toHaveBeenCalled();

    service.createCredential.mockResolvedValue({ id: 'prof-1' });
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 's', companyId: null })
      .expect(201);
    expect(service.createCredential).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId: null }));
  });

  // Every other string here is capped; array entries were not, so a multi-MB
  // scope was persisted and the equivalent event forwarded upstream. The global
  // 10mb express.json limit bounds the body, not the field.
  it('bounds string-array entries by length and count', async () => {
    const app = await tenantApp(service);
    for (const scopes of [['x'.repeat(257)], Array.from({ length: 101 }, (_, i) => `scope-${i}`)]) {
      const res = await request(app)
        .post('/api/suitecentral/prod/credentials')
        .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 's', scopes })
        .expect(400);
      expect(res.body.error).toBe('invalid_field');
    }
    expect(service.createCredential).not.toHaveBeenCalled();
  });

  it('accepts string arrays at the bounds', async () => {
    service.createCredential.mockResolvedValue({ id: 'prof-1' });
    const app = await tenantApp(service);
    const scopes = ['x'.repeat(256), ...Array.from({ length: 99 }, (_, i) => `scope-${i}`)];
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 's', scopes })
      .expect(201);
    expect(service.createCredential).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scopes }));
  });

  it('does not let inherited properties satisfy required fields', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'tenant-admin-1', tenantId: 'tenant-a' } as Express.User;
      // Simulate a parser that let a `__proto__` key mutate the prototype:
      // the required pair exists ONLY on the prototype chain, never as the
      // body's own keys. The router must treat that body as missing both.
      req.body = Object.create({ environmentId: 'env-1', credentialProfileId: 'prof-1' });
      next();
    });
    app.use(
      '/api/suitecentral/prod',
      await createSuiteCentralControlPlaneRouter({
        accessMode: 'tenant_admin',
        service: service as unknown as SuiteCentralControlPlaneService,
      }),
    );
    await request(app).post('/api/suitecentral/prod/connector/test-connection').expect(400);
    expect(service.testConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['environmentId', { credentialProfileId: 'prof-1' }],
    ['credentialProfileId', { environmentId: 'env-1' }],
  ])('requires %s on connector bodies', async (_label, body) => {
    const app = await tenantApp(service);
    await request(app).post('/api/suitecentral/prod/connector/test-connection').send(body).expect(400);
    expect(service.testConnection).not.toHaveBeenCalled();
  });

  it('has no performance update route', async () => {
    const app = await tenantApp(service);
    await request(app).post('/api/suitecentral/prod/performance/env-1/update').send({ foo: 1 }).expect(404);
  });

  it('has no insights route', async () => {
    const app = await tenantApp(service);
    await request(app).get('/api/suitecentral/prod/monitoring/insights/env-1').expect(404);
  });
});

describe('createSuiteCentralControlPlaneRouter — input narrowing', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it.each([
    ['a non-string name', { name: { $ne: null }, baseUrl: 'https://x.example.com' }],
    ['a missing name', { baseUrl: 'https://x.example.com' }],
    ['a non-string baseUrl', { name: 'Prod', baseUrl: 42 }],
    ['a bad environmentTier', { name: 'Prod', baseUrl: 'https://x.example.com', environmentTier: 'staging' }],
    ['a non-integer timeoutMs', { name: 'Prod', baseUrl: 'https://x.example.com', timeoutMs: 'soon' }],
    ['a non-object rateLimitConfig', { name: 'Prod', baseUrl: 'https://x.example.com', rateLimitConfig: 'lots' }],
  ])('rejects %s on environment create', async (_label, body) => {
    const app = await tenantApp(service);
    await request(app).post('/api/suitecentral/prod/environments').send(body).expect(400);
    expect(service.createEnvironment).not.toHaveBeenCalled();
  });

  // `upsertMonitoringConfig` uses expectedVersion 0 to mean "create" (its
  // docblock: "pass 0 to create"). The router rejected 0 as out of range, so
  // monitoring could never be enabled for an environment that had no config
  // row yet — the first write is always the one that cannot happen. Every other
  // expectedVersion in this API is a pure CAS on an existing row and stays >= 1.
  it('accepts expectedVersion 0 on monitoring config — the create case', async () => {
    service.setMonitoringConfig.mockResolvedValue({ id: 'm1', version: 1 });
    const app = await tenantApp(service);
    await request(app)
      .put('/api/suitecentral/prod/monitoring/config/env-1')
      .send({ expectedVersion: 0, enabled: true })
      .expect(200);

    expect(service.setMonitoringConfig).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      { enabled: true },
      0,
    );
  });

  it('accepts a positive expectedVersion on monitoring config — the update case', async () => {
    service.setMonitoringConfig.mockResolvedValue({ id: 'm1', version: 3 });
    const app = await tenantApp(service);
    await request(app)
      .put('/api/suitecentral/prod/monitoring/config/env-1')
      .send({ expectedVersion: 2, enabled: false, intervalMs: 60000 })
      .expect(200);

    expect(service.setMonitoringConfig).toHaveBeenCalledWith(
      expect.anything(),
      'env-1',
      { enabled: false, intervalMs: 60000 },
      2,
    );
  });

  it.each([[-1], [1.5], ['0'], [null]])(
    'still rejects a non-integer monitoring expectedVersion (%p)',
    async (expectedVersion) => {
      const app = await tenantApp(service);
      await request(app)
        .put('/api/suitecentral/prod/monitoring/config/env-1')
        .send({ expectedVersion, enabled: true })
        .expect(400);
      expect(service.setMonitoringConfig).not.toHaveBeenCalled();
    },
  );

  it('requires an expectedVersion on monitoring config', async () => {
    const app = await tenantApp(service);
    await request(app)
      .put('/api/suitecentral/prod/monitoring/config/env-1')
      .send({ enabled: true })
      .expect(400);
    expect(service.setMonitoringConfig).not.toHaveBeenCalled();
  });

  it('requires a numeric expectedVersion on environment update', async () => {
    const app = await tenantApp(service);
    await request(app).put('/api/suitecentral/prod/environments/env-1').send({ name: 'x' }).expect(400);
    expect(service.updateEnvironment).not.toHaveBeenCalled();
  });

  it('passes a parsed environment patch with its expectedVersion', async () => {
    service.updateEnvironment.mockResolvedValue(ENV_VIEW);
    const app = await tenantApp(service);
    await request(app)
      .put('/api/suitecentral/prod/environments/env-1')
      .send({ expectedVersion: 4, name: 'Renamed', timeoutMs: 5000 })
      .expect(200);

    expect(service.updateEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ targetTenantId: 'tenant-a' }),
      'env-1',
      4,
      { name: 'Renamed', timeoutMs: 5000 },
    );
  });

  // fieldMappings/syncSettings are non-nullable in CreateTemplateInput (unlike
  // description). Folding an explicit null to "absent" would silently persist
  // `{}` for a caller who asked for something else.
  it.each([['fieldMappings'], ['syncSettings']])(
    'rejects an explicit null %s on template create rather than coercing it',
    async (field) => {
      const app = await tenantApp(service);
      await request(app)
        .post('/api/suitecentral/prod/templates')
        .send({ name: 't', sourceSystem: 'netsuite', [field]: null })
        .expect(400);
      expect(service.createTemplate).not.toHaveBeenCalled();
    },
  );

  it('still allows an omitted fieldMappings/syncSettings', async () => {
    service.createTemplate.mockResolvedValue({ id: 't1' });
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/templates')
      .send({ name: 't', sourceSystem: 'netsuite' })
      .expect(201);
    const input = service.createTemplate.mock.calls[0][1];
    expect(input).not.toHaveProperty('fieldMappings');
    expect(input).not.toHaveProperty('syncSettings');
  });

  it('still allows an explicit null description, which IS nullable', async () => {
    service.createTemplate.mockResolvedValue({ id: 't1' });
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/templates')
      .send({ name: 't', sourceSystem: 'netsuite', description: null })
      .expect(201);
    expect(service.createTemplate.mock.calls[0][1].description).toBeNull();
  });

  it('requires a non-empty clientSecret on credential create', async () => {
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: '' })
      .expect(400);
    expect(service.createCredential).not.toHaveBeenCalled();
  });

  it('requires an expectedVersion query on credential delete', async () => {
    const app = await tenantApp(service);
    await request(app).delete('/api/suitecentral/prod/credentials/prof-1').expect(400);
    expect(service.deleteCredential).not.toHaveBeenCalled();
  });

  it('parses the expectedVersion query on credential delete', async () => {
    service.deleteCredential.mockResolvedValue(undefined);
    const app = await tenantApp(service);
    await request(app).delete('/api/suitecentral/prod/credentials/prof-1').query({ expectedVersion: '7' }).expect(204);
    expect(service.deleteCredential).toHaveBeenCalledWith(expect.anything(), 'prof-1', 7);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['1e3']])(
    'rejects a non-positive-integer expectedVersion (%s)',
    async (value) => {
      const app = await tenantApp(service);
      await request(app).delete('/api/suitecentral/prod/credentials/prof-1').query({ expectedVersion: value }).expect(400);
      expect(service.deleteCredential).not.toHaveBeenCalled();
    },
  );

  // The runtime `unshift`es each new sample, so history is newest-first and
  // element 0 is the latest. This route depends on that ordering across two
  // modules; if the runtime ever appends instead, this catches it as a stale
  // reading rather than an obvious failure.
  it('answers latest-health with the newest stored sample', async () => {
    const newest = { status: 'healthy', responseTimeMs: 12, checkedAt: '2026-07-16T10:00:00Z', errorCode: null };
    const older = { status: 'unhealthy', responseTimeMs: 99, checkedAt: '2026-07-16T09:00:00Z', errorCode: 'x' };
    service.getHealthHistory.mockResolvedValue([newest, older]);
    const app = await tenantApp(service);
    const res = await request(app).get('/api/suitecentral/prod/monitoring/health/env-1').expect(200);

    expect(service.getHealthHistory).toHaveBeenCalledWith(expect.anything(), 'env-1', 1);
    expect(res.body).toEqual(newest);
  });

  it('answers latest-health with null when nothing has been sampled', async () => {
    service.getHealthHistory.mockResolvedValue([]);
    const app = await tenantApp(service);
    const res = await request(app).get('/api/suitecentral/prod/monitoring/health/env-1').expect(200);
    expect(res.body).toBeNull();
  });

  it('caps and parses the health-history limit', async () => {
    service.getHealthHistory.mockResolvedValue([]);
    const app = await tenantApp(service);
    await request(app).get('/api/suitecentral/prod/monitoring/health/env-1/history').query({ limit: '10' }).expect(200);
    expect(service.getHealthHistory).toHaveBeenCalledWith(expect.anything(), 'env-1', 10);
  });

  it('rejects a non-numeric health-history limit', async () => {
    const app = await tenantApp(service);
    await request(app).get('/api/suitecentral/prod/monitoring/health/env-1/history').query({ limit: 'all' }).expect(400);
    expect(service.getHealthHistory).not.toHaveBeenCalled();
  });

  it('rejects a bulk-import records payload that is not an array of objects', async () => {
    const app = await tenantApp(service);
    await request(app)
      .post('/api/suitecentral/prod/connector/bulk-import')
      .send({ environmentId: 'env-1', credentialProfileId: 'prof-1', entityType: 'customer', records: ['nope'] })
      .expect(400);
    expect(service.bulkImport).not.toHaveBeenCalled();
  });
});

describe('createSuiteCentralControlPlaneRouter — secret hygiene', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it('sends the secret to the service exactly once and never echoes it', async () => {
    service.createCredential.mockResolvedValue({
      id: 'prof-1', environmentId: 'env-1', name: 'p', clientId: 'c', companyId: null,
      scopes: [], isActive: true, secretConfigured: true, rotatedAt: null, lastUsedAt: null, version: 1,
    });
    const app = await tenantApp(service);
    const res = await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientId: 'c', clientSecret: 'super-secret-value' })
      .expect(201);

    expect(service.createCredential).toHaveBeenCalledTimes(1);
    expect(service.createCredential.mock.calls[0][1].clientSecret).toBe('super-secret-value');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    expect(res.body).not.toHaveProperty('clientSecret');
  });

  it('never echoes the secret in a validation error body', async () => {
    const app = await tenantApp(service);
    const res = await request(app)
      .post('/api/suitecentral/prod/credentials')
      .send({ environmentId: 'env-1', name: 'p', clientSecret: 'super-secret-value' })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });

  it('never echoes the secret when the service rejects a rotation', async () => {
    service.rotateCredential.mockRejectedValue(new SuiteCentralConflictError('credential_version_conflict', 'Version conflict.'));
    const app = await tenantApp(service);
    const res = await request(app)
      .post('/api/suitecentral/prod/credentials/prof-1/rotate')
      .send({ expectedVersion: 2, clientSecret: 'super-secret-value' })
      .expect(409);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });
});

describe('createSuiteCentralControlPlaneRouter — error mapping', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  it.each([
    [new SuiteCentralValidationError('bad_input', 'Bad input.'), 400],
    [new SuiteCentralForbiddenError('platform_admin_required', 'Platform administrator access required.'), 403],
    [new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.'), 404],
    [new SuiteCentralConflictError('environment_name_conflict', 'Conflict.'), 409],
    [new SuiteCentralDestinationRejectedError('destination_rejected', 'Rejected.'), 422],
    [new SuiteCentralInternalError('internal_error', 'Internal.'), 500],
    [new SuiteCentralUpstreamError('upstream_failed', 'Upstream failed.'), 502],
    [new SuiteCentralDependencyError('dependency_unavailable', 'Unavailable.'), 503],
  ])('maps %p to its status', async (error, expected) => {
    service.listEnvironments.mockRejectedValue(error);
    const app = await tenantApp(service);
    const res = await request(app).get('/api/suitecentral/prod/environments').expect(expected);
    expect(res.body).toEqual({
      error: expect.any(String),
      message: expect.any(String),
      correlationId: expect.any(String),
    });
  });

  it('collapses an unmodelled error to 500 without leaking its message', async () => {
    service.listEnvironments.mockRejectedValue(new Error('ORA-00933: connect ec2-1-2-3-4.compute.amazonaws.com failed'));
    const app = await tenantApp(service);
    const res = await request(app).get('/api/suitecentral/prod/environments').expect(500);

    expect(res.body.error).toBe('internal_error');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ORA-00933');
    expect(body).not.toContain('amazonaws');
  });
});

describe('createSuiteCentralAllowedHostsRouter', () => {
  let service: ServiceMock;
  beforeEach(() => { service = serviceMock(); });

  async function allowlistApp(user: unknown = { id: 'platform-admin-1', tenantId: 'tenant-of-the-admin' }): Promise<Express> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = user as Express.User;
      next();
    });
    app.use(
      '/api/admin/suitecentral/allowed-hosts',
      await createSuiteCentralAllowedHostsRouter({ service: service as unknown as SuiteCentralControlPlaneService }),
    );
    return app;
  }

  it('lists hosts under a platform_admin context', async () => {
    service.listAllowedHosts.mockResolvedValue([]);
    await request(await allowlistApp()).get('/api/admin/suitecentral/allowed-hosts').expect(200);
    expect(service.listAllowedHosts).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'platform-admin-1',
      accessMode: 'platform_admin',
    }));
  });

  // The allowlist is global. Attributing its audit rows to the acting admin's
  // own tenant would imply a tenant-scoped change that never happened.
  it('attributes the audit context to the system tenant, not the admin JWT tenant', async () => {
    service.listAllowedHosts.mockResolvedValue([]);
    await request(await allowlistApp()).get('/api/admin/suitecentral/allowed-hosts').expect(200);
    expect(service.listAllowedHosts).toHaveBeenCalledWith(expect.objectContaining({
      targetTenantId: SYSTEM_IDENTITY.tenantId,
    }));
  });

  // SuiteCentralOutboundPolicy canonicalizes a destination with
  // domainToASCII().toLowerCase() and then matches the allowlist EXACTLY, so a
  // row stored as the admin typed it reads `active` in the UI and can never
  // authorize anything. Canonicalizing here — and returning what was stored —
  // is the only way the admin sees the host as it will actually be matched.
  it.each([
    ['uppercase', 'SUITE.EXAMPLE.COM', 'suite.example.com'],
    ['unicode', 'münchen.example.com', 'xn--mnchen-3ya.example.com'],
    // The punycode escape hatch for the contextual-joiner restriction above:
    // this is the same host as `ط‌بل.example`, spelled in the ASCII form the
    // outbound check matches on, and it canonicalizes to itself.
    ['already-punycode joiner', 'xn--ngb3a2bw89p.example', 'xn--ngb3a2bw89p.example'],
  ] as const)('canonicalizes a %s hostname to the form the outbound check looks up', async (_label, supplied, expected) => {
    service.createAllowedHost.mockResolvedValue({ id: 'h1', hostname: expected });
    await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname: supplied })
      .expect(201);
    expect(service.createAllowedHost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hostname: expected }),
    );
  });

  // domainToASCII is a canonicalizer, not a validator, and it silently REPAIRS:
  // it percent-decodes, so `%65xample.com` becomes example.com. On an allowlist
  // the input has to be recognizable as what it authorizes, so a typo — or an
  // obfuscated entry in a review — must not quietly become a real host.
  it.each([
    ['percent-encoding', '%65xample.com'],
    // Invisible: reads as foobar.com, and domainToASCII would MAKE it
    // foobar.com. An entry that survives review by looking like a host the
    // reviewer trusts.
    ['a zero-width space', 'foo\u200Bbar.com'],
    ['a soft hyphen', 'foo\u00ADbar.com'],
    ['an empty label', 'foo..bar.com'],
    ['an overlong label', `${'a'.repeat(64)}.example.com`],
    // DNS host labels cannot start or end with a hyphen, and domainToASCII
    // passes both through untouched — another entry that reads active and can
    // never resolve.
    ['a leading hyphen in a label', '-example.com'],
    ['a trailing hyphen in a label', 'example-.com'],
    // ZWNJ here is a valid CONTEXTJ joiner per UTS #46, but it is invisible,
    // and an allowlist entry whose identity turns on a character no reviewer
    // can see cannot be reviewed. Deliberate restriction — the punycode
    // spelling of the same host is accepted (test below).
    ['a contextual joiner (ZWNJ)', 'ط‌بل.example'],
  ])('rejects a hostname carrying %s rather than repairing it', async (_label, hostname) => {
    const res = await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname })
      .expect(400);
    expect(res.body.error).toBe('invalid_field');
    expect(service.createAllowedHost).not.toHaveBeenCalled();
  });

  // Guessing which part of a URL was meant to be the host is how an allowlist
  // entry ends up authorizing something nobody asked for.
  it.each([
    ['a scheme', 'https://suite.example.com'],
    ['a port', 'suite.example.com:443'],
    ['a path', 'suite.example.com/api'],
    ['credentials', 'user@suite.example.com'],
  ])('rejects a hostname carrying %s', async (_label, hostname) => {
    const res = await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname })
      .expect(400);
    expect(res.body.error).toBe('invalid_field');
    expect(service.createAllowedHost).not.toHaveBeenCalled();
  });

  // The repository reads an empty list as "use the default", so `[]` — which
  // any caller would read as "no ports at all" — silently broadens the
  // allowlist to 443. This list is what an egress check consults.
  it('rejects an explicit empty allowedPorts rather than defaulting it to 443', async () => {
    const res = await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname: 'suite.example.com', allowedPorts: [] })
      .expect(400);
    expect(res.body.error).toBe('invalid_field');
    expect(service.createAllowedHost).not.toHaveBeenCalled();
  });

  it('still accepts an omitted allowedPorts, which is how the default is asked for', async () => {
    service.createAllowedHost.mockResolvedValue({ id: 'h1', hostname: 'suite.example.com' });
    await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname: 'suite.example.com' })
      .expect(201);
    expect(service.createAllowedHost).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ allowedPorts: expect.anything() }),
    );
  });

  it('does not accept a target tenant from the caller', async () => {
    service.createAllowedHost.mockResolvedValue({ id: 'h1', hostname: 'suite.example.com' });
    await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname: 'suite.example.com', tenantId: 'tenant-evil' })
      .expect(201);

    expect(service.createAllowedHost).toHaveBeenCalledWith(
      expect.objectContaining({ targetTenantId: SYSTEM_IDENTITY.tenantId }),
      expect.objectContaining({ hostname: 'suite.example.com' }),
    );
    expect(service.createAllowedHost.mock.calls[0][1]).not.toHaveProperty('tenantId');
  });

  it('requires a hostname on create', async () => {
    await request(await allowlistApp()).post('/api/admin/suitecentral/allowed-hosts').send({}).expect(400);
    expect(service.createAllowedHost).not.toHaveBeenCalled();
  });

  it('rejects a non-integer port', async () => {
    await request(await allowlistApp())
      .post('/api/admin/suitecentral/allowed-hosts')
      .send({ hostname: 'suite.example.com', allowedPorts: [443, 'ssl'] })
      .expect(400);
    expect(service.createAllowedHost).not.toHaveBeenCalled();
  });

  it('revokes a host by id', async () => {
    service.revokeAllowedHost.mockResolvedValue({ id: 'h1', status: 'revoked' });
    await request(await allowlistApp()).post('/api/admin/suitecentral/allowed-hosts/h1/revoke').expect(200);
    expect(service.revokeAllowedHost).toHaveBeenCalledWith(expect.anything(), 'h1');
  });

  it('maps a service forbidden error to 403', async () => {
    service.listAllowedHosts.mockRejectedValue(
      new SuiteCentralForbiddenError('platform_admin_required', 'Platform administrator access required.'),
    );
    await request(await allowlistApp()).get('/api/admin/suitecentral/allowed-hosts').expect(403);
  });
});
