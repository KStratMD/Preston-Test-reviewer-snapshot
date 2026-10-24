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
import {
  createIntegrationRouter,
  type SerializedAssetRetryOperationsPort,
} from '../../../src/routes/integration';
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
const OPERATION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * A9: the route no longer drains inside the request, so the thing under test
 * is the RESERVATION port. `retryOperations` defaults to a working stub;
 * passing `null` exercises the unavailable path.
 */
function makeRetryPort(): jest.Mocked<SerializedAssetRetryOperationsPort> {
  return {
    reserve: jest.fn().mockResolvedValue({
      operationId: OPERATION_ID,
      status: 'accepted',
      deduplicated: false,
    }),
    getStatus: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<SerializedAssetRetryOperationsPort>;
}

function makeApp(
  integrationService: Pick<IntegrationService, 'retryDeferredSerializedAssetsForTenant'>,
  user?: unknown,
  requestOverrides?: { correlationId?: string },
  retryOperations?: SerializedAssetRetryOperationsPort | null,
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
    serializedAssetRetryOperations:
      retryOperations === null ? undefined : (retryOperations ?? makeRetryPort()),
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
    const retry = makeRetryPort();
    retry.reserve.mockRejectedValue(
      new NotFoundError(`Configuration ${CONFIG_ID} not found`),
    );
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(404);
  });

  it('maps a wrong-profile configuration (not netsuite_serialized_asset) to 400', async () => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    retry.reserve.mockRejectedValue(
      new BadRequestAppError(
        `Configuration ${CONFIG_ID} does not use the netsuite_serialized_asset execution profile`,
      ),
    );
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(400);
    // Status is taken from the AppError; the MESSAGE is this route's own fixed
    // text, never the thrower's (see mapSerializedAssetRetryError).
    expect(res.body.error).toBe('Serialized-asset forced retry request was rejected');
    expect(res.body.error).not.toContain('netsuite_serialized_asset');
  });

  it('treats a request-time conflict as out of contract rather than a 409', async () => {
    // Guards the A9 contract against regressing to the synchronous behaviour.
    // Reservation CONVERGES onto an already-live operation and returns 202 with
    // its id, so "already running" is an operation status and never a
    // request-time failure. A ConflictAppError reaching the handler therefore
    // means something upstream started running the drain in-request again; it
    // must collapse to the generic 500 instead of surfacing a 409 that
    // contradicts the documented contract. If someone re-adds 409 to
    // SERIALIZED_ASSET_RETRY_PUBLIC_MESSAGES, this fails.
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    // A serial is planted so this also carries the canary property the
    // allowlist table applies to every in-contract status.
    const serial = 'SN-CONFLICT-555444333';
    retry.reserve.mockRejectedValue(
      new ConflictAppError(`Integration ${CONFIG_ID} is already running unit ${serial}`),
    );
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Serialized-asset forced retry failed');
    expect(JSON.stringify(res.body)).not.toContain(serial);
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_ID);
  });

  it('reserves durably and returns 202 without awaiting the drain', async () => {
    // A9's whole point: the request no longer blocks on a full backlog drain
    // against NetSuite and Salesforce. It reserves and returns.
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      operationId: OPERATION_ID,
      status: 'accepted',
      statusUrl: `/api/integrations/${CONFIG_ID}/status/forced-retries/${OPERATION_ID}`,
    });
    // The synchronous executor must not be touched by the request at all.
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();

    expect(retry.reserve).toHaveBeenCalledTimes(1);
    const [args] = retry.reserve.mock.calls[0];
    expect(args.tenantId).toBe('tenant-a');
    expect(args.configurationId).toBe(CONFIG_ID);
    expect(args.requesterUserId).toBe('admin-1');
    expect(typeof args.correlationId).toBe('string');
    expect(args.correlationId.length).toBeGreaterThan(0);
  });

  it('reports the existing operation when the reservation deduplicated', async () => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    retry.reserve.mockResolvedValue({ operationId: OPERATION_ID, status: 'running', deduplicated: true });
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    // Still 202 with the SAME operation — a retried request is safe, and the
    // caller is not told a second drain started, because none did.
    expect(res.status).toBe(202);
    expect(res.body.operationId).toBe(OPERATION_ID);
    expect(res.body.status).toBe('running');
  });

  it('reports 503 rather than silently falling back to the synchronous drain', async () => {
    // If the durable service could not be resolved, "unavailable" is the
    // honest answer. Running the old inline drain instead would quietly
    // restore the request-blocking behaviour A9 exists to remove.
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, null);

    const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(res.status).toBe(503);
    expect(service.retryDeferredSerializedAssetsForTenant).not.toHaveBeenCalled();
  });

  it('uses the documented 503 text on both handlers, not a second vocabulary', async () => {
    // Copilot round 4: the port-absent paths emitted their own string while the
    // route documents a closed public vocabulary. Two spellings of the same
    // condition is how a contract starts drifting from its Swagger.
    const expected = 'Serialized-asset forced retry is temporarily unavailable';
    const app = makeApp(makeMockIntegrationService(), TENANT_ADMIN_USER, undefined, null);

    const post = await request(app)
      .post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`)
      .send({});
    const get = await request(app).get(
      `/api/integrations/${CONFIG_ID}/status/forced-retries/op-1`,
    );

    expect(post.status).toBe(503);
    expect(get.status).toBe(503);
    expect(post.body.error).toBe(expected);
    expect(get.body.error).toBe(expected);
  });

  // Decision: actor/tenant/correlation are bound EXCLUSIVELY from verified
  // middleware state. A spoofed body must never reach the reservation.
  it('ignores a spoofed body (actorUserId/tenantId/forceDeferredRetry/correlationId) and uses only verified JWT state', async () => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app)
      .post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`)
      .send({
        actorUserId: 'attacker',
        tenantId: 'attacker-tenant',
        correlationId: 'attacker-correlation',
        forceDeferredRetry: false,
      });

    expect(res.status).toBe(202);
    const [args] = retry.reserve.mock.calls[0];
    expect(args.tenantId).toBe('tenant-a');
    expect(args.tenantId).not.toBe('attacker-tenant');
    expect(args.requesterUserId).toBe('admin-1');
    expect(args.requesterUserId).not.toBe('attacker');
    expect(args.correlationId).not.toBe('attacker-correlation');
  });

  it('falls back to a generic 500 for an unrecognized error shape', async () => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    retry.reserve.mockRejectedValue(new Error('boom'));
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

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
      const retry = makeRetryPort();
      retry.reserve.mockRejectedValue(
        new FakeStatusError(status, 'this message must not leak either'),
      );
      const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe('this message must not leak either');
    });

    it('never echoes a non-AppError message, even one containing a canary serial-like string', async () => {
      const service = makeMockIntegrationService();
      const retry = makeRetryPort();
      const CANARY = 'SN-CANARY-000111222';
      retry.reserve.mockRejectedValue(new Error(`upsert failed for ${CANARY}`));
      const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(500);
      expect(res.body.error).not.toContain(CANARY);
    });

    it('takes the STATUS from an in-contract AppError but never its message', async () => {
      const service = makeMockIntegrationService();
      const retry = makeRetryPort();
      retry.reserve.mockRejectedValue(
        new BadRequestAppError(`Configuration ${CONFIG_ID} does not use the netsuite_serialized_asset execution profile`),
      );
      const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

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
      // 409 is deliberately absent — it is no longer in this route's contract.
      // Its canary case is covered by the out-of-contract test above, which
      // asserts the collapse to 500 AND that the planted serial is not relayed.
      [503, () => new ServiceUnavailableAppError(`cannot reach the store for unit ${ALLOWLIST_CANARY}`)],
    ])('never relays a serial planted in an ALLOWLISTED %s error', async (status, makeError) => {
      const service = makeMockIntegrationService();
      const retry = makeRetryPort();
      retry.reserve.mockRejectedValue(makeError());
      const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

      expect(res.status).toBe(status);
      expect(JSON.stringify(res.body)).not.toContain(ALLOWLIST_CANARY);
    });

    it('collapses an AppError whose statusCode is outside this route\'s contract (e.g. a hypothetical 401/403) to a generic 500', async () => {
      const service = makeMockIntegrationService();
      const retry = makeRetryPort();
      class OutOfContractAppError extends Error {
        statusCode = 403;
        constructor() {
          super('do not leak this 403-shaped message');
          this.name = 'OutOfContractAppError';
        }
      }
      retry.reserve.mockRejectedValue(new OutOfContractAppError());
      const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

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
    const retry = makeRetryPort();
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
    app.use(createIntegrationRouter({
      integrationService: service as IntegrationService,
      serializedAssetRetryOperations: makeRetryPort(),
    }));

    // More non-admin requests than the dedicated budget. Every one MUST be
    // rejected by the guard (403), never by the limiter (429).
    const rejectionCount = SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS + 5;
    for (let i = 0; i < rejectionCount; i++) {
      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});
      expect(res.status).toBe(403);
    }

    // Same (ip, user) key, now an admin: the full budget must still be there.
    // 202, not 200 — A9 reserves rather than draining inline, and the rate
    // profile stays on the reservation POST.
    asAdmin = true;
    for (let i = 0; i < SERIALIZED_ASSET_FORCED_RETRY_MAX_REQUESTS; i++) {
      const res = await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});
      expect(res.status).toBe(202);
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
    const retry = makeRetryPort();
    service.retryDeferredSerializedAssetsForTenant.mockResolvedValue({ ok: true } as never);
    const app = makeApp(service, TENANT_ADMIN_USER, undefined, retry);

    await request(app)
      .post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`)
      .send({ userId: 'attacker', actorUserId: 'attacker', correlationId: 'attacker-supplied' });

    const [args] = retry.reserve.mock.calls[0];
    expect(args.requesterUserId).toBe(TENANT_ADMIN_USER.id);
    expect(args.requesterUserId).not.toBe('attacker');
    expect(args.correlationId).not.toBe('attacker-supplied');
  });

  it('propagates a well-formed correlation header so tracing still works', async () => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    const app = makeApp(service, TENANT_ADMIN_USER, { correlationId: 'trace-abc.123:xyz' }, retry);

    await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    expect(retry.reserve.mock.calls[0][0].correlationId).toBe('trace-abc.123:xyz');
  });

  it.each([
    ['an oversized value', 'x'.repeat(129)],
    ['embedded newlines', 'trace\ninjected: value'],
    ['an empty string', ''],
  ])('replaces %s with a generated id rather than persisting it', async (_label, injected) => {
    const service = makeMockIntegrationService();
    const retry = makeRetryPort();
    const app = makeApp(service, TENANT_ADMIN_USER, { correlationId: injected }, retry);

    await request(app).post(`/api/integrations/${CONFIG_ID}/serialized-assets/retry-deferred`).send({});

    const { correlationId } = retry.reserve.mock.calls[0][0];
    expect(correlationId).not.toBe(injected);
    expect(correlationId).toMatch(CORRELATION_ID_SHAPE);
  });
});

describe('GET /api/integrations/:id/status/forced-retries/:operationId', () => {
  const statusUrl = `/api/integrations/${CONFIG_ID}/status/forced-retries/${OPERATION_ID}`;

  const succeededOperation = {
    id: OPERATION_ID,
    status: 'succeeded',
    createdAt: '2026-08-08T00:00:00.000Z',
    startedAt: '2026-08-08T00:00:01.000Z',
    finishedAt: '2026-08-08T00:00:09.000Z',
    unitsRead: 10,
    unitsUpserted: 8,
    unitsDeferred: 1,
    unitsQuarantined: 1,
    unitsFailed: 0,
    errorCode: null,
    errorClass: null,
  };

  it('rejects an anonymous request with 401', async () => {
    const res = await request(makeApp(makeMockIntegrationService(), undefined)).get(statusUrl);
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-admin with 403', async () => {
    const app = makeApp(makeMockIntegrationService(), {
      id: 'u1', tenantId: 'tenant-a', roles: ['user'], permissions: [],
    });
    expect((await request(app).get(statusUrl)).status).toBe(403);
  });

  it('returns the sanitized projection for the caller\'s own tenant', async () => {
    const retry = makeRetryPort();
    retry.getStatus.mockResolvedValue(succeededOperation);
    const app = makeApp(makeMockIntegrationService(), TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).get(statusUrl);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      operationId: OPERATION_ID,
      status: 'succeeded',
      createdAt: succeededOperation.createdAt,
      startedAt: succeededOperation.startedAt,
      finishedAt: succeededOperation.finishedAt,
      counters: { read: 10, upserted: 8, deferred: 1, quarantined: 1, failed: 0 },
      errorCode: null,
      errorClass: null,
    });
    expect(retry.getStatus).toHaveBeenCalledWith('tenant-a', CONFIG_ID, OPERATION_ID);
  });

  it('returns the SAME 404 for an unknown operation and for another tenant\'s', async () => {
    // Indistinguishable on purpose: a different response for "exists but not
    // yours" would let one tenant probe for another's operations by id.
    const retry = makeRetryPort();
    retry.getStatus.mockResolvedValue(null);
    const app = makeApp(makeMockIntegrationService(), TENANT_ADMIN_USER, undefined, retry);

    const unknown = await request(app).get(
      `/api/integrations/${CONFIG_ID}/status/forced-retries/00000000-0000-0000-0000-000000000000`,
    );
    const crossTenant = await request(app).get(statusUrl);

    expect(unknown.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(unknown.body).toEqual(crossTenant.body);
  });

  it('CANARY: a worker failure reaches HTTP as a fixed code and class, never a message', async () => {
    // The durable row has nowhere to hold a connector message (migration 063),
    // so this proves the whole path: even if a serial or secret were somehow
    // present on the operation object, the response shape has no field for it.
    const retry = makeRetryPort();
    retry.getStatus.mockResolvedValue({
      ...succeededOperation,
      status: 'failed',
      unitsRead: 3, unitsUpserted: 0, unitsDeferred: 0, unitsQuarantined: 0, unitsFailed: 3,
      errorCode: 'forced_retry_execution_failed',
      errorClass: 'ConnectorError',
      // Fields the route must not echo even when handed them.
      ...({ rawError: 'upsert failed for SN-000123 secret=abc', leaseOwner: 'retry-worker-1' } as never),
    });
    const app = makeApp(makeMockIntegrationService(), TENANT_ADMIN_USER, undefined, retry);

    const res = await request(app).get(statusUrl);

    expect(res.status).toBe(200);
    expect(res.body.errorCode).toBe('forced_retry_execution_failed');
    expect(res.body.errorClass).toBe('ConnectorError');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('SN-000123');
    expect(serialized).not.toContain('secret=abc');
    expect(serialized).not.toContain('retry-worker-1');
    expect(Object.keys(res.body).sort()).toEqual([
      'counters', 'createdAt', 'errorClass', 'errorCode', 'finishedAt', 'operationId', 'startedAt', 'status',
    ]);
  });

  it('reports 503 when the durable service is unavailable', async () => {
    const app = makeApp(makeMockIntegrationService(), TENANT_ADMIN_USER, undefined, null);
    expect((await request(app).get(statusUrl)).status).toBe(503);
  });
});
