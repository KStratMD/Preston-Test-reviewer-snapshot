import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { WorkflowCentralService, WorkflowDefinition } from '../services/WorkflowCentralService';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';
import type { WorkflowCentralOperatorService } from '../services/workflowCentral/WorkflowCentralOperatorService';
import type { WorkflowEngineService } from '../services/workflowCentral/WorkflowEngineService';
import { workflowCentralReadyGate } from '../middleware/workflowCentralReady';
import {
  WorkflowInstanceMissingError,
  WorkflowDefinitionMissingError,
  InvalidStateTransitionError,
  InstancePausedError,
  InvalidActionError,
  InvalidLimitError,
  InvalidInstanceIdError,
  NotFoundError,
  AlreadyDispositionedError,
  RaceLostError,
} from '../services/workflowCentral/errors';
import {
  ACTIVITY_LOG_MAX_LIMIT,
  ACTIVITY_LOG_MIN_LIMIT,
} from '../services/workflowCentral/config';
import {
  EphemeralPayloadExpiredError,
  EphemeralPayloadNotAllowedError,
} from '../services/workflowCentral/payload/errors';

// ---------------------------------------------------------------------------
// Typed-error → HTTP response mapper (spec §6.1, T10)
// ---------------------------------------------------------------------------
function mapErrorToResponse(err: unknown): { status: number; body: { ok: false; code: string; message?: string } } {
  if (err instanceof WorkflowInstanceMissingError) {
    return { status: 500, body: { ok: false, code: 'workflow_instance_missing', message: err.message } };
  }
  if (err instanceof WorkflowDefinitionMissingError) {
    return { status: 400, body: { ok: false, code: 'workflow_definition_missing', message: err.message } };
  }
  if (err instanceof InvalidStateTransitionError) {
    return { status: 409, body: { ok: false, code: 'invalid_state_transition', message: err.message } };
  }
  if (err instanceof InstancePausedError) {
    return { status: 409, body: { ok: false, code: 'instance_paused', message: err.message } };
  }
  if (err instanceof InvalidActionError) {
    return { status: 400, body: { ok: false, code: 'invalid_action', message: err.message } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { ok: false, code: 'not_found', message: err.message } };
  }
  if (err instanceof AlreadyDispositionedError) {
    return { status: 409, body: { ok: false, code: 'already_dispositioned', message: err.message } };
  }
  if (err instanceof InvalidLimitError) {
    return { status: 400, body: { ok: false, code: 'invalid_limit', message: err.message } };
  }
  if (err instanceof InvalidInstanceIdError) {
    return { status: 400, body: { ok: false, code: 'invalid_instance_id', message: err.message } };
  }
  // Phase 1 governance-without-hosting-data (ADR-019): only the ephemeral whole-render
  // errors map at route-level. Per-ref PayloadRef* failures live INSIDE the 200-response
  // resolution[i].error per the partial-success contract — they are NOT mapped here.
  if (err instanceof EphemeralPayloadExpiredError) {
    return { status: 410, body: { ok: false, code: err.code, message: err.message } };
  }
  if (err instanceof EphemeralPayloadNotAllowedError) {
    return { status: 403, body: { ok: false, code: err.code, message: err.message } };
  }
  if (err instanceof RaceLostError) {
    // D25 + T8 wrapper: should be unreachable since callCompleteTaskAtomicWithCASTranslation
    // already translates this to AlreadyDispositionedError. If we reach here, treat as
    // invariant breach.
    return { status: 500, body: { ok: false, code: 'cascade_failed' } };
  }
  return { status: 500, body: { ok: false, code: 'internal_error' } };
}

const router = express.Router();

// Mount readiness gate before any handler — all requests 503 until
// engine.hydrationReady === true (set by Server.start() → engine.hydrate()).
// The engine is a synchronous singleton; container.get() is safe here.
router.use(workflowCentralReadyGate(container.get<WorkflowEngineService>(TYPES.WorkflowEngineService)));

async function getService(): Promise<WorkflowCentralService> {
  return container.getAsync<WorkflowCentralService>(TYPES.WorkflowCentralService);
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const userId = req.query.userId as string | undefined;
  const dashboard = await service.getDashboard(tenantId, userId);
  res.json(dashboard);
}));

router.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'workflow-central' });
});

router.get('/metrics', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const metrics = await service.getMetrics(tenantId);
  res.json(metrics);
}));

router.get('/by-category', asyncHandler(async (_req, res) => {
  const service = await getService();
  const byCategory = service.getWorkflowsByCategory();
  res.json(byCategory);
}));

// =============================================================================
// Workflow Definitions
// =============================================================================

router.get('/definitions', asyncHandler(async (req, res) => {
  const service = await getService();
  const filters = {
    category: req.query.category as string | undefined,
    status: req.query.status as any,
    search: req.query.search as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getDefinitions(filters);
  res.json(result);
}));

router.get('/definitions/:id', asyncHandler(async (req, res) => {
  const service = await getService();
  const definition = await service.getDefinition(req.params.id);
  if (!definition) {
    return res.status(404).json({ error: 'Workflow definition not found' });
  }
  res.json(definition);
}));

router.post('/definitions', asyncHandler(async (req, res) => {
  const service = await getService();
  const { name, description, category, triggerType, triggerConfig, steps, variables, slaHours, createdBy } = req.body;

  if (!name || !description || !category || !triggerType || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const definition = await service.createDefinition({
    name, description, category, triggerType, triggerConfig, steps, variables, slaHours, createdBy,
  });

  res.status(201).json(definition);
}));

router.put('/definitions/:id', asyncHandler(async (req, res) => {
  const service = await getService();
  // Whitelist allowed fields to prevent mass assignment (must match service.updateDefinition signature)
  const updates: Partial<Pick<WorkflowDefinition, 'name' | 'description' | 'category' | 'triggerType' | 'triggerConfig' | 'steps' | 'variables' | 'slaHours'>> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.category !== undefined) updates.category = req.body.category;
  if (req.body.triggerType !== undefined) updates.triggerType = req.body.triggerType;
  if (req.body.triggerConfig !== undefined) updates.triggerConfig = req.body.triggerConfig;
  if (req.body.steps !== undefined) updates.steps = req.body.steps;
  // Definition-update route — `variables` here is WorkflowVariable[] (variable
  // DECLARATIONS on the workflow template, NOT runtime customer payload).
  // Out of scope for ADR-019 Phase 1 (targets WorkflowInstance.variables /
  // Task.data — runtime values, not definition schemas).
  // LEGACY-COMPAT: payload-custody-gate
  if (req.body.variables !== undefined) updates.variables = req.body.variables;
  if (req.body.slaHours !== undefined) updates.slaHours = req.body.slaHours;

  const definition = await service.updateDefinition(req.params.id, updates);
  if (!definition) {
    return res.status(404).json({ error: 'Workflow definition not found or not in draft status' });
  }
  res.json(definition);
}));

router.post('/definitions/:id/publish', asyncHandler(async (req, res) => {
  const service = await getService();
  const definition = await service.publishDefinition(req.params.id);
  if (!definition) {
    return res.status(404).json({ error: 'Workflow definition not found or not in draft status' });
  }
  res.json(definition);
}));

router.post('/definitions/:id/deprecate', asyncHandler(async (req, res) => {
  const service = await getService();
  const definition = await service.deprecateDefinition(req.params.id);
  if (!definition) {
    return res.status(404).json({ error: 'Workflow definition not found or not active' });
  }
  res.json(definition);
}));

router.post('/definitions/:id/steps', asyncHandler(async (req, res) => {
  const service = await getService();
  const step = req.body;
  if (!step.name || !step.type || step.order === undefined) {
    return res.status(400).json({ error: 'Missing required step fields' });
  }
  const definition = await service.addStep(req.params.id, step);
  if (!definition) {
    return res.status(404).json({ error: 'Workflow definition not found or not in draft status' });
  }
  res.json(definition);
}));

// =============================================================================
// Workflow Instances
// =============================================================================

router.get('/instances', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  // Normalize Express-parsed query values: repeating any query param at the URL
  // level (e.g. `?status=running&status=waiting`) yields a string-array at
  // runtime, which this route doesn't support — passing the array through
  // would bleed a 500 out of the repo predicate. Same goes for non-numeric
  // `limit` / `offset` (parseInt yields NaN → invalid SQL bindings). Reject
  // every malformed shape with 400 so misuse fails deterministically (Copilot
  // R3 + R6 findings).
  //
  // Each parser returns the parsed value on success or a 400 message string on
  // failure. Caller pattern: `if (result instanceof InvalidParam) return ...;`
  // — TypeScript narrows reliably on `instanceof` (discriminated-union
  // narrowing via boolean discriminators was flaky under tsconfig.strict).
  class InvalidParam {
    constructor(readonly message: string) {}
  }
  const stringParam = (raw: unknown, name: string): string | undefined | InvalidParam => {
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return new InvalidParam(`\`${name}\` must be a single string`);
    if (typeof raw !== 'string') return new InvalidParam(`\`${name}\` must be a string`);
    return raw;
  };
  const intParam = (raw: unknown, name: string): number | undefined | InvalidParam => {
    if (raw === undefined) return undefined;
    if (Array.isArray(raw) || typeof raw !== 'string')
      return new InvalidParam(`\`${name}\` must be a single non-negative integer`);
    // Empty / whitespace-only strings (`?limit=`) used to short-circuit as
    // "param absent" via `req.query.limit ? ... : undefined`. `Number('')`
    // is `0`, which would pass the integer check and silently change the
    // paging behaviour from "default limit" to "return zero rows" — Copilot
    // R7 finding. Preserve the prior semantics by treating empty as absent.
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      return new InvalidParam(`\`${name}\` must be a single non-negative integer`);
    return n;
  };
  const reject400 = (message: string) =>
    res.status(400).json({ ok: false, code: 'invalid_query_param', message });

  const statusParse = stringParam(req.query.status, 'status');
  if (statusParse instanceof InvalidParam)
    return reject400(`${statusParse.message} (use \`?status=active\` for the multi-status bucket)`);
  const workflowIdParse = stringParam(req.query.workflowId, 'workflowId');
  if (workflowIdParse instanceof InvalidParam) return reject400(workflowIdParse.message);
  const startedByParse = stringParam(req.query.startedBy, 'startedBy');
  if (startedByParse instanceof InvalidParam) return reject400(startedByParse.message);
  const limitParse = intParam(req.query.limit, 'limit');
  if (limitParse instanceof InvalidParam) return reject400(limitParse.message);
  const offsetParse = intParam(req.query.offset, 'offset');
  if (offsetParse instanceof InvalidParam) return reject400(offsetParse.message);

  // `?status=active` is a synthetic bucket covering currently-executing rows
  // (`running` + `waiting`) AND backfilled `unknown_recovered` instances from
  // migration 042 (spec §3.5 / D5). Terminal states (completed/cancelled/
  // failed) and `paused` are intentionally excluded.
  const ACTIVE_STATUSES = ['running', 'waiting', 'unknown_recovered'] as const;
  const filters = {
    workflowId: workflowIdParse,
    status: statusParse === 'active' ? undefined : (statusParse as any),
    statuses: statusParse === 'active' ? [...ACTIVE_STATUSES] : undefined,
    startedBy: startedByParse,
    limit: limitParse,
    offset: offsetParse,
  };
  const result = await service.getInstances(tenantId, filters);
  res.json(result);
}));

router.get('/instances/:id', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const instance = await service.getInstance(tenantId, req.params.id);
  if (!instance) {
    return res.status(404).json({ error: 'Workflow instance not found' });
  }
  res.json(instance);
}));

router.post('/instances', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);
  const { workflowId, variables, startedBy: bodyStartedBy } = req.body ?? {};

  // Codex BLOCKS-MERGE R-fix: prefer the authenticated identity over body-
  // supplied startedBy. Body is trusted ONLY when both ctx fields are
  // SYSTEM_IDENTITY (the documented pre-auth demo path). Mirrors the
  // cancel/complete/delegate BM-1 R-fix pattern. Without this, an
  // authenticated caller could spoof the start-instance audit actor via
  // the audit log's user_id column.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const startedBy = isPreAuth ? bodyStartedBy : ctxUserId;

  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required' });
  }
  if (typeof startedBy !== 'string' || startedBy.trim().length === 0) {
    return res.status(400).json({ error: 'startedBy is required (must be a non-empty string)' });
  }

  const result = await service.startInstance({ tenantId, workflowId, variables, startedBy });
  if (!result) {
    return res.status(404).json({ error: 'Workflow definition not found or not active' });
  }

  res.status(201).json(result);
}));

router.post('/instances/:id/cancel', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);
  const { cancelledBy: bodyCancelledBy, reason } = req.body ?? {};

  // Codex BM-1 R-fix: prefer the authenticated identity over body-supplied
  // cancelledBy. Body is trusted ONLY when both ctx fields are SYSTEM_IDENTITY
  // (the documented pre-auth demo path). Mirrors the FinanceCentral approve/
  // reject route policy. Without this, an authenticated operator could record
  // a cancel as any arbitrary user via the audit log's user_id column.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const cancelledBy = isPreAuth ? bodyCancelledBy : ctxUserId;

  if (typeof cancelledBy !== 'string' || cancelledBy.trim().length === 0) {
    return res.status(400).json({ error: 'cancelledBy is required (must be a non-empty string)' });
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string when provided' });
  }

  const instance = await service.cancelInstance(tenantId, req.params.id, cancelledBy, reason);
  if (!instance) {
    return res.status(404).json({ error: 'Workflow instance not found or not running' });
  }
  res.json(instance);
}));

router.post('/instances/:id/pause', asyncHandler(async (req, res) => {
  const service = await getService();
  // Codex BM-3 R-fix: pause/resume now require tenant identity (was tenantless,
  // matching the now-removed broken `_findInstanceById`).
  const { tenantId } = extractIdentityContext(req);
  try {
    const instance = await service.pauseInstance(tenantId, req.params.id);
    if (!instance) {
      // Unified mapper shape — same contract as the InvalidStateTransitionError path (Copilot R2).
      return res.status(404).json({ ok: false, code: 'not_found', message: 'Workflow instance not found or not running' });
    }
    res.json(instance);
  } catch (err) {
    // pauseInstance rethrows InvalidStateTransitionError on wrong status.
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

router.post('/instances/:id/resume', asyncHandler(async (req, res) => {
  const service = await getService();
  // Codex BM-3 R-fix (see pause).
  const { tenantId } = extractIdentityContext(req);
  try {
    const instance = await service.resumeInstance(tenantId, req.params.id);
    if (!instance) {
      // Unified mapper shape — same contract as the InvalidStateTransitionError path (Copilot R2).
      return res.status(404).json({ ok: false, code: 'not_found', message: 'Workflow instance not found or not paused' });
    }
    res.json(instance);
  } catch (err) {
    // resumeInstance rethrows InvalidStateTransitionError on wrong status.
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

// =============================================================================
// Tasks
// =============================================================================

router.get('/tasks', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const filters = {
    instanceId: req.query.instanceId as string | undefined,
    status: req.query.status as any,
    priority: req.query.priority as any,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getTasks(tenantId, filters);
  res.json(result);
}));

router.get('/tasks/assignee/:assigneeId', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const status = req.query.status as any;
  const tasks = await service.getTasksByAssignee(tenantId, req.params.assigneeId, status);
  res.json(tasks);
}));

router.get('/tasks/:id', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const task = await service.getTask(tenantId, req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
}));

// Task ID shape validator (Phase 1 T11 / ADR-019).
// Task IDs are `TASK-${Date.now()}-${idSeq}` (WorkflowEngineService.ts:912,
// WorkflowCentralRepository.ts:391). Validator rejects empty / whitespace-
// padded / >128 chars / non-[A-Za-z0-9-]. Does NOT enforce the TASK- prefix
// (over-strict — would break future ID schemes) and does NOT validate tenant
// ownership (404 case via repo.getById returning null). Cross-tenant access
// falls into 404, NOT 400 — response doesn't leak whether ID exists elsewhere.
// Per feedback_copilot_input_shape_waves — enumerate shapes UPFRONT.
const TASK_ID_SHAPE_RE = /^[A-Za-z0-9-]+$/;
function isValidTaskIdShape(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  if (trimmed !== id) return false;
  if (id.length > 128) return false;
  return TASK_ID_SHAPE_RE.test(id);
}

router.get('/tasks/:id/render', asyncHandler(async (req, res) => {
  if (!isValidTaskIdShape(req.params.id)) {
    return res.status(400).json({
      ok: false,
      code: 'invalid_task_id',
      message: 'Task id must be 1-128 chars, A-Z a-z 0-9 dash only',
    });
  }
  const { tenantId } = extractIdentityContext(req);
  const operator = await container.getAsync<WorkflowCentralOperatorService>(TYPES.WorkflowCentralOperatorService);

  try {
    const render = await operator.getTaskForOperator(tenantId, req.params.id);
    // 200 with the discriminated TaskRenderModel — per-ref connector failures
    // live INSIDE render.resolution[i].error per the partial-success contract.
    return res.status(200).json(render);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

router.post('/tasks/:id/complete', asyncHandler(async (req, res) => {
  const { actionId, completedBy: bodyCompletedBy, comment, data } = req.body ?? {};

  // Field validation per spec D5 F-08
  if (typeof actionId !== 'string' || actionId.trim() === '') {
    return res.status(400).json({ ok: false, code: 'invalid_request_body', message: 'actionId must be a non-empty string' });
  }
  if (comment !== undefined && typeof comment !== 'string') {
    return res.status(400).json({ ok: false, code: 'invalid_request_body', message: 'comment must be a string when provided' });
  }
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return res.status(400).json({ ok: false, code: 'invalid_request_body', message: 'data must be an object when provided' });
  }

  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);

  // Codex BM-1 R-fix: prefer authenticated identity over body-supplied
  // completedBy. Body is honored ONLY in the pre-auth demo path where both
  // ctx fields are SYSTEM_IDENTITY. See the cancel route above for the full
  // mixed-auth-edge-case rationale.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const completedBy = isPreAuth ? bodyCompletedBy : ctxUserId;
  if (typeof completedBy !== 'string' || completedBy.trim() === '') {
    return res.status(400).json({ ok: false, code: 'invalid_request_body', message: 'completedBy must be a non-empty string' });
  }

  const operator = await container.getAsync<WorkflowCentralOperatorService>(TYPES.WorkflowCentralOperatorService);

  // PR-OP-3 T8: operator.completeTask now throws TYPED errors for not_found /
  // invalid_action / instance_paused / already_dispositioned / workflow_instance_missing
  // paths (per D25). The only remaining {ok:false} result-code path is cascade_failed
  // (untyped catch-all for unexpected runtime errors). Route maps typed throws via
  // mapErrorToResponse — matches the pause/resume handler pattern above.
  try {
    const result = await operator.completeTask({
      tenantId,
      taskId: req.params.id,
      completion: { actionId, completedBy, comment, data },
    });

    if (result.ok) {
      return res.status(200).json(result);
    }
    // Only cascade_failed reaches here (untyped catch-all from T8).
    return res.status(500).json(result);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

router.post('/tasks/:id/delegate', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);
  const { newAssigneeId, newAssigneeName, delegatedBy: bodyDelegatedBy } = req.body ?? {};

  if (typeof newAssigneeId !== 'string' || newAssigneeId.trim() === '') {
    return res.status(400).json({ error: 'newAssigneeId is required (must be a non-empty string)' });
  }
  if (typeof newAssigneeName !== 'string' || newAssigneeName.trim() === '') {
    return res.status(400).json({ error: 'newAssigneeName is required (must be a non-empty string)' });
  }

  // Codex BM-1 R-fix: same pattern as cancel + complete. Body actor honored
  // ONLY in the documented pre-auth demo path; otherwise the authenticated
  // user is the canonical delegation actor.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const delegatedBy = isPreAuth ? bodyDelegatedBy : ctxUserId;
  if (typeof delegatedBy !== 'string' || delegatedBy.trim() === '') {
    return res.status(400).json({ error: 'delegatedBy is required (must be a non-empty string)' });
  }

  const task = await service.delegateTask(tenantId, req.params.id, newAssigneeId, newAssigneeName, delegatedBy);
  if (!task) {
    return res.status(404).json({ error: 'Task not found or not pending' });
  }
  res.json(task);
}));

// =============================================================================
// Activity
// =============================================================================

router.get('/activity', asyncHandler(async (req, res) => {
  const { tenantId } = extractIdentityContext(req);
  // Input-shape defense per [[feedback-copilot-input-shape-waves]]: reject
  // array (?limit=a&limit=b), undefined-via-empty-string (?limit=), non-numeric,
  // decimal, and out-of-range upfront. Repo also re-validates as belt-and-braces.
  let limit: number | undefined;
  try {
    limit = parseActivityLimitQuery(req.query.limit);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
  let instanceId: string | undefined;
  try {
    instanceId = parseActivityInstanceIdQuery(req.query.instanceId);
  } catch (err) {
    const mapped = mapErrorToResponse(err);
    return res.status(mapped.status).json(mapped.body);
  }
  const service = await getService();
  const activity = await service.getRecentActivity(tenantId, { limit, instanceId });
  res.json(activity);
}));

// ---------------------------------------------------------------------------
// /activity query-param parsers
// Defensive against every Express query-shape: string, array, undefined,
// empty-string, non-numeric, decimal, negative, out-of-range. Bounds imported
// from workflowCentral/config so route + repo stay in sync without the route
// having to import the repo module just for a constant. Copilot R4.
// ---------------------------------------------------------------------------
const ACTIVITY_LIMIT_MIN = ACTIVITY_LOG_MIN_LIMIT;
const ACTIVITY_LIMIT_MAX = ACTIVITY_LOG_MAX_LIMIT;

function parseActivityLimitQuery(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    // Array, object, etc. — reject explicitly. Repo's bounded-int check
    // would also throw, but the error message is clearer here.
    throw new InvalidLimitError(raw, ACTIVITY_LIMIT_MIN, ACTIVITY_LIMIT_MAX);
  }
  const trimmed = raw.trim();
  if (trimmed === '') throw new InvalidLimitError(raw, ACTIVITY_LIMIT_MIN, ACTIVITY_LIMIT_MAX);
  // Reject decimals and non-integer numeric strings. parseInt would silently
  // truncate '1.5' → 1; Number('1.5') is 1.5 which !Number.isInteger.
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new InvalidLimitError(raw, ACTIVITY_LIMIT_MIN, ACTIVITY_LIMIT_MAX);
  }
  if (n < ACTIVITY_LIMIT_MIN || n > ACTIVITY_LIMIT_MAX) {
    throw new InvalidLimitError(raw, ACTIVITY_LIMIT_MIN, ACTIVITY_LIMIT_MAX);
  }
  return n;
}

function parseActivityInstanceIdQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    // Distinct typed error so the response code/message is accurate
    // (was reusing InvalidLimitError → misleading "limit must be…" body).
    throw new InvalidInstanceIdError(raw);
  }
  const trimmed = raw.trim();
  if (trimmed === '') return undefined; // empty string == no filter
  return trimmed;
}

export { router as workflowCentralRouter };
