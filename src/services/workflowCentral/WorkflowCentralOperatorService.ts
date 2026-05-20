import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import { WorkflowCentralRepository } from './WorkflowCentralRepository';
import { WorkflowEngineService, persistedToWorkflowInstance } from './WorkflowEngineService';
import { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database, NewAuditLog } from '../../database/types';
import {
  RaceLostError,
  type CascadePlan,
  type CompleteTaskResult,
  type InstancePatch,
  type PersistedInstance,
  type PersistedTask,
  type StepExecution,
} from './types';
import {
  AlreadyDispositionedError,
  InstancePausedError,
  InvalidActionError,
  NotFoundError,
  WorkflowInstanceMissingError,
} from './errors';
import { EphemeralPayloadExpiredError, EphemeralPayloadNotAllowedError } from './payload/errors';
import { redactWorkflowPayloadForAudit } from './payload/WorkflowPayload';
import type { WorkflowPayloadResolver, ResolutionOutcome } from './payload/WorkflowPayloadResolver';
import { SYSTEM_IDENTITY } from '../governance/identityContext';
import {
  WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD_SETTING_KEY,
  isEphemeralWorkflowPayloadAllowed,
} from '../../config/runtimeFlags';
import type { TenantConfigurationRepository } from '../../database/repositories/TenantConfigurationRepository';
import { workflowCentralAuditDeliveryFailures } from './metrics';
import { safeActivityLog } from './activityLog';
import { randomUUID } from 'crypto';

/**
 * Operator-promotion service for WorkflowCentral task completion.
 *
 * PR-OP-3 T8 rewrite — 6-step sequence per spec §3.2 (instance durability):
 *   1. Validate input pre-TX (task lookup + action validation; throws typed errors).
 *   2. planCascade (pure — runs inside TX after instance lock + def lookup).
 *   3. db.transaction:
 *        a. selectTaskInstanceId → selectInstanceForUpdate  (instance-first lock order, D21)
 *        b. D21 paused gate (throw InstancePausedError when status='paused')
 *        c. engine.getDefinition lookup (definition_missing branch on miss)
 *        d. planCascade → completeTaskAtomicWithCascade (RaceLostError → AlreadyDispositionedError per D25)
 *        e. CascadePlan → InstancePatch inline (D11) → repo.updateInstanceForTenant
 *   4. refreshCacheFromCommit (engine cache write — outside TX, D9)
 *   5. safeAudit (outside TX; never throws; increments audit-delivery-failure metric on throw)
 *   6. Return discriminated result
 *
 * Typed errors thrown to caller:
 *   - NotFoundError                  → route mapper → 404
 *   - InvalidActionError             → route mapper → 400
 *   - InstancePausedError            → route mapper → 409
 *   - AlreadyDispositionedError      → route mapper → 409
 *   - WorkflowInstanceMissingError   → route mapper → 500 + WARN (invariant breach)
 *   - other thrown errors            → cascade_failed (CompleteTaskResult.ok=false)
 *
 * Pattern source: src/services/financeCentral/FinanceCentralOperatorService.ts
 * Spec: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md §3.2 D11, D21, D25
 */

/**
 * Internal TX-scoped result discriminator.
 */
type CompleteTaskTxResult =
  | {
      kind: 'ok';
      updatedTask: PersistedTask;
      updatedInstance: PersistedInstance | null;
      plan: CascadePlan;
      downstreamTaskIds: string[];
    }
  | { kind: 'definition_missing'; updatedTask: PersistedTask; downstreamTaskIds: string[] };

/**
 * Discriminated render model for the operator surface (Phase 1 T9 / ADR-019).
 * Branches on the underlying task.payload mode:
 *   - 'resolved'  — payload is external_reference; resolver returned per-ref outcomes
 *   - 'ephemeral' — payload is ephemeral_hosted; data flows inline (audit redaction
 *                   happens at the audit-emit site via redactWorkflowPayloadForAudit,
 *                   NOT here — operators need the data to act on the task)
 *   - 'legacy'    — pre-backfill row with `data` populated and no `payload`. The
 *                   transitional fallback lets the operator UI keep rendering during
 *                   Phase 1 rollout; Phase 1 follow-up (Task 19) drops this branch.
 */
export type TaskRenderModel = { task: PersistedTask } & (
  | { kind: 'resolved'; resolution: ResolutionOutcome[] }
  | {
      kind: 'ephemeral';
      ephemeral: { expiresAt: string; reason: string; data: Record<string, unknown> };
    }
  | {
      kind: 'legacy';
      legacyResolution: { fields: Record<string, unknown>; source: 'legacy-row' };
    }
);

@injectable()
export class WorkflowCentralOperatorService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.WorkflowEngineService) private engine: WorkflowEngineService,
    @inject(TYPES.WorkflowCentralRepository) private repo: WorkflowCentralRepository,
    @inject(TYPES.AuditLogRepository) private auditLog: AuditLogRepository,
    @inject(TYPES.DatabaseService) private db: DatabaseService,
    @inject(TYPES.WorkflowPayloadResolver) private payloadResolver: WorkflowPayloadResolver,
    @inject(TYPES.TenantConfigurationRepository) private tenantConfig: TenantConfigurationRepository,
  ) {}

  /**
   * ADR-019 ephemeral payload gate — true when EITHER the global env
   * override (`WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD`) is set OR the tenant
   * has opted in via `workflow.allow_ephemeral_payload = 'true'` in
   * `tenant_configurations`. Env short-circuits so the per-tenant DB
   * read is skipped under global allow.
   *
   * Fail-closed posture: uses `getBooleanStrict` (NOT `getBoolean`) so
   * infra failures surface as thrown errors → 500 at the route layer,
   * NOT silently translated into `false`/403. The standard `getBoolean`
   * routes through `getString`, which deliberately swallows
   * SecretManager errors on encrypted rows (returns null per the
   * "null-on-no-secret" repo contract). For a policy gate that would
   * turn a dead secret backend into a silent 403 policy denial — the
   * exact regression Codex M1 flagged on the first revision of this
   * PR. The strict path additionally rejects encrypted rows for this
   * key (feature gates have no legitimate need to be encrypted).
   */
  private async isEphemeralAllowedForTenant(tenantId: string): Promise<boolean> {
    if (isEphemeralWorkflowPayloadAllowed()) return true;
    return this.tenantConfig.getBooleanStrict(tenantId, WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD_SETTING_KEY);
  }

  /**
   * Operator render path (Phase 1 T9). Reads the task; branches on the
   * payload mode to produce a TaskRenderModel discriminated union. Per-ref
   * connector failures live INSIDE the resolved outcome (`resolution[i].error`)
   * — this method NEVER throws on connector failures. Whole-render conditions
   * (task missing, ephemeral expired) throw typed errors mapped at the route
   * layer (T11).
   */
  async getTaskForOperator(tenantId: string, taskId: string): Promise<TaskRenderModel> {
    const startedAt = Date.now();
    const task = await this.repo.getById(tenantId, taskId);
    if (!task) {
      throw new NotFoundError(`task ${taskId} not found in tenant ${tenantId}`);
    }
    const payload = task.payload;
    if (payload && payload.mode === 'external_reference') {
      const resolution = await this.payloadResolver.resolve(payload.references, tenantId);
      // Audit emit: refs only (no resolved field values) per
      // redactWorkflowPayloadForAudit. Resolved content lives in the response
      // body, never the audit row — keeps long-retention audit DLP-clean per
      // ADR-019 + T12.
      await this.safeAudit({
        ...this.baseRenderAudit(tenantId, taskId, startedAt),
        result: 'success',
        details: this.baseDetails({ tenantId, taskId }, {
          payload: redactWorkflowPayloadForAudit(payload),
          ref_count: payload.references.length,
          resolution_failures: resolution.filter((o) => o.status === 'failed').length,
        }),
      });
      return { task, kind: 'resolved', resolution };
    }
    if (payload && payload.mode === 'ephemeral_hosted') {
      // ADR-019 ephemeral opt-in gate — Codex P1 finding on PR #811 R2.
      // Reject ephemeral payload render unless EITHER the global env
      // flag OR the per-tenant `workflow.allow_ephemeral_payload`
      // setting is opted in. See `isEphemeralAllowedForTenant` above.
      if (!(await this.isEphemeralAllowedForTenant(tenantId))) {
        await this.safeAudit({
          ...this.baseRenderAudit(tenantId, taskId, startedAt),
          result: 'failure',
          error_message: 'ephemeral_payload_not_allowed',
          details: this.baseDetails({ tenantId, taskId }, {
            payload: redactWorkflowPayloadForAudit(payload),
          }),
        });
        throw new EphemeralPayloadNotAllowedError(
          `task ${taskId} requires ephemeral_payload opt-in (env WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD or tenant setting workflow.allow_ephemeral_payload)`,
          { tenantId, taskId },
        );
      }
      if (Date.parse(payload.expiresAt) <= Date.now()) {
        // Audit even the expired path so operators see the attempt
        await this.safeAudit({
          ...this.baseRenderAudit(tenantId, taskId, startedAt),
          result: 'failure',
          error_message: 'ephemeral_payload_expired',
          details: this.baseDetails({ tenantId, taskId }, {
            payload: redactWorkflowPayloadForAudit(payload),
          }),
        });
        throw new EphemeralPayloadExpiredError(
          `task ${taskId} ephemeral payload expired at ${payload.expiresAt}`,
          { tenantId, taskId, expiresAt: payload.expiresAt },
        );
      }
      // Audit: mode + expiresAt + reason only — ephemeral.data NEVER reaches audit.
      // Load-bearing invariant — asserted by the T12 redaction tests.
      await this.safeAudit({
        ...this.baseRenderAudit(tenantId, taskId, startedAt),
        result: 'success',
        details: this.baseDetails({ tenantId, taskId }, {
          payload: redactWorkflowPayloadForAudit(payload),
        }),
      });
      return {
        task,
        kind: 'ephemeral',
        ephemeral: {
          expiresAt: payload.expiresAt,
          reason: payload.reason,
          data: payload.data,
        },
      };
    }
    // Legacy fallback (pre-backfill rows): expose task.data through the same
    // surface so the operator UI keeps rendering until the Phase 1 follow-up
    // drops the legacy columns. Marked source: 'legacy-row' so callers can
    // surface a "migrate me" hint.
    // Audit details record only that the legacy path was taken — task.data is
    // NOT serialized into the audit row (DLP carve-out matches the existing
    // PR-OP-2 D8 rule for completion comments + data).
    await this.safeAudit({
      ...this.baseRenderAudit(tenantId, taskId, startedAt),
      result: 'success',
      details: this.baseDetails({ tenantId, taskId }, {
        payload_kind: 'legacy',
        source: 'legacy-row',
      }),
    });
    return {
      task,
      kind: 'legacy',
      legacyResolution: { fields: task.data, source: 'legacy-row' },
    };
  }

  private baseRenderAudit(
    tenantId: string,
    taskId: string,
    startedAt: number,
  ): Omit<NewAuditLog, 'result' | 'details' | 'error_message'> & { error_message: string | null } {
    return {
      tenant_id: tenantId,
      user_id: SYSTEM_IDENTITY.userId, // PR 2C-Auth populates real userId once mounted
      action: 'workflow_central.render_task',
      resource_type: 'workflow_central_task',
      resource_id: taskId,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  }

  async completeTask(args: {
    tenantId: string;
    taskId: string;
    completion: {
      actionId: string;
      completedBy: string;
      comment?: string;
      data?: Record<string, unknown>;
    };
  }): Promise<CompleteTaskResult> {
    const startedAt = Date.now();

    // ---- Step 1: pre-TX validation ------------------------------------------
    // Pre-TX typed throws ALSO emit failure audit (D15 observability — operators
    // need a trail of every attempt, even ones that bail before the TX opens).

    const task = await this.repo.getById(args.tenantId, args.taskId);
    if (!task) {
      const err = new NotFoundError(`task ${args.taskId} not found in tenant ${args.tenantId}`);
      await this.safeAudit({
        ...this.baseAudit(args, startedAt, args.completion.completedBy),
        result: 'failure',
        error_message: err.code,
        details: this.baseDetails(args, {
          completion_result: err.code,
          action_id: args.completion.actionId,
          task_id: args.taskId,
          error_class: err.name,
        }),
      });
      throw err;
    }

    const taskAction = task.actions.find((a) => a.id === args.completion.actionId);
    if (!taskAction) {
      const err = new InvalidActionError(
        args.completion.actionId,
        task.actions.map((a) => a.id),
      );
      await this.safeAudit({
        ...this.baseAudit(args, startedAt, args.completion.completedBy),
        result: 'failure',
        error_message: err.code,
        details: this.baseDetails(args, {
          completion_result: err.code,
          action_id: args.completion.actionId,
          task_id: args.taskId,
          error_class: err.name,
        }),
      });
      throw err;
    }

    // ---- Step 2-3: TX block --------------------------------------------------

    let txResult: CompleteTaskTxResult;
    try {
      txResult = await this.db.transaction(async (tx) => {
        // Step 3a: instance-first lock order (D21, spec §3.2 — prevents deadlocks
        // when two operators contend on the same instance).
        const taskInstance = await this.repo.selectTaskInstanceId(tx, args.tenantId, args.taskId);
        if (!taskInstance) {
          // Task was deleted between the pre-TX read and the TX. Surface as
          // NotFoundError — caller mapper translates to 404.
          throw new NotFoundError(
            `task ${args.taskId} not found in tenant ${args.tenantId} (vanished mid-TX)`,
          );
        }

        const instance = await this.repo.selectInstanceForUpdate(
          tx,
          args.tenantId,
          taskInstance.instanceId,
        );
        if (!instance) {
          // Lock acquired but no instance row — invariant breach (FK should
          // prevent this). 500 + WARN per D25.
          throw new WorkflowInstanceMissingError(args.tenantId, taskInstance.instanceId);
        }

        // Step 3b: D21 paused gate — reject completeTask on paused instance.
        // Operator must resume the instance first. Route mapper → 409.
        if (instance.status === 'paused') {
          throw new InstancePausedError(args.tenantId, instance.id);
        }

        // Step 3c: definition lookup. Snake_case access per PersistedInstance shape.
        const definition = this.engine.getDefinition(instance.workflow_id);

        const nowIso = new Date().toISOString();

        if (!definition) {
          // Definition_missing branch: complete the task but don't cascade or
          // patch the instance. Outer audit stamps workflow_definition_missing=true.
          const emptyPlan: CascadePlan = {
            downstreamTaskRows: [],
            instanceUpdates: null,
            workflowDefinitionMissing: true,
          };
          const cascadeResult = await this.callCompleteTaskAtomicWithCASTranslation(
            tx,
            args.tenantId,
            args.taskId,
            {
              completedBy: args.completion.completedBy,
              completedAt: nowIso,
              actionId: args.completion.actionId,
              comment: args.completion.comment,
              data: args.completion.data,
            },
            emptyPlan,
          );
          return {
            kind: 'definition_missing',
            updatedTask: cascadeResult.updatedTask,
            downstreamTaskIds: cascadeResult.insertedIds,
          };
        }

        // Step 3d: planCascade (pure). Convert PersistedInstance → WorkflowInstance
        // for the planner shape (D5: cancellationReason is always null on durable reads).
        const planningInstance = persistedToWorkflowInstance(instance, null);
        const plan = this.engine.planCascade(task, planningInstance, taskAction);

        // Step 3d (continued): atomic UPDATE parent + INSERT children.
        const cascadeResult = await this.callCompleteTaskAtomicWithCASTranslation(
          tx,
          args.tenantId,
          args.taskId,
          {
            completedBy: args.completion.completedBy,
            completedAt: nowIso,
            actionId: args.completion.actionId,
            comment: args.completion.comment,
            data: args.completion.data,
          },
          plan,
        );

        // Step 3e: D11 inline CascadePlan → InstancePatch translation.
        let updatedInstance: PersistedInstance | null = null;
        if (plan.instanceUpdates) {
          const sourceStatus = plan.instanceUpdates.status;
          // D5: never overwrite the 'unknown_recovered' marker via patch.
          const shouldSetStatus =
            (sourceStatus === 'completed' || sourceStatus === 'failed') &&
            instance.status !== 'unknown_recovered';

          // planCascade guarantees appendStepHistory is set whenever
          // instanceUpdates is non-null. Cast through the documented shape.
          const stepHistoryAppend = plan.instanceUpdates.appendStepHistory as StepExecution;

          const patch: InstancePatch = {
            kind: 'completeTask',
            currentStepId: plan.instanceUpdates.currentStepId,
            currentStepName: plan.instanceUpdates.currentStepName,
            stepHistoryAppend,
            // shouldSetStatus already narrows sourceStatus to 'completed' | 'failed';
            // the conditional spread reflects D5 (unknown_recovered guard) + the
            // terminal-status constraint in one place.
            ...(shouldSetStatus
              ? { status: sourceStatus as 'completed' | 'failed', completedAt: nowIso }
              : {}),
            updatedAt: nowIso,
          };

          updatedInstance = await this.repo.updateInstanceForTenant(
            tx,
            args.tenantId,
            instance.id,
            patch,
          );
        }

        return {
          kind: 'ok',
          updatedTask: cascadeResult.updatedTask,
          updatedInstance,
          plan,
          downstreamTaskIds: cascadeResult.insertedIds,
        };
      });
    } catch (err) {
      // Re-throw typed errors so the route mapper can translate to HTTP codes.
      if (
        err instanceof NotFoundError ||
        err instanceof InvalidActionError ||
        err instanceof InstancePausedError ||
        err instanceof AlreadyDispositionedError ||
        err instanceof WorkflowInstanceMissingError
      ) {
        // WorkflowInstanceMissingError signals invariant breach (instance row
        // deleted out-from-under a pending task); emit a structured WARN so
        // it surfaces in ops alerting alongside the audit row. Other typed
        // errors here are normal user-input rejections — no WARN.
        if (err instanceof WorkflowInstanceMissingError) {
          this.logger.warn('workflow_instance_missing', {
            error_class: err.name,
            tenant_id: args.tenantId,
            task_id: args.taskId,
            // Include instance_id from the error class so on-call can
            // correlate this WARN with the missing instance row in
            // workflow_central_instances and the failure audit row
            // (Copilot R4).
            instance_id: err.instanceId,
          });
        }
        await this.safeAudit({
          ...this.baseAudit(args, startedAt, args.completion.completedBy),
          result: 'failure',
          error_message: err.code,
          details: this.baseDetails(args, {
            completion_result: err.code,
            action_id: args.completion.actionId,
            task_id: args.taskId,
            error_class: err.name,
          }),
        });
        throw err;
      }

      // Untyped error → cascade_failed result code per PR-OP-2 contract.
      const cause = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ...this.baseAudit(args, startedAt, args.completion.completedBy),
        result: 'failure',
        error_message: 'cascade_failed',
        details: this.baseDetails(args, {
          completion_result: 'cascade_failed',
          task_id: task.id,
          instance_id: task.instanceId,
          workflow_id: task.workflowId,
          workflow_name: task.workflowName,
          step_id: task.stepId,
          step_name: task.stepName,
          action_id: args.completion.actionId,
          action_type: taskAction.type,
          cascade_error_message: cause,
        }),
      });
      return { ok: false, code: 'cascade_failed', cause };
    }

    // ---- Step 4: post-TX engine-cache refresh + audit ------------------------

    if (txResult.kind === 'definition_missing') {
      await this.safeAudit({
        ...this.baseAudit(args, startedAt, args.completion.completedBy),
        result: 'success',
        error_message: null,
        details: this.baseDetails(args, {
          completion_result: 'success',
          result_code: 'workflow_definition_missing',
          task_id: task.id,
          instance_id: task.instanceId,
          workflow_id: task.workflowId,
          workflow_name: task.workflowName,
          step_id: task.stepId,
          step_name: task.stepName,
          action_id: args.completion.actionId,
          action_type: taskAction.type,
          downstream_task_ids: txResult.downstreamTaskIds,
          workflow_definition_missing: true,
        }),
      });

      // Codex R1 High: the task itself completed successfully on this branch
      // (the missing-definition only suppresses downstream cascade). Tee the
      // activity row alongside the audit row so the feed stays complete for
      // every successful task_completed disposition.
      await safeActivityLog({
        repo: this.repo,
        logger: this.logger,
        row: {
          id: randomUUID(),
          tenantId: args.tenantId,
          instanceId: task.instanceId,
          workflowName: task.workflowName,
          action: 'task_completed',
          userId: args.completion.completedBy,
          userName: args.completion.completedBy,
          stepName: task.stepName,
          details: JSON.stringify({
            task_id: task.id,
            action_id: args.completion.actionId,
            action_type: taskAction.type,
            workflow_definition_missing: true,
          }),
          timestamp: new Date().toISOString(),
        },
      });

      return {
        ok: true,
        code: 'ok',
        task: txResult.updatedTask,
        downstreamTaskIds: txResult.downstreamTaskIds,
        workflowDefinitionMissing: true,
      };
    }

    // kind === 'ok'
    if (txResult.updatedInstance) {
      // Engine-cache write happens AFTER successful TX commit per D9.
      this.engine.refreshCacheFromCommit({ instance: txResult.updatedInstance });
    }

    await this.safeAudit({
      ...this.baseAudit(args, startedAt, args.completion.completedBy),
      result: 'success',
      error_message: null,
      details: this.baseDetails(args, {
        completion_result: 'success',
        task_id: task.id,
        instance_id: task.instanceId,
        workflow_id: task.workflowId,
        workflow_name: task.workflowName,
        step_id: task.stepId,
        step_name: task.stepName,
        action_id: args.completion.actionId,
        action_type: taskAction.type,
        downstream_task_ids: txResult.downstreamTaskIds,
        workflow_definition_missing: false,
      }),
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      row: {
        id: randomUUID(),
        tenantId: args.tenantId,
        instanceId: task.instanceId,
        workflowName: task.workflowName,
        action: 'task_completed',
        userId: args.completion.completedBy,
        userName: args.completion.completedBy,
        stepName: task.stepName,
        details: JSON.stringify({
          task_id: task.id,
          action_id: args.completion.actionId,
          action_type: taskAction.type,
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return {
      ok: true,
      code: 'ok',
      task: txResult.updatedTask,
      downstreamTaskIds: txResult.downstreamTaskIds,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Wraps repo.completeTaskAtomicWithCascade with RaceLostError → AlreadyDispositionedError
   * translation per D25. Route mapper sees only AlreadyDispositionedError → 409.
   */
  private async callCompleteTaskAtomicWithCASTranslation(
    tx: Kysely<Database>,
    tenantId: string,
    taskId: string,
    completion: {
      completedBy: string;
      completedAt: string;
      actionId: string;
      comment?: string;
      data?: Record<string, unknown>;
    },
    plan: CascadePlan,
  ): Promise<{ updatedTask: PersistedTask; insertedIds: string[] }> {
    try {
      return await this.repo.completeTaskAtomicWithCascade(tx, tenantId, taskId, completion, plan);
    } catch (err) {
      if (err instanceof RaceLostError) {
        throw new AlreadyDispositionedError(`task ${taskId} race lost (already dispositioned)`);
      }
      throw err;
    }
  }

  private baseAudit(
    args: { tenantId: string; taskId: string },
    startedAt: number,
    userId: string,
  ): Omit<NewAuditLog, 'result' | 'details' | 'error_message'> & { error_message: string | null } {
    return {
      tenant_id: args.tenantId,
      user_id: userId,
      action: 'workflow_central.complete_task',
      resource_type: 'workflow_central_task',
      resource_id: args.taskId,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  }

  private baseDetails(
    args: { tenantId: string; taskId: string },
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      tenant_id: args.tenantId,
      task_id: args.taskId,
      ...extra,
    };
  }

  /**
   * Best-effort audit write. NEVER throws. Increments the
   * workflow_central_audit_delivery_failures_total counter when the audit
   * insert fails AFTER a durable state TX commit — surfacing the durability
   * gap to operators per D15.
   */
  private async safeAudit(entry: NewAuditLog): Promise<void> {
    try {
      await this.auditLog.create(entry);
    } catch (err) {
      this.logger.warn(
        'audit log write failed for workflow-central operator action (instance state durable; audit gap)',
        {
          action: entry.action,
          resource_id: entry.resource_id,
          error: err instanceof Error ? err.message : String(err),
          error_class: err instanceof Error ? err.constructor.name : 'unknown',
        },
      );
      workflowCentralAuditDeliveryFailures.inc({
        action: (entry.action ?? '').replace('workflow_central.', ''),
        outcome: 'thrown',
      });
    }
  }
}
