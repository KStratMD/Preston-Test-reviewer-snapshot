/**
 * FlowResult — discriminated union returned by `FlowExecutor.execute()`.
 *
 * Mirrors the HTTP shape that route catches produce today, but as a typed
 * value so programmatic callers can branch on the discriminator without
 * parsing an HTTP body:
 *
 *   - `succeeded`     → `{targetRecordId, governance}`
 *   - `pending_approval` → `{approvalId, pollUrl, governance}`     (HITL queued)
 *   - `blocked`       → `{reason: 'governance' | 'validation', findings}`
 *   - `failed`        → `{error, attempt}` — terminal non-governance failure
 *
 * The `governance` field is included on succeeded + pending_approval so
 * callers can audit-log the OutboundDecision findings without re-running the
 * DLP scan. `blocked` carries its own reason union because a validation
 * failure (template's `validate` hook) and a governance block are
 * meaningfully different operator-facing events.
 */

import type { OutboundDecision } from '../../services/governance/OutboundGovernanceService';

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

export interface FlowBlockedResult {
  status: 'blocked';
  reason: 'governance' | 'validation';
  /**
   * Governance findings (DLP detection types, oversize, etc.) — populated when
   * `reason === 'governance'`. For validation blocks, this carries the
   * template `validate` hook's error list.
   */
  findings: string[];
  governance?: OutboundDecision<unknown>;
}

export interface FlowFailedResult {
  status: 'failed';
  error: string;
  /** 1-based attempt counter on the dispatch step. Today always 1 — retry loop is PR 14b. */
  attempt: number;
}
