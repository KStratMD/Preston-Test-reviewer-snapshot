/**
 * Outbound Governance Service — PR 2A
 *
 * Centralized DLP guard for outbound payloads. Scans data before it
 * reaches AI providers, connector writes, or audit-log persistence.
 *
 * Default mode is `'block'` (Option B): high-risk PII collapses to a
 * hard block. The `'queue'` mode (Option A) is reserved for PR 3B
 * which wires the approval-queue infrastructure.
 *
 * Dependencies: DLPService (PII scanning), GovernanceService (policy),
 * Logger.
 */

import { injectable, inject, unmanaged } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import { DLPService } from '../security/DLPService';
import type { PIIDetectionResult as DLPPIIDetectionResult, PIIFinding } from '../security/DLPService';
import type { GovernanceService } from '../ai/orchestrator/GovernanceService';
import { classifyFindingsRisk } from '../security/findingsRiskClassifier';

// ── Public interfaces ──────────────────────────────────────────────

/**
 * Contextual metadata attached to every outbound validation call.
 */
export interface OutboundContext {
  /** Tenant making the request — mandatory for multi-tenant isolation. */
  tenantId: string;
  /** User initiating the request; system-originated calls use SYSTEM_IDENTITY. */
  userId?: string;
  /** Where the payload is headed. */
  destination: 'ai_provider' | 'connector_write' | 'audit_log';
  /** Free-text destination detail, e.g. 'openai', 'netsuite.create'. */
  destinationDetail: string;
  /** Nature of the operation. */
  operationType: 'read' | 'write' | 'execute';
  /** Optional resource type, e.g. 'customer', 'invoice'. */
  resourceType?: string;
  /** Optional resource identifier. */
  resourceId?: string;
  /** Caller-supplied risk hint (overridden by scan results). */
  riskLevel?: 'low' | 'medium' | 'high';
}

/**
 * Decision returned after scanning an outbound payload.
 */
export interface OutboundDecision<T = unknown> {
  /** True when the payload may proceed (no block, no pending approval). */
  approved: boolean;
  /**
   * True when high-risk PII requires human approval before proceeding.
   * Under Option B (`approvalMode: 'block'`), this is ALWAYS false —
   * high-risk PII is hard-blocked instead.
   */
  approvalRequired: boolean;
  /**
   * Payload with PII redacted (or the original if nothing found).
   *
   * **Three states** consumers MUST account for (Copilot R4 finding —
   * presence alone does not imply the payload is sanitized):
   *
   *   1. `undefined` — paired with `auditMetadata.blocked === true`.
   *      Indicates a fail-closed block; no sanitized form is available.
   *      The exhaustive set of producers (Copilot R6):
   *        - Oversize guard (payload exceeds `config.maxPayloadBytes`).
   *        - DLP scanner threw an exception (try/catch fail-safe).
   *        - DLP returned `scanResult.scanFailed === true`.
   *        - Relevant findings exist and `posture.autoRedact === false`
   *          (per-tenant explicit disable of redaction → block).
   *        - Relevant findings exist and `dlpService.redactData(...)`
   *          returned `undefined` (redactor produced no safe copy
   *          → defense-in-depth block).
   *      Audit-log persistence MUST treat this as "no redacted form
   *      available" rather than persisting raw.
   *   2. Original raw payload, with `auditMetadata.redacted === false` —
   *      either no findings were detected, OR posture-driven bypass
   *      returned the payload as-is. The bypass cases are signaled via
   *      `auditMetadata.postureBypass`:
   *        - `'allow_pii'`: tenant has `posture.allowPII === true` on a
   *           non-`audit_log` destination AND findings were detected.
   *           Consumers reading `redactedPayload` MUST check `postureBypass`
   *           before assuming the payload is PII-free.
   *        - `'posture_pii_types_filtered_all'`: scanResult.findings is
   *           non-empty but `posture.piiTypes` filtered all to zero. The
   *           tenant-allowlist-narrowed set of types is enforced; types
   *           outside the allowlist pass through raw.
   *   3. Redacted payload, with `auditMetadata.redacted === true` —
   *      `dlpService.redactData(payload, relevantFindings)` ran and
   *      returned a non-undefined value. Safe to surface.
   *
   * The `redacted` and `postureBypass` fields together are the authoritative
   * signal of whether `redactedPayload` is sanitized; never infer from
   * `redactedPayload` shape alone.
   */
  redactedPayload?: T;
  /** PII types detected during the scan. */
  findings: string[];
  /** Overall risk classification after scanning. */
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  /** Audit-ready metadata about the scan. */
  auditMetadata: {
    scanDurationMs: number;
    findingsCount: number;
    detectedCount?: number;
    redacted: boolean;
    blocked: boolean;
    postureBypass?: 'allow_pii' | 'posture_pii_types_filtered_all';
  };
}

// ── Configuration ──────────────────────────────────────────────────

export type ApprovalMode = 'block' | 'queue';

export interface OutboundGovernanceConfig {
  /**
   * `'block'` (default, Option B): high-risk PII → hard block.
   * `'queue'` (Option A, requires PR 3B): high-risk PII → pending approval.
   */
  approvalMode: ApprovalMode;
  /** Maximum payload size in bytes before auto-block. Default 1 MB. */
  maxPayloadBytes: number;
  /** Enable strict mode — block on ANY PII, not just high-risk. */
  strictMode: boolean;
}

// PR 3B: default flipped from 'block' to 'queue'. The HITL approval queue
// (PR 3A schema + repo + service; PR 3B route catches + resume worker;
// PR 3C operator API + UI) is the wedge-grade posture — high-risk PII
// stops, waits for an approver, resumes. Tier-A 'block' is still available
// per-tenant via Tier-C config or the legacy GovernanceBlockedError path.
//
// Boot-time guard: `approvalModeStartupGuard` refuses to start the server
// when the new default is in effect AND `governance_approvals` is unreachable
// — preferable to silently dropping high-risk writes mid-request.
// Frozen so callers can't mutate the module-level default by reference.
// `getDefaultOutboundGovernanceConfig` also returns a defensive copy for
// callers that intend to overlay their own values — both layers together
// match the JSDoc contract (Copilot R2).
const DEFAULT_CONFIG: Readonly<OutboundGovernanceConfig> = Object.freeze({
  approvalMode: 'queue',
  maxPayloadBytes: 1_048_576, // 1 MB
  strictMode: false,
});

/**
 * Single source of truth for the default outbound-governance config.
 *
 * Exported so callers like the boot-time `approvalModeStartupGuard` can
 * reference the same default the service uses at runtime — duplicating
 * `{ approvalMode: 'queue' }` across modules would let the guard desync
 * from the service if the default ever changed again (Copilot R1).
 *
 * Returns a defensive copy so callers cannot mutate the frozen default.
 */
export function getDefaultOutboundGovernanceConfig(): OutboundGovernanceConfig {
  return { ...DEFAULT_CONFIG };
}

// ── Severity thresholds per PII type (moved to findingsRiskClassifier.ts) ──

// ── Service ────────────────────────────────────────────────────────

@injectable()
export class OutboundGovernanceService {
  private readonly config: OutboundGovernanceConfig;

  constructor(
    @inject(TYPES.DLPService) private readonly dlpService: DLPService,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.GovernanceService) private readonly governance: GovernanceService,
    @unmanaged() config?: Partial<OutboundGovernanceConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger.info('OutboundGovernanceService initialized', {
      approvalMode: this.config.approvalMode,
      maxPayloadBytes: this.config.maxPayloadBytes,
      strictMode: this.config.strictMode,
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Validate a payload before it is sent to an AI provider (OpenAI,
   * Claude, LMStudio, etc.). PII in `messages[].content` or similar
   * fields is redacted or blocked.
   */
  async validateAIProviderRequest<T>(
    payload: T,
    ctx: OutboundContext,
  ): Promise<OutboundDecision<T>> {
    return this.evaluate(payload, ctx);
  }

  /**
   * Validate a payload before it is written to an external connector
   * (NetSuite, Shopify, HubSpot, etc.).
   */
  async validateConnectorWrite<T>(
    payload: T,
    ctx: OutboundContext,
  ): Promise<OutboundDecision<T>> {
    return this.evaluate(payload, ctx);
  }

  /**
   * Validate a payload before it is persisted to the audit log.
   * Prevents the audit log from becoming a PII exfiltration vector.
   */
  async validateAuditLogPayload<T>(
    payload: T,
    ctx: OutboundContext,
  ): Promise<OutboundDecision<T>> {
    return this.evaluate(payload, ctx);
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Core evaluation pipeline shared by all three public methods.
   */
  private async evaluate<T>(
    payload: T,
    ctx: OutboundContext,
  ): Promise<OutboundDecision<T>> {
    const start = Date.now();

    // ── Oversized payload guard ────────────────────────────────────
    const payloadSize = this.estimatePayloadSize(payload);
    if (payloadSize > this.config.maxPayloadBytes) {
      this.logger.warn('OutboundGovernance: payload exceeds size limit', {
        tenantId: ctx.tenantId,
        destination: ctx.destination,
        payloadSize,
        limit: this.config.maxPayloadBytes,
      });
      return {
        approved: false,
        approvalRequired: false,
        findings: [],
        riskLevel: 'high',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          redacted: false,
          blocked: true,
        },
      };
    }

    // ── DLP scan FIRST (Copilot R1: defer posture lookup to the PII path so
    // PII-free outbound calls skip the per-tenant cache/DB roundtrip). Scan
    // runs with `autoRedact: false` so the decision layer below owns
    // per-finding narrowing via `dlpService.redactData(...)`.
    let scanResult: DLPPIIDetectionResult;
    try {
      scanResult = await this.dlpService.scanForPII(
        payload as Record<string, unknown>,
        {
          autoRedact: false,
          blockOnDetection: false,
          piiTypes: [],
          allowPII: false,
        },
      );
    } catch (error) {
      // Fail-safe: scanner failure → hard block + log
      this.logger.error('OutboundGovernance: DLP scanner failure (fail-safe block)',
        error instanceof Error ? error : new Error(String(error)),
        { tenantId: ctx.tenantId, destination: ctx.destination },
      );
      return {
        approved: false,
        approvalRequired: false,
        findings: [],
        riskLevel: 'high',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          redacted: false,
          blocked: true,
        },
      };
    }

    // ── Scan-failed-but-resolved fail-safe ──────────────────────────
    if (scanResult.scanFailed) {
      this.logger.error('OutboundGovernance: DLP scan failed silently (fail-safe block)',
        new Error('scanResult.scanFailed === true'),
        { tenantId: ctx.tenantId, destination: ctx.destination },
      );
      return {
        approved: false,
        approvalRequired: false,
        findings: [],
        riskLevel: 'high',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          redacted: false,
          blocked: true,
        },
      };
    }

    const detectedPiiTypes = [...new Set(scanResult.findings.map((f: PIIFinding) => f.type))];

    // ── No-PII fast-path (deferred posture lookup) ──────────────────
    // Skip the `getPostureForTenant` roundtrip on the common case where the
    // scanner found nothing — posture only affects decisions when findings
    // exist, and `allowPII` scan-and-flag mode has nothing distinct to log
    // when there's no PII to flag. Copilot R1.
    if (scanResult.findings.length === 0) {
      return {
        approved: true,
        approvalRequired: false,
        redactedPayload: payload,
        findings: [],
        riskLevel: 'none',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          detectedCount: 0,
          redacted: false,
          blocked: false,
        },
      };
    }

    const posture = await this.governance.getPostureForTenant(ctx.tenantId);

    // ── posture.allowPII scan-and-flag mode ──────────────────────────
    // Audit-log destination is the exception: even tenants that opt in to
    // raw PII for outbound AI/connector writes MUST NOT have raw PII written
    // to audit_log details (it would defeat the entire purpose of
    // validateAuditLogPayload — "Prevent audit log from becoming a PII
    // exfiltration vector"). So allowPII is honored on `ai_provider` and
    // `connector_write` destinations (raw passthrough + scan-and-flag for
    // visibility), but on `audit_log` we still redact via the normal
    // posture.autoRedact path below. Copilot R2.
    if (posture.allowPII && ctx.destination !== 'audit_log') {
      const observedRiskLevel = classifyFindingsRisk(scanResult.findings);
      this.logger.debug('OutboundGovernance: posture.allowPII scan-and-flag', {
        tenantId: ctx.tenantId,
        destination: ctx.destination,
        riskLevel: observedRiskLevel,
        findingsCount: scanResult.findings.length,
        piiTypes: detectedPiiTypes,
      });
      return {
        approved: true,
        approvalRequired: false,
        redactedPayload: payload,
        findings: detectedPiiTypes,
        riskLevel: observedRiskLevel,
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: scanResult.findings.length,
          detectedCount: scanResult.findings.length,
          redacted: false,
          blocked: false,
          postureBypass: 'allow_pii',
        },
      };
    }

    // ── piiTypes filtering ───────────────────────────────────────────
    // Audit-log destination is the exception (Codex pre-merge HIGH on PR
    // #835): the `posture.piiTypes` allowlist narrows enforcement for
    // outbound destinations, but on `audit_log` we ALWAYS enforce against
    // ALL detected findings. A tenant with `piiTypes=['email']` writing
    // phone-number-bearing payloads to the audit log would otherwise
    // bypass redaction (relevantFindings narrows to zero → "no PII
    // fast-path" → returns raw payload), turning audit_logs.details into
    // a PII exfiltration vector for everything not on the allowlist.
    const isAuditLog = ctx.destination === 'audit_log';
    const relevantFindings = (posture.piiTypes.length === 0 || isAuditLog)
      ? scanResult.findings
      : scanResult.findings.filter((f: PIIFinding) => posture.piiTypes.includes(f.type));

    // ── No PII fast-path (or filtered away) ──────────────────────────
    if (relevantFindings.length === 0) {
      return {
        approved: true,
        approvalRequired: false,
        redactedPayload: payload,
        findings: [],
        riskLevel: 'none',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          detectedCount: scanResult.findings.length,
          redacted: false,
          blocked: false,
          postureBypass: scanResult.findings.length > 0 ? 'posture_pii_types_filtered_all' : undefined,
        },
      };
    }

    // ── Risk classification on FILTERED findings ───────────────────
    const riskLevel = classifyFindingsRisk(relevantFindings);
    let approvalRequired = false;
    let blocked = false;
    let redactedPayload: T | undefined;

    // Redaction is required before any approved or queued path
    if (!posture.autoRedact) {
      blocked = true; // fail-safe: relevant findings found but autoRedact is false
    } else {
      const redacted = this.dlpService.redactData(payload, relevantFindings) as T | undefined;
      if (redacted === undefined) {
        blocked = true; // fail-safe if redactData returns undefined
      } else {
        redactedPayload = redacted;
      }
    }

    // Block precedence: strictMode OR posture.blockOnDetection
    if (this.config.strictMode || posture.blockOnDetection) {
      blocked = true;
    }

    // HIGH risk queue/block split
    if (!blocked && riskLevel === 'high') {
      if (this.config.approvalMode === 'queue') {
        approvalRequired = true;
      } else {
        blocked = true;
      }
    }

    const piiTypes = [...new Set(relevantFindings.map((f: PIIFinding) => f.type))];

    this.logger.debug('OutboundGovernance: scan complete', {
      tenantId: ctx.tenantId,
      destination: ctx.destination,
      destinationDetail: ctx.destinationDetail,
      riskLevel,
      findingsCount: relevantFindings.length,
      detectedCount: scanResult.findings.length,
      piiTypes,
      blocked,
      approvalRequired,
    });

    return {
      approved: !blocked && !approvalRequired,
      approvalRequired,
      redactedPayload,
      findings: piiTypes,
      riskLevel,
      auditMetadata: {
        scanDurationMs: Date.now() - start,
        findingsCount: relevantFindings.length,
        detectedCount: scanResult.findings.length,
        redacted: redactedPayload !== undefined && relevantFindings.length > 0,
        blocked,
      },
    };
  }

  /**
   * Cheap size estimate via JSON serialization.
   *
   * Stringify failures (most commonly circular references) MUST surface as
   * oversize — not 0 — because DLPService.scanObject() has no cycle
   * detection, so an under-reported size would let a circular payload
   * through to the scanner and recurse to stack-overflow. Returning
   * Number.MAX_SAFE_INTEGER routes the payload to the oversize-block path.
   */
  private estimatePayloadSize(payload: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}
