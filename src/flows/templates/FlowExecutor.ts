/**
 * FlowExecutor — the single canonical runtime for governed flow templates.
 *
 * One execute() per template invocation. The executor walks every template
 * through the same pipeline:
 *
 *   1. transform(event)          — template hook
 *   2. validate(record)?         — template hook (optional)
 *   3. validateConnectorWrite()  — OutboundGovernanceService (DLP scan)
 *      → approvalRequired         → enqueue + return pending_approval
 *      → !approved (blocked)      → return blocked
 *      → approved                 → dispatch redacted payload
 *   4. dispatch                  — IConnector.create | update | delete
 *
 * Templates never implement orchestration plumbing — they only carry the data
 * (interfaces, hooks, policies) that the executor consumes.
 *
 * Narrow PR 14 scope: single-row only ('create' | 'update' | 'delete'). The
 * full remediation plan also specifies a bulk_upsert path (per-row lineage
 * chains, batch rollback via the connector's bulkRollbackStrategy) — that
 * ships in PR 14b once a connector actually exposes a non-`'unsupported'`
 * strategy. Lineage and Ownership integration follows PR 12 / PR 13.
 *
 * The PendingApprovalError catch mirrors the route-layer pattern in
 * `src/middleware/governance/approvalQueueErrorHandler.ts` — same enqueue
 * args, same fail-closed posture when the queue refuses an unredacted
 * payload. The two paths converge on `ApprovalQueueService.enqueue()`.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { OutboundGovernanceService, OutboundContext, OutboundDecision } from '../../services/governance/OutboundGovernanceService';
import type { ApprovalQueueService } from '../../services/governance/ApprovalQueueService';
import type { AuditService } from '../../services/ai/orchestrator/AuditService';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import {
  OwnershipViolationError,
  OwnershipBlockedError,
  OwnershipFieldLevelMergeBlockedError,
  LoopDetectedError,
  QueueForHumanNotYetSafeError,
} from '../../governance/sourceOfTruth/ConflictResolutionPolicy';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import { SOURCE_SYSTEM_TO_CONNECTOR_KEY } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import type { IConnector } from '../../interfaces/IConnector';
import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';
import type { DataRecord } from '../../types';
import type { FlowContext, FlowTemplate, FlowTarget } from './FlowTemplate';
import type { FlowResult } from './FlowResult';
import { hashLineagePayload } from '../../services/lineage/LineageRecorder';

/**
 * Defensive cap on dispatch payload shape — see `connectorPayload()`.
 * Keeps a typo-class bug (template returns a primitive, array, or class
 * instance like `new Date()` / `new Map()`) from reaching a connector's
 * `create(entityType, data)` signature where `data` is typed as
 * `DataRecord` (a record-shaped object).
 *
 * Strict prototype check: only `{...}` object literals pass. Class instances
 * (Date, Map, Set, custom classes) would serialise weirdly through JSON.
 * Null-prototype objects (`Object.create(null)`) also pass since their
 * prototype is `null`, not `Object.prototype` — but they're functionally
 * indistinguishable from plain objects for JSON purposes, so this is
 * acceptable. Copilot R10 on PR #825 tightened the prior `typeof === 'object'`
 * + `!Array.isArray` check.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

@injectable()
export class FlowExecutor {
  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.OutboundGovernanceService) private readonly outboundGovernance: OutboundGovernanceService,
    @inject(TYPES.ApprovalQueueService) private readonly approvalQueue: ApprovalQueueService,
    @inject(TYPES.OwnershipResolver) private readonly ownershipResolver: OwnershipResolver,
    @inject(TYPES.AuditService) private readonly auditService: AuditService,
  ) {}

  /**
   * Run a template against a source event. Returns a discriminated
   * FlowResult — never throws governance errors (those become typed result
   * values). Unexpected exceptions (transform/validate/dispatch crash) are
   * caught and returned as `{status: 'failed'}` so callers always see a Result.
   */
  async execute<E, T extends Record<string, unknown>>(
    template: FlowTemplate<E, T>,
    event: E,
    ctx: FlowContext,
  ): Promise<FlowResult> {
    const flowMeta = {
      templateId: template.id,
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      operation: template.target.operation,
      target: `${template.target.system}.${template.target.recordType}`,
    };

    // PR 12: optional record-level lineage. `ctx.lineageRecorder` is undefined
    // for callers that haven't opted in, so `lineageRecorder?.startChain(...)`
    // collapses to `undefined` and every subsequent `lineage?.X(...)` is a no-op
    // — the existing pipeline is structurally unchanged. Lineage append errors
    // are NOT allowed to fail the flow: each emission attaches `.catch()` so
    // a repo.append failure is swallowed + logged. Instrumentation is
    // best-effort; business semantics never gate on lineage success.
    const lineage = ctx.lineageRecorder?.startChain({
      tenantId: ctx.tenantId,
      correlationId: ctx.correlationId,
      templateId: template.id,
    });
    const swallowLineageErr = (step: string) => (err: unknown) => {
      this.logger.error(
        `FlowExecutor lineage.${step} append failed (swallowed)`,
        err instanceof Error ? err : new Error(String(err)),
        flowMeta,
      );
    };

    // PR 12 follow-up — emit `source_read` as the first chain event when the
    // caller has plumbed `ctx.sourceRecord`. Conditional because not every
    // executor entry point (legacy callers, in-test fixtures) carries the
    // upstream source identifier. Without `sourceRecord`, the executor keeps
    // its pre-emitter behaviour (transform → governance → target_write).
    if (ctx.sourceRecord) {
      await lineage?.sourceRead(ctx.sourceRecord)?.catch(swallowLineageErr('sourceRead'));
    }

    let record: T;
    try {
      record = await template.transform(event, ctx);
    } catch (err) {
      this.logger.error('FlowExecutor.transform failed', err instanceof Error ? err : new Error(String(err)), flowMeta);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
    }

    // PR 12 R5 — pre-compute the hash with its own swallow path so a
    // hashLineagePayload throw (circular refs, BigInt, custom toJSON) cannot
    // crash the business flow. The `?.catch` below only protects against
    // promise rejection from the recorder; sync arg-eval errors must be
    // caught BEFORE the call expression evaluates.
    let payloadHash: string;
    try {
      payloadHash = hashLineagePayload(record);
    } catch (hashErr) {
      // PR 12 R6 — distinct log message: this is hash-compute failure, not
      // an append. swallowLineageErr would log "append failed" which is
      // inaccurate for this branch (no append was attempted).
      this.logger.error(
        'FlowExecutor lineage.transform-hash compute failed (swallowed)',
        hashErr instanceof Error ? hashErr : new Error(String(hashErr)),
        flowMeta,
      );
      payloadHash = 'sha256:hash-failed';
    }
    await lineage?.transform({ payloadHash })?.catch(swallowLineageErr('transform'));

    if (template.validate) {
      let validation;
      try {
        validation = await template.validate(record, ctx);
      } catch (err) {
        this.logger.error('FlowExecutor.validate threw', err instanceof Error ? err : new Error(String(err)), flowMeta);
        return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
      }
      if (!validation.ok) {
        this.logger.info('FlowExecutor validation rejected record', { ...flowMeta, errors: validation.errors });
        return { status: 'blocked', reason: 'validation', findings: validation.errors };
      }
    }

    // Connector contract check: the caller MUST supply a pre-initialized
    // target connector matching `template.target.system`. Without this gate,
    // a caller passing a HubSpot connector for a NetSuite-targeted template
    // would silently dispatch the wrong write. Codex 5.5 HIGH on PR #825
    // surfaced the broader connector-resolution gap; this assertion is the
    // narrow guard.
    //
    // CASE + REGISTRY-KEY NORMALIZATION (Codex 5.5 HIGH follow-up + PR 13
    // Codex review #4): real connectors expose display-case `systemType`
    // (`NetSuite`, `HubSpot`, `BusinessCentral`) while the canonical
    // registry keys are lowercase + run-together (`netsuite`, `hubspot`,
    // `businesscentral`). PR 13 tightened `template.target.system` to the
    // `SourceSystem` snake_case form (e.g. `business_central`) — that does
    // NOT lowercase to the registry key. Route through
    // SOURCE_SYSTEM_TO_CONNECTOR_KEY so `business_central` → `businesscentral`
    // matches a real BusinessCentral connector. The type signature
    // guarantees every SourceSystem has a non-null mapping; adding a future
    // Squire-internal-only source that lacks an IConnector would require
    // its own routing decision rather than a null sentinel here.
    const expectedSystem = SOURCE_SYSTEM_TO_CONNECTOR_KEY[template.target.system].toLowerCase();
    const actualSystem = ctx.connector?.systemType?.toLowerCase();
    if (!ctx.connector || actualSystem !== expectedSystem) {
      const got = ctx.connector?.systemType ?? '(missing)';
      const msg = `FlowContext.connector.systemType '${got}' does not match template.target.system '${template.target.system}' (resolved to connector key '${expectedSystem}')`;
      this.logger.error('FlowExecutor: connector / template system mismatch', new Error(msg), flowMeta);
      return { status: 'failed', error: msg, attempt: 1 };
    }

    // Fail-fast on update without a usable record.id (Copilot R2 on PR
    // #825). The captured `originalUpdateId` (below) is what the dispatch
    // step will pass to `connector.update(...)`, so a missing id at this
    // point produces an unactionable approval row whose resourceId would
    // be 'unknown' AND a dispatch that can't proceed. Note: this guard
    // operates on the RAW record's id field BEFORE governance — the
    // redacted payload's id is not consulted for the lookup anymore
    // (Codex 5.5 HIGH follow-up landed in this PR).
    //
    // ALSO captures the ORIGINAL update id BEFORE governance scan (Codex
    // 5.5 HIGH follow-up on PR #825): low/medium PII records where the
    // `id` field itself is PII-shaped (email, phone, name-like external
    // id) get APPROVED with a redacted form (e.g. `id: '[REDACTED]'`).
    // The dispatch path used to read the lookup id from
    // `decision.redactedPayload ?? record`, which would have sent the
    // MASKED id to `connector.update(...)` and either failed to find the
    // target record or — worse — updated the wrong record if the redacted
    // placeholder collided with a real id. The original id must reach the
    // connector AS THE LOOKUP ARG; the body can carry the redacted form.
    let originalUpdateId: string | null = null;
    if (template.target.operation === 'update') {
      originalUpdateId = readId(record);
      if (originalUpdateId === null) {
        const msg = `update operation requires payload.id from template.transform; received record without a usable id`;
        this.logger.error('FlowExecutor: update template produced record without payload.id', new Error(msg), flowMeta);
        return { status: 'failed', error: msg, attempt: 1 };
      }
    }

    // Fail-fast on delete with unresolvable target id. Pre-resolving here
    // lets us surface resolver failures BEFORE governance scan + enqueue
    // and avoids persisting an approval row whose resourceId is 'unknown'
    // (which an operator could never meaningfully review). Codex 5.5
    // MEDIUM on PR #825 flagged the prior swallow-and-persist behavior.
    // The resolved id is threaded through both the enqueue path AND the
    // dispatch path via `preResolvedDeleteId` — the resolver is invoked
    // exactly once per execute(). Idempotence is still required as a
    // template contract (so a future retry loop or split call path stays
    // safe), but today there is no second invocation.
    let preResolvedDeleteId: string | null = null;
    if (template.target.operation === 'delete') {
      try {
        const resolved = await template.target.resolveTargetRecordId(event, ctx);
        if (typeof resolved !== 'string') {
          const msg = `delete operation: resolveTargetRecordId returned non-string value`;
          this.logger.error('FlowExecutor: delete resolver produced unusable id', new Error(msg), flowMeta);
          return { status: 'failed', error: msg, attempt: 1 };
        }
        const trimmed = resolved.trim();
        if (trimmed.length === 0) {
          // Type-check already established `resolved` is a string above;
          // this branch ONLY fires for empty/whitespace-only string
          // returns. Copilot R7 on PR #825 tightened the message.
          const msg = `delete operation: resolveTargetRecordId returned empty/whitespace-only string`;
          this.logger.error('FlowExecutor: delete resolver produced unusable id', new Error(msg), flowMeta);
          return { status: 'failed', error: msg, attempt: 1 };
        }
        // Store the TRIMMED value so the enqueue resourceId AND the dispatch
        // call both see the canonical id (matches readId()'s whitespace
        // handling for update operations). Copilot R6 on PR #825.
        preResolvedDeleteId = trimmed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error('FlowExecutor: delete resolver threw', err instanceof Error ? err : new Error(msg), flowMeta);
        return { status: 'failed', error: `delete operation: resolveTargetRecordId failed: ${msg}`, attempt: 1 };
      }
    }

    // PR 13b — ownership enforcement via guardedWrite (wraps the dispatch
    // call below). guardedWrite calls ownershipResolver.validateWrite
    // internally; if the write is blocked, it throws a WriteBlockedError
    // subclass (OwnershipViolationError, OwnershipBlockedError, or
    // LoopDetectedError) BEFORE calling do:(), so the connector is never
    // reached on a blocked-ownership path. The governance scan (below)
    // runs before the guarded dispatch; a non-owner write that survives
    // governance is still blocked at the guardedWrite dispatch gate.
    // The catch block in the dispatch try/catch translates these errors
    // into typed FlowBlockedResult variants with reason:'ownership' or
    // reason:'loop'. Replaces the inline validateWrite pre-flight from
    // PR 13.

    // OutboundGovernanceService runs the DLP scan + decides approve/queue/block.
    // The narrow PR 14 path performs ONE validation here and passes the
    // redacted payload through to the connector — concrete connectors that
    // still call BaseConnector.validateOutboundWrite() will re-scan, which is
    // acceptable defense-in-depth until the precomputedDecision plumbing
    // lands in PR 14b. The double-scan is wasted work, never incorrect: same
    // payload + same policy → same decision.
    const governanceCtx: OutboundContext = {
      tenantId: ctx.tenantId,
      userId: ctx.userId ?? SYSTEM_IDENTITY.userId,
      destination: 'connector_write',
      // Lowercase normalization matches BaseConnector.validateOutboundWrite's
      // convention (`${this.systemType.toLowerCase()}.${operation}`) so
      // governance logs / metrics / policy routing don't fragment by case
      // depending on whether the path went through a template (which may
      // use lowercase registry keys) or a direct connector call (which
      // uses display case). Copilot R10 on PR #825. Reuses `expectedSystem`
      // which was already lowercased for the contract check above.
      destinationDetail: `${expectedSystem}.${template.target.operation}`,
      operationType: 'write',
      resourceType: template.target.recordType,
      riskLevel: template.riskClassification(record, ctx),
    };

    let decision: OutboundDecision<T>;
    try {
      decision = await this.outboundGovernance.validateConnectorWrite(record, governanceCtx);
    } catch (err) {
      this.logger.error('FlowExecutor governance scan threw', err instanceof Error ? err : new Error(String(err)), flowMeta);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
    }

    // Map the OutboundDecision shape to a single-string lineage result:
    //   approvalRequired  → 'pending_approval'
    //   approved          → 'approved'
    //   else              → 'blocked'
    // Precedence matches `execute()`'s branching below: approvalRequired
    // wins over approved, and the absence of both collapses to blocked.
    const lineageResult = decision.approvalRequired
      ? 'pending_approval'
      : decision.approved
        ? 'approved'
        : 'blocked';
    await lineage?.governanceDecision({
      result: lineageResult,
      findings: decision.findings ?? [],
    })?.catch(swallowLineageErr('governanceDecision'));

    if (decision.approvalRequired) {
      // Enqueue via ApprovalQueueService — the service's own fail-closed guards
      // (UnredactedPayloadError, InvalidDecisionError) protect against
      // persisting raw PII or a malformed decision shape.
      try {
        const approvalId = await this.approvalQueue.enqueue({
          tenantId: ctx.tenantId,
          requesterUserId: ctx.userId ?? SYSTEM_IDENTITY.userId,
          operationType: 'connector_write',
          resourceType: template.target.recordType,
          // Operation-discriminated resourceId so operator UIs surface a
          // meaningful pointer to what's being approved:
          //   create  → 'new'    (matches approvalQueueErrorHandler convention)
          //   update  → decision.redactedPayload.id ?? record.id
          //                       (prefer the DLP-redacted form so a
          //                        PII-bearing `id` field doesn't leak
          //                        into governance_approvals.resource_id —
          //                        Copilot R8 on PR #825)
          //   delete  → preResolvedDeleteId  (already validated above as
          //                                   non-empty; resolver errors
          //                                   already mapped to 'failed')
          resourceId: this.resolveResourceIdSync(template.target, record, decision.redactedPayload, preResolvedDeleteId),
          reason: { kind: 'governance', decision },
        });
        this.logger.info('FlowExecutor enqueued pending approval', { ...flowMeta, approvalId });
        return {
          status: 'pending_approval',
          approvalId,
          pollUrl: `/api/governance/approvals/${approvalId}`,
          governance: decision,
        };
      } catch (err) {
        this.logger.error(
          'FlowExecutor enqueue failed (fail-closed — surfacing as failed result)',
          err instanceof Error ? err : new Error(String(err)),
          flowMeta,
        );
        return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
      }
    }

    if (!decision.approved) {
      this.logger.info('FlowExecutor governance blocked write', { ...flowMeta, findings: decision.findings, riskLevel: decision.riskLevel });
      return {
        status: 'blocked',
        reason: 'governance',
        findings: decision.findings,
        governance: decision,
      };
    }

    // Approved → dispatch the redacted payload via guardedWrite. Falling back
    // to `record` is safe because OutboundGovernanceService only omits
    // redactedPayload on fail-safe blocks, which are caught above by
    // `!decision.approved`.
    const payload = (decision.redactedPayload ?? record) as T;

    try {
      const targetRecordId = await guardedWrite(
        {
          context: {
            tenantId: ctx.tenantId,
            callerSystem: template.source.system,
            targetSystem: template.target.system,
            entity: template.target.canonicalEntity,
            recordId: preResolvedDeleteId ?? originalUpdateId ?? undefined,
            correlationId: ctx.correlationId,
            requesterUserId: ctx.userId ?? SYSTEM_IDENTITY.userId,
            operation: template.target.operation,
          },
          do: async () => {
            // Inline connector dispatch so connector.create/update/delete are
            // direct AST descendants of this guardedWrite() call expression —
            // required by check-guarded-writes.mjs's AST-parent walk. See
            // dispatchInner() below for the full rationale for each branch.
            const dataPayload = connectorPayload(payload);
            switch (template.target.operation) {
              case 'create': {
                const result = await ctx.connector.create(template.target.recordType, dataPayload);
                const id = readId(result);
                if (id === null) {
                  throw new Error(`Connector ${template.target.system}.create returned a record without an id`);
                }
                return id;
              }
              case 'update': {
                if (originalUpdateId === null) {
                  throw new Error('update operation requires originalUpdateId from execute()');
                }
                await ctx.connector.update(template.target.recordType, originalUpdateId, dataPayload);
                return originalUpdateId;
              }
              case 'delete': {
                if (preResolvedDeleteId === null) {
                  throw new Error('delete operation requires preResolvedDeleteId from execute()');
                }
                await ctx.connector.delete(template.target.recordType, preResolvedDeleteId);
                return preResolvedDeleteId;
              }
            }
          },
        },
        {
          ownershipResolver: this.ownershipResolver,
          auditService: this.auditService,
          approvalQueueService: this.approvalQueue,
        },
      );
      // Do NOT include `targetRecordId` in this success log. For update/delete
      // operations it would be the RAW (un-redacted) lookup id we deliberately
      // route around the audit/redaction surfaces (Codex 5.5 HIGH on PR #825,
      // landed in this PR). Logger sinks aggregate searchable text — emitting
      // a PII-shaped id here would re-introduce the leak the dispatch path is
      // designed to prevent. flowMeta carries templateId + correlationId +
      // target — sufficient to trace the dispatch without surfacing the id.
      // For create operations the id is system-generated (safe), but the log
      // line stays symmetric across all three operations. Copilot R3 on PR
      // #827.
      this.logger.info('FlowExecutor dispatch succeeded', { ...flowMeta });
      await lineage?.targetWrite({
        system: template.target.system,
        entityType: template.target.recordType,
        entityId: targetRecordId,
      })?.catch(swallowLineageErr('targetWrite'));
      return { status: 'succeeded', targetRecordId, governance: decision };
    } catch (err) {
      if (
        err instanceof OwnershipViolationError ||
        err instanceof OwnershipBlockedError ||
        err instanceof OwnershipFieldLevelMergeBlockedError
      ) {
        this.logger.info('FlowExecutor: ownership blocked write via guardedWrite', {
          ...flowMeta,
          declaredOwner: err.detail.declaredOwner,
          callerSystem: err.detail.callerSystem,
        });
        return {
          status: 'blocked',
          reason: 'ownership',
          findings: [err.message],
          ownership: {
            entity: err.detail.entity,
            declaredOwner: err.detail.declaredOwner,
            callerSystem: err.detail.callerSystem,
            conflictPolicy:
              err instanceof OwnershipViolationError
                ? err.detail.conflictPolicy
                : err.detail.policy,
            ...(err instanceof OwnershipFieldLevelMergeBlockedError
              ? {
                  allowedFieldPaths: err.detail.allowedFieldPaths,
                  blockedFieldPaths: err.detail.blockedFieldPaths,
                }
              : {}),
            correlationId: err.detail.correlationId,
          },
        };
      }
      // Copilot R14 on PR #851: QueueForHumanNotYetSafeError is the third
      // ownership-class `WriteBlockedError` subclass; without this branch a
      // flow whose target entity declared `queue_for_human` (today only
      // possible via fixture manifests; production manifest has no such
      // entry) would fall through to `status: 'failed'` instead of mapping
      // to `reason: 'ownership'`. That mirrors the route-layer 409 mapping
      // in `approvalQueueErrorHandler`. The conflictPolicy literal is
      // 'queue_for_human' because the error class doesn't carry it on
      // `.detail` (the resolver already encoded the decision).
      if (err instanceof QueueForHumanNotYetSafeError) {
        this.logger.info('FlowExecutor: queue_for_human fail-closed via guardedWrite', {
          ...flowMeta,
          declaredOwner: err.detail.declaredOwner,
          callerSystem: err.detail.callerSystem,
        });
        return {
          status: 'blocked',
          reason: 'ownership',
          findings: [err.message],
          ownership: {
            entity: err.detail.entity,
            declaredOwner: err.detail.declaredOwner,
            callerSystem: err.detail.callerSystem,
            conflictPolicy: 'queue_for_human',
            correlationId: err.detail.correlationId,
          },
        };
      }
      if (err instanceof LoopDetectedError) {
        this.logger.info('FlowExecutor: reciprocal-write loop detected via guardedWrite', {
          ...flowMeta,
          callerSystem: err.detail.callerSystem,
          targetSystem: err.detail.targetSystem,
          breakingCondition: err.detail.breakingCondition,
        });
        return {
          status: 'blocked',
          reason: 'loop',
          findings: [err.message],
          loop: {
            breakingCondition: err.detail.breakingCondition,
            callerSystem: err.detail.callerSystem,
            targetSystem: err.detail.targetSystem,
            correlationId: err.detail.correlationId,
          },
        };
      }
      this.logger.error('FlowExecutor dispatch failed', err instanceof Error ? err : new Error(String(err)), flowMeta);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
    }
  }

  /**
   * Operation-discriminated dispatch. Splits out so the unit tests can drive
   * each branch independently and so the `bulk_upsert` branch can land here
   * (PR 14b) without churning execute().
   *
   * Both pre-resolved ids (`originalUpdateId`, `preResolvedDeleteId`) are
   * values `execute()` captured BEFORE the governance scan. They flow
   * through here separately from `payload` so the connector's LOOKUP arg is
   * always the un-redacted target id, even when the DLP scan rewrites the
   * `id` field inside the body. Codex 5.5 HIGH (update) and MEDIUM (delete)
   * on PR #825 caught the leak path that used `readId(redactedPayload)`
   * for the lookup.
   */

  /**
   * Synchronous resourceId resolver used at enqueue time. The delete branch
   * reads the already-validated `preResolvedDeleteId` from `execute()`'s
   * pre-governance gate — by the time we reach the enqueue path, the
   * resolver has already returned a non-empty string OR the executor has
   * already returned 'failed', so `preResolvedDeleteId === null` is
   * unreachable here in practice.
   *
   * For update operations, the resourceId is sourced from the redacted
   * payload (the DLP-scanned form) so a PII-bearing `id` field doesn't
   * reach `governance_approvals.resource_id`. When `decision.redactedPayload`
   * is present (anything other than null/undefined), the resolver returns
   * `readId(redactedPayload) ?? 'unknown'` and NEVER falls back to the raw
   * `record.id` — `readId` is null-safe, so non-plain payloads (a future
   * upstream type-contract violation) collapse to `'unknown'` rather than
   * the raw record id. This locks the queue-path contract: any
   * redactedPayload presence means the raw record id never reaches the
   * audit row. The raw-record fallback below the null/undefined gate only
   * fires when `redactedPayload` is genuinely absent — unreachable from
   * `execute()` per the OutboundGovernanceService contract
   * (approvalRequired decisions always include redactedPayload), but kept
   * for any future caller that bypasses `execute()`. Copilot R8 on PR
   * #825 caught the original unredacted-leak class; Copilot R4 + Codex
   * 5.5 HIGH on PR #827 closed the stripped-id-field plain-object case
   * (independently corroborated); Copilot R8 on PR #827 extended the
   * same posture to non-plain-but-non-null payloads (defense-in-depth);
   * Copilot R5 + R7 on PR #827 corrected the rationale + docstring drift.
   */
  private resolveResourceIdSync<T extends Record<string, unknown>>(
    target: FlowTarget,
    record: T,
    redactedPayload: unknown,
    preResolvedDeleteId: string | null,
  ): string {
    switch (target.operation) {
      case 'create':
        return 'new';
      case 'update': {
        // Queue-path contract (ADR-021 §5a): `governance_approvals.resource_id`
        // MUST be the redacted form — never the raw record id — so PII
        // doesn't land in audit storage.
        //
        // When `decision.redactedPayload` is present (anything other than
        // null/undefined), treat it as authoritative for the resourceId
        // and NEVER fall back to the raw `record.id`. `readId` is itself
        // null-safe — non-plain-object inputs (string, array, class
        // instance, primitive — any upstream type-contract violation)
        // return null, which collapses to the `'unknown'` placeholder.
        // This locks the queue-path contract: if a redactedPayload exists
        // at all, the raw record id never reaches `governance_approvals.
        // resource_id`. Copilot R4 + Codex 5.5 HIGH on PR #827 closed the
        // plain-object-but-id-stripped case; Copilot R8 on PR #827
        // extended the same posture to non-plain-but-non-null payloads
        // (defense-in-depth against a future caller that hand-constructs
        // an OutboundDecision with a malformed redactedPayload shape).
        //
        // The raw-record fallback below the null/undefined gate only
        // fires when `decision.redactedPayload` is genuinely absent. Per
        // the OutboundGovernanceService contract (`src/services/
        // governance/OutboundGovernanceService.ts`), fail-safe blocks
        // omit `redactedPayload` BUT also set `approvalRequired: false`,
        // and resolveResourceIdSync is only called from the
        // `approvalRequired` enqueue branch. Post-scan decisions that DO
        // set `approvalRequired: true` always include `redactedPayload`
        // (possibly equal to the original payload when no redaction was
        // needed). So in practice this branch is unreachable from
        // execute(); it exists for any future caller that bypasses
        // execute() (e.g. a direct unit-test invocation that hand-
        // constructs an OutboundDecision shape). Copilot R5 on PR #827
        // corrected the prior unreachable-branch rationale.
        if (redactedPayload !== null && redactedPayload !== undefined) {
          return readId(redactedPayload) ?? 'unknown';
        }
        const recordId = readId(record);
        return recordId ?? 'unknown';
      }
      case 'delete':
        return preResolvedDeleteId ?? 'unknown';
    }
  }
}

function connectorPayload<T extends Record<string, unknown>>(value: T): DataRecord {
  if (!isPlainRecord(value)) {
    throw new Error('FlowExecutor dispatch payload is not a plain object record');
  }
  return value as DataRecord;
}

function readId(record: unknown): string | null {
  if (!isPlainRecord(record)) return null;
  const id = record.id;
  if (typeof id === 'string') {
    // Whitespace-only ids (e.g. `'   '`) would pass a length check but
    // produce invalid connector calls / misleading approval rows. Trim
    // and reject empties to match the non-empty-string validation the
    // delete-resolver pre-resolution already enforces. Copilot R5 on
    // PR #825 flagged the prior length-only check.
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}
