// Typed errors for the workflowCentral subsystem. Route boundary maps these
// to HTTP codes via a dedicated mapper (see src/routes/workflowCentral.ts).
// No magic-string regex on err.message; always check typed `code` field.
//
// RaceLostError is re-exported here for collocated imports but lives in
// types.ts to avoid duplicating PR-OP-2's existing definition.

import type { WorkflowInstance } from '../WorkflowCentralService';

export { RaceLostError } from './types';

export class WorkflowInstanceMissingError extends Error {
  readonly code = 'workflow_instance_missing' as const;
  constructor(readonly tenantId: string, readonly instanceId: string) {
    super(`workflow instance ${instanceId} not found in tenant ${tenantId}`);
    this.name = 'WorkflowInstanceMissingError';
  }
}

export class WorkflowDefinitionMissingError extends Error {
  readonly code = 'workflow_definition_missing' as const;
  constructor(readonly workflowId: string) {
    super(`workflow definition ${workflowId} not registered`);
    this.name = 'WorkflowDefinitionMissingError';
  }
}

export class InvalidStateTransitionError extends Error {
  readonly code = 'invalid_state_transition' as const;
  constructor(
    readonly tenantId: string,
    readonly instanceId: string,
    readonly currentStatus: WorkflowInstance['status'],
    readonly attempted: 'pause' | 'resume',
    readonly validSources: WorkflowInstance['status'][],
  ) {
    super(
      `cannot ${attempted} instance ${instanceId} from status ${currentStatus} (valid: ${validSources.join(', ')})`,
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class InstancePausedError extends Error {
  readonly code = 'instance_paused' as const;
  constructor(readonly tenantId: string, readonly instanceId: string) {
    super(`workflow instance ${instanceId} is paused; resume before completing tasks`);
    this.name = 'InstancePausedError';
  }
}

// Thrown by completeTask when the request body's actionId doesn't match any of
// task.actions[]. Route mapper translates to 400 invalid_action (spec §6.1).
// Spec §3.2 step 3a call signature: new InvalidActionError(actionId, task.actions.map(a => a.id))
export class InvalidActionError extends Error {
  readonly code = 'invalid_action' as const;
  constructor(readonly actionId: string, readonly validActionIds: string[]) {
    super(`action ${actionId} not valid; expected one of: ${validActionIds.join(', ')}`);
    this.name = 'InvalidActionError';
  }
}

// Workflow-central-scoped NotFoundError. `src/errors/NotFoundError.ts` exists
// at the repo root but is a general AppError subclass — the workflow-central
// surface keeps a local subclass so the audit `error_class` column reads
// consistently across operator actions. Route mapper → 404 not_found (spec §6.1).
export class NotFoundError extends Error {
  readonly code = 'not_found' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// NEW in PR-OP-3 (no existing typed class for the 409 path). PR-OP-2's operator
// service catches `RaceLostError` and translates to the string result code
// `'already_dispositioned'`; PR-OP-3 introduces this typed class so route
// mappers and unit tests can branch via `instanceof` consistently across all
// operator actions. Route mapper → 409 already_dispositioned (spec §6.1).
export class AlreadyDispositionedError extends Error {
  readonly code = 'already_dispositioned' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyDispositionedError';
  }
}

/**
 * Thrown by the activity-log read path when the caller-supplied `limit`
 * fails the bounded-integer contract `[1, max]`. Route mapper → 400
 * invalid_limit. Defends against array-shape (?limit=a&limit=b), empty
 * string (?limit=), non-numeric (?limit=abc), negative, decimal, and
 * over-cap values per [[feedback-copilot-input-shape-waves]].
 */
export class InvalidLimitError extends Error {
  readonly code = 'invalid_limit' as const;
  constructor(readonly received: unknown, readonly min: number, readonly max: number) {
    super(`limit must be an integer in [${min}, ${max}]; received ${String(received)}`);
    this.name = 'InvalidLimitError';
  }
}

/**
 * Thrown by the activity-log route when `instanceId` is shape-invalid
 * (array shape `?instanceId=a&instanceId=b`, non-string, etc.). Distinct
 * from `InvalidLimitError` so route consumers see an accurate error code +
 * message rather than a misleading "limit must be…" message. Route mapper
 * → 400 invalid_instance_id. Copilot R1 thread on route param parsing.
 */
export class InvalidInstanceIdError extends Error {
  readonly code = 'invalid_instance_id' as const;
  constructor(readonly received: unknown) {
    // Surface the actual shape — array length, plain object, number, etc. —
    // and a truncated string repr so 400 bodies and logs are actionable when
    // debugging malformed queries. typeof alone collapses arrays/objects
    // into 'object', dropping the actionable signal. Copilot R4.
    const shape = Array.isArray(received)
      ? `array(length=${received.length})`
      : typeof received;
    const sample = String(received).slice(0, 80);
    super(`instanceId must be a single string; received ${shape} (${sample})`);
    this.name = 'InvalidInstanceIdError';
  }
}
