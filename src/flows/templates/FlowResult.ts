/**
 * FlowResult — discriminated union returned by `FlowExecutor.execute()`.
 *
 * Mirrors the HTTP shape that route catches produce today, but as a typed
 * value so programmatic callers can branch on the discriminator without
 * parsing an HTTP body:
 *
 *   - `succeeded`     → `{targetRecordId, governance}`
 *   - `pending_approval` → `{approvalId, pollUrl, governance}`     (HITL queued)
 *   - `blocked`       → `{reason: 'governance' | 'validation' | 'ownership' | 'loop', findings, ...}`
 *   - `failed`        → `{error, attempt}` — terminal non-governance failure
 *
 * The `governance` field is included on succeeded + pending_approval so
 * callers can audit-log the OutboundDecision findings without re-running the
 * DLP scan. `blocked` is a tagged union on `reason` — the 'governance'
 * variant carries the OutboundDecision, 'validation' carries the template's
 * validate-hook error list, and 'ownership' (PR 13) carries the structured
 * OwnershipFailureDetail. Validation, governance, and ownership are
 * meaningfully different operator-facing events.
 */

import type { OutboundDecision } from '../../services/governance/OutboundGovernanceService';
import type { CanonicalEntity, CallerSystem, ConflictPolicy, SourceSystem } from '../../governance/sourceOfTruth/SourceOfTruthManifest';

export type FlowResult =
  | FlowSucceededResult
  | FlowPendingApprovalResult
  | FlowBlockedResult
  | FlowFailedResult;

export interface FlowSucceededResult {
  status: 'succeeded';
  /**
   * Stable target identifier. For `create` this is the new record id; for
   * `update` the same id that was supplied; for `delete` the id resolved via
   * `resolveTargetRecordId` (connectors that return `true` on delete carry no
   * id of their own).
   */
  targetRecordId: string;
  governance: OutboundDecision<unknown>;
}

export interface FlowPendingApprovalResult {
  status: 'pending_approval';
  approvalId: string;
  pollUrl: string;
  governance: OutboundDecision<unknown>;
}

/**
 * Structured ownership failure detail emitted by FlowExecutor when
 * OwnershipResolver rejects (or non-throwingly blocks) a flow-originated
 * write. Carries enough context that the FlowResult never has to collapse
 * to an opaque error string. PR 13 (Codex round 2).
 */
export interface OwnershipFailureDetail {
  // Widened beyond CanonicalEntity to accept connector-side record types
  // (e.g. 'contacts', 'Customer') flowing through guardedWrite for entities
  // not in SOURCE_OF_TRUTH_MANIFEST. Copilot R1 cluster-B.
  entity: CanonicalEntity | string;
  declaredOwner: SourceSystem;
  callerSystem: CallerSystem;
  conflictPolicy: ConflictPolicy;
  fieldPath?: string;
  allowedFieldPaths?: string[];
  blockedFieldPaths?: string[];
  correlationId: string;
}

/**
 * Discriminated by `reason`. PR 13 added 'ownership'; PR 13b adds 'loop'
 * (reciprocal-write hazard detected by OwnershipResolver.detectLoop).
 * Existing callers narrowing on the original three variants keep working.
 */
export type FlowBlockedResult =
  | {
      status: 'blocked';
      reason: 'governance';
      findings: string[];
      governance: OutboundDecision<unknown>;
    }
  | {
      status: 'blocked';
      reason: 'validation';
      findings: string[];
    }
  | {
      status: 'blocked';
      reason: 'ownership';
      findings: string[];
      ownership: OwnershipFailureDetail;
    }
  | {
      status: 'blocked';
      reason: 'loop';
      findings: string[];
      loop: {
        breakingCondition: string;
        callerSystem: SourceSystem;
        targetSystem: SourceSystem;
        correlationId: string;
      };
    };

export interface FlowFailedResult {
  status: 'failed';
  error: string;
  /** 1-based attempt counter on the dispatch step. Today always 1 — retry loop is PR 14b. */
  attempt: number;
}
