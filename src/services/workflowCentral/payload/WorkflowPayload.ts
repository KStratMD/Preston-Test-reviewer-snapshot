/**
 * WorkflowPayload tagged-union contract for governance-without-hosting-data
 * Phase 1 — see ADR-019 and docs/plans/2026-05-17-governance-without-hosting-data-plan.md.
 *
 * - `WorkflowPayloadReference` (mode: 'external_reference') = pointers into the
 *   client's ERP. Default for new non-demo WorkflowCentral instances. Resolver
 *   fetches live data at render time; the audit log records refs, never values.
 * - `EphemeralWorkflowPayload` (mode: 'ephemeral_hosted') = transient payload
 *   for workflows that cannot be reference-based (cross-system compose,
 *   AI-generated workflows pre-creation in the ERP). REQUIRES `expiresAt`
 *   and tenant opt-in via `workflow.allow_ephemeral_payload` or the
 *   `WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD` env flag. `redactWorkflowPayloadForAudit`
 *   drops `data` before any audit emit — load-bearing invariant.
 */

export type WorkflowPayloadMode = 'external_reference' | 'ephemeral_hosted';

export interface WorkflowExternalRecordReference {
  readonly system: 'netsuite' | 'businesscentral' | 'salesforce' | 'hubspot' | 'shipstation' | 'oracle';
  readonly recordType: string;
  readonly recordId: string;
  readonly displayHint?: string;
  readonly fieldsOfInterest?: readonly string[];
  readonly recordUrl?: string;
  readonly versionToken?: string;
}

export interface WorkflowPayloadReference {
  readonly mode: 'external_reference';
  readonly references: readonly WorkflowExternalRecordReference[];
  readonly evaluationHints?: Readonly<Record<string, string | number | boolean>>;
}

export interface EphemeralWorkflowPayload {
  readonly mode: 'ephemeral_hosted';
  readonly expiresAt: string;
  readonly reason: string;
  readonly data: Record<string, unknown>;
}

export type WorkflowPayload = WorkflowPayloadReference | EphemeralWorkflowPayload;

const ALLOWED_SYSTEMS: ReadonlySet<string> = new Set([
  'netsuite', 'businesscentral', 'salesforce', 'hubspot', 'shipstation', 'oracle',
]);

function isExternalRef(v: unknown): v is WorkflowExternalRecordReference {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.system !== 'string' || !ALLOWED_SYSTEMS.has(r.system)) return false;
  if (typeof r.recordType !== 'string' || r.recordType.length === 0) return false;
  if (typeof r.recordId !== 'string' || r.recordId.length === 0) return false;
  if (r.fieldsOfInterest !== undefined
      && !(Array.isArray(r.fieldsOfInterest) && r.fieldsOfInterest.every((f) => typeof f === 'string'))) return false;
  return true;
}

export function isWorkflowPayloadReference(v: unknown): v is WorkflowPayloadReference {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return p.mode === 'external_reference'
    && Array.isArray(p.references)
    && p.references.every(isExternalRef);
}

// Anchored ISO-8601 — keeps `Date.parse` non-ISO fallbacks ("2026-05-18 noon",
// "tomorrow", "2026/05/18") out. Tight format because the value is the
// audit-row + retention-job SLA anchor; ambiguous parses there are load-bearing.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isEphemeralWorkflowPayload(v: unknown): v is EphemeralWorkflowPayload {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (p.mode !== 'ephemeral_hosted') return false;
  if (typeof p.expiresAt !== 'string'
      || !ISO_TIMESTAMP_RE.test(p.expiresAt)
      || Number.isNaN(Date.parse(p.expiresAt))) return false;
  if (typeof p.reason !== 'string' || p.reason.length === 0) return false;
  if (typeof p.data !== 'object' || p.data === null || Array.isArray(p.data)) return false;
  return true;
}

export function assertWorkflowPayloadReference(v: unknown): asserts v is WorkflowPayloadReference {
  if (!isWorkflowPayloadReference(v)) throw new TypeError('Invalid WorkflowPayloadReference shape');
}

export function assertEphemeralWorkflowPayload(v: unknown): asserts v is EphemeralWorkflowPayload {
  if (!isEphemeralWorkflowPayload(v)) throw new TypeError('Invalid EphemeralWorkflowPayload shape');
}

/**
 * Audit-safe shape: refs unchanged (refs are not sensitive — they're pointers
 * the client can also see); ephemeral `data` DROPPED. Load-bearing invariant:
 * audit row JSON must never contain ephemeral.data values. T12 wraps every
 * audit-emit site that touches `task.payload` through this helper.
 */
export function redactWorkflowPayloadForAudit(payload: WorkflowPayload): Record<string, unknown> {
  if (payload.mode === 'external_reference') {
    return {
      mode: payload.mode,
      references: payload.references,
      evaluationHints: payload.evaluationHints,
    };
  }
  return {
    mode: payload.mode,
    expiresAt: payload.expiresAt,
    reason: payload.reason,
  };
}
