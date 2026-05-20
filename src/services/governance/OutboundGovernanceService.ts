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
   * **Absent on fail-safe blocks** — when the oversize guard, the DLP scan
   * exception path, or `scanFailed` short-circuits the evaluation, no
   * redacted form exists (the scan never ran or never completed) and this
   * field is `undefined`. Audit-log persistence MUST treat absence as
   * "no redacted form available" rather than persisting raw payload.
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
    redacted: boolean;
    blocked: boolean;
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

// ── Severity thresholds per PII type ───────────────────────────────

/**
 * PII types classified as high-risk regardless of destination.
 * High-risk findings trigger block/approval; lower-risk findings
 * are auto-redacted and allowed through.
 *
 * Includes credentials (api_key, jwt_token) — DLPService classifies
 * these as critical severity and outbound leakage of credentials is
 * a hard-block scenario.
 */
const HIGH_RISK_PII: ReadonlySet<string> = new Set([
  'ssn',
  'credit_card',
  'bank_account',
  'medical_record_number',
  'passport',
  'drivers_license',
  'api_key',
  'jwt_token',
]);

const MEDIUM_RISK_PII: ReadonlySet<string> = new Set([
  'phone',
  'phone_intl',
  'date_of_birth',
  'name',
]);

// ── Service ────────────────────────────────────────────────────────

@injectable()
export class OutboundGovernanceService {
  private readonly config: OutboundGovernanceConfig;

  constructor(
    @inject(TYPES.DLPService) private readonly dlpService: DLPService,
    @inject(TYPES.Logger) private readonly logger: Logger,
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

    // ── DLP scan ───────────────────────────────────────────────────
    let scanResult: DLPPIIDetectionResult;
    try {
      scanResult = await this.dlpService.scanForPII(
        payload as Record<string, unknown>,
        {
          autoRedact: true,
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
    // DLPService.scanForPII catches internal errors and returns
    // {detected:false, scanFailed:true}. Treat that as a fail-safe block,
    // NOT as no-PII — otherwise a scanner crash silently approves.
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

    // ── No PII fast-path ───────────────────────────────────────────
    if (!scanResult.detected || scanResult.findings.length === 0) {
      return {
        approved: true,
        approvalRequired: false,
        redactedPayload: payload,
        findings: [],
        riskLevel: 'none',
        auditMetadata: {
          scanDurationMs: Date.now() - start,
          findingsCount: 0,
          redacted: false,
          blocked: false,
        },
      };
    }

    // ── Risk classification ────────────────────────────────────────
    const riskLevel = this.classifyRisk(scanResult.findings);
    let approvalRequired = riskLevel === 'high';
    let blocked = false;

    // Strict mode: block on ANY PII and override queue mode
    if (this.config.strictMode && scanResult.findings.length > 0) {
      blocked = true;
      approvalRequired = false;
    }

    // High-risk → block or queue depending on approval mode (only when not already hard-blocked)
    if (!blocked && approvalRequired) {
      if (this.config.approvalMode === 'block') {
        // Option B (default): collapse approvalRequired → hard block
        blocked = true;
        approvalRequired = false;
      }
      // Option A ('queue'): approvalRequired stays true for the caller
      // to enqueue — but that path only works when PR 3B's queue is wired.
    }

    const redactedPayload = (scanResult.redactedData as T | undefined) ?? payload;
    const piiTypes = [...new Set(scanResult.findings.map((f: PIIFinding) => f.type))];

    // Log per-scan completion at debug to avoid doubling per-request log
    // volume on the inference hot path (DLPService.scanForPII already logs
    // its own per-scan summary). Block/approvalRequired decisions are
    // surfaced separately by the routes that consume the OutboundDecision.
    this.logger.debug('OutboundGovernance: scan complete', {
      tenantId: ctx.tenantId,
      destination: ctx.destination,
      destinationDetail: ctx.destinationDetail,
      riskLevel,
      findingsCount: scanResult.findings.length,
      piiTypes,
      blocked,
      approvalRequired,
    });

    return {
      approved: !blocked && !approvalRequired,
      approvalRequired,
      // Carry the redacted payload on this path (post-scan, including
      // strict/queue/block mode). PR 4A2's audit persistence uses it to
      // log WHAT was blocked without persisting raw PII. Fail-safe blocks
      // (oversize / scan exception / scanFailed) intentionally omit this
      // field — see OutboundDecision.redactedPayload jsdoc.
      redactedPayload: redactedPayload,
      findings: piiTypes,
      riskLevel,
      auditMetadata: {
        scanDurationMs: Date.now() - start,
        findingsCount: scanResult.findings.length,
        redacted: scanResult.redactedData != null,
        blocked,
      },
    };
  }

  /**
   * Classify overall risk based on the PII findings.
   *
   * - Any `HIGH_RISK_PII` type (SSN, CC, credentials, etc.) → 'high'
   * - Any `MEDIUM_RISK_PII` type (phone, DOB, name) → 'medium'
   * - Anything else (email, IP) → 'low'
   *
   * Destination-aware classification is not yet implemented — when added,
   * thread `OutboundContext` back through this signature.
   */
  private classifyRisk(findings: PIIFinding[]): 'none' | 'low' | 'medium' | 'high' {
    if (findings.length === 0) return 'none';

    let highest: 'low' | 'medium' = 'low';
    for (const finding of findings) {
      if (HIGH_RISK_PII.has(finding.type)) return 'high';
      if (MEDIUM_RISK_PII.has(finding.type)) {
        highest = 'medium';
      }
    }
    return highest;
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
