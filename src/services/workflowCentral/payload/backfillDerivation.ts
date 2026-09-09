/**
 * Pure derivation logic for the Phase 1 backfill script (ADR-019 / T13).
 * Lives in src so Jest can import it; the CLI script at
 * scripts/backfill-workflow-payload-refs.mjs imports these helpers and
 * adds the DB-touching wrapper.
 */
import type { WorkflowExternalRecordReference } from './WorkflowPayload';

export const ALLOWED_SYSTEMS: ReadonlySet<string> = new Set([
  'netsuite', 'businesscentral', 'salesforce', 'hubspot', 'shipstation', 'oracle',
]);

export const EPHEMERAL_DAYS = 30;

function lower(v: unknown): string | undefined {
  return typeof v === 'string' ? v.toLowerCase() : undefined;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Walk an arbitrary JSON object looking for a derivable
 * {system, recordType, recordId} triple. Accepts both top-level keys and
 * nested *_ref / *Ref shapes. Lowercases the system key. Returns null when
 * no derivable triple is found.
 */
export function deriveRef(obj: unknown): WorkflowExternalRecordReference | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const flat = obj as Record<string, unknown>;
  const directSystem = lower(flat.system ?? flat.connector ?? flat.platform);
  const directRecordType = flat.recordType ?? flat.record_type ?? flat.entityType ?? flat.entity_type;
  // recordId aliases: NO bare `id` — too ambiguous (could be workflow ID,
  // task ID, etc.). Required explicit recordId / record_id / internalId /
  // internal_id. The .mjs CLI script mirrors this exact list (Codex R3 P2).
  const directRecordId = flat.recordId ?? flat.record_id ?? flat.internalId ?? flat.internal_id;
  if (
    directSystem !== undefined && ALLOWED_SYSTEMS.has(directSystem)
    && isStr(directRecordType) && isStr(directRecordId)
  ) {
    return {
      system: directSystem as WorkflowExternalRecordReference['system'],
      recordType: directRecordType,
      recordId: directRecordId,
    };
  }
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v !== 'object' || v === null) continue;
    if (/_ref$|Ref$/.test(k)) {
      const nested = deriveRef(v);
      if (nested) return nested;
    }
  }
  return null;
}

export interface EphemeralFromBackfill {
  readonly mode: 'ephemeral_hosted';
  readonly expiresAt: string;
  readonly reason: string;
  readonly data: Record<string, unknown>;
}

export function ephemeralPayload(reason: string, originalData: unknown = {}): EphemeralFromBackfill {
  const expiresAt = new Date(Date.now() + EPHEMERAL_DAYS * 86_400_000).toISOString();
  // Preserve original legacy data so non-derivable rows still render with
  // their business fields (Codex P4 finding on PR #811 R2). Without this,
  // setting payload on a non-derivable row would short-circuit the legacy
  // fallback branch in WorkflowCentralOperatorService.getTaskForOperator and
  // the operator UI would render empty until Phase 2 cleanup.
  // Render is still gated by isEphemeralWorkflowPayloadAllowed() — these
  // rows only surface under explicit opt-in until migrated / deleted.
  const data = typeof originalData === 'object' && originalData !== null && !Array.isArray(originalData)
    ? (originalData as Record<string, unknown>)
    : {};
  return { mode: 'ephemeral_hosted', expiresAt, reason, data };
}
