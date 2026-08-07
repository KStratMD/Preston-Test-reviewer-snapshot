/**
 * Governance Service - PII detection, content filtering, and compliance controls
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { Logger } from '../../../utils/Logger';
import type { AgentExecutionContext } from './interfaces';
import { DLPService, type DLPPIIType, type PIIFinding as DLPPIIFinding } from '../../security/DLPService';
import type { TenantConfigurationRepository } from '../../../database/repositories/TenantConfigurationRepository';
import { SYSTEM_IDENTITY } from '../../governance/identityContext';

/**
 * Narrow, single-purpose thunk type used to lazily resolve the async-bound
 * `TenantConfigurationRepository` from inside a sync-bound `GovernanceService`.
 * Inversify's stock `interfaces.Provider<T>` is intentionally permissive
 * (`(...args) => ((...args) => Promise<T>) | Promise<T>`) — it admits the
 * curried-factory form that some advanced bindings use. We deliberately
 * use a narrower shape here so call sites get the right `T` from a single
 * `await` without an extra cast.
 *
 * Bound in `src/inversify/inversify.config.ts` via `toProvider(context =>
 * () => context.container.getAsync<TenantConfigurationRepository>(...))`.
 */
export type TenantConfigurationProvider = () => Promise<TenantConfigurationRepository>;

// Re-export the canonical DLP PII type union so consumers importing
// PIIType.type from this module see the same list as DLPService.
// This is the cross-module coupling ultraplan nit A asked us to make
// explicit — commit 2 unifies the two services' pattern registries,
// and the type alias is the TypeScript-level expression of that.
export type { DLPPIIType };
export type GovernancePIIFinding = DLPPIIFinding;

export interface GovernanceResult {
  approved: boolean;
  reason?: string;
  flags: string[];
  riskLevel: 'low' | 'medium' | 'high';
  redactedData?: unknown;
  complianceChecks: ComplianceCheck[];
}

export interface ComplianceCheck {
  rule: string;
  status: 'passed' | 'failed' | 'warning';
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface PIIDetectionResult {
  hasPII: boolean;
  piiTypes: PIIType[];
  confidence: number;
  redactedText?: string;
  originalText: string;
  governanceFindings?: readonly GovernancePIIFinding[];
  /**
   * Value-based redaction carrier produced by DLPService's
   * `redactData()` path, which uses `String.prototype.replace()`
   * (not index-based slicing) and is therefore safe regardless of
   * whether `PIIType[]` carries real or placeholder offsets.
   *
   * Populated by both branches of `detectPII()`:
   *   - String-mode: holds the redacted string returned by
   *     `DLPService.scanText(text, {autoRedact:true}).redactedData`.
   *   - Object-mode: holds the deep-cloned redacted object returned
   *     by `DLPService.scanForPII(data, {autoRedact:true}).redactedData`.
   *
   * `redactPIIFromData()` short-circuits to this field when present,
   * bypassing the legacy index-based `redactDataRecursive()` path.
   * For object inputs this is the ONLY safe redaction route — the
   * legacy path would slice every string field using each finding's
   * placeholder `startIndex=0/endIndex=0`, prepending the replacement
   * to non-PII fields. Multi-field integrity is regression-tested in
   * `tests/integration/MCPAutoRedact.fixture.test.ts`.
   *
   * Added in commit 2's GovernanceService unification. Consumers
   * that want the redacted form of a structured input should read
   * this field; consumers that want a redacted text form of a
   * string input continue to read `redactedText`.
   */
  redactedData?: unknown;
}

export interface PIIType {
  /**
   * Widened in commit 2 from the old 8-value union to the 14-value
   * DLPPIIType union exported by DLPService. This preserves TypeScript
   * exhaustiveness checking across pattern additions while unifying the
   * two services on a single source-of-truth type.
   */
  type: DLPPIIType;
  value: string;
  confidence: number;
  /**
   * 0-based start offset of the PII match in the source text scope.
   *
   * - **String-mode** `detectPII(stringInput)`: REAL offset into the
   *   original string. Resolved by the adapter from
   *   `DLPFinding.location.column` (which `DLPService.scanString()`
   *   sets from `match.index` for every regex match), with a
   *   `text.indexOf(value)` fallback for the (effectively never-fires)
   *   case where `column` is undefined. Safe to consume for
   *   highlighting, anchoring, or slice-based redaction in string mode.
   *
   * - **Object-mode** `detectPII(objectInput)`: PLACEHOLDER `0`. Object
   *   inputs span multiple field values, so a single integer offset
   *   has no meaning across the whole structure. Consumers that need
   *   to locate PII in an object should use `finding.location.path`
   *   from `dlpResult.findings` directly, OR rely on the new
   *   `PIIDetectionResult.redactedData` field which already contains
   *   the value-based redacted form.
   *
   * IMPORTANT: object-mode redaction does NOT consume these placeholder
   * indices — `redactPIIFromData()` short-circuits to
   * `piiResult.redactedData` before ever reaching the index-based
   * `redactDataRecursive()` legacy path. The placeholders never get
   * silently slice-applied. See the JSDoc on `redactPIIFromData()`
   * for the full chain.
   */
  startIndex: number;
  /**
   * 0-based end offset of the PII match. Same mode rules as
   * `startIndex`:
   *   - String-mode: real `startIndex + value.length`
   *   - Object-mode: placeholder `0`
   */
  endIndex: number;
  replacement?: string;
}

export interface ContentFilter {
  name: string;
  enabled: boolean;
  patterns: RegExp[];
  allowlist?: string[];
  severity: 'low' | 'medium' | 'high';
  action: 'block' | 'warn' | 'redact';
}

export interface GovernanceRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scope: 'input' | 'output' | 'both';
  condition: (data: unknown, context: AgentExecutionContext) => boolean;
  action: 'allow' | 'block' | 'redact' | 'warn';
  message: string;
  severity: 'low' | 'medium' | 'high';
}

export interface GovernanceConfig {
  enablePIIDetection: boolean;
  enableContentFiltering: boolean;
  enableComplianceChecks: boolean;
  autoRedactPII: boolean;
  strictMode: boolean;
  retentionDays: number;
  auditLevel: 'minimal' | 'standard' | 'comprehensive';
}

/**
 * Per-tenant governance posture (PR-C3). Resolved by
 * `getPostureForTenant(tenantId)` from the 4 `governance.*` keys in
 * `tenant_configurations` and consumed at the DECISION layer in
 * `validateInput()` / `validateOutput()`. `detectPII()` intentionally
 * preserves the pre-C3 hardcoded scan-policy literal (the commit-2
 * invariant requires `autoRedact:true` unconditionally so the value-based
 * `redactedData` path is always populated) — per-tenant overrides flow
 * through the validateInput/validateOutput precedence matrix, not through
 * the DLPService policy object.
 *
 * Resolution rules (see `getPostureForTenant`):
 *   - `allowPII`         — `governance.allow_pii`         via `getBooleanStrict` (fail-closed; default `false`)
 *   - `blockOnDetection` — `governance.block_on_detection` via `getBooleanStrict` (fail-closed; default `false`)
 *   - `autoRedact`       — `governance.auto_redact`       via `getString`        (tri-state; default `true`)
 *   - `piiTypes`         — `governance.pii_types_csv`     via `getString`        (CSV; default `[]`)
 *
 * Storage requirement: the two `getBooleanStrict` keys (`allow_pii`,
 * `block_on_detection`) MUST be persisted with `is_encrypted=false` — those
 * reads throw on encrypted rows by design (an encrypted feature-gate would
 * collapse SecretManager outages into a silent policy denial). The two
 * `getString` keys (`auto_redact`, `pii_types_csv`) tolerate encrypted rows
 * and will decrypt transparently, but there is no security benefit to
 * encrypting them (the tri-state autoRedact flag and a CSV of PII type
 * names are not secret-bearing); recommend storing them plaintext for
 * operator clarity, but the read path won't break if they're not.
 */
export interface TenantGovernancePosture {
  allowPII: boolean;
  blockOnDetection: boolean;
  autoRedact: boolean;
  /**
   * Allowlist of PII types to enforce posture decisions against.
   *
   * Semantics (Codex MEDIUM finding on C3.1 review):
   *   - Empty array `[]` (default): enforce posture on ALL detected PII types
   *     — the historical behavior, preserved for tenants that don't set
   *     `governance.pii_types_csv`.
   *   - Non-empty array: enforce posture ONLY on the listed types. Findings
   *     of other types are observed by the scan but do NOT trigger
   *     redaction/block/approval. This is an ALLOWLIST of types to enforce,
   *     NOT a blocklist of types to skip.
   *
   * Example: a tenant with `piiTypes = ['email']` whose payload contains
   * both an email and a phone number gets the email handled by posture
   * (redact/block per the other flags) while the phone is passed through
   * unmodified. Operators can monitor by comparing `detectedCount` (raw
   * findings) vs `enforcedCount` (post-filter findings) in the audit log.
   *
   * `readonly` rather than `string[]` so callers can't compile-time `.push()`
   * into `DEFAULT_POSTURE.piiTypes` (the runtime would throw because the
   * default is `Object.freeze(...)`, but the type should also forbid it).
   * Consumers that need a mutable copy (e.g. to spread into a DLPService
   * policy that types `piiTypes: string[]`) should do so explicitly:
   * `[...posture.piiTypes]`. Copilot R0.
   */
  piiTypes: readonly string[];
}

/**
 * Fail-open-to-safe-defaults posture. Returned by `getPostureForTenant` when:
 *   - the caller is `SYSTEM_IDENTITY` (background jobs, no per-tenant policy),
 *   - `tenantId` is omitted (legacy call sites that haven't been threaded through),
 *   - any DB / repository error fires while reading the 4 keys.
 *
 * Values are intentionally identical to the pre-C3 hardcoded literal that
 * lived inline in `detectPII()` so the fallback is regression-equivalent —
 * tenants that don't write any `governance.*` rows see the same behavior they
 * saw before C3 landed.
 */
export const DEFAULT_POSTURE: Readonly<TenantGovernancePosture> = Object.freeze({
  allowPII: false,
  blockOnDetection: false,
  autoRedact: true,
  piiTypes: Object.freeze([]) as readonly string[],
});

/** Posture cache TTL — small enough that an operator flipping a tenant's
 *  config sees the change within a minute, large enough that high-throughput
 *  PII detection paths don't hammer `tenant_configurations` 4 reads per call.
 *  Exported for test ergonomics (jest fake timers advance by this constant). */
export const GOVERNANCE_POSTURE_CACHE_TTL_MS = 60_000;

/** Bounded cache size — FIFO-evict the oldest entry once we reach this
 *  number of distinct tenants. Without a hard upper bound, a long-lived
 *  process that touches many distinct tenants once (and never revisits them
 *  after TTL) would let `postureCache` grow without limit — the eager-delete
 *  on cache-miss only fires when the SAME tenantId is looked up again.
 *  Matches the FIFO-eviction pattern at `WorkflowPayloadCache.set`. Copilot
 *  R8 caught the gap left by R0's eager-delete fix. */
export const GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES = 10_000;

interface PostureCacheEntry {
  posture: TenantGovernancePosture;
  expiresAt: number;
}

/**
 * Tri-state parse for `governance.auto_redact`:
 *   - `null` (row missing)  → `DEFAULT_POSTURE.autoRedact` (true)
 *   - exact string `'true'`  → `true`
 *   - exact string `'false'` → `false`
 *   - anything else (typo, trailing whitespace via direct DB edit) →
 *     `DEFAULT_POSTURE.autoRedact` (true) — the safe default rather than
 *     silently treating an unparseable value as the opposite-of-default.
 */
function parseAutoRedact(raw: string | null): boolean {
  if (raw === null) return DEFAULT_POSTURE.autoRedact;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return DEFAULT_POSTURE.autoRedact;
}

/**
 * Parse `governance.pii_types_csv` into a normalized string list:
 *   - `null` / empty / whitespace-only → `[]`
 *   - splits on `,`, trims each token, **lowercases each token**, drops empty tokens.
 *
 * PR-C3.1a R1 (Copilot R0) — case-insensitive match invariant. DLPService
 * emits findings with lowercase `.type` values (the canonical pattern names:
 * 'ssn', 'email', 'phone', etc.), but tenants can write the CSV with mixed
 * case ("SSN, Email") — historically that would silently miss matches and
 * leak PII. Lowercase at parse-time so every consumer (the C3.1a sites
 * + future C3.1b/c migrations + the validateInput/validateOutput filters
 * deferred to C3.1c) can do exact-equality membership checks.
 *
 * NOTE: `posture.piiTypes` is plumbed but NOT YET consulted as a findings
 * filter in PR-C3 first cut. The downstream filter (applied to
 * `piiResult.piiTypes` in `validateInput()` / `validateOutput()` so a
 * tenant-configured list narrows which findings count for redaction or
 * rejection) is deferred to PR-C3.1 alongside the migration of the 8
 * other DLP callsites enumerated in the C3 scoping report. No validation
 * against the DLP registry's known PII types happens here — unknown
 * entries are tolerated (forward-compat: a tenant can pre-stage a value
 * for a PII type the deployment hasn't shipped yet without throwing).
 */
function parsePiiTypesCsv(raw: string | null): string[] {
  if (raw === null) return [];
  // PR-C3.1a R1 — lowercase at parse-time so downstream membership checks
  // are case-insensitive against DLP's lowercase finding types.
  const tokens = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return tokens;
}

@injectable()
export class GovernanceService {
  private config: GovernanceConfig;
  private contentFilters = new Map<string, ContentFilter>();
  private governanceRules = new Map<string, GovernanceRule>();
  /**
   * Per-tenant posture cache keyed on `tenantId`. Read on every
   * `getPostureForTenant()` call; populated only when a posture is
   * successfully resolved from the repository (fallbacks to `DEFAULT_POSTURE`
   * do NOT write, so an outage doesn't pin the bad result for 60 seconds).
   *
   * Cached entries are deeply frozen — `posture` itself plus `posture.piiTypes`
   * — so a caller that accidentally tries `cached.piiTypes.push(...)` throws
   * at the call site rather than silently corrupting the shared cache for
   * subsequent requests (Copilot R2).
   *
   * Two complementary growth controls keep the Map bounded:
   *   1. Eager-delete of an expired entry on cache-miss for the SAME tenant
   *      (Copilot R0). Handles tenants that are revisited after TTL.
   *   2. FIFO eviction at `GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES` distinct
   *      tenants (Copilot R8). Handles tenants that are looked up once and
   *      never revisited — without this, (1) alone wouldn't reclaim those
   *      entries and the Map would grow without bound.
   */
  private postureCache = new Map<string, PostureCacheEntry>();
  /**
   * Concurrent-request dedup for posture resolution. Without this, N
   * simultaneous detectPII calls for the same tenant on a cache miss would
   * each fire 4 `tenant_configurations` reads — burning DB capacity to
   * resolve the same posture N times. We cache the in-flight Promise per
   * tenant; concurrent callers await the same resolution and the entry is
   * cleared on completion (success OR failure) so subsequent cache misses
   * can retry. Copilot R2.
   */
  private inFlightPostureResolution = new Map<string, Promise<TenantGovernancePosture>>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.DLPService) private dlpService: DLPService,
    @inject(TYPES.TenantConfigurationRepositoryProvider)
      private tenantConfigProvider: TenantConfigurationProvider
  ) {
    this.config = {
      enablePIIDetection: true,
      enableContentFiltering: true,
      enableComplianceChecks: true,
      autoRedactPII: true,
      strictMode: false,
      retentionDays: 90,
      auditLevel: 'standard'
    };

    // Pattern registry removed in commit 2 — PII detection now
    // delegates to DLPService via detectPII()'s shape-routing adapter.
    this.initializeFilters();
    this.initializeRules();
  }

  /**
   * Validate input data before agent processing
   */
  async validateInput(data: unknown, context: AgentExecutionContext): Promise<GovernanceResult> {
    try {
      const result: GovernanceResult = {
        approved: true,
        flags: [],
        riskLevel: 'low',
        complianceChecks: []
      };

      // PII Detection
      if (this.config.enablePIIDetection) {
        const piiResult = await this.detectPII(data);
        if (piiResult.hasPII) {
          const posture = await this.getPostureForTenant(context.tenantId);
          const decision = this.applyPosturePIIDecision(data, piiResult, posture, 'input');
          for (const flag of decision.flags) result.flags.push(flag);
          if (decision.riskLevel) result.riskLevel = decision.riskLevel;
          if (decision.redactedData !== undefined) result.redactedData = decision.redactedData;
          if (decision.reason !== undefined) {
            result.approved = false;
            result.reason = decision.reason;
          }
        }
      }

      // Content Filtering
      if (this.config.enableContentFiltering) {
        const filterResult = await this.applyContentFilters(data, 'input');
        result.flags.push(...filterResult.flags);

        if (filterResult.blocked) {
          result.approved = false;
          result.reason = filterResult.reason;
          result.riskLevel = 'high';
        } else if (filterResult.warnings.length > 0) {
          result.riskLevel = this.escalateRiskLevel(result.riskLevel, 'medium');
        }
      }

      // Governance Rules
      const rulesResult = await this.applyGovernanceRules(data, context, 'input');
      result.complianceChecks.push(...rulesResult.checks);
      result.flags.push(...rulesResult.flags);

      if (rulesResult.blocked) {
        result.approved = false;
        result.reason = rulesResult.reason;
        result.riskLevel = 'high';
      }

      // Business Logic Validation
      const businessResult = await this.validateBusinessLogic(data, context);
      result.complianceChecks.push(...businessResult.checks);
      result.flags.push(...businessResult.flags);

      this.logger.info('Input validation completed', {
        sessionId: context.sessionId,
        approved: result.approved,
        flags: result.flags,
        riskLevel: result.riskLevel,
        complianceChecks: result.complianceChecks.length
      });

      return result;

    } catch (error) {
      this.logger.error('Input validation failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return {
        approved: false,
        reason: `Validation error: ${error}`,
        flags: ['validation_error'],
        riskLevel: 'high',
        complianceChecks: []
      };
    }
  }

  /**
   * Validate output data after agent processing
   */
  async validateOutput(data: unknown, context: AgentExecutionContext): Promise<GovernanceResult> {
    try {
      const result: GovernanceResult = {
        approved: true,
        flags: [],
        riskLevel: 'low',
        complianceChecks: []
      };

      // PII Detection in output
      if (this.config.enablePIIDetection) {
        const piiResult = await this.detectPII(data);
        if (piiResult.hasPII) {
          const posture = await this.getPostureForTenant(context.tenantId);
          const decision = this.applyPosturePIIDecision(data, piiResult, posture, 'output');
          for (const flag of decision.flags) result.flags.push(flag);
          if (decision.riskLevel) result.riskLevel = decision.riskLevel;
          if (decision.redactedData !== undefined) result.redactedData = decision.redactedData;
          if (decision.reason !== undefined) {
            result.approved = false;
            result.reason = decision.reason;
          }
        }
      }

      // Content Filtering for output
      if (this.config.enableContentFiltering) {
        const filterResult = await this.applyContentFilters(data, 'output');
        result.flags.push(...filterResult.flags);

        if (filterResult.blocked) {
          result.approved = false;
          result.reason = `Output filtering: ${filterResult.reason}`;
          result.riskLevel = 'high';
        }
      }

      // Output-specific governance rules
      const rulesResult = await this.applyGovernanceRules(data, context, 'output');
      result.complianceChecks.push(...rulesResult.checks);
      result.flags.push(...rulesResult.flags);

      // Quality checks for AI output
      const qualityResult = await this.validateOutputQuality(data, context);
      result.complianceChecks.push(...qualityResult.checks);
      result.flags.push(...qualityResult.flags);

      this.logger.info('Output validation completed', {
        sessionId: context.sessionId,
        approved: result.approved,
        flags: result.flags,
        riskLevel: result.riskLevel
      });

      return result;

    } catch (error) {
      this.logger.error('Output validation failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return {
        approved: false,
        reason: `Output validation error: ${error}`,
        flags: ['output_validation_error'],
        riskLevel: 'high',
        complianceChecks: []
      };
    }
  }

  /**
   * Detect PII in data.
   *
   * Shape-routing adapter (commit 2): structured inputs go through
   * DLPService.scanForPII() which preserves dotted-path field names so
   * field-gated patterns can fire; raw string inputs go through
   * DLPService.scanText() which skips gated patterns (no field context).
   * Both branches pass { autoRedact: true } so DLPService produces
   * value-based redactedData via its redactData() path (DLPService.ts:697,
   * which uses String.prototype.replace, not index-based slicing). The
   * adapter then reads dlpResult.redactedData uniformly for both input
   * shapes — zero index math in the adapter layer.
   *
   * INVARIANT (ultraplan review finding 5): autoRedact is passed
   * unconditionally here, NOT gated on this.config.autoRedactPII.
   * This matches pre-commit-2 behavior where the old detectPII()
   * always populated redactedText whenever hasPII was true — the
   * config.autoRedactPII flag gates whether validateInput() USES
   * redactedData (line 117), not whether detectPII() produces it.
   * Callers who don't want redaction simply ignore the redactedData
   * field.
   */
  async detectPII(data: unknown): Promise<PIIDetectionResult> {
    // Pre-C3 hardcoded literal preserved verbatim. `autoRedact: true` is the
    // commit-2 invariant — DLPService.scanForPII() / scanText() use it to
    // populate `redactedData` via the value-based path, which keeps
    // object-mode redaction safe (placeholder startIndex/endIndex on
    // adapter-built `PIIType[]` would corrupt object inputs if we relied on
    // index-based slicing). Per-tenant posture overrides do NOT flow into
    // this policy object — DLPService's scan paths ignore allowPII/
    // blockOnDetection/piiTypes (only enforceDataLossPrevention() consults
    // them), and forwarding `autoRedact: false` would silently break
    // object-mode safety. Per-tenant policy is consumed in validateInput()
    // / validateOutput() at the DECISION layer (where to USE the redacted
    // form, when to REJECT) rather than at the SCAN layer here. See the C3
    // posture matrix at the decision points in validateInput/validateOutput.
    const policy = {
      allowPII: false,
      piiTypes: [] as string[],
      autoRedact: true,
      blockOnDetection: false,
    };
    // Route structured inputs (objects/arrays) to scanForPII so dotted
    // field paths are preserved for field-gated patterns. Route
    // EVERYTHING ELSE (strings, numbers, booleans, null, undefined) to
    // scanText via String() coercion — this matches the pre-commit-2
    // behavior where extractTextFromData() called String(data) for
    // non-object inputs. Without this coercion, a bare numeric like
    // 123456789 would fall into scanForPII → scanObject which silently
    // ignores scalar primitives, dropping PII detection entirely
    // (Codex PR review 2026-04-10, P1).
    const isStructured = data !== null && data !== undefined &&
      (typeof data === 'object' || Array.isArray(data));
    const dlpResult = isStructured
      ? await this.dlpService.scanForPII(data, policy)
      : await this.dlpService.scanText(String(data), policy);
    return this.adaptDLPResultToGovernanceShape(data, dlpResult);
  }

  /**
   * Apply posture-aware PII decision logic for either input or output paths.
   * Centralizes the per-tenant posture decision matrix (allowPII / autoRedact
   * / blockOnDetection / piiTypes filter) and the legacy fallback when
   * `piiResult.governanceFindings` is undefined (hand-built result, e.g.
   * test mocks of `detectPII`). Returns a partial decision the caller merges
   * into its `GovernanceResult` without early-returning so downstream content/
   * governance/business checks still run.
   *
   * Asymmetry between sides matches CLAUDE.md C3 invariant:
   *   - input:  allowPII → autoRedact → block (redact precedes block)
   *   - output: allowPII → block → autoRedact (block precedes redact)
   */
  private applyPosturePIIDecision(
    data: unknown,
    piiResult: PIIDetectionResult,
    posture: TenantGovernancePosture,
    side: 'input' | 'output',
  ): {
    flags: readonly string[];
    riskLevel?: 'low' | 'medium' | 'high';
    redactedData?: unknown;
    reason?: string;
  } {
    const flagDetected = side === 'input' ? 'pii_detected' : 'output_pii_detected';
    const flagFiltered = side === 'input'
      ? 'pii_detected_but_filtered_by_posture'
      : 'output_pii_detected_but_filtered_by_posture';
    const flagAllowed = side === 'input' ? 'pii_allowed_by_tenant' : 'output_pii_allowed_by_tenant';
    const flagAutoRedacted = side === 'input' ? 'pii_auto_redacted' : 'output_pii_auto_redacted';
    const blockReason = side === 'input' ? 'PII detected in input data' : 'PII found in agent output';

    const rawFindings = piiResult.governanceFindings;
    const useRawFindings = rawFindings !== undefined;
    const sourceTypes: readonly { type: string }[] = useRawFindings ? rawFindings : piiResult.piiTypes;
    const relevantTypes = posture.piiTypes.length === 0
      ? sourceTypes
      : sourceTypes.filter(f => posture.piiTypes.includes(f.type));
    const hasOriginalFindings = sourceTypes.length > 0;
    const hasRelevantFindings = relevantTypes.length > 0;

    if (hasOriginalFindings && !hasRelevantFindings) {
      return { flags: [flagFiltered] };
    }
    if (!hasRelevantFindings) {
      return { flags: [] };
    }

    const flags: string[] = [flagDetected];
    const riskLevel: 'high' = 'high';

    if (posture.allowPII) {
      flags.push(flagAllowed);
      return { flags, riskLevel };
    }

    if (side === 'output' && (posture.blockOnDetection || this.config.strictMode)) {
      return { flags, riskLevel, reason: blockReason };
    }

    if (posture.autoRedact && this.config.autoRedactPII) {
      // Pick the redaction source. `dlpService.redactData(data, findings)`
      // assumes `data` is a string or object/array and returns primitives
      // (number, boolean, etc.) unchanged — that would silently surface the
      // raw value while flagging it as redacted. For non-structured
      // primitives, fall back to the adapter-produced `redactedData` /
      // `redactedText` (which came from the string-coerced detectPII scan)
      // so the redacted-flag-and-value pair stays consistent. Copilot R2.
      const isStructured = typeof data === 'string'
        || (typeof data === 'object' && data !== null);
      const canCallRedactData = useRawFindings && isStructured;
      const redactedData = canCallRedactData
        ? this.dlpService.redactData(data, [...(relevantTypes as readonly GovernancePIIFinding[])])
        : (piiResult.redactedData ?? piiResult.redactedText);
      if (redactedData !== undefined) {
        flags.push(flagAutoRedacted);
        return { flags, riskLevel, redactedData };
      }
      // Adapter-produced redacted data missing on legacy/primitive path → fail-closed.
      return { flags, riskLevel, reason: blockReason };
    }

    if (side === 'input' && (posture.blockOnDetection || this.config.strictMode)) {
      return { flags, riskLevel, reason: blockReason };
    }

    return { flags, riskLevel };
  }

  /**
   * Resolve the per-tenant governance posture (PR-C3). Reads the four
   * `governance.*` keys from `tenant_configurations` and caches the result
   * in-memory for `GOVERNANCE_POSTURE_CACHE_TTL_MS` (60s).
   *
   * Fail-open-to-safe-defaults: returns `DEFAULT_POSTURE` (regression-
   * equivalent with the pre-C3 hardcoded literal) when:
   *   - `tenantId` is `undefined` / empty (legacy caller, no per-tenant context),
   *   - `tenantId === SYSTEM_IDENTITY.tenantId` (background sweeps),
   *   - any error fires while reading the 4 keys
   *     (DB outage, encrypted-row plaintext violation on the strict reads, etc.).
   *
   * Failures do NOT write to the cache — an outage doesn't pin the bad
   * result for 60 seconds. The next call retries.
   */
  async getPostureForTenant(tenantId?: string): Promise<TenantGovernancePosture> {
    if (!tenantId || tenantId === SYSTEM_IDENTITY.tenantId) {
      return DEFAULT_POSTURE;
    }

    const now = Date.now();
    const cached = this.postureCache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return cached.posture;
    }
    // Cache miss path. Eagerly delete the expired entry (if any) before
    // we re-read so a REVISITED tenant doesn't carry forward a stale
    // entry (the subsequent `set` would overwrite, but the explicit
    // delete makes the lifecycle obvious and lets the FIFO bookkeeping
    // below treat the upcoming insert as a fresh growth event when
    // appropriate). One-shot tenants that are never revisited are
    // handled by the FIFO eviction at `GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES`
    // — see the class field JSDoc for the two complementary growth
    // controls. Copilot R0 + R9.
    if (cached) {
      this.postureCache.delete(tenantId);
    }

    // Concurrent-request dedup: if another resolution is in-flight for this
    // tenant, await the same Promise rather than firing 4 more DB reads.
    // Copilot R2.
    const existing = this.inFlightPostureResolution.get(tenantId);
    if (existing) {
      return existing;
    }

    const resolution = this.resolvePostureFromRepository(tenantId);
    this.inFlightPostureResolution.set(tenantId, resolution);
    try {
      return await resolution;
    } finally {
      // Always clear the in-flight slot — success populates the cache for
      // subsequent calls; failure leaves the cache empty so the next call
      // retries (no cache poisoning).
      this.inFlightPostureResolution.delete(tenantId);
    }
  }

  /**
   * Single-tenant repository read + posture shaping. Extracted from
   * `getPostureForTenant` so concurrent callers can share one in-flight
   * Promise via `inFlightPostureResolution`. Always resolves — internal
   * errors fall back to `DEFAULT_POSTURE` and log a warning. Never throws.
   */
  private async resolvePostureFromRepository(
    tenantId: string,
  ): Promise<TenantGovernancePosture> {
    try {
      const tcr = await this.tenantConfigProvider();
      // Read all four keys concurrently. `getBooleanStrict` throws on
      // encrypted rows (the governance.* keys are required to be plaintext
      // — see TenantGovernancePosture's JSDoc); we let that throw escape to
      // the outer catch so the whole posture falls back to DEFAULT rather
      // than mixing a partial result (e.g., trusting allow_pii=true while
      // block_on_detection couldn't be read).
      const [allowPII, blockOnDetection, autoRedactRaw, piiTypesCsv] =
        await Promise.all([
          tcr.getBooleanStrict(tenantId, 'governance.allow_pii'),
          tcr.getBooleanStrict(tenantId, 'governance.block_on_detection'),
          tcr.getString(tenantId, 'governance.auto_redact'),
          tcr.getString(tenantId, 'governance.pii_types_csv'),
        ]);

      // Deep-freeze the cached entry — both `posture` itself and
      // `posture.piiTypes` — so a caller that accidentally tries
      // `cached.piiTypes.push(...)` throws at the call site instead of
      // silently corrupting the shared cache for subsequent requests.
      // Copilot R2.
      const posture: TenantGovernancePosture = Object.freeze({
        allowPII,
        blockOnDetection,
        autoRedact: parseAutoRedact(autoRedactRaw),
        piiTypes: Object.freeze(parsePiiTypesCsv(piiTypesCsv)) as readonly string[],
      });

      // FIFO eviction when inserting a NEW tenant would breach the bound.
      // Re-setting an existing key is a refresh, not a growth event (the
      // `set` updates the value in place; JS Map preserves insertion order
      // and does NOT reorder the key to the tail), so it doesn't trigger
      // eviction — only true growth past the bound does. Note we don't
      // actually hit the "existing key" branch in this method anyway: the
      // cache-miss path above already deleted any prior entry for this
      // `tenantId` via the eager-delete, so by the time we reach this
      // `set` the key is guaranteed not to be present. The `!has` guard
      // is kept as documentation of the FIFO invariant and as a safety
      // net for any future refactor that adds a different write path.
      // Matches WorkflowPayloadCache.set's pattern. Copilot R8 + R9.
      if (
        !this.postureCache.has(tenantId)
        && this.postureCache.size >= GOVERNANCE_POSTURE_CACHE_MAX_ENTRIES
      ) {
        const oldestKey = this.postureCache.keys().next().value;
        if (oldestKey !== undefined) this.postureCache.delete(oldestKey);
      }
      this.postureCache.set(tenantId, {
        posture,
        expiresAt: Date.now() + GOVERNANCE_POSTURE_CACHE_TTL_MS,
      });
      return posture;
    } catch (err) {
      this.logger.warn(
        'Failed to resolve tenant governance posture; falling back to DEFAULT_POSTURE',
        {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return DEFAULT_POSTURE;
    }
  }

  /**
   * Adapt DLPService's PIIDetectionResult shape to the Governance
   * PIIDetectionResult shape. Reads exactly three fields from the DLP
   * result — `findings`, `piiTypes`, `redactedData` — which both
   * scanForPII() and scanText() provide (after commit 2's scanText
   * extension).
   *
   * INDEX HANDLING (Codex review 2026-04-09 finding 1 — addressed):
   *   - **String mode** (`originalData: string`): real 0-based offsets
   *     from `finding.location.column`, with `text.indexOf(finding.value)`
   *     as a defensive fallback for the (effectively never-fires) case
   *     where `column` is undefined. This preserves the pre-commit-2
   *     contract that any consumer using offsets to highlight or locate
   *     PII in a raw string still gets accurate positions.
   *   - **Object mode** (object/array input): 0/0 placeholders. Object
   *     inputs have no single global text scope, so a single integer
   *     offset is meaningless — there's only the per-field path
   *     (`finding.location.path`) and the per-field column within that
   *     field's string value. Consumers that want to locate PII in an
   *     object input must use `finding.location.path` + value matching,
   *     not the Governance `PIIType.startIndex/endIndex` fields.
   *
   * Object-mode redaction does NOT consume the placeholder indices —
   * `redactPIIFromData()` short-circuits to `piiResult.redactedData`
   * (populated by DLPService's value-based redactData() path) before
   * ever reaching the index-based `redactDataRecursive()` legacy path.
   *
   * CONFIDENCE AGGREGATION: preserves the exact formula from the
   * pre-commit-2 implementation at GovernanceService.ts:290-292 —
   * average across findings (finding-weighted, not type-weighted).
   * Per-finding confidence VALUES differ from pre-commit-2 because
   * the DLP registry uses flat confidences (e.g. email: 0.85) vs
   * the old content-sensitive heuristic (0.9 if '.' and '@', else
   * 0.6). This value drift was verified as safe during plan review
   * via grep for `piiResult.confidence` / `.confidence > 0.` in
   * src/ — zero downstream consumers threshold on the field.
   */
  private adaptDLPResultToGovernanceShape(
    originalData: unknown,
    dlpResult: {
      findings: DLPPIIFinding[];
      piiTypes: string[];
      redactedData?: unknown;
    }
  ): PIIDetectionResult {
    // String-mode offset resolution: prefer DLPFinding.location.column
    // (set from match.index by scanString), fall back to value search
    // if column is undefined for any reason. Object-mode keeps 0/0
    // placeholders because a single integer offset has no meaning
    // across multiple fields.
    const isStringMode = typeof originalData === 'string';
    const sourceText = isStringMode ? (originalData as string) : '';
    const resolveStartIndex = (finding: DLPPIIFinding): number => {
      if (!isStringMode) return 0;
      if (typeof finding.location.column === 'number') {
        return finding.location.column;
      }
      const fallback = sourceText.indexOf(finding.value);
      return fallback >= 0 ? fallback : 0;
    };

    const piiTypes: PIIType[] = dlpResult.findings.map(finding => {
      const startIndex = resolveStartIndex(finding);
      return {
        type: finding.type as DLPPIIType,
        value: finding.value,
        confidence: finding.confidence,
        startIndex,
        endIndex: isStringMode ? startIndex + finding.value.length : 0,
        replacement: finding.redactedValue,
      };
    });

    const confidence = dlpResult.findings.length > 0
      ? dlpResult.findings.reduce((sum, f) => sum + f.confidence, 0) / dlpResult.findings.length
      : 0;

    // originalText: reuse extractTextFromData() (kept alive for
    // applyContentFilters()) to preserve the pre-commit-2
    // JSON.stringify semantics for object inputs. This is a
    // presentation/audit field, not a detection input — scanning
    // already happened via scanForPII()/scanText() above.
    const originalText = this.extractTextFromData(originalData);

    // redactedText: for string inputs, scanText() returned a
    // redactedData: string, which IS a valid redactedText. For
    // object inputs, there's no single canonical text form of a
    // redacted object — consumers use redactedData (unknown) instead.
    const redactedText = typeof originalData === 'string'
      ? (dlpResult.redactedData as string | undefined)
      : undefined;

    return {
      hasPII: piiTypes.length > 0,
      piiTypes,
      confidence,
      originalText,
      redactedText,
      redactedData: dlpResult.redactedData,
      governanceFindings: dlpResult.findings,
    };
  }

  /**
   * Redact PII from data structure.
   *
   * Commit 2: short-circuits to `piiResult.redactedData` when the
   * DLPService adapter has populated it (which is always, for calls
   * that flow through this.detectPII()). The legacy
   * redactDataRecursive() path is preserved only as a fallback for
   * hand-constructed PIIDetectionResult objects (e.g. test fixtures,
   * third-party callers) whose startIndex/endIndex are real offsets
   * into a single text scope.
   *
   * WHY: redactDataRecursive() walks every string field and calls
   * redactPIIFromText(), which is purely index-based:
   * `text.slice(0, pii.startIndex) + replacement + text.slice(pii.endIndex)`.
   * The commit-2 adapter writes placeholder startIndex=0/endIndex=0
   * for object-mode findings, which would cause that slicing to
   * prepend the replacement to every string field in the entire
   * object — catastrophically wrong. The short-circuit to
   * piiResult.redactedData (populated via DLPService's value-based
   * redactData() path) avoids that entire class of bug.
   */
  redactPIIFromData(data: unknown, piiResult: PIIDetectionResult): unknown {
    if (!piiResult.hasPII) {
      return data;
    }

    // Preferred path: use the value-based redactedData produced by
    // DLPService.scanForPII()/scanText() with {autoRedact:true} and
    // threaded through the adapter. The adapter's placeholder
    // startIndex/endIndex are NEVER consumed on this path.
    if (piiResult.redactedData !== undefined) {
      return piiResult.redactedData;
    }

    // Legacy path: hand-constructed PIIDetectionResult with real
    // indices into a single text scope. Indices in
    // piiResult.piiTypes must be real offsets or this WILL corrupt
    // the output.
    const redactedData = JSON.parse(JSON.stringify(data));
    this.redactDataRecursive(redactedData, piiResult.piiTypes);
    return redactedData;
  }

  /**
   * Add custom governance rule
   */
  addGovernanceRule(rule: GovernanceRule): void {
    this.governanceRules.set(rule.id, rule);
    this.logger.info('Governance rule added', {
      id: rule.id,
      name: rule.name,
      scope: rule.scope,
      action: rule.action
    });
  }

  /**
   * Remove governance rule
   */
  removeGovernanceRule(ruleId: string): boolean {
    const removed = this.governanceRules.delete(ruleId);
    if (removed) {
      this.logger.info('Governance rule removed', { id: ruleId });
    }
    return removed;
  }

  /**
   * Add content filter
   */
  addContentFilter(filter: ContentFilter): void {
    this.contentFilters.set(filter.name, filter);
    this.logger.info('Content filter added', {
      name: filter.name,
      severity: filter.severity,
      action: filter.action
    });
  }

  /**
   * Update governance configuration
   */
  updateConfig(config: Partial<GovernanceConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Governance configuration updated', { config: this.config });
  }

  /**
   * Get governance statistics
   */
  getGovernanceStats(): {
    config: GovernanceConfig;
    rulesCount: number;
    filtersCount: number;
    piiPatternsCount: number;
  } {
    return {
      config: this.config,
      rulesCount: this.governanceRules.size,
      filtersCount: this.contentFilters.size,
      // Commit 2: pattern registry unified into DLPService. Read the
      // count from there rather than maintaining a parallel counter.
      piiPatternsCount: this.dlpService.getRegisteredPatterns().length
    };
  }

  // Private methods
  //
  // Commit 2: initializePatterns(), calculatePIIConfidence(), and
  // generateReplacement() were deleted when the pattern registry was
  // unified into DLPService. detectPII() now routes to
  // DLPService.scanForPII()/scanText() via the adapter above.
  // extractTextFromData() is preserved because applyContentFilters()
  // still uses it (separate code path from PII detection).
  // redactPIIFromText() and redactDataRecursive() are preserved as
  // the legacy string-mode path for hand-constructed
  // PIIDetectionResult objects.

  private initializeFilters(): void {
    // Malicious content filter
    this.contentFilters.set('malicious', {
      name: 'malicious',
      enabled: true,
      patterns: [
        /script\s*:/gi,
        /<script/gi,
        /javascript\s*:/gi,
        /on\w+\s*=/gi
      ],
      severity: 'high',
      action: 'block'
    });

    // Profanity filter
    this.contentFilters.set('profanity', {
      name: 'profanity',
      enabled: true,
      patterns: [
        /\b(damn|hell|crap)\b/gi // Basic example - real implementation would be more comprehensive
      ],
      severity: 'medium',
      action: 'warn'
    });

    // Sensitive data filter
    this.contentFilters.set('sensitive', {
      name: 'sensitive',
      enabled: true,
      patterns: [
        /\b(password|secret|key|token)\b/gi,
        /\b(confidential|classified|restricted)\b/gi
      ],
      severity: 'high',
      action: 'warn'
    });
  }

  private initializeRules(): void {
    // Data size limit rule
    this.addGovernanceRule({
      id: 'data_size_limit',
      name: 'Data Size Limit',
      description: 'Limit input data size to prevent resource exhaustion',
      enabled: true,
      scope: 'input',
      condition: (data) => {
        const dataSize = JSON.stringify(data).length;
        return dataSize > 1024 * 1024; // 1MB limit
      },
      action: 'block',
      message: 'Input data exceeds size limit (1MB)',
      severity: 'high'
    });

    // Production system protection
    this.addGovernanceRule({
      id: 'production_protection',
      name: 'Production System Protection',
      description: 'Block operations on production systems without explicit approval',
      enabled: true,
      scope: 'both',
      condition: (data, context) => {
        const targetSystem = context.targetSystem?.toLowerCase() || '';
        return targetSystem.includes('prod') || targetSystem.includes('production');
      },
      action: 'warn',
      message: 'Operation targets production system',
      severity: 'medium'
    });

    // Industry compliance rule
    this.addGovernanceRule({
      id: 'industry_compliance',
      name: 'Industry Compliance Check',
      description: 'Apply industry-specific compliance requirements',
      enabled: true,
      scope: 'both',
      condition: (data, context) => {
        const industry = context.industry?.toLowerCase() || '';
        return ['healthcare', 'finance', 'government'].includes(industry);
      },
      action: 'warn',
      message: 'Regulated industry detected - additional compliance required',
      severity: 'medium'
    });
  }

  /**
   * Flatten arbitrary input into a text form for consumers that need
   * a single string (e.g. applyContentFilters() which runs content-
   * filter regexes against flattened text, and the PII detection
   * adapter's `originalText` field).
   *
   * WARNING: do NOT route PII detection through this helper — the
   * JSON.stringify() path obliterates field paths, defeating the
   * field-gated pattern design. PII scanning must go through
   * DLPService.scanForPII()/scanText() on the raw input.
   */
  private extractTextFromData(data: unknown): string {
    if (typeof data === 'string') {
      return data;
    } else if (typeof data === 'object' && data !== null) {
      return JSON.stringify(data);
    } else {
      return String(data);
    }
  }

  private redactPIIFromText(text: string, piiTypes: PIIType[]): string {
    let redactedText = text;

    // Sort by start index in reverse order to maintain indices
    const sortedPII = [...piiTypes].sort((a, b) => b.startIndex - a.startIndex);

    for (const pii of sortedPII) {
      redactedText = redactedText.slice(0, pii.startIndex) +
                    (pii.replacement || '[REDACTED]') +
                    redactedText.slice(pii.endIndex);
    }

    return redactedText;
  }

  private redactDataRecursive(obj: unknown, piiTypes: PIIType[]): unknown {
    if (typeof obj === 'string') {
      return this.redactPIIFromText(obj, piiTypes);
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === 'string') {
          obj[i] = this.redactPIIFromText(obj[i], piiTypes);
        } else if (typeof obj[i] === 'object') {
          this.redactDataRecursive(obj[i], piiTypes);
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      const record = obj as Record<string, unknown>;
      for (const key in record) {
        if (typeof record[key] === 'string') {
          record[key] = this.redactPIIFromText(record[key] as string, piiTypes);
        } else if (typeof record[key] === 'object') {
          this.redactDataRecursive(record[key], piiTypes);
        }
      }
    }
  }

  private async applyContentFilters(data: unknown, scope: 'input' | 'output'): Promise<{
    blocked: boolean;
    reason?: string;
    flags: string[];
    warnings: string[];
  }> {
    const result = {
      blocked: false,
      reason: undefined as string | undefined,
      flags: [] as string[],
      warnings: [] as string[]
    };

    const text = this.extractTextFromData(data);

    for (const filter of this.contentFilters.values()) {
      if (!filter.enabled) continue;

      for (const pattern of filter.patterns) {
        // Reset lastIndex for global regexes to avoid stateful test() issues across calls
        if (pattern.global) {
          pattern.lastIndex = 0;
        }
        if (pattern.test(text)) {
          const flag = `${scope}_${filter.name}_detected`;
          result.flags.push(flag);

          if (filter.action === 'block') {
            result.blocked = true;
            result.reason = `Content filter '${filter.name}' blocked ${scope}`;
            break;
          } else if (filter.action === 'warn') {
            result.warnings.push(`Content filter '${filter.name}' warning on ${scope}`);
          }
        }
      }

      if (result.blocked) break;
    }

    return result;
  }

  private async applyGovernanceRules(
    data: unknown,
    context: AgentExecutionContext,
    scope: 'input' | 'output'
  ): Promise<{
    blocked: boolean;
    reason?: string;
    flags: string[];
    checks: ComplianceCheck[];
  }> {
    const result = {
      blocked: false,
      reason: undefined as string | undefined,
      flags: [] as string[],
      checks: [] as ComplianceCheck[]
    };

    for (const rule of this.governanceRules.values()) {
      if (!rule.enabled || (rule.scope !== 'both' && rule.scope !== scope)) {
        continue;
      }

      try {
        const triggered = rule.condition(data, context);

        const check: ComplianceCheck = {
          rule: rule.name,
          status: triggered ? 'failed' : 'passed',
          message: triggered ? rule.message : `Rule '${rule.name}' passed`,
          severity: rule.severity
        };

        result.checks.push(check);

        if (triggered) {
          result.flags.push(`rule_${rule.id}_triggered`);

          if (rule.action === 'block') {
            result.blocked = true;
            result.reason = rule.message;
            break;
          }
        }
      } catch (error) {
        result.checks.push({
          rule: rule.name,
          status: 'failed',
          message: `Rule evaluation error: ${error}`,
          severity: 'high'
        });
      }
    }

    return result;
  }

  private async validateBusinessLogic(
    data: unknown,
    context: AgentExecutionContext
  ): Promise<{
    flags: string[];
    checks: ComplianceCheck[];
  }> {
    const result = {
      flags: [] as string[],
      checks: [] as ComplianceCheck[]
    };

    // Business hours check
    const currentHour = new Date().getHours();
    if (currentHour < 6 || currentHour > 22) {
      result.checks.push({
        rule: 'Business Hours',
        status: 'warning',
        message: 'Operation outside business hours',
        severity: 'low'
      });
      result.flags.push('outside_business_hours');
    }

    // User authentication check
    if (!context.userId) {
      result.checks.push({
        rule: 'User Authentication',
        status: 'warning',
        message: 'No user ID provided',
        severity: 'medium'
      });
      result.flags.push('no_user_authentication');
    }

    return result;
  }

  private async validateOutputQuality(
    data: unknown,
    context: AgentExecutionContext
  ): Promise<{
    flags: string[];
    checks: ComplianceCheck[];
  }> {
    const result = {
      flags: [] as string[],
      checks: [] as ComplianceCheck[]
    };

    // Output completeness check
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      result.checks.push({
        rule: 'Output Completeness',
        status: 'failed',
        message: 'Agent produced empty or null output',
        severity: 'high'
      });
      result.flags.push('empty_output');
    }

    // Output structure validation
    // (typeof null === 'object', so the explicit null guard prevents a crash
    // on the null/empty output the completeness check above intentionally allows.)
    if (typeof data === 'object' && data !== null && (data as Record<string, unknown>).success === false && !(data as Record<string, unknown>).errors) {
      result.checks.push({
        rule: 'Error Reporting',
        status: 'warning',
        message: 'Failed output missing error details',
        severity: 'medium'
      });
      result.flags.push('incomplete_error_reporting');
    }

    return result;
  }

  private escalateRiskLevel(current: 'low' | 'medium' | 'high', proposed: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
    const levels = { low: 1, medium: 2, high: 3 };
    return levels[proposed] > levels[current] ? proposed : current;
  }
}
