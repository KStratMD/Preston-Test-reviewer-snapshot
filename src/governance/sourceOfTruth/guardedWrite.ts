import type { OwnershipResolver, OwnershipDecision, WriteOperation } from './OwnershipResolver';
import type { AuditService } from '../../services/ai/orchestrator/AuditService';
import {
  isCanonicalEntity,
  isSourceSystem,
  SOURCE_SYSTEM_TO_CONNECTOR_KEY,
  type CallerSystem,
  type CanonicalEntity,
  type SourceSystem,
} from './SourceOfTruthManifest';
import type { ApprovalQueueService } from '../../services/governance/ApprovalQueueService';
import {
  LoopDetectedError,
  MissingWriteDescriptorError,
  OwnershipBlockedError,
  OwnershipFieldLevelMergeBlockedError,
  OwnershipPendingApprovalError,
  OwnershipViolationError,
} from './ConflictResolutionPolicy';
import { connectorRecordTypeFor } from './connectorRecordType';
import { pickPayloadFields, type FieldLevelPayload } from './fieldLevelPayload';

export type { WriteOperation } from './OwnershipResolver';

export interface GuardedWriteContext {
  tenantId: string;
  callerSystem: CallerSystem;
  targetSystem: SourceSystem;
  /**
   * Canonical-entity name preferred. Arbitrary connector record types
   * (e.g. 'contacts', 'Customer', 'records') are accepted because the
   * integration/sync layers supply the connector-side record name
   * directly from existing configs. When no manifest declaration matches
   * the entity, the underlying OwnershipResolver returns
   * `{ allowed: true, reason: 'no_policy_declared' }` and the audit row
   * carries the `ownership_no_policy_declared` flag. Copilot R1 cluster-B.
   */
  entity: CanonicalEntity | string;
  recordId?: string;
  fieldPaths?: readonly string[];
  correlationId: string;
  requesterUserId: string;
  operation: WriteOperation;
  /**
   * Optional integration-config id. When supplied AND the write is enqueued
   * for human approval, `OwnershipResumeHandler.apply()` uses it to resolve
   * the per-tenant `IntegrationConfig` and re-initialize the target connector
   * (auth, base URL) before dispatch. Without it the resume falls back to
   * `ConnectorManager.getConnector(targetSystemId, targetSystemId)` which
   * returns an uninitialized instance. Plaintext-safe — UUID, not PII.
   * Plumbed into the persisted descriptor as a top-level field outside the
   * encrypted args envelope.
   *
  * SECURITY: `OwnershipResumeHandler.apply()` resolves this through
  * `ConfigurationService.getConfigurationForTenant(approval.tenantId, id)`.
  * Route authors should still pass ids selected from tenant-scoped server
  * state rather than raw request bodies, but the resume sink now fail-closes
  * if the stored config belongs to a different tenant.
   * (verified at PR #853 review).
   */
  integrationConfigId?: string;
}

/**
 * What the caller provides on GuardedWriteArgs.resume. Replay-only fields:
 * the caller doesn't know declaredOwner (the resolver does), and the caller
 * already states entity / callerSystem via context — no point repeating.
 */
export interface CallerWriteDescriptor {
  targetSystemId: string;
  operation: WriteOperation;
  entityType: string;
  args: unknown;
  /**
   * Optional integration-config id (UUID). Propagated from
   * `GuardedWriteContext.integrationConfigId` so the resume handler can
   * call `ConnectorManager.initializeConnectorsForConfig(config)` before
   * dispatch. Not PII. Persisted as a TOP-LEVEL plaintext field on the
   * `EncryptedWriteDescriptorPayload`, alongside the manifest vocabulary
   * (`targetSystemId`, `operation`, `entityType`, `ownership`) — NOT
   * inside the encrypted `argsEncrypted` envelope. Integrity is
   * guaranteed via the metadata-digest binding the encrypted blob carries
   * (`writeDescriptorEncryption.ts`), so DB-tier tampering with this
   * field surfaces as `metadata_tampered` at resume time.
   */
  integrationConfigId?: string;
}

/**
 * What gets persisted in the write_descriptor column. guardedWrite enriches
 * the caller-supplied descriptor with the ownership context that was active
 * at enqueue time so OwnershipResumeHandler can emit a correlated resume-
 * time audit row without fabricating fields.
 *
 * Note `ownership.targetSystem: SourceSystem` (canonical manifest vocabulary)
 * is intentionally separate from `targetSystemId: string` (connector-registry
 * key passed to `ConnectorManager.getConnector`). These can differ — Business
 * Central is `business_central` in the manifest but `businesscentral` in the
 * connector registry (Codex R6 P2 on PR #851). The resume audit row uses
 * `ownership.targetSystem`; the connector dispatch uses `targetSystemId`.
 */
export interface WriteDescriptor extends CallerWriteDescriptor {
  ownership: {
    entity: CanonicalEntity | string;
    declaredOwner: SourceSystem;
    callerSystem: CallerSystem;
    targetSystem: SourceSystem;
  };
}

export interface GuardedWriteArgs<T> {
  context: GuardedWriteContext;
  do: () => Promise<T>;
  resume?: CallerWriteDescriptor;
  override?: { permitted: true; reason: string };
}

export interface GuardedWriteFieldLevelArgs<
  T,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  context: GuardedWriteContext;
  fieldLevelPayload: FieldLevelPayload<TPayload>;
  do: (approvedPayload: TPayload) => Promise<T>;
  resume?: CallerWriteDescriptor;
  override?: { permitted: true; reason: string };
}

export interface GuardedWriteDeps {
  ownershipResolver: Pick<OwnershipResolver, 'validateWrite' | 'detectLoop'>;
  auditService: Pick<AuditService, 'logGovernanceCheck'>;
  /**
   * PR 13c-2 Task 3: required now that queue_for_human is live. Producing
   * a queue_required decision without an enqueue dep is a programming
   * error — guardedWrite throws a plain Error in that path rather than
   * silently swallowing the decision. Tests that exercise non-queue
   * decisions (allow / source_wins / reject_with_alert / target_wins)
   * MAY still omit this dep; those branches return / throw before any
   * enqueue call so the field is unused.
   */
  approvalQueueService?: Pick<ApprovalQueueService, 'enqueue'>;
}

/**
 * Single ownership-gated chokepoint for direct connector mutations.
 *
 * Stage A1: handles allow + source_wins + reject_with_alert.
 * Stage B: adds queue_for_human + operator override.
 * Stage C: wires detectLoop.
 *
 * Audit rows emitted per path:
 *   allow (no override):          decision → outcome            (2 rows)
 *   reject_with_alert + override: decision → override → outcome (3 rows)
 *   source_wins + override:       decision → override → outcome (3 rows)
 *   source_wins, no override:     decision                      (1 row, throws)
 *   queue_required:               decision                      (1 row, then enqueues
 *                                                                 encrypted descriptor and
 *                                                                 throws OwnershipPendingApprovalError —
 *                                                                 PR 13c-2 lifted the PR 13b fail-closed)
 *   reject_with_alert (no override): decision (approved=false, flag='ownership_violation_rejected')  (1 row, then rethrows)
 *                                  — emitted in the catch block around validateWrite so the operator-
 *                                  facing /api/governance/ownership-rejections endpoint can see the
 *                                  blocked write. (Copilot R1 cluster-A2 on PR #851 — prior behavior
 *                                  emitted no row before rethrowing.)
 *
 * Throws on every block path — no typed-return blocked result.
 */
export async function guardedWrite<T>(
  args: GuardedWriteArgs<T>,
  deps: GuardedWriteDeps,
): Promise<T>;
export async function guardedWrite<T, TPayload extends Record<string, unknown>>(
  args: GuardedWriteFieldLevelArgs<T, TPayload>,
  deps: GuardedWriteDeps,
): Promise<T>;
export async function guardedWrite<T, TPayload extends Record<string, unknown>>(
  args: GuardedWriteArgs<T> | GuardedWriteFieldLevelArgs<T, TPayload>,
  deps: GuardedWriteDeps,
): Promise<T> {
  // PR 13c-2 Task 3: `resume` is now consumed for queue_for_human writes.
  // ApprovalQueueService.enqueue wraps `resume.args` in AES-256-GCM via the
  // global EncryptionService before persisting to
  // `governance_approvals.write_descriptor`. The legacy
  // QueueForHumanNotYetSafeError throw was removed when the encrypted-args
  // path landed.
  const { context, resume, override } = args;

  // Can the caller override? Only operator_action callers with explicit permit.
  const canOverride =
    context.callerSystem === 'operator_action' && override?.permitted === true;

  // ── 1. Validate ownership (throws for reject_with_alert unless overridden) ─
  // Two override flags carry the pre-override policy + declaredOwner into the
  // shared override-audit-emission below. Both flow through the same
  // detectLoop + write + outcome path (Copilot R10 on PR #851 — previously
  // source_wins+override executed the write before the detectLoop gate and
  // returned, bypassing reciprocal-loop detection for operator overrides).
  let caughtViolation: OwnershipViolationError | null = null;
  let sourceWinsOverride: { declaredOwner: SourceSystem } | null = null;
  let fieldMergeOverride: {
    declaredOwner: SourceSystem;
    allowedFieldPaths: string[];
    blockedFieldPaths: string[];
  } | null = null;
  let decision: OwnershipDecision;
  try {
    decision = await deps.ownershipResolver.validateWrite({
      tenantId: context.tenantId,
      entity: context.entity,
      targetSystem: context.targetSystem,
      callerSystem: context.callerSystem,
      correlationId: context.correlationId,
      recordId: context.recordId,
      operation: context.operation,
      fieldPaths: context.fieldPaths,
    });
  } catch (err) {
    if (err instanceof OwnershipViolationError && canOverride) {
      // reject_with_alert + operator override: catch the violation, treat as allowed.
      caughtViolation = err;
      decision = { allowed: true, owner: context.targetSystem };
    } else {
      // reject_with_alert (no override): the operations dashboard
      // (`/api/governance/ownership-rejections`) reads `governance_check`
      // rows where `approved=false`. The catch must emit a rejection audit
      // row BEFORE rethrowing or the dashboard would never see this class
      // of block. Failures emitting the audit row are deliberately
      // swallowed (log only) so the original rejection still surfaces to
      // the caller — losing observability on the audit row is preferable
      // to masking the violation. Copilot R1 (cluster-A2).
      if (err instanceof OwnershipViolationError) {
        try {
          await deps.auditService.logGovernanceCheck({
            sessionId: context.correlationId,
            tenantId: context.tenantId,
            checkType: 'ownership',
            approved: false,
            riskLevel: 'high',
            flags: ['ownership_violation_rejected'],
            userId: context.requesterUserId,
            ownership: {
              entity: err.detail.entity,
              declaredOwner: err.detail.declaredOwner,
              callerSystem: err.detail.callerSystem,
              targetSystem: context.targetSystem,
              operation: context.operation,
              policy: err.detail.conflictPolicy,
            },
          });
        } catch {
          // Intentional: emitting the audit row is best-effort. The
          // OwnershipViolationError below is the load-bearing failure.
        }
      }
      throw err;
    }
  }

  // Copilot R17 on PR #851: for source_wins + operator override, flip the
  // decision to allowed=true BEFORE emitting the decision audit row. Without
  // this pre-flip the decision row was emitted with approved=false (matching
  // the resolver's literal "non_owner_write" verdict), and only the OVERRIDE
  // audit row that fires later carried approved=true. The
  // `/api/governance/ownership-rejections` dashboard filters on approved=false,
  // so successful overridden writes were leaking into the rejections panel.
  // This mirrors the reject_with_alert + override path which uses the
  // `caughtViolation` mechanism above (validateWrite throws OwnershipViolationError,
  // we catch it, mutate `decision` to allowed=true, and the audit row fires
  // with approved=true + flags=['ownership_violation_override']). Symmetric
  // mechanism for source_wins via `sourceWinsOverride`.
  if (
    decision.allowed === false &&
    decision.reason === 'non_owner_write' &&
    decision.policy === 'source_wins' &&
    canOverride
  ) {
    sourceWinsOverride = { declaredOwner: decision.declaredOwner };
    decision = { allowed: true, owner: context.targetSystem };
  }
  if (
    decision.allowed === false &&
    decision.reason === 'field_level_merge_blocked' &&
    canOverride
  ) {
    fieldMergeOverride = {
      declaredOwner: decision.declaredOwner,
      allowedFieldPaths: decision.allowedFieldPaths,
      blockedFieldPaths: decision.blockedFieldPaths,
    };
    decision = { allowed: true, owner: context.targetSystem };
  }

  // A resolver-approved field_level_merge can STILL be blocked by the payload
  // shape/mode at dispatch time (block_on_any_disallowed with blocked fields, a
  // drop_disallowed filter that empties the payload, or a missing
  // fieldLevelPayload). Determine that here, BEFORE the decision audit, so the
  // row records approved=false for a write that will be blocked rather than a
  // misleading approved=true (Codex review). This precomputes whether the
  // current payload/mode will block the write under the same conditions used by
  // the short-circuit throw below (before loop detection).
  let fieldLevelMergeWillBlock = false;
  if (decision.allowed === true && decision.reason === 'field_level_merge') {
    if (!('fieldLevelPayload' in args)) {
      fieldLevelMergeWillBlock = true;
    } else if (
      args.fieldLevelPayload.mode === 'block_on_any_disallowed' &&
      decision.blockedFieldPaths.length > 0
    ) {
      fieldLevelMergeWillBlock = true;
    } else if (
      Object.keys(pickPayloadFields(args.fieldLevelPayload.payload, decision.allowedFieldPaths)).length === 0
    ) {
      fieldLevelMergeWillBlock = true;
    }
  }

  // ── 2. Decision audit row (always) ───────────────────────────────────────
  // Declared owner recorded on the decision audit row. For a blocked decision
  // it's the resolver's declaredOwner; for an allowed decision the override paths
  // (caughtViolation / sourceWinsOverride / fieldMergeOverride) carry the
  // pre-override owner, a field_level_merge carries its declaredOwner, and a plain
  // owner write carries decision.owner. Written as an if/else chain rather than a
  // nested ternary so the precedence is unambiguous (Copilot review).
  let declaredOwnerForAudit: SourceSystem;
  if (decision.allowed !== true) {
    declaredOwnerForAudit = decision.declaredOwner;
  } else if (caughtViolation) {
    declaredOwnerForAudit = caughtViolation.detail.declaredOwner;
  } else if (sourceWinsOverride) {
    declaredOwnerForAudit = sourceWinsOverride.declaredOwner;
  } else if (fieldMergeOverride) {
    declaredOwnerForAudit = fieldMergeOverride.declaredOwner;
  } else if (decision.reason === 'field_level_merge' || decision.reason === 'demo_tenant_override') {
    declaredOwnerForAudit = decision.declaredOwner;
  } else {
    declaredOwnerForAudit = decision.owner;
  }

  const fieldMergeAuditPaths =
    decision.allowed === true && decision.reason === 'field_level_merge'
      ? {
          allowedFieldPaths: decision.allowedFieldPaths,
          blockedFieldPaths: decision.blockedFieldPaths,
        }
      : fieldMergeOverride
        ? {
            allowedFieldPaths: fieldMergeOverride.allowedFieldPaths,
            blockedFieldPaths: fieldMergeOverride.blockedFieldPaths,
          }
        : undefined;

  const decisionAuditOwnership: Parameters<typeof deps.auditService.logGovernanceCheck>[0]['ownership'] =
    decision.allowed === true
      ? {
          entity: context.entity,
          declaredOwner: declaredOwnerForAudit,
          callerSystem: context.callerSystem,
          targetSystem: context.targetSystem,
          operation: context.operation,
          ...(fieldMergeAuditPaths !== undefined
            ? {
                policy: 'merge_field_level' as const,
                ...fieldMergeAuditPaths,
              }
            : {}),
        }
      : {
          entity: context.entity,
          declaredOwner: decision.declaredOwner,
          callerSystem: context.callerSystem,
          targetSystem: context.targetSystem,
          operation: context.operation,
          policy: decision.reason === 'non_owner_write'
            ? decision.policy
            : decision.reason === 'field_level_merge_blocked'
              ? decision.policy
              : 'queue_for_human',
          ...(decision.reason === 'field_level_merge_blocked'
            ? {
                allowedFieldPaths: decision.allowedFieldPaths,
                blockedFieldPaths: decision.blockedFieldPaths,
              }
            : {}),
        };

  const decisionFlags: string[] =
    decision.allowed === true
      ? (caughtViolation || sourceWinsOverride || fieldMergeOverride
          ? ['ownership_violation_override']
          : decision.reason === 'field_level_merge'
            ? [fieldLevelMergeWillBlock
                ? 'ownership_field_merge_blocked'
                : decision.blockedFieldPaths.length > 0 ? 'ownership_field_merge_partial' : 'ownership_field_merge_allowed']
          : decision.reason === 'no_policy_declared'
            ? ['ownership_no_policy_declared']
            : decision.reason === 'demo_tenant_override'
              ? ['ownership_demo_tenant_override']
              : [])
      : decision.reason === 'field_level_merge_blocked'
        ? ['ownership_field_merge_blocked']
        : [`ownership_${decision.reason}`];

  // demo_tenant_override is HIGH like the operator-override paths — it is a
  // policy bypass and must stand out in the audit trail, not blend into the
  // medium-risk routine-allow rows.
  const decisionRiskLevel =
    fieldMergeAuditPaths !== undefined ||
    decision.reason === 'field_level_merge_blocked' ||
    decision.reason === 'demo_tenant_override'
      ? 'high'
      : 'medium';

  await deps.auditService.logGovernanceCheck({
    sessionId: context.correlationId,
    tenantId: context.tenantId,
    checkType: 'ownership',
    // approved=false when the field_level_merge will be blocked at dispatch
    // (Codex review) — the row must not read approved for a blocked write.
    approved: decision.allowed === true && !fieldLevelMergeWillBlock,
    riskLevel: decisionRiskLevel,
    flags: decisionFlags,
    userId: context.requesterUserId,
    ownership: decisionAuditOwnership,
  });

  // ── 3. Decision handling ─────────────────────────────────────────────────

  // Short-circuit a field_level_merge that the payload shape/mode blocks
  // (Copilot review): the decision audit row above already recorded
  // approved=false, and the write is guaranteed to fail, so throw here BEFORE
  // loop detection rather than running an unnecessary lineage query first.
  if (decision.allowed === true && decision.reason === 'field_level_merge' && fieldLevelMergeWillBlock) {
    throw new OwnershipFieldLevelMergeBlockedError({
      entity: context.entity,
      declaredOwner: decision.declaredOwner,
      callerSystem: context.callerSystem,
      policy: 'merge_field_level',
      correlationId: context.correlationId,
      allowedFieldPaths: decision.allowedFieldPaths,
      blockedFieldPaths: decision.blockedFieldPaths,
    });
  }

  if (decision.allowed === false) {
    if (decision.reason === 'queue_required') {
      // PR 13c-2 Task 3: real enqueue path. The decision-audit row above
      // has already fired; we now persist the encrypted descriptor and
      // throw OwnershipPendingApprovalError(queueId) so the route layer
      // (approvalQueueErrorHandler) maps to 202 with pollUrl.
      if (!resume) {
        // Programming error — entity declares queue_for_human but caller
        // didn't supply a resume descriptor. The decision audit row was
        // already emitted with policy='queue_for_human', so the operator
        // chain still records the intent.
        throw new MissingWriteDescriptorError(context.correlationId);
      }
      if (!deps.approvalQueueService) {
        // Programming error — queue_required produced without an enqueue
        // dep. Surface as a plain Error so the caller's catch (FlowExecutor
        // status='failed' or route 500) can distinguish from typed
        // ownership errors.
        throw new Error(
          `guardedWrite: queue_required decision but no approvalQueueService dep was injected (correlationId=${context.correlationId})`,
        );
      }
      // Copilot R9 on PR #853: derive the connector-registry key from the
      // canonical context.targetSystem (e.g. business_central → businesscentral)
      // rather than trusting resume.targetSystemId. If the caller supplied a
      // resume.targetSystemId and it doesn't match the derived key, fail-
      // closed — a divergence would enqueue a descriptor that later dispatches
      // through the wrong connector while the audited ownership.targetSystem
      // still points at the original context. Symmetric with FlowExecutor's
      // connector-contract check at flows/templates/FlowExecutor.ts:193.
      const derivedTargetSystemId = SOURCE_SYSTEM_TO_CONNECTOR_KEY[context.targetSystem];
      if (resume.targetSystemId !== derivedTargetSystemId) {
        throw new Error(
          `guardedWrite: resume.targetSystemId='${resume.targetSystemId}' does not match the connector-registry key derived from context.targetSystem='${context.targetSystem}' (expected '${derivedTargetSystemId}'). Refusing to enqueue a descriptor that would dispatch to the wrong connector at resume time (correlationId=${context.correlationId}).`,
        );
      }
      // Copilot R10 on PR #853: same class of finding as R9 above —
      // resume.operation is caller-supplied while context.operation is the
      // canonical source recorded on the already-emitted decision audit
      // row. A divergence would mean the audit trail records one operation
      // while resume dispatches another. Fail-close so the descriptor and
      // audit chain stay consistent. resume.entityType is intentionally
      // NOT validated against context.entity — callers legitimately supply
      // the connector-side record name (e.g. 'Customer', 'contacts') which
      // differs from the canonical manifest entity.
      if (resume.operation !== context.operation) {
        throw new Error(
          `guardedWrite: resume.operation='${resume.operation}' does not match context.operation='${context.operation}'. Refusing to enqueue a descriptor whose operation disagrees with the already-audited decision row (correlationId=${context.correlationId}).`,
        );
      }
      const writeDescriptor: WriteDescriptor = {
        targetSystemId: derivedTargetSystemId,
        operation: context.operation,
        entityType: resume.entityType,
        args: resume.args,
        ownership: {
          entity: context.entity,
          declaredOwner: decision.declaredOwner,
          callerSystem: context.callerSystem,
          targetSystem: context.targetSystem,
        },
      };
      if (resume.integrationConfigId !== undefined) {
        writeDescriptor.integrationConfigId = resume.integrationConfigId;
      } else if (context.integrationConfigId !== undefined) {
        writeDescriptor.integrationConfigId = context.integrationConfigId;
      }

      const queueId = await deps.approvalQueueService.enqueue({
        tenantId: context.tenantId,
        requesterUserId: context.requesterUserId,
        operationType: 'ownership_write',
        // Use the canonical-or-connector entity name and the explicit
        // recordId when available so the approval-queue list surface can
        // group by resource. 'new' matches the convention used by the
        // governance arm (handleApprovalQueueError) for create operations.
        resourceType: String(context.entity),
        resourceId: context.recordId ?? 'new',
        reason: {
          kind: 'ownership',
          entity: context.entity,
          declaredOwner: decision.declaredOwner,
          callerSystem: context.callerSystem,
          conflictPolicy: 'queue_for_human',
          writeDescriptor,
        },
      });

      throw new OwnershipPendingApprovalError(queueId);
    }

    if (decision.reason === 'field_level_merge_blocked') {
      throw new OwnershipFieldLevelMergeBlockedError({
        entity: context.entity,
        declaredOwner: decision.declaredOwner,
        callerSystem: context.callerSystem,
        policy: 'merge_field_level',
        correlationId: context.correlationId,
        allowedFieldPaths: decision.allowedFieldPaths,
        blockedFieldPaths: decision.blockedFieldPaths,
      });
    }

    // non_owner_write — only source_wins reaches here (target_wins → allowed=true;
    // reject_with_alert → threw in validateWrite; queue_for_human handled above).
    // Copilot R17 on PR #851: the canOverride+source_wins branch was pre-evaluated
    // BEFORE the decision audit row above so the row reflects the post-override
    // approved=true state (was leaking approved=false rows into the
    // /ownership-rejections dashboard). The non-overridable source_wins case
    // still throws OwnershipBlockedError here.
    if (decision.reason === 'non_owner_write' && decision.policy === 'source_wins') {
      throw new OwnershipBlockedError({
        entity: context.entity,
        declaredOwner: decision.declaredOwner,
        callerSystem: context.callerSystem,
        policy: 'source_wins',
        correlationId: context.correlationId,
      });
    }

    const unhandledDecision: never = decision;
    throw new Error(`guardedWrite: unhandled decision branch: ${JSON.stringify(unhandledDecision)}`);
  }

  // ── 4. Allowed path (decision.allowed === true) ──────────────────────────
  // Covers: owner writes, target_wins, and reject_with_alert + operator override.

  if (caughtViolation || sourceWinsOverride || fieldMergeOverride) {
    // Override audit row — one shape for both reject_with_alert and
    // source_wins override paths so they share the detectLoop + write
    // pipeline below (Copilot R10 on PR #851).
    const overridePolicy: 'reject_with_alert' | 'source_wins' | 'merge_field_level' = caughtViolation
      ? 'reject_with_alert'
      : sourceWinsOverride
        ? 'source_wins'
        : 'merge_field_level';
    const overrideDeclaredOwner: SourceSystem = caughtViolation
      ? caughtViolation.detail.declaredOwner
      : sourceWinsOverride
        ? sourceWinsOverride.declaredOwner
        : fieldMergeOverride!.declaredOwner;
    await deps.auditService.logGovernanceCheck({
      sessionId: context.correlationId,
      tenantId: context.tenantId,
      checkType: 'ownership',
      approved: true,
      riskLevel: 'high',
      flags: ['governance_override'],
      userId: context.requesterUserId,
      ownership: {
        entity: context.entity,
        declaredOwner: overrideDeclaredOwner,
        callerSystem: context.callerSystem,
        targetSystem: context.targetSystem,
        operation: context.operation,
        policy: overridePolicy,
        ...(fieldMergeOverride
          ? {
              allowedFieldPaths: fieldMergeOverride.allowedFieldPaths,
              blockedFieldPaths: fieldMergeOverride.blockedFieldPaths,
            }
          : {}),
        governanceOverride: {
          permitted: true,
          reason: override!.reason,
          originalPolicy: overridePolicy,
        },
      },
    });
  }

  // ── 4b. Loop detection ──────────────────────────────────────────────────
  // Second gate after ownership allow. The override field never disables
  // the check for SourceSystem callers — i.e. if a SourceSystem-identified
  // caller (netsuite, hubspot, etc.) trips detectLoop, the LoopDetectedError
  // throw is non-overridable. But the check itself is only WIRED for
  // SourceSystem callers because lineage events are keyed by SourceSystem
  // — non-SourceSystem callers (operator_action, sync_error_remediation,
  // webhook_relay, integration_engine, sync_orchestrator) cannot be in a
  // reciprocal-write lineage chain to begin with, so there is no chain for
  // detectLoop to find. Skip is explicit by design, not a silent type cast.
  //
  // Copilot R19 on PR #851: this is a documentation-precision concern —
  // the PR description's "operator_action overrides never bypass loop
  // detection" phrasing is imprecise (operator_action skips the entire
  // check by virtue of not being a SourceSystem, not by override-bypass).
  // PR description + proof card updated in CI-27 to phrase this as
  // "loop detection is wired for SourceSystem callers; operator_action
  // is outside the lineage graph by construction". A future enhancement
  // (PR 13c+) could thread a synthetic lineage identity for operator
  // writes if we want override-initiated writes to participate in loop
  // detection — out of scope for PR 13b's wedge.
  const callerForLoop = context.callerSystem;
  if (isSourceSystem(callerForLoop)) {
    const loopCheck = await deps.ownershipResolver.detectLoop({
      tenantId: context.tenantId,
      entity: context.entity,
      // connectorRecordTypeFor requires a CanonicalEntity. For non-canonical
      // entities (e.g. raw connector record types passed through), fall back
      // to the entity string itself — the lineage table stores whatever the
      // upstream lineage.targetWrite call emitted, so the loop detector sees
      // the same string either way. Copilot R1 cluster-B widening.
      entityType: isCanonicalEntity(context.entity)
        ? connectorRecordTypeFor(context.entity, context.targetSystem)
        : context.entity,
      entityId: context.recordId ?? '',
      targetSystem: context.targetSystem,
      callerSystem: callerForLoop,
      correlationId: context.correlationId,
    });
    if (loopCheck.loopDetected) {
      const declaredOwnerForLoop: SourceSystem = caughtViolation
        ? caughtViolation.detail.declaredOwner
        : sourceWinsOverride
          ? sourceWinsOverride.declaredOwner
          : fieldMergeOverride
            ? fieldMergeOverride.declaredOwner
            : (decision.allowed === true &&
                  (decision.reason === 'field_level_merge' || decision.reason === 'demo_tenant_override')
                ? decision.declaredOwner
                : decision.allowed === true
                  ? decision.owner
                  : context.targetSystem);
      await deps.auditService.logGovernanceCheck({
        sessionId: context.correlationId,
        tenantId: context.tenantId,
        checkType: 'loop_detection',
        approved: false,
        riskLevel: 'high',
        flags: ['loop_detected'],
        userId: context.requesterUserId,
        ownership: {
          entity: context.entity,
          declaredOwner: declaredOwnerForLoop,
          callerSystem: context.callerSystem,
          targetSystem: context.targetSystem,
          operation: context.operation,
          loopBreakingCondition: loopCheck.breakingCondition,
        },
      });
      throw new LoopDetectedError({
        entity: context.entity,
        callerSystem: callerForLoop,
        targetSystem: context.targetSystem,
        breakingCondition: loopCheck.breakingCondition!,
        correlationId: context.correlationId,
      });
    }
  }

  // Every field_level_merge block case (block_on_any_disallowed with blocked
  // fields, an empty drop_disallowed filter, or a missing fieldLevelPayload) was
  // already thrown at the short-circuit above, so here a field_level_merge always
  // has a payload and a non-empty allowed subset.
  let result: T;
  if ('fieldLevelPayload' in args) {
    let approvedPayload: TPayload = args.fieldLevelPayload.payload;
    if (decision.allowed === true && decision.reason === 'field_level_merge') {
      // drop_disallowed: pass only the caller-owned subset to the connector.
      approvedPayload = pickPayloadFields(args.fieldLevelPayload.payload, decision.allowedFieldPaths) as TPayload;
    }
    result = await args.do(approvedPayload);
  } else {
    result = await args.do();
  }

  // Copilot R17 on PR #851: the outcome audit row is best-effort. The
  // connector mutation has already succeeded by this point, so an
  // audit-persistence failure (DB outage, transient repository error)
  // must NOT propagate as a write failure. Callers (FlowExecutor catch
  // block, route handlers) treat thrown errors as write failures and
  // may retry — re-throwing here would risk duplicate writes against
  // the external system. Match the rejection-audit pattern at L141-152
  // and the OwnershipResumeHandler resume-audit pattern: log on
  // failure, return the successful result. Audit-row completeness is
  // valuable but it's NOT load-bearing for the user-visible write
  // contract.
  try {
    await deps.auditService.logGovernanceCheck({
      sessionId: context.correlationId,
      tenantId: context.tenantId,
      checkType: 'ownership',
      approved: true,
      riskLevel: 'low',
      flags: (caughtViolation || sourceWinsOverride || fieldMergeOverride)
        ? ['write_succeeded', 'governance_override']
        : decision.reason === 'demo_tenant_override'
          ? ['write_succeeded', 'ownership_demo_tenant_override']
          : ['write_succeeded'],
      userId: context.requesterUserId,
      ownership: {
        entity: context.entity,
        // Copilot R11 on PR #851: on source_wins+override path,
        // `decision` was mutated to `{owner: context.targetSystem}` so the
        // outcome audit row would otherwise record the TARGET system as
        // declaredOwner, disagreeing with the earlier decision/override
        // rows. Consult `sourceWinsOverride?.declaredOwner` (the manifest's
        // actual owner captured before the override flipped the decision)
        // — same fix the loop-detected audit row already uses.
        declaredOwner: caughtViolation
          ? caughtViolation.detail.declaredOwner
          : sourceWinsOverride
            ? sourceWinsOverride.declaredOwner
            : fieldMergeOverride
              ? fieldMergeOverride.declaredOwner
              : decision.reason === 'field_level_merge' || decision.reason === 'demo_tenant_override'
                ? decision.declaredOwner
                : decision.owner,
        callerSystem: context.callerSystem,
        targetSystem: context.targetSystem,
        operation: context.operation,
      },
    });
  } catch {
    // Intentional: outcome audit is best-effort. Returning the result
    // is the load-bearing failure mode here; we'd rather lose the
    // outcome row than retry a successful external mutation.
  }

  return result;
}
