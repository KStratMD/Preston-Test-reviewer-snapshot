import { createHash } from 'crypto';
import { uuidv4 } from '../../../utils/uuid';
import type { AuditLogRepository } from '../../../database/repositories/AuditLogRepository';
import type { NewAuditLog } from '../../../database/types';
import type { OutboundGovernanceService } from '../../governance/OutboundGovernanceService';
import type { Logger } from '../../../utils/Logger';
import type { SuiteCentralControlPlaneContext } from './domain';
import { safeCorrelationId } from './correlation';

/**
 * Sanitized audit trail for the SuiteCentral control plane (PR-A5).
 *
 * Every state-changing or outbound control-plane operation writes an `attempt`
 * row BEFORE the work happens and a `success`/`failure` row after. The attempt
 * row is what makes an interrupted or crashed operation visible: without it, a
 * process that dies mid-write leaves no trace at all. Because a write is only
 * sanctioned once its attempt is durably recorded, a persistence failure here
 * propagates and the caller fails closed rather than proceeding unaudited.
 *
 * Two independent defenses keep secret material out of `audit_logs`:
 *
 *   1. A key-NAME guard rejects detail keys that look secret-bearing before any
 *      backend is touched. This is a guard against a programming error at the
 *      call site, not user input — hence a hard throw rather than a silent strip,
 *      which would hide the bug it exists to catch.
 *   2. `OutboundGovernanceService.validateAuditLogPayload` DLP-scans the details.
 *      Note the governance service deliberately does NOT honor `posture.allowPII`
 *      on the `audit_log` destination, so a permissive tenant posture cannot turn
 *      the audit trail into a PII exfiltration vector.
 *
 * The guard cannot see a secret hidden under an innocuous key (`{ note: '<secret>' }`).
 * Callers must never hand secret material to this writer in the first place; the
 * control-plane service enforces that and pins it with a sentinel test.
 */

/**
 * The only detail shape accepted. Deliberately flat and primitive: nested
 * objects would let secret material ride along under a key the guard never
 * inspects.
 */
export type SuiteCentralAuditDetails = Record<string, string | number | boolean | null>;

/**
 * Detail keys that must never be persisted. Broad by intent — `auth` also
 * catches `authorization`/`authHeader`. Detail keys are chosen by our own call
 * sites, so a false positive is a rename at the call site, not a caller-facing
 * failure.
 */
const FORBIDDEN_DETAIL_KEY = /secret|token|password|auth/i;

/**
 * `resource_id` holds one of OUR generated ids — always a uuid. Anything else is
 * caller text that has not been validated yet (several operations audit the
 * attempt before the ownership check that would reject a bad id), and the column
 * is not DLP-scanned, so it must never be persisted verbatim.
 */
const GENERATED_RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The access modes the domain actually defines; anything else is not trusted. */
const SAFE_ACCESS_MODES: ReadonlySet<string> = new Set(['tenant_admin', 'platform_admin']);

type AuditResult = 'success' | 'failure';

export class SuiteCentralAuditWriter {
  constructor(
    private readonly auditLogRepository: Pick<AuditLogRepository, 'create'>,
    private readonly outboundGovernance: Pick<OutboundGovernanceService, 'validateAuditLogPayload'>,
    private readonly logger: Logger,
  ) {}

  /** Record that an operation is about to run. Must resolve before the work starts. */
  async attempt(
    context: SuiteCentralControlPlaneContext,
    action: string,
    resourceType: string,
    resourceId: string,
    details: SuiteCentralAuditDetails,
  ): Promise<void> {
    await this.write(context, action, 'attempt', resourceType, resourceId, details, 'success', null, null);
  }

  async success(
    context: SuiteCentralControlPlaneContext,
    action: string,
    resourceType: string,
    resourceId: string,
    details: SuiteCentralAuditDetails,
    durationMs: number,
  ): Promise<void> {
    await this.write(context, action, 'success', resourceType, resourceId, details, 'success', null, durationMs);
  }

  /**
   * Record a failure by stable machine `code`. No details are accepted: a failure
   * payload is the most likely place for raw upstream text (and the secrets it
   * may quote) to leak into the audit trail.
   */
  async failure(
    context: SuiteCentralControlPlaneContext,
    action: string,
    resourceType: string,
    resourceId: string,
    code: string,
    durationMs: number,
  ): Promise<void> {
    await this.write(context, action, 'failure', resourceType, resourceId, {}, 'failure', code, durationMs);
  }

  private async write(
    context: SuiteCentralControlPlaneContext,
    action: string,
    phase: 'attempt' | 'success' | 'failure',
    resourceType: string,
    resourceId: string,
    details: SuiteCentralAuditDetails,
    result: AuditResult,
    code: string | null,
    durationMs: number | null,
  ): Promise<void> {
    this.assertNoSecretBearingKeys(details);
    // Sanitize once, up front: the id flows into the governance context AND the
    // persisted row, and neither may carry unvetted caller text.
    const safeResource = this.safeResourceId(resourceId);

    const decision = await this.outboundGovernance.validateAuditLogPayload(details, {
      tenantId: context.targetTenantId,
      userId: context.actorUserId,
      destination: 'audit_log',
      destinationDetail: 'audit_logs.details',
      operationType: 'write',
      resourceType,
      resourceId: safeResource,
    });

    // Fail-closed on all three authoritative signals, matching the governed-write
    // seam: a present `redactedPayload` alone is not proof of sanitation.
    const sanitized =
      !decision.approved || decision.auditMetadata.blocked || decision.redactedPayload === undefined
        ? { omittedByOutboundGovernance: true }
        : decision.redactedPayload;

    if (sanitized !== decision.redactedPayload) {
      this.logger.warn('SuiteCentral audit details omitted by outbound governance', {
        tenantId: context.targetTenantId,
        correlationId: safeCorrelationId(context.correlationId),
        action,
        resourceType,
        // Sanitized, like the row and the governance context — sanitizing the
        // durable column but logging the raw value would just move the leak.
        resourceId: safeResource,
      });
    }

    // `accessMode` and `correlationId` are merged AFTER governance so they survive
    // a redaction that legitimately strips the caller's details. That places them
    // outside the DLP scan, so neither may be trusted on the way in: the
    // correlation id originates from the caller (a request header, once routes are
    // mounted), so an unvetted one would be arbitrary attacker text persisted to a
    // durable row that governance never saw. Both are validated instead.
    const row: NewAuditLog = {
      id: uuidv4(),
      tenant_id: context.targetTenantId,
      user_id: context.actorUserId,
      action: `suitecentral.${action}.${phase}`,
      resource_type: resourceType,
      resource_id: safeResource,
      old_values: null,
      new_values: null,
      details: {
        ...sanitized,
        accessMode: SAFE_ACCESS_MODES.has(context.accessMode) ? context.accessMode : 'unknown',
        correlationId: safeCorrelationId(context.correlationId),
      },
      result,
      error_message: code,
      duration_ms: durationMs,
      ip_address: null,
      user_agent: null,
      created_at: new Date().toISOString(),
    };

    await this.auditLogRepository.create(row);
  }

  /**
   * Keep a resource id only if it is one of our generated uuids; otherwise store
   * a digest of it.
   *
   * `audit_logs.resource_id` is NOT part of the payload governance scans — only
   * `details` is — and several operations write their attempt row BEFORE the
   * ownership check that would reject a bogus id. So an unvetted id is caller
   * text landing verbatim in a durable, ungoverned column, bypassing the same
   * defenses the details guard provides.
   *
   * A shape check alone would not be enough (a secret can be token-shaped, which
   * is why {@link stableErrorCode} trusts source over shape), so anything that is
   * not a uuid is replaced by a digest: non-reversible, bounded, and still
   * distinct per input, so the row stays useful for correlation without carrying
   * the value.
   */
  private safeResourceId(resourceId: string): string {
    if (GENERATED_RESOURCE_ID.test(resourceId)) return resourceId;
    const digest = createHash('sha256').update(resourceId, 'utf8').digest('hex').slice(0, 16);
    this.logger.warn('SuiteCentral audit received a non-generated resource id — storing a digest', {
      digest,
    });
    return `digest:${digest}`;
  }

  /**
   * Reject anything the flat-primitive contract does not allow.
   *
   * A key-name check alone is shallow: `{ meta: { clientSecret } }` has no
   * forbidden key at the root, and a symbol-keyed entry is invisible to
   * `Object.keys`. Both would then spread into the persisted row. TypeScript
   * forbids these shapes, but the guard exists precisely for the case where a
   * caller's types are wrong or the value crossed an `unknown` boundary — so it
   * enforces the contract at runtime instead of trusting it.
   */
  private assertNoSecretBearingKeys(details: SuiteCentralAuditDetails): void {
    if (Object.getOwnPropertySymbols(details).length > 0) {
      throw new Error('suitecentral_audit_symbol_detail_key');
    }
    for (const key of Object.keys(details)) {
      if (FORBIDDEN_DETAIL_KEY.test(key)) {
        // The key NAME is safe to surface; the value never is.
        throw new Error(`suitecentral_audit_forbidden_detail_key:${key}`);
      }
      // Values must be flat primitives: a nested object could carry secret
      // material under a key this guard never inspects.
      const value = (details as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object') {
        throw new Error(`suitecentral_audit_non_primitive_detail_value:${key}`);
      }
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        throw new Error(`suitecentral_audit_non_primitive_detail_value:${key}`);
      }
      // `undefined` is not part of the contract and is not the same as `null`:
      // JSON.stringify DROPS an undefined-valued key, so it would not fail loudly
      // — the field would just be missing from the audit row while the caller
      // believed it was recorded. An audit trail that silently omits what it was
      // asked to record is worse than one that refuses.
      if (value === undefined) {
        throw new Error(`suitecentral_audit_undefined_detail_value:${key}`);
      }
    }
  }
}
