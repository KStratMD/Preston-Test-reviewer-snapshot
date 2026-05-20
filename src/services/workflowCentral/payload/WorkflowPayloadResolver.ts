import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { ConnectorManager } from '../../integration/ConnectorManager';
import type { DLPService } from '../../security/DLPService';
import type { Logger } from '../../../utils/Logger';
import type { WorkflowExternalRecordReference } from './WorkflowPayload';
import { PayloadRefError } from './errors';
import { WorkflowPayloadCache } from './WorkflowPayloadCache';

/**
 * Per-ref resolution outcome. The resolver returns one outcome per input ref;
 * a failed connector call on one ref does NOT short-circuit the rest — the
 * operator UI gets a partial-success array and renders each ref independently
 * (load-bearing for cross-system compose workflows).
 *
 * Per-ref failures are NEVER route-level HTTP codes. The route handler at
 * src/routes/workflowCentral.ts wraps a successful resolve() call in HTTP 200;
 * per-ref errors live inside `outcomes[i].error`. Only whole-render conditions
 * (NotFoundError, EphemeralPayload*Error, invalid :id) bubble to HTTP codes.
 */
export interface ResolutionOutcome {
  readonly ref: WorkflowExternalRecordReference;
  readonly status: 'resolved' | 'failed';
  readonly fields?: Record<string, unknown>;
  readonly resolvedAt?: string;
  readonly error?: {
    readonly code: string;
    readonly statusCode: number;
    readonly message: string;
  };
}

@injectable()
export class WorkflowPayloadResolver {
  constructor(
    @inject(TYPES.ConnectorManager) private readonly connectors: ConnectorManager,
    @inject(TYPES.DLPService) private readonly dlp: DLPService,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.WorkflowPayloadCache) private readonly cache: WorkflowPayloadCache,
  ) {}

  async resolve(
    refs: readonly WorkflowExternalRecordReference[],
    tenantId: string,
  ): Promise<ResolutionOutcome[]> {
    const outcomes: ResolutionOutcome[] = [];
    for (const ref of refs) {
      outcomes.push(await this.resolveOne(ref, tenantId));
    }
    return outcomes;
  }

  private async resolveOne(
    ref: WorkflowExternalRecordReference,
    tenantId: string,
  ): Promise<ResolutionOutcome> {
    const cached = this.cache.get(tenantId, ref);
    if (cached !== undefined) {
      return { ref, status: 'resolved', fields: cached.fields, resolvedAt: cached.resolvedAt };
    }
    try {
      // Per-tenant connector convention: `${system}_${tenantId}`. Matches the
      // existing tenant-scoped callsites at SyncErrorAssistService.ts:390 and
      // FinanceCentralOperatorService.ts:128. NOT the IntegrationService:207-208
      // pattern (those use configId, not tenantId).
      const systemId = `${ref.system}_${tenantId}`;
      const connector = await this.connectors.getConnector(ref.system, systemId);
      // BaseConnector.read is (entityType, id) positional, returns DataRecord | null.
      const raw = await connector.read(ref.recordType, ref.recordId);
      if (raw === null) {
        return failed(ref, 404, 'PAYLOAD_REF_RECORD_NOT_FOUND',
          `${ref.system}/${ref.recordType}/${ref.recordId} not found`);
      }
      const projected = ref.fieldsOfInterest && ref.fieldsOfInterest.length > 0
        ? pickFields(raw as Record<string, unknown>, ref.fieldsOfInterest)
        : (raw as Record<string, unknown>);
      const scanned = await this.dlp.scanForPII(projected, {
        autoRedact: true,
        allowPII: false,
        piiTypes: [],
        blockOnDetection: false,
      });
      // Fail-closed on internal DLP failure — DLPService sets scanFailed:true
      // on internal errors (DLPService.ts:59 + :562). Surfacing UNSCANNED
      // payload here would leak it; instead we mark the outcome as failed so
      // the operator UI shows the ref couldn't be safely rendered.
      if (scanned.scanFailed) {
        return failed(ref, 500, 'PAYLOAD_REF_DLP_SCAN_FAILED',
          'DLP scan failed; refusing to surface unscanned payload');
      }
      // Fail-closed on PII detected without redactor output. Mirrors the
      // SyncErrorAssist convention (promptBuilder.ts:221-245 +
      // SyncErrorAssistService.ts:596-607): if findings.length > 0 but
      // redactedData is undefined, the redactor failed to produce a safe
      // copy — surfacing the raw projected fields would leak the PII the
      // scanner JUST detected. Copilot R4 finding on PR #811.
      if (scanned.findings.length > 0 && scanned.redactedData === undefined) {
        return failed(ref, 500, 'PAYLOAD_REF_DLP_SCAN_FAILED',
          'DLP detected PII but produced no redacted copy; refusing to surface raw payload');
      }
      const safe = (scanned.redactedData as Record<string, unknown> | undefined) ?? projected;
      const resolvedAt = new Date().toISOString();
      // Successful resolution → cache. Failures are NEVER cached (no negative
      // caching — let the retry hit the connector and pick up recovery).
      this.cache.set(tenantId, ref, { fields: safe, resolvedAt });
      return {
        ref,
        status: 'resolved',
        fields: safe,
        resolvedAt,
      };
    } catch (e) {
      this.logger.warn('WorkflowPayloadResolver: connector read failed', {
        system: ref.system,
        recordType: ref.recordType,
        recordId: ref.recordId,
        tenantId,
        err: e instanceof Error ? e.message : String(e),
      });
      return { ref, status: 'failed', error: translateConnectorError(e) };
    }
  }
}

function pickFields(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k];
    }
  }
  return out;
}

function failed(
  ref: WorkflowExternalRecordReference,
  statusCode: number,
  code: string,
  message: string,
): ResolutionOutcome {
  return { ref, status: 'failed', error: { code, statusCode, message } };
}

/**
 * Connector-error translation by typed properties (statusCode, error code)
 * — never regex over err.message per feedback_copilot_typed_error_pressure.
 *
 * Discrimination order:
 *   1. instanceof PayloadRefError (future-proof for connectors that wrap
 *      their failures in the typed classes from ./errors)
 *   2. err.statusCode (HTTP-style errors with explicit status)
 *   3. err.code (Node network errors: ECONNREFUSED, ETIMEDOUT, etc.)
 *   4. Generic fallback → PAYLOAD_REF_CONNECTOR_UNAVAILABLE (503)
 *
 * PAYLOAD_REF_SYSTEM_UNKNOWN is intentionally NOT inferred here — the
 * runtime ref-validator (isWorkflowPayloadReference) already rejects
 * unknown system values upfront via the literal union + ALLOWED_SYSTEMS
 * check, so a system-unknown error from ConnectorManager would only fire
 * on an untyped ref bypassing the validator. The PR-OP-3 errors-by-typed-
 * class pattern means the upfront validator is the right place to enforce
 * this, not catch-time translation.
 */
const NETWORK_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
]);

function translateConnectorError(e: unknown): { code: string; statusCode: number; message: string } {
  if (e instanceof PayloadRefError) {
    return { code: e.code, statusCode: e.statusCode, message: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  const errObj = (typeof e === 'object' && e !== null) ? e as { statusCode?: unknown; code?: unknown } : null;
  const statusCode = typeof errObj?.statusCode === 'number' ? errObj.statusCode : null;
  const code = typeof errObj?.code === 'string' ? errObj.code : null;

  if (statusCode === 404) return { code: 'PAYLOAD_REF_RECORD_NOT_FOUND', statusCode: 404, message: msg };
  if (statusCode === 401) return { code: 'PAYLOAD_REF_AUTH_EXPIRED', statusCode: 401, message: msg };
  // 403 ≠ 401 — Copilot R1 finding on PR #811. 403 is authenticated-but-unauthorized
  // (record-level permission / tenant scope gap); operator UI should NOT prompt
  // re-auth as it would for 401/auth-expired. Distinct typed outcome.
  if (statusCode === 403) return { code: 'PAYLOAD_REF_FORBIDDEN', statusCode: 403, message: msg };
  if (statusCode === 503 || (code !== null && NETWORK_FAILURE_CODES.has(code))) {
    return { code: 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE', statusCode: 503, message: msg };
  }

  return { code: 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE', statusCode: 503, message: msg };
}
