import { injectable, inject } from 'inversify';
import { createHash } from 'node:crypto';
import { TYPES } from '../../../inversify/types';
import type { ConnectorManager } from '../../integration/ConnectorManager';
import type { DLPService } from '../../security/DLPService';
import type { Logger } from '../../../utils/Logger';
import type { WorkflowExternalRecordReference } from './WorkflowPayload';
import { PayloadRefError } from './errors';
import { WorkflowPayloadCache } from './WorkflowPayloadCache';
import type { GovernanceService, TenantGovernancePosture } from '../../ai/orchestrator/GovernanceService';

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
    @inject(TYPES.GovernanceService) private readonly governance: GovernanceService,
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
    // Posture lookup BEFORE cache lookup: the cache key is keyed by
    // (tenantId, ref, fields) and has no notion of posture, so a posture
    // flip in either direction would otherwise serve stale results:
    //   - allowPII=true → false: cache held raw PII; cleared by skipping
    //     cache.set() on the allowPII path below.
    //   - allowPII=false → true: cache held REDACTED data; would keep
    //     returning sanitized output even after the tenant opted in to
    //     raw PII. Fixed by skipping the cache lookup on the allowPII
    //     path so the connector re-fetch always wins.
    // Both directions covered by reading posture first and skipping
    // cache entirely (lookup + set) when allowPII=true.
    // Codex pre-merge HIGH on PR #835 (rounds 1 + 2).
    const posture = await this.governance.getPostureForTenant(tenantId);
    const postureFingerprint = computePostureFingerprint(posture);

    if (!posture.allowPII) {
      // Posture-aware cache lookup: pass the fingerprint so a mismatch
      // (any change to allowPII/blockOnDetection/autoRedact/piiTypes since
      // the entry was cached) evicts the stale entry rather than serving
      // data computed under a posture the tenant has since changed.
      // Copilot R5 — closes the broader posture-drift leak class, not
      // just allowPII.
      const cached = this.cache.get(tenantId, ref, postureFingerprint);
      if (cached !== undefined) {
        return { ref, status: 'resolved', fields: cached.fields, resolvedAt: cached.resolvedAt };
      }
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

      if (posture.allowPII) {
        // Tenant explicitly opted in to surfacing raw connector PII in operator UI.
        // No cache.set() — see top-of-function comment for symmetric reasoning.
        const resolvedAt = new Date().toISOString();
        return { ref, status: 'resolved', fields: projected, resolvedAt };
      }

      const scanned = await this.dlp.scanForPII(projected, {
        autoRedact: false, allowPII: false, piiTypes: [], blockOnDetection: false,
      });

      if (scanned.scanFailed) {
        return failed(ref, 500, 'PAYLOAD_REF_DLP_SCAN_FAILED',
          'DLP scan failed; refusing to surface unscanned payload');
      }

      const relevantFindings = posture.piiTypes.length === 0
        ? scanned.findings
        : scanned.findings.filter(f => posture.piiTypes.includes(f.type));

      if (relevantFindings.length > 0 && posture.blockOnDetection) {
        return failed(ref, 403, 'PAYLOAD_REF_DLP_BLOCKED',
          'DLP findings present and tenant posture blocks on detection');
      }

      if (relevantFindings.length > 0 && !posture.autoRedact) {
        return failed(ref, 403, 'PAYLOAD_REF_DLP_BLOCKED',
          'DLP findings present and tenant posture disables auto-redact');
      }

      let safe: Record<string, unknown>;
      if (relevantFindings.length === 0) {
        safe = projected;
      } else {
        const redacted = this.dlp.redactData(projected, relevantFindings) as Record<string, unknown> | undefined;
        if (redacted === undefined) {
          return failed(ref, 500, 'PAYLOAD_REF_DLP_SCAN_FAILED',
            'DLP redaction produced no output; refusing to surface raw payload');
        }
        safe = redacted;
      }

      const resolvedAt = new Date().toISOString();
      // Successful resolution → cache (with posture fingerprint so future
      // posture changes invalidate the entry). Failures are NEVER cached
      // (no negative caching — let the retry hit the connector and pick
      // up recovery).
      this.cache.set(tenantId, ref, { fields: safe, resolvedAt, postureFingerprint });
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

/**
 * Deterministic fingerprint of the 4 posture properties that affect the
 * cached resolution shape. Any change to `allowPII`/`blockOnDetection`/
 * `autoRedact`/`piiTypes` produces a different hash, so the resolver's
 * cache lookup will miss against entries computed under the previous
 * posture (avoiding the broader posture-drift leak class — Copilot R5).
 *
 * `piiTypes` is sorted before hashing so semantically-equal posture
 * configurations with different array orderings collide as expected.
 */
function computePostureFingerprint(posture: TenantGovernancePosture): string {
  const piiTypesCanonical = [...posture.piiTypes].sort().join(',');
  const raw = [
    posture.allowPII ? '1' : '0',
    posture.blockOnDetection ? '1' : '0',
    posture.autoRedact ? '1' : '0',
    piiTypesCanonical,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
