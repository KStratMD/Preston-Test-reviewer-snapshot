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
import type { IConnector } from '../../interfaces/IConnector';
import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';
import type { DataRecord } from '../../types';
import type { FlowContext, FlowTemplate, FlowTarget } from './FlowTemplate';
import type { FlowResult } from './FlowResult';

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

    let record: T;
    try {
      record = await template.transform(event, ctx);
    } catch (err) {
      this.logger.error('FlowExecutor.transform failed', err instanceof Error ? err : new Error(String(err)), flowMeta);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
    }

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
    // CASE NORMALIZATION (Codex 5.5 HIGH follow-up): real connectors expose
    // display-case `systemType` (`NetSuite`, `HubSpot`, `BusinessCentral`)
    // while the canonical registry keys + the template authoring convention
    // are lowercase (`netsuite`, `hubspot`, `businesscentral`). Comparing
    // raw strings would reject every production-resolved connector. Both
    // sides normalize to lowercase before equality; templates SHOULD declare
    // `target.system` in lowercase registry-key form, but the executor
    // accepts either case so the safety net survives a typo on either side.
    const expectedSystem = template.target.system.toLowerCase();
    const actualSystem = ctx.connector?.systemType?.toLowerCase();
    if (!ctx.connector || actualSystem !== expectedSystem) {
      const got = ctx.connector?.systemType ?? '(missing)';
      const msg = `FlowContext.connector.systemType '${got}' does not match template.target.system '${template.target.system}' (case-insensitive)`;
      this.logger.error('FlowExecutor: connector / template system mismatch', new Error(msg), flowMeta);
      return { status: 'failed', error: msg, attempt: 1 };
    }

    // Fail-fast on update without payload.id (Copilot R2). The dispatch
    // step requires payload.id; pre-validating avoids a pointless DLP scan
    // + (on the queue branch) an unactionable approval row whose resourceId
    // would be 'unknown'.
    if (template.target.operation === 'update' && readId(record) === null) {
      const msg = `update operation requires payload.id from template.transform; received record without a usable id`;
      this.logger.error('FlowExecutor: update template produced record without payload.id', new Error(msg), flowMeta);
      return { status: 'failed', error: msg, attempt: 1 };
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
          decision,
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

    // Approved → dispatch the redacted payload. Falling back to `record` is
    // safe because OutboundGovernanceService only omits redactedPayload on
    // fail-safe blocks, which are caught above by `!decision.approved`.
    const payload = (decision.redactedPayload ?? record) as T;

    try {
      const targetRecordId = await this.dispatch(template.target, payload, ctx.connector, preResolvedDeleteId);
      this.logger.info('FlowExecutor dispatch succeeded', { ...flowMeta, targetRecordId });
      return { status: 'succeeded', targetRecordId, governance: decision };
    } catch (err) {
      this.logger.error('FlowExecutor dispatch failed', err instanceof Error ? err : new Error(String(err)), flowMeta);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), attempt: 1 };
    }
  }

  /**
   * Operation-discriminated dispatch. Splits out so the unit tests can drive
   * each branch independently and so the `bulk_upsert` branch can land here
   * (PR 14b) without churning execute().
   *
   * `preResolvedDeleteId` is the value `execute()` already obtained from
   * `target.resolveTargetRecordId(...)` BEFORE governance scan (Codex 5.5
   * MEDIUM fix). Passing it through avoids invoking the resolver twice and
   * guarantees the dispatch sees exactly the id that was reflected in the
   * approval row's resourceId.
   */
  private async dispatch<T extends Record<string, unknown>>(
    target: FlowTarget,
    payload: T,
    connector: IConnector,
    preResolvedDeleteId: string | null,
  ): Promise<string> {
    const dataPayload = connectorPayload(payload);

    switch (target.operation) {
      case 'create': {
        const result = await connector.create(target.recordType, dataPayload);
        const id = readId(result);
        if (id === null) {
          throw new Error(`Connector ${target.system}.create returned a record without an id`);
        }
        return id;
      }
      case 'update': {
        const id = readId(dataPayload);
        if (id === null) {
          throw new Error(`update operation requires payload.id; got ${typeof dataPayload.id}`);
        }
        const result = await connector.update(target.recordType, id, dataPayload);
        return readId(result) ?? id;
      }
      case 'delete': {
        if (preResolvedDeleteId === null) {
          // Unreachable in execute()'s call path because the delete pre-resolve
          // gate would have returned 'failed' before dispatch. Belt-and-braces
          // guard for any future caller that bypasses execute().
          throw new Error('delete operation requires preResolvedDeleteId from execute()');
        }
        await connector.delete(target.recordType, preResolvedDeleteId);
        return preResolvedDeleteId;
      }
    }
  }

  /**
   * Synchronous resourceId resolver used at enqueue time. The delete branch
   * reads the already-validated `preResolvedDeleteId` from `execute()`'s
   * pre-governance gate — by the time we reach the enqueue path, the
   * resolver has already returned a non-empty string OR the executor has
   * already returned 'failed', so `preResolvedDeleteId === null` is
   * unreachable here in practice.
   *
   * For update operations, the resourceId is read PREFERENTIALLY from
   * `decision.redactedPayload.id` so a PII-bearing `id` field is masked
   * before it reaches `governance_approvals.resource_id`. The raw record
   * is only used as a fallback when the redacted payload is absent or
   * id-less (which the pre-governance fail-fast already rejected for
   * update). Copilot R8 on PR #825 caught the unredacted leak.
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
        // Prefer the redacted payload's id (DLP-scanned form) over the raw
        // record's id. Falls back to the raw record id if the redacted
        // form is absent — that covers oversize-block + scan-failure
        // shapes, which the !decision.approved branch above handles, but
        // belt-and-braces here too.
        const redactedId = readId(redactedPayload);
        if (redactedId !== null) return redactedId;
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
