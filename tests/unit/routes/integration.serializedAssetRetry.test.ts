/**
 * Route-layer contract tests for
 * POST /api/integrations/:id/serialized-assets/retry-deferred (Task 9,
 * 2026-07-27 NetSuite serialized-asset sync plan).
 *
 * `IntegrationService` is mocked throughout — this suite pins what the route
 * SENDS to `retryDeferredSerializedAssetsForTenant` and how it maps the
 * service's typed errors to HTTP status, not the service's internal logic
 * (covered separately in
 * tests/unit/services/IntegrationService.serializedAssetDispatch.test.ts).
 *
 * The route is the trust boundary for decision 11 (an early retry that
 * bypasses a deferred unit's `next_attempt_at` / the `MAX_DEFERRAL_ATTEMPTS`
 * ceiling): every case here proves that boundary holds — unauthenticated,
 * non-admin, tenant-less, and body-spoofed callers are all refused or
 * neutralized before the verified actor/tenant ever reaches the service.
 */

import request from 'supertest';
import express, { type Express } from 'express';
import type { IntegrationService } from '../../../src/services/IntegrationService';
import { createIntegrationRouter } from '../../../src/routes/integration';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { BadRequestAppError, ConflictAppError, ServiceUnavailableAppError } from '../../../src/errors/AppError';
import { SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS } from '../../../src/middleware/rateLimit';

const CONFIG_ID = 'cfg-sa-1';

function makeMockIntegrationService(): jest.Mocked<Pick<IntegrationService, 'retryDeferredSerializedAssetsForTenant'>> {
  return {
    retryDeferredSerializedAssetsForTenant: jest.fn(),
  } as unknown as jest.Mocked<Pick<IntegrationService, 'retryDeferredSerializedAssetsForTenant'>>;
}

/** Mirrors the route's own CORRELATION_ID_PATTERN. */
const CORRELATION_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

function makeApp(
  integrationService: Pick<IntegrationService, 'retryDeferredSerializedAssetsForTenant'>,
  user?: unknown,
  requestOverrides?: { correlationId?: string },
): Express {
  const app = express();
  app.use(express.json());
  if (user !== undefined) {
    app.use((req, _res, next) => {
      req.user = user as Express.User;
      next();
    });
  }
  if (requestOverrides?.correlationId !== undefined) {
    // Stands in for the observability middleware, which populates
    // req.correlationId from the caller's x-correlation-id header.
    const injected = requestOverrides.correlationId;
    app.use((req, _res, next) => {
      (req as typeof req & { correlationId?: string }).correlationId = injected;
      next();
    });
  }
  const router = createIntegrationRouter({
    integrationService: integrationService as IntegrationService,
  });
  app.use(router);
  return app;
}

const TENANT_ADMIN_USER = { id: 'admin-1', tenantId: 'tenant-a', roles: ['tenant_admin'], permissions: [] };

const successResult = {
  integrationId: CONFIG_ID,
  syncId: 'serialized_asset_forced_retry_1',
  status: 'success' as const,
  success: true,
  recordsProcessed: 3,
  recordsSuccessful: 3,
  recordsFailed: 0,
  errors: [],
  startTime: new Date(),
  endTime: new Date(),
};

describe('POST /api/integrations/:id/serialized-assets/retry-deferred', () => {
  it('rejects an anonymous request with 401 and never calls the service', async () => {
    const service = makeMockIntegrationService();
    const app = makeApp(service, undefined);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(401);
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();
  });

  it('rejects an authenticated non-admin with 403 and never calls the service', async () => {
    const service = makeMockIntegrationService();
    const app = makeApp(service, { id: 'u1', tenantId: 'tenant-a', roles: ['user'], permissions: [] });

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(403);
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();
  });

  // Task 9's governing concern: `suitecentral:admin` is unrelated authority
  // for an ERP retry command. Proven end-to-end through the mounted route,
  // not just the isolated middleware unit.
  it('rejects a SuiteCentral-only admin (suitecentral:admin permission, no tenant_admin role) with 403', async () => {
    const service = makeMockIntegrationService();
    const app = makeApp(service, { id: 'u1', tenantId: 'tenant-a', roles: [], permissions: ['suitecentral:admin'] });

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(403);
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();
  });

  it('rejects a tenant_admin claim with no tenantId with 401 and never calls the service', async () => {
    const service = makeMockIntegrationService();
    const app = makeApp(service, { id: 'u1', roles: ['tenant_admin'], permissions: [] });

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(401);
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();
  });

  it('maps a cross-tenant/missing configuration id to 404', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(
      new NotFoundError(`Configuration ${CONFIG_ID} not found`),
    );
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(404);
  });

  it('maps a wrong-profile configuration (not netsuite_serialized_asset) to 400', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(
      new BadRequestAppError(
        `Configuration ${CONFIG_ID} does not use the netsuite_serialized_asset execution profile`,
      ),
    );
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(400);
    // Status is taken from the AppError; the MESSAGE is this route's own fixed
    // text, never the thrower's (see mapSerializedAssetRetryError).
    expect(res.body.error).toBe('Serialized-asset forced retry request was rejected');
    expect(res.body.error).not.toContain('netsuite_serialized_asset');
  });

  it('maps an already-running configuration to 409', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(
      new ConflictAppError(`Integration ${CONFIG_ID} is already running`),
    );
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(409);
  });

  it('accepts a valid tenant-admin retry request and returns the service result as 200', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue(successResult);
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(service.retryDeferredSerializedAssetsForTenant).toHaveBeenCalledTimes(1);
    const [tenantId, configId, actor] = service.retryDeferredSerializedAssetsForTenant.mock.calls[0];
    expect(tenantId).toBe('tenant-a');
    expect(configId).toBe(CONFIG_ID);
    expect(actor.userId).toBe('admin-1');
    expect(typeof actor.correlationId).toBe('string');
    expect(actor.correlationId.length).toBeGreaterThan(0);
  });

  // Decision: actor/tenant/correlation are bound EXCLUSIVELY from verified
  // middleware state. A spoofed body must never reach the service.
  it('ignores a spoofed body (actorUserId/tenantId/forceDeferredRetry/correlationId) and uses only verified JWT state', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue(successResult);
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app)
      .post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`)
      .send({
        actorUserId: 'attacker',
        tenantId: 'attacker-tenant',
        correlationId: 'attacker-correlation',
        forceDeferredRetry: false,
      });

    expect(res.status).toBe(200);
    const [tenantId, , actor] = service.retryDeferredSerializedAssetsForTenant.mock.calls[0];
    expect(tenantId).toBe('tenant-a');
    expect(tenantId).not.toBe('attacker-tenant');
    expect(actor.userId).toBe('admin-1');
    expect(actor.userId).not.toBe('attacker');
    expect(actor.correlationId).not.toBe('attacker-correlation');
  });

  it('falls back to a generic 500 for an unrecognized error shape', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(new Error('boom'));
    const app = makeApp(service, TENANT_ADMIN_USER);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(500);
  });

  // ---------------------------------------------------------------------
  // Review IMPORTANT 1: the route's old `getErrorStatusCode(err) ?? 500`
  // trusted a `.statusCode` property off ANY thrown value, so an error
  // carrying `statusCode: 200` would report a FAILED forced retry as a
  // success (`{"error":"failed"}` with HTTP 200), `204` as an empty
  // no-content response with the failure invisible, and `600`/`418` as
  // literal (nonsense) HTTP statuses. Only a real AppError subclass thrown by
  // this route's own service-layer vocabulary (NotFoundError/
  // BadRequestAppError/ConflictAppError, all covered above) may dictate the
  // response; everything else collapses to a fixed generic 500.
  // ---------------------------------------------------------------------

  describe('bounded error mapping (review IMPORTANT 1)', () => {
    class FakeStatusError extends Error {
      statusCode: number;
      constructor(statusCode: number, message: string) {
        super(message);
        this.name = 'FakeStatusError';
        this.statusCode = statusCode;
      }
    }

    it.each([
      [200, 'reported as success'],
      [204, 'empty no-content, failure invisible'],
      [600, 'nonsense HTTP status'],
      [418, 'a real-but-wrong HTTP status'],
    ])('never passes an out-of-contract statusCode (%i) through as the real HTTP status', async (status) => {
      const service = makeMockIntegrationService();
      service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(
        new FakeStatusError(status, 'this message must not leak either'),
      );
      const app = makeApp(service, TENANT_ADMIN_USER);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe('this message must not leak either');
    });

    it('never echoes a non-AppError message, even one containing a canary serial-like string', async () => {
      const service = makeMockIntegrationService();
      const CANARY = 'SN-CANARY-000111222';
      service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(new Error(`upsert failed for ${CANARY}`));
      const app = makeApp(service, TENANT_ADMIN_USER);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).not.toContain(CANARY);
    });

    it('takes the STATUS from an in-contract AppError but never its message', async () => {
      const service = makeMockIntegrationService();
      service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(
        new BadRequestAppError(`Configuration ${CONFIG_ID} does not use the netsuite_serialized_asset execution profile`),
      );
      const app = makeApp(service, TENANT_ADMIN_USER);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Serialized-asset forced retry request was rejected');
    });

    // The finding this replaced the old passthrough for: allowlisting the STATUS
    // says nothing about the TEXT. Every allowed status is probed with a serial
    // planted in the message, because the previous contract's safety rested on
    // every future thrower in the service layer remembering not to include one.
    const ALLOWLIST_CANARY = 'SN-CANARY-999888777';
    it.each([
      [400, () => new BadRequestAppError(`rejected unit ${ALLOWLIST_CANARY}`)],
      [404, () => new NotFoundError(`no such unit ${ALLOWLIST_CANARY}`)],
      [409, () => new ConflictAppError(`unit ${ALLOWLIST_CANARY} is already running`)],
      [503, () => new ServiceUnavailableAppError(`cannot reach the store for unit ${ALLOWLIST_CANARY}`)],
    ])('never relays a serial planted in an ALLOWLISTED %s error', async (status, makeError) => {
      const service = makeMockIntegrationService();
      service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(makeError());
      const app = makeApp(service, TENANT_ADMIN_USER);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(status);
      expect(JSON.stringify(res.body)).not.toContain(ALLOWLIST_CANARY);
    });

    it('collapses an AppError whose statusCode is outside this route\'s contract (e.g. a hypothetical 401/403) to a generic 500', async () => {
      const service = makeMockIntegrationService();
      class OutOfContractAppError extends Error {
        statusCode = 403;
        constructor() {
          super('do not leak this 403-shaped message');
          this.name = 'OutOfContractAppError';
        }
      }
      service.retryDeferredSerializedAssetsForTenant.mockRejectedValue(new OutOfContractAppError());
      const app = makeApp(service, TENANT_ADMIN_USER);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).not.toContain('403-shaped');
    });
  });

  // ---------------------------------------------------------------------
  // Review MINOR 1: guard-before-limiter ordering was unpinned — swapping
  // requireIntegrationTenantAdmin and the dedicated rate limiter left all
  // prior tests green. Proven here by sharing one (ip, user) rate-limit key
  // across a run of guard-rejected requests, then switching the SAME key to
  // an admin identity: with the correct guard-then-limiter order, the 15
  // rejected requests never touch the limiter, so the dedicated budget
  // (SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS) is still fully available
  // afterward. If the limiter ran first, requests past the budget would
  // start returning 429 instead of 403, and the admin's later requests would
  // arrive with the budget already partially or fully consumed.
  // ---------------------------------------------------------------------

  it('runs requireIntegrationTenantAdmin before the dedicated rate limiter, so guard-rejected traffic never consumes its budget', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue(successResult);

    const SHARED_ID = 'shared-key-user';
    let asAdmin = false;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = (asAdmin
        ? { id: SHARED_ID, tenantId: 'tenant-a', roles: ['tenant_admin'], permissions: [] }
        : { id: SHARED_ID, tenantId: 'tenant-a', roles: ['user'], permissions: [] }) as Express.User;
      next();
    });
    app.use(createIntegrationRouter({ integrationService: service as IntegrationService }));

    // More non-admin requests than the dedicated budget. Every one MUST be
    // rejected by the guard (403), never by the limiter (429).
    const rejectionCount = SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS + 5;
    for (let i = 0; i < rejectionCount; i++) {
      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});
      expect(res.status).toBe(403);
    }

    // Same (ip, user) key, now an admin: the full budget must still be there.
    asAdmin = true;
    for (let i = 0; i < SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS; i++) {
      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});
      expect(res.status).toBe(200);
    }
  });
});

/**
 * Codex merge-readiness review raised `retryDeferredSerializedAssetsForTenant`
 * receiving an untrusted `{userId, correlationId}` bag.
 *
 * The userId half is REFUTED at the production call site and pinned below:
 * the route reads `req.user.id` and 401s without it, so a caller can never
 * attribute governance rows to another user.
 *
 * The correlationId half is real but narrower — it comes from the caller's
 * `x-correlation-id` header. It is now shape-bounded before propagation. That
 * stops oversized/hostile values reaching a durable audit column; it cannot
 * stop a caller writing their own serial into their own tenant's rows, and
 * nothing shape-based could.
 */
describe('POST /:id/serialized-assets/retry-deferred — actor and correlation provenance', () => {
  it('derives the actor from verified req.user only, never from the request body', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue({ ok: true } as never);
    const app = makeApp(service, TENANT_ADMIN_USER);

    await request(app)
      .post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`)
      .send({ userId: 'attacker', actorUserId: 'attacker', correlationId: 'attacker-supplied' });

    const [, , actor] = service.retryDeferredSerializedAssetsForTenant.mock.calls[0];
    expect(actor.userId).toBe(TENANT_ADMIN_USER.id);
    expect(actor.userId).not.toBe('attacker');
    expect(actor.correlationId).not.toBe('attacker-supplied');
  });

  it('propagates a well-formed correlation header so tracing still works', async () => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue({ ok: true } as never);
    const app = makeApp(service, TENANT_ADMIN_USER, { correlationId: 'trace-abc.123:xyz' });

    await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    const [, , actor] = service.retryDeferredSerializedAssetsForTenant.mock.calls[0];
    expect(actor.correlationId).toBe('trace-abc.123:xyz');
  });

  it.each([
    ['an oversized value', 'x'.repeat(129)],
    ['embedded newlines', 'trace\ninjected: value'],
    ['an empty string', ''],
  ])('replaces %s with a generated id rather than persisting it', async (_label, injected) => {
    const service = makeMockIntegrationService();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue({ ok: true } as never);
    const app = makeApp(service, TENANT_ADMIN_USER, { correlationId: injected });

    await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    const [, , actor] = service.retryDeferredSerializedAssetsForTenant.mock.calls[0];
    expect(actor.correlationId).not.toBe(injected);
    expect(actor.correlationId).toMatch(CORRELATION_ID_SHAPE);
  });
});
