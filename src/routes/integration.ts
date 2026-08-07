import { Router } from 'express';
import type { IntegrationService } from '../services/IntegrationService';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { Logger } from '../utils/Logger';
import { logger as defaultLogger } from '../utils/Logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { NotFoundError } from '../errors/NotFoundError';
import { AppError } from '../errors/AppError';
import { requireTenantId } from './tenantGuard';
import { env } from '../config';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import { requireIntegrationTenantAdmin } from '../middleware/verifiedAdmin';
import { createSerializedAssetForcedRetryRateLimit } from '../middleware/rateLimit';
import { uuidv4 } from '../utils/uuid';

type CreateIntegrationRouterOpts = {
  integrationService: IntegrationService;
  configurationService?: ConfigurationService;
  logger?: Logger;
};

/**
 * Extended IntegrationService surface used by this router.
 *
 * The router supports two method-naming conventions:
 *  - the canonical names declared on `IntegrationService` (`runIntegration`,
 *    `testIntegration`, `getIntegrationStatus`, ...), and
 *  - alias method names (`executeIntegration`, `testConnection`,
 *    `getAllIntegrationStatuses`, `getSyncStatus`, webhook + mapping helpers)
 *    that the integration test mock supplies — see
 *    `tests/unit/routes/__tests__/integration.test.ts` for the exact contract.
 *
 * Replaces the previous `(integrationService as any).METHOD` dispatch pattern.
 * Every alias is optional because the route either falls back to the canonical
 * method or returns 4xx/5xx when neither is present.
 */
interface ExtendedIntegrationService extends IntegrationService {
  executeIntegration?: (id: string, options: unknown) => Promise<unknown>;
  testConnection?: (id: string) => Promise<unknown>;
  getSyncStatus?: (id: string) => Promise<unknown> | unknown;
  getWebhooks?: (id: string) => Promise<unknown>;
  registerWebhook?: (id: string, payload: unknown) => Promise<unknown>;
  unregisterWebhook?: (id: string, webhookId: string) => Promise<unknown>;
  getFieldMappings?: (id: string) => Promise<unknown>;
  saveFieldMappings?: (id: string, mappings: unknown) => Promise<unknown>;
  validateMappings?: (id: string, mappings: unknown) => Promise<unknown>;
  getTransformationPreview?: (id: string, sample: unknown, mappings: unknown) => Promise<unknown>;
}

/**
 * Narrow an unknown error to extract a numeric `statusCode` if present.
 * Replaces `(error as any)?.statusCode === 404` checks.
 */
const getErrorStatusCode = (err: unknown): number | undefined => {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
};

/**
 * Bounded error -> HTTP mapping for the serialized-asset forced-retry route
 * ONLY (review IMPORTANT 1, Task 9 hardening). `getErrorStatusCode` above is
 * a duck-typed helper trusted only for `runHandler`'s narrow
 * `=== 404` check; reusing that pattern here as `getErrorStatusCode(err) ??
 * 500` let ANY thrown value's `.statusCode` property dictate the response —
 * proven exploitable with `statusCode: 200` (a FAILED forced retry reported
 * as success), `204` (empty no-content, failure invisible), and `600`/`418`
 * (literal nonsense/wrong HTTP statuses), each also echoing the thrown
 * value's raw `message` verbatim.
 *
 * This route's service layer throws a CLOSED, known vocabulary
 * (NotFoundError/BadRequestAppError/ConflictAppError, all `AppError`
 * subclasses with statusCode 404/400/409; `ServiceUnavailableAppError` (503)
 * reserved for a future readiness-style refusal). Only a real `AppError`
 * instance whose `statusCode` is in that allowlist is trusted, and it is
 * trusted for its STATUS ONLY.
 *
 * The message is NOT relayed (Codex merge-readiness review). Allowlisting the
 * status says nothing about the text: a `ConflictAppError('Unit SN-123 is
 * already running')` would have passed the status gate and echoed the serial
 * straight to the caller. The previous round's own review recorded that no
 * serial escapes "TODAY only because Task 7's error vocabulary happens to be
 * sanitized, and no test pins the reachable error set" — i.e. the guarantee
 * rested on every future thrower in the service layer remembering. It now rests
 * on this table instead. The caller loses nothing it did not already know: the
 * configuration id is in its own request URL.
 *
 * Anything else — a non-AppError `Error`, a plain object, or an `AppError`
 * carrying an out-of-contract status — collapses to a fixed generic 500, so a
 * canary planted anywhere in an error can never escape.
 */
/**
 * Bound on the correlation id this route will propagate into the
 * serialized-asset path (Codex merge-readiness review).
 *
 * `req.correlationId` originates from the caller's `x-correlation-id` header and
 * reaches `guardedWrite`'s context and durable governance audit rows. Every
 * route in this codebase forwards it unvalidated, which is the established
 * precedent — but this is the one family that promises decision-8 privacy, and
 * an unbounded caller-controlled string landing in a durable audit column is
 * worth refusing on its own robustness merits.
 *
 * BE PRECISE ABOUT WHAT THIS DOES NOT DO: it does not prevent a caller from
 * putting a serial in the header. A serial is well within this charset, and no
 * shape check can distinguish one from a legitimate trace id. What it prevents
 * is an oversized or structurally hostile value (newlines, control characters,
 * a megabyte of text) being persisted. The remaining exposure is a tenant admin
 * writing their OWN tenant's data into their OWN tenant's audit rows — not a
 * cross-tenant leak, and not something the system did to them.
 *
 * A rejected value is REPLACED by a generated uuid rather than failing the
 * request: tracing continuity is not worth a 400 on a write path.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function acceptableCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value) ? value : undefined;
}

const SERIALIZED_ASSET_RETRY_GENERIC_MESSAGE = 'Serialized-asset forced retry failed';

const SERIALIZED_ASSET_RETRY_PUBLIC_MESSAGES: ReadonlyMap<number, string> = new Map([
  [400, 'Serialized-asset forced retry request was rejected'],
  [404, 'Configuration not found'],
  [409, 'Serialized-asset forced retry conflicts with the current state of this configuration'],
  [503, 'Serialized-asset forced retry is temporarily unavailable'],
]);

function mapSerializedAssetRetryError(err: unknown): { status: number; message: string } {
  if (err instanceof AppError) {
    const publicMessage = SERIALIZED_ASSET_RETRY_PUBLIC_MESSAGES.get(err.statusCode);
    if (publicMessage !== undefined) {
      return { status: err.statusCode, message: publicMessage };
    }
  }
  return { status: 500, message: SERIALIZED_ASSET_RETRY_GENERIC_MESSAGE };
}

/**
 * Resolve an optional method on the extended service or throw a TypeError
 * with the same shape as the previous `(integrationService as any).foo(...)`
 * runtime call. Preserves the legacy crash-into-asyncHandler behavior for
 * webhook + mapping endpoints when the underlying service does not implement
 * them — these endpoints are alias-only and have no canonical fallback.
 */
const requireMethod = <K extends keyof ExtendedIntegrationService>(
  service: ExtendedIntegrationService,
  name: K,
): NonNullable<ExtendedIntegrationService[K]> => {
  const fn = service[name];
  if (typeof fn !== 'function') {
    throw new TypeError(`integrationService.${String(name)} is not a function`);
  }
  // Bind the receiver so callers invoking `requireMethod(svc, 'foo')(...)` keep
  // method context — without this, `this` is undefined inside class methods in
  // strict mode and any impl using `this.logger`/`this.repo` would crash. The
  // pre-tranche `(svc as any).foo(...)` form preserved context as a method-call
  // expression; `requireMethod` must replicate that.
  return (fn as (this: ExtendedIntegrationService, ...args: unknown[]) => unknown).bind(
    service,
  ) as NonNullable<ExtendedIntegrationService[K]>;
};

export const createIntegrationRouter = (svcOrOpts: IntegrationService | CreateIntegrationRouterOpts): Router => {
  const opts: CreateIntegrationRouterOpts | undefined =
    svcOrOpts && typeof svcOrOpts === 'object' && 'integrationService' in svcOrOpts
      ? (svcOrOpts as CreateIntegrationRouterOpts)
      : undefined;
  const integrationService: ExtendedIntegrationService =
    (opts?.integrationService ?? (svcOrOpts as IntegrationService)) as ExtendedIntegrationService;
  const configurationService: ConfigurationService | undefined =
    opts?.configurationService ?? integrationService.configService;
  const _logger: Logger | undefined = opts?.logger;
  const router = Router();
  const base = '/api/integrations';

  const ownsIntegration = (tenantId: string, id: string): boolean => {
    if (!configurationService) return true;
    return Boolean(configurationService.getConfigurationForTenant(tenantId, id));
  };

  const statusConfigId = (status: unknown): string | undefined => {
    if (!status || typeof status !== 'object' || !('configId' in status)) return undefined;
    const configId = (status as { configId?: unknown }).configId;
    return typeof configId === 'string' ? configId : undefined;
  };

  const filterStatusesForTenant = (tenantId: string, statuses: unknown[]): unknown[] => {
    if (!configurationService) return statuses;
    const tenantConfigIds = new Set(
      configurationService.getAllConfigurationsForTenant(tenantId).map(config => config.id),
    );
    return statuses.filter(status => {
      const configId = statusConfigId(status);
      return configId !== undefined && tenantConfigIds.has(configId);
    });
  };

  /**
   * @swagger
   * /api/integrations/{id}/run:
   *   post:
   *     summary: Execute integration sync
   *     description: Runs a complete synchronization process for the specified integration
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               batchSize:
   *                 type: number
   *                 description: Number of records to process in each batch
   *                 example: 100
   *               dryRun:
   *                 type: boolean
   *                 description: Run validation without making actual changes
   *                 example: false
   *               filter:
   *                 type: object
   *                 description: Additional filtering criteria
   *                 example: { "status": "active" }
   *               startDate:
   *                 type: string
   *                 format: date-time
   *                 description: Sync records modified after this date
   *                 example: "2024-01-01T00:00:00Z"
   *           example:
   *             batchSize: 50
   *             dryRun: false
   *             filter: { "status": "active" }
   *     responses:
   *       200:
   *         description: Integration execution started successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [started, running, completed, failed]
   *                   example: "started"
   *                 executionId:
   *                   type: string
   *                   description: Unique identifier for this execution
   *                   example: "exec_123abc456def"
   *                 message:
   *                   type: string
   *                   example: "Integration execution started successfully"
   *                 recordsToProcess:
   *                   type: number
   *                   description: Estimated number of records to sync
   *                   example: 1250
   *                 estimatedDuration:
   *                   type: string
   *                   description: Estimated completion time
   *                   example: "15 minutes"
   *       404:
   *         description: Integration configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       400:
   *         description: Invalid execution options
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Integration execution failed to start
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const runHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    const options = req.body || {};
    // Method precedence: tenant-scoped runIntegrationForTenant, then
    // executeIntegration, then canonical runIntegration. Resolution AND
    // invocation both live inside the try block (Copilot review): the `.bind`
    // on a truthy-non-function alias would otherwise throw synchronously before
    // the try, bypassing this handler's error mapping. Inside the try, any
    // non-function value (truthy-non-function alias, missing canonical method on
    // a partial mock) flows through the typeof guard and returns 500. Using
    // `.call(integrationService, …)` preserves `this` for class-method impls.
    // PR 13c-4 Task 6: anonymous-bypass closure. authMiddleware on the mount
    // already 401s missing-JWT callers; this narrowing closes the handler-layer
    // hole where a malformed JWT (Bearer present, tenantId claim missing/empty)
    // would have reached the legacy tenantless dispatch (previously reached when
    // the now-removed `resolveTenantId` helper mapped anonymous callers to
    // undefined). Prefer req.user?.tenantId directly per spec §9.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    try {
      const exec = integrationService.runIntegrationForTenant?.bind(integrationService)
        ?? integrationService.executeIntegration
        ?? integrationService.runIntegration;
      if (typeof exec !== 'function') {
        throw new TypeError('integrationService run/execute method is not a function');
      }
      const result = typeof integrationService.runIntegrationForTenant === 'function'
        ? await (exec as (t: string, i: string, o: unknown) => Promise<unknown>)(tenantId, id, options)
        : await (exec as (i: string, o: unknown) => Promise<unknown>).call(integrationService, id, options);
      res.status(200).json(result);
    } catch (err) {
      if (await handleApprovalQueueError(err, req, res, {
        operationType: 'connector_write',
        resourceType: 'integration.run',
        resourceId: id,
      })) return;
      // Map cross-tenant / missing-config rejections to 404 (Copilot R8) —
      // both the route's tenant-scoped path and the legacy fallback can
      // surface a NotFoundError via the service layer.
      if (err instanceof NotFoundError || getErrorStatusCode(err) === 404) {
        res.status(404).json({ error: err instanceof Error ? err.message : 'Integration not found' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Integration execution failed';
      // Honor a classified AppError's own status instead of flattening it to 500
      // (Codex R4 on PR-B). This handler is the one place in the router that
      // SWALLOWS the error rather than rethrowing — `testHandler` and
      // `syncRecordHandler` both `throw error`, so their typed errors reach the
      // error boundary and are classified there. Here the hardcoded 500 meant a
      // deliberate, deterministic refusal was reported as a server fault: the
      // ConflictAppError (409) that `assertNoManagedCredentialReference` raises
      // on this exact path could never reach the wire, and the same would have
      // been true of every other typed status this stack introduces (e.g. the
      // activation guard's ServiceUnavailableAppError). `statusCode` is the sole
      // reason AppError exists; overriding it is the defect, not the mapping.
      // The response envelope is unchanged, and an unclassified error — the
      // genuine "server broke" case — still returns 500.
      res.status(err instanceof AppError ? err.statusCode : 500).json({ error: message });
    }
  });
  router.post(`${base}/:id/run`, runHandler);
  router.post('/:id/run', runHandler);

  // Task 9 (2026-07-27 NetSuite serialized-asset sync plan): one limiter
  // instance per router (matches the readiness-route convention in
  // src/routes/configuration.ts) — production builds exactly one integration
  // router so real traffic shares one budget; tests get a fresh MemoryStore
  // per app instead of tripping each other's counters.
  const serializedAssetForcedRetryRateLimit = createSerializedAssetForcedRetryRateLimit();

  /**
   * @swagger
   * /api/integrations/{id}/serialized-assets/retry-deferred:
   *   post:
   *     summary: Run a full serialized-asset sync that also forces early retry of deferred units
   *     description: >
   *       Task 9 (2026-07-27 NetSuite serialized-asset sync plan): the ONLY
   *       authenticated path that may request an early retry bypassing a
   *       deferred unit's `next_attempt_at` and the `MAX_DEFERRAL_ATTEMPTS`
   *       ceiling (decision 11). This is a FULL sync, not a narrow retry of
   *       only the deferred backlog — every accepted request re-sweeps the
   *       NetSuite source from the durable cursor, advances that cursor, and
   *       upserts any new units in the same run, in addition to bypassing the
   *       schedule for previously-deferred ones. Requires a verified tenant-administrator
   *       identity (`tenant_admin` role) — see `requireIntegrationTenantAdmin`.
   *       Any `actorUserId`/`tenantId`/`correlationId`/`forceDeferredRetry`
   *       field in the request body is ignored. The actor (`req.user.id`) and
   *       tenant (`req.user.tenantId`) are bound exclusively from the verified
   *       JWT; the correlation id is observability-only (falls back to
   *       `req.correlationId`, itself derived from the client-controlled
   *       `x-correlation-id` header when present, else a fresh server UUID) —
   *       it is never trusted for authorization or attribution.
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID (must use the netsuite_serialized_asset execution profile)
   *     responses:
   *       200:
   *         description: Forced retry completed (or previewed); result envelope matches POST /:id/run
   *       400:
   *         description: Configuration does not use the netsuite_serialized_asset execution profile, or is inactive
   *       401:
   *         description: Verified tenant administrator identity required
   *       403:
   *         description: Integration tenant administrator access required
   *       404:
   *         description: Integration configuration not found (including cross-tenant)
   *       409:
   *         description: The configuration is already running
   */
  const retryDeferredSerializedAssetsHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    // Server-owned actor ONLY — never req.body. Task 8's review caught a
    // caller-supplied actorUserId reaching governance_approvals; this route
    // must not repeat that mistake for the one surface that also bypasses
    // MAX_DEFERRAL_ATTEMPTS.
    const actorUserId = req.user?.id;
    if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
      res.status(401).json({ error: 'unauthorized', reason: 'operator_identity_required' });
      return;
    }
    const correlationId = acceptableCorrelationId(req.correlationId) ?? uuidv4();
    try {
      const result = await integrationService.retryDeferredSerializedAssetsForTenant(tenantId, id, {
        userId: actorUserId,
        correlationId,
      });
      res.status(200).json(result);
    } catch (err) {
      if (await handleApprovalQueueError(err, req, res, {
        operationType: 'connector_write',
        resourceType: 'integration.serialized_assets.retry_deferred',
        resourceId: id,
      })) return;
      // Bounded mapping (review IMPORTANT 1) — see mapSerializedAssetRetryError's
      // doc comment for why this route does NOT use the generic
      // getErrorStatusCode(err) ?? 500 passthrough every other handler in this
      // file uses.
      const { status, message } = mapSerializedAssetRetryError(err);
      res.status(status).json({ error: message });
    }
  });
  router.post(
    `${base}/:id/serialized-assets/retry-deferred`,
    requireIntegrationTenantAdmin,
    serializedAssetForcedRetryRateLimit,
    retryDeferredSerializedAssetsHandler,
  );
  router.post(
    '/:id/serialized-assets/retry-deferred',
    requireIntegrationTenantAdmin,
    serializedAssetForcedRetryRateLimit,
    retryDeferredSerializedAssetsHandler,
  );

  /**
   * @swagger
   * /api/integrations/{id}/test:
   *   post:
   *     summary: Test integration connectivity
   *     description: Validates the integration configuration and tests connectivity to source and target systems
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     responses:
   *       200:
   *         description: Integration test results
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 isValid:
   *                   type: boolean
   *                   description: Overall test result
   *                   example: true
   *                 sourceConnection:
   *                   type: object
   *                   properties:
   *                     status:
   *                       type: string
   *                       enum: [connected, failed, warning]
   *                       example: "connected"
   *                     message:
   *                       type: string
   *                       example: "Successfully connected to Salesforce"
   *                     responseTime:
   *                       type: number
   *                       description: Connection response time in milliseconds
   *                       example: 245
   *                 targetConnection:
   *                   type: object
   *                   properties:
   *                     status:
   *                       type: string
   *                       enum: [connected, failed, warning]
   *                       example: "connected"
   *                     message:
   *                       type: string
   *                       example: "Successfully connected to NetSuite"
   *                     responseTime:
   *                       type: number
   *                       description: Connection response time in milliseconds
   *                       example: 189
   *                 fieldMappings:
   *                   type: object
   *                   properties:
   *                     valid:
   *                       type: number
   *                       description: Number of valid field mappings
   *                       example: 12
   *                     invalid:
   *                       type: number
   *                       description: Number of invalid field mappings
   *                       example: 0
   *                     warnings:
   *                       type: array
   *                       items:
   *                         type: string
   *                       example: []
   *                 permissions:
   *                   type: object
   *                   properties:
   *                     source:
   *                       type: array
   *                       items:
   *                         type: string
   *                       description: Source system permissions status
   *                       example: ["read", "write"]
   *                     target:
   *                       type: array
   *                       items:
   *                         type: string
   *                       description: Target system permissions status
   *                       example: ["read", "write", "create"]
   *               example:
   *                 isValid: true
   *                 sourceConnection:
   *                   status: "connected"
   *                   message: "Successfully connected to Salesforce"
   *                   responseTime: 245
   *                 targetConnection:
   *                   status: "connected"
   *                   message: "Successfully connected to NetSuite"
   *                   responseTime: 189
   *                 fieldMappings:
   *                   valid: 12
   *                   invalid: 0
   *                   warnings: []
   *                 permissions:
   *                   source: ["read", "write"]
   *                   target: ["read", "write", "create"]
   *       404:
   *         description: Integration configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Test execution failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const testHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    // PR 13c-4 Task 6: anonymous-bypass closure — same narrowing as runHandler.
    // Falls back to the legacy tenantless testConnection/testIntegration when
    // the service doesn't expose testIntegrationForTenant.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    try {
      // Resolution inside the try (Copilot review): `.bind` on a truthy
      // non-function alias would otherwise throw before the try and bypass the
      // handler's error mapping. Precedence: testIntegrationForTenant →
      // testConnection → testIntegration.
      const testFn = integrationService.testIntegrationForTenant?.bind(integrationService)
        ?? integrationService.testConnection
        ?? integrationService.testIntegration;
      if (typeof testFn !== 'function') {
        throw new TypeError('integrationService testConnection/testIntegration is not a function');
      }
      const result = typeof integrationService.testIntegrationForTenant === 'function'
        ? await (testFn as (t: string, i: string) => Promise<unknown>)(tenantId, id)
        : await (testFn as (i: string) => Promise<unknown>).call(integrationService, id);
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof NotFoundError || getErrorStatusCode(error) === 404) {
        res.status(404).json({ error: error instanceof Error ? error.message : 'Integration not found' });
        return;
      }
      throw error;
    }
  });
  router.post(`${base}/:id/test`, testHandler);
  router.post('/:id/test', testHandler);

  /**
   * @swagger
   * /api/integrations/{id}/sync-record:
   *   post:
   *     summary: Sync single record
   *     description: Synchronizes a specific record between source and target systems
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - recordId
   *             properties:
   *               recordId:
   *                 type: string
   *                 description: Unique identifier of the record to sync
   *                 example: "0031234567890ABC"
   *               direction:
   *                 type: string
   *                 enum: [source_to_target, target_to_source, bidirectional]
   *                 description: Direction of synchronization (optional, uses config default)
   *                 example: "source_to_target"
   *               dryRun:
   *                 type: boolean
   *                 description: Run validation without making actual changes
   *                 example: false
   *           example:
   *             recordId: "0031234567890ABC"
   *             direction: "source_to_target"
   *             dryRun: false
   *     responses:
   *       200:
   *         description: Record synchronization result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: Whether synchronization was successful
   *                   example: true
   *                 recordId:
   *                   type: string
   *                   description: Source record ID
   *                   example: "0031234567890ABC"
   *                 targetRecordId:
   *                   type: string
   *                   description: Target system record ID after sync
   *                   example: "123456"
   *                 operation:
   *                   type: string
   *                   enum: [created, updated, skipped, failed]
   *                   description: Operation performed on target record
   *                   example: "updated"
   *                 fieldsUpdated:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of fields that were modified
   *                   example: ["name", "email", "phone"]
   *                 transformationResults:
   *                   type: object
   *                   description: Results of data transformation rules
   *                   example:
   *                     appliedRules: 3
   *                     warnings: []
   *                 message:
   *                   type: string
   *                   description: Human-readable result message
   *                   example: "Record synchronized successfully"
   *                 executionTime:
   *                   type: number
   *                   description: Synchronization time in milliseconds
   *                   example: 1250
   *               example:
   *                 success: true
   *                 recordId: "0031234567890ABC"
   *                 targetRecordId: "123456"
   *                 operation: "updated"
   *                 fieldsUpdated: ["name", "email", "phone"]
   *                 transformationResults:
   *                   appliedRules: 3
   *                   warnings: []
   *                 message: "Record synchronized successfully"
   *                 executionTime: 1250
   *       400:
   *         description: Invalid request or missing recordId
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       404:
   *         description: Integration configuration or record not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Synchronization failed
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const syncRecordHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    // PR 13c-4 Task 6: anonymous-bypass closure — same narrowing as runHandler.
    // Tenant gate BEFORE body validation (Codex review) so a Bearer-authenticated
    // caller with no tenant claim gets the fail-closed 401 tenant_required rather
    // than a recordId 400 that would mask the auth failure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    const { recordId } = req.body;
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }
    try {
      const result = typeof integrationService.syncSingleRecordForTenant === 'function'
        ? await integrationService.syncSingleRecordForTenant(tenantId, id, recordId)
        : await integrationService.syncSingleRecord(id, recordId);
      res.status(200).json(result);
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'connector_write',
        resourceType: 'integration.sync_record',
        resourceId: id,
      })) return;
      if (error instanceof NotFoundError || getErrorStatusCode(error) === 404) {
        res.status(404).json({ error: error instanceof Error ? error.message : 'Integration not found' });
        return;
      }
      throw error;
    }
  });
  router.post(`${base}/:id/sync-record`, syncRecordHandler);
  router.post('/:id/sync-record', syncRecordHandler);

  /**
   * @swagger
   * /api/integrations/{id}/stop:
   *   post:
   *     summary: Stop running integration
   *     description: Stops a currently running integration synchronization process
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     responses:
   *       200:
   *         description: Integration stop result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: Whether the integration was successfully stopped
   *                   example: true
   *                 message:
   *                   type: string
   *                   description: Result message
   *                   example: "Integration stopped"
   *                 recordsProcessed:
   *                   type: number
   *                   description: Number of records processed before stopping
   *                   example: 150
   *                 executionTime:
   *                   type: number
   *                   description: Total execution time before stopping (milliseconds)
   *                   example: 45000
   *               example:
   *                 success: true
   *                 message: "Integration stopped"
   *                 recordsProcessed: 150
   *                 executionTime: 45000
   *       404:
   *         description: Integration configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       500:
   *         description: Failed to stop integration
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const stopHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    // PR 13c-4 Task 6: anonymous-bypass closure. authMiddleware on the mount
    // gates anonymous callers; this narrowing fails closed if req.user lacks
    // a tenantId claim (malformed JWT or upstream regression).
    //
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const result = await integrationService.stopIntegration(id);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/stop`, stopHandler);
  router.post('/:id/stop', stopHandler);

  /**
   * @swagger
   * /api/integrations/status:
   *   get:
   *     summary: Get comprehensive system integration status
   *     description: Returns overall system statistics and breakdowns for integrations
   *     tags: [Integrations]
   *     responses:
   *       200:
   *         description: System status summary
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 totalConfigurations:
   *                   type: number
   *                 activeConfigurations:
   *                   type: number
   *                 systemStatus:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       system:
   *                         type: string
   *                       count:
   *                         type: number
   *                 lastUpdate:
   *                   type: string
   *                   format: date-time
   */
  const statusAllHandler = asyncHandler(async (req, res) => {
    // PR 13c-4 Task 6: authMiddleware gates this route; require a tenantId on
    // req.user so a Bearer token with a missing/empty tenantId claim doesn't
    // reach the underlying service.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    let rawStatuses: unknown;

    if (typeof integrationService.getAllIntegrationStatuses === 'function') {
      rawStatuses = await integrationService.getAllIntegrationStatuses();
    } else if (typeof integrationService.getIntegrationStatus === 'function') {
      // Canonical signature requires a configId, but the test mock supplies a
      // zero-arg overload that returns a single status — preserve that path.
      rawStatuses = await (integrationService.getIntegrationStatus as (id?: string) => unknown)();
    } else {
      rawStatuses = [];
    }

    const normalized = Array.isArray(rawStatuses)
      ? rawStatuses
      : rawStatuses == null
        ? []
        : [rawStatuses];
    const tenantStatuses = filterStatusesForTenant(tenantId, normalized);

    // Use env config for debug flag (defaults to false if not set)
    const debugEnabled = process.env.DEBUG_INTEGRATION_STATUS === '1' || env.LOG_LEVEL === 'debug';
    if (debugEnabled) {
      const type = Array.isArray(tenantStatuses) ? 'array' : typeof tenantStatuses;
      const logger = _logger || defaultLogger;
      logger.debug('[integration:status] debug', { rawType: typeof rawStatuses, isRawArray: Array.isArray(rawStatuses), normalizedType: type, normalizedLength: Array.isArray(tenantStatuses) ? tenantStatuses.length : undefined });
    }

    res.status(200).json(tenantStatuses);
  });
  router.get(`${base}/status`, statusAllHandler);
  router.get('/status', statusAllHandler);

  /**
   * @swagger
   * /api/integrations/{id}/status:
   *   get:
   *     summary: Get specific integration status
   *     description: Retrieves the current status and execution details for a specific integration
   *     tags: [Integrations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     responses:
   *       200:
   *         description: Integration status details
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                   description: Integration configuration ID
   *                   example: "sf_to_ns_customers"
   *                 name:
   *                   type: string
   *                   description: Integration display name
   *                   example: "Salesforce to NetSuite Customer Sync"
   *                 status:
   *                   type: string
   *                   enum: [idle, running, completed, failed, stopping]
   *                   description: Current execution status
   *                   example: "running"
   *                 startTime:
   *                   type: string
   *                   format: date-time
   *                   description: Current execution start time
   *                   example: "2024-01-15T10:30:00Z"
   *                 progress:
   *                   type: object
   *                   properties:
   *                     processed:
   *                       type: number
   *                       description: Records processed so far
   *                       example: 250
   *                     total:
   *                       type: number
   *                       description: Total records to process
   *                       example: 1000
   *                     percentage:
   *                       type: number
   *                       description: Completion percentage
   *                       example: 25
   *                     currentBatch:
   *                       type: number
   *                       description: Current batch being processed
   *                       example: 3
   *                     totalBatches:
   *                       type: number
   *                       description: Total number of batches
   *                       example: 10
   *                 performance:
   *                   type: object
   *                   properties:
   *                     recordsPerSecond:
   *                       type: number
   *                       description: Current processing rate
   *                       example: 15.6
   *                     avgResponseTime:
   *                       type: number
   *                       description: Average API response time in milliseconds
   *                       example: 250
   *                     errors:
   *                       type: number
   *                       description: Number of errors encountered
   *                       example: 2
   *                     retries:
   *                       type: number
   *                       description: Number of retry attempts
   *                       example: 1
   *                 lastError:
   *                   type: object
   *                   properties:
   *                     message:
   *                       type: string
   *                       description: Last error message
   *                       example: "Rate limit exceeded, retrying..."
   *                     timestamp:
   *                       type: string
   *                       format: date-time
   *                       description: Error timestamp
   *                       example: "2024-01-15T10:35:00Z"
   *                     recordId:
   *                       type: string
   *                       description: Record ID that caused the error
   *                       example: "0031234567890ABC"
   *                 estimatedCompletion:
   *                   type: string
   *                   format: date-time
   *                   description: Estimated completion time
   *                   example: "2024-01-15T11:00:00Z"
   *               example:
   *                 id: "sf_to_ns_customers"
   *                 name: "Salesforce to NetSuite Customer Sync"
   *                 status: "running"
   *                 startTime: "2024-01-15T10:30:00Z"
   *                 progress:
   *                   processed: 250
   *                   total: 1000
   *                   percentage: 25
   *                   currentBatch: 3
   *                   totalBatches: 10
   *                 performance:
   *                   recordsPerSecond: 15.6
   *                   avgResponseTime: 250
   *                   errors: 2
   *                   retries: 1
   *                 lastError:
   *                   message: "Rate limit exceeded, retrying..."
   *                   timestamp: "2024-01-15T10:35:00Z"
   *                   recordId: "0031234567890ABC"
   *                 estimatedCompletion: "2024-01-15T11:00:00Z"
   *       404:
   *         description: Integration configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const statusByIdHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Integration ID is required' });
      return;
    }
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const status = (await integrationService.getSyncStatus?.(id)) ?? integrationService.getIntegrationStatus(id);
    res.status(200).json(status);
  });
  router.get(`${base}/:id/status`, statusByIdHandler);
  router.get('/:id/status', statusByIdHandler);

  // Webhooks
  const getWebhooksHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const hooks = await requireMethod(integrationService, 'getWebhooks')(id);
    res.status(200).json(hooks);
  });
  router.get(`${base}/:id/webhooks`, getWebhooksHandler);
  router.get('/:id/webhooks', getWebhooksHandler);

  const urlRegex = /^(https?:\/\/)[\w.-]+(?::\d+)?(\/.*)?$/i;
  const registerWebhookHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { url, events, secret } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    if (typeof url !== 'string' || !urlRegex.test(url)) {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'Events must be an array' });
    }
    const payload = { url, events, ...(secret ? { secret } : {}) };
    const result = await requireMethod(integrationService, 'registerWebhook')(id, payload);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/webhooks`, registerWebhookHandler);
  router.post('/:id/webhooks', registerWebhookHandler);

  const unregisterWebhookHandler = asyncHandler(async (req, res) => {
    const { id, webhookId } = req.params as { id?: string; webhookId?: string };
    if (!id || !webhookId) return res.status(400).json({ error: 'Integration ID and webhookId are required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const result = await requireMethod(integrationService, 'unregisterWebhook')(id, webhookId);
    res.status(200).json(result);
  });
  router.delete(`${base}/:id/webhooks/:webhookId`, unregisterWebhookHandler);
  router.delete('/:id/webhooks/:webhookId', unregisterWebhookHandler);

  // Field mappings
  const getMappingsHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const mappings = await requireMethod(integrationService, 'getFieldMappings')(id);
    res.status(200).json(mappings);
  });
  router.get(`${base}/:id/mappings`, getMappingsHandler);
  router.get('/:id/mappings', getMappingsHandler);

  const saveMappingsHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { mappings } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Mappings must be an array' });
    const result = await requireMethod(integrationService, 'saveFieldMappings')(id, mappings);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/mappings`, saveMappingsHandler);
  router.post('/:id/mappings', saveMappingsHandler);

  const validateMappingsHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { mappings } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const result = await requireMethod(integrationService, 'validateMappings')(id, mappings);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/mappings/validate`, validateMappingsHandler);
  router.post('/:id/mappings/validate', validateMappingsHandler);

  const previewMappingsHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { sample, mappings } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Integration ID is required' });
    // PR 13c-4 Task 6: anonymous-bypass closure.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;
    if (!ownsIntegration(tenantId, id)) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const result = await requireMethod(integrationService, 'getTransformationPreview')(id, sample, mappings);
    res.status(200).json(result);
  });
  router.post(`${base}/:id/mappings/preview`, previewMappingsHandler);
  router.post('/:id/mappings/preview', previewMappingsHandler);

  return router;
};
