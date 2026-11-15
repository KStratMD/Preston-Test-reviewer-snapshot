import type { ChatMessage } from '../ai/providers/types';
import type { DLPService, PIIFinding } from '../security/DLPService';
import type { Logger } from '../../utils/Logger';
import type { SyncErrorAssistMetrics } from './SyncErrorAssistMetrics';
import type { GovernanceService, TenantGovernancePosture } from '../ai/orchestrator/GovernanceService';

export function buildPrompt(
  errorRecord: { error_message: string; error_context: Record<string, unknown> },
  threshold: string,
): ChatMessage[] {
  const systemMessage = `You are a NetSuite ERP integration specialist. The user will give you a sync error from SyncCentral. Your job is to suggest a fix.

Output strictly the following JSON shape (no surrounding text):
{
  "confidence": "high" | "mid" | "low",
  "suggestion_type": "create_missing_record" | "fix_field_value" | "manual_review",
  "suggestion_text": "<one-paragraph human-readable explanation, mentioning specific IDs and field names from the error>",
  "references_field": "<field name being fixed, or null>"
}

Only return actionable suggestions (suggestion_type "create_missing_record" or "fix_field_value") when your confidence is at or above the configured threshold of "${threshold}". Otherwise, return suggestion_type: "manual_review" with confidence: "low".`;

  const userMessage = `Sync error from SyncCentral:

Error message: ${errorRecord.error_message}

Context (JSON):
${JSON.stringify(errorRecord.error_context, null, 2)}

What should an operator do to fix this?`;

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ];
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all |any |the )?previous instructions?/i,
  /\bsystem\s*:/i,                                       // word-boundary so `ecoSYSTEM:` / `subSYSTEM:` aren't flagged
  /<\/?\s*(?:system|assistant|user)\s*>/i,
  /\{\{[^}]+\}\}/,        // template-tag handlebars/mustache style
  /\[\[[^\]]+\]\]/,        // alternate template-tag
];

function containsLikelyPromptInjection(value: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(value));
}

interface InjectionWalkState {
  replacedAny: boolean;
}

function replaceInjectionSignaturesDeep(value: unknown, state: InjectionWalkState): unknown {
  if (typeof value === 'string') {
    if (containsLikelyPromptInjection(value)) {
      state.replacedAny = true;
      return '[content removed: prompt-injection signature]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => replaceInjectionSignaturesDeep(v, state));
  }
  if (value !== null && typeof value === 'object') {
    // Use Object.create(null) to defuse prototype-pollution: callers walk untrusted
    // JSON whose keys may include `__proto__`/`constructor`/`prototype`, and writing
    // through a plain `{}` would mutate Object.prototype.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Codex R1 #1 — keys also reach the prompt via JSON.stringify, so an attacker-
      // controlled key like "ignore previous instructions" bypasses the value-only
      // scrub. Drop entries whose key matches an injection signature; flag replacedAny
      // so the caller logs + emits the prompt_injection_replaced metric.
      if (containsLikelyPromptInjection(k)) {
        state.replacedAny = true;
        continue;
      }
      out[k] = replaceInjectionSignaturesDeep(v, state);
    }
    return out;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface SanitizeOpts {
  dlpService: DLPService;
  /**
   * PR-C3.1a — per-tenant DLP posture is consumed at the DECISION layer of
   * each sanitizer (after the scan, before deciding to redact). Threaded via
   * `SanitizeOpts` so the free-function helpers stay testable in isolation:
   * production wires the live `GovernanceService` instance; tests inject a
   * minimal stub that returns whatever posture the case-under-test needs.
   *
   * `posture.allowPII` short-circuits the DLP scan entirely; `posture.piiTypes`
   * narrows which findings count for redaction; `posture.autoRedact=false`
   * forces a fail-closed placeholder rather than the substituted redactedData.
   * `posture.blockOnDetection` is N/A here — these are AI-prompt-prep paths
   * with no "block" outcome (no caller to reject a request from).
   */
  governanceService: Pick<GovernanceService, 'getPostureForTenant'>;
  correlationId: string;
  tenantId: string;
  logger: Logger;
  metrics: SyncErrorAssistMetrics;
}

/**
 * PR-C3.1a — apply the per-tenant `posture.piiTypes` allowlist to a scan's
 * findings. Empty list (default `DEFAULT_POSTURE.piiTypes = []`) keeps the
 * pre-C3.1 behavior of treating every finding as relevant; a non-empty list
 * narrows the relevant set to only those types. Unknown type strings are
 * tolerated (forward-compat: matches the C3 design's deliberate non-
 * validation against the DLP registry).
 *
 * PR-C3.1a R1 (Codex Medium) — the allowlist semantics apply at TWO layers:
 *   1. Decision: `hasRelevantPII = relevantFindings.length > 0` gates whether
 *      redaction triggers at all. Non-allowed-type findings alone (with no
 *      allowed-type findings co-present) do NOT trigger redaction.
 *   2. Redaction surface: when redaction DOES fire, call back into
 *      `dlpService.redactData(input, relevantFindings)` so the substitution
 *      covers ONLY the allowed-type spans. Using `scan.redactedData` directly
 *      would sweep up co-present non-allowed types — making the contract
 *      strictly more aggressive than the tenant configured. The downside of
 *      narrowed redaction is one extra `redactData` walk on the trigger
 *      path; that cost is bounded by the same data-shape as the scan and
 *      is amortized by the 60s posture cache.
 */
function filterRelevantFindings(
  findings: PIIFinding[],
  posture: TenantGovernancePosture,
): PIIFinding[] {
  if (posture.piiTypes.length === 0) return findings;
  const allowed = new Set(posture.piiTypes);
  return findings.filter((f) => allowed.has(f.type));
}

/**
 * R2-5 + R3-5 + R5-3 + R7-1 — three-layer defense for sourcePayload.
 *
 *   1. DLPService.scanForPII({ autoRedact: true }) on the parsed object.
 *   2. If scanFailed → return object placeholder { _redaction: 'dlp_scan_failed', removed: true }.
 *      MUST be an object (not a string) so buildPrompt's `error_context: Record<string, unknown>`
 *      contract holds end-to-end. R5-3 closed the prior bug where this was typed as a string.
 *   3. Otherwise: use redactedData if present, else the original parsed object.
 *   4. Run prompt-injection signature replacement on the result.
 *
 * Always returns a plain object — no nullish, no string. Free function (not a service method)
 * so the helper is testable in isolation and avoids method-binding complications inside
 * setImmediate closures.
 *
 * Spec §3.5 — all branches log + emit `dlp_scan_outcome` metric; the injection-replacement
 * branch additionally logs warn + emits `prompt_injection_replaced`.
 */
export async function sanitizeSourcePayloadForPrompt(
  parsed: Record<string, unknown>,
  opts: SanitizeOpts,
): Promise<Record<string, unknown>> {
  const { dlpService, governanceService, correlationId, tenantId, logger, metrics } = opts;

  // PR-C3.1a — resolve per-tenant posture FIRST. `posture.allowPII=true` is the
  // explicit "this tenant has opted in to allowing PII through this path"
  // signal (regression-equivalent fallback: DEFAULT_POSTURE for system identity
  // / undefined tenantId / repository errors). Short-circuit the DLP scan
  // entirely; the prompt-injection signature walk still runs because that
  // defense is independent of PII (an attacker-controlled string with prompt-
  // injection markers is hostile regardless of whether the tenant allows PII).
  // posture.blockOnDetection is N/A here — sanitizeSourcePayloadForPrompt has
  // no "block" outcome; it can only redact-or-pass into the AI prompt.
  const posture = await governanceService.getPostureForTenant(tenantId);
  if (posture.allowPII) {
    metrics.recordDlpScanOutcome(tenantId, 'clean');
    logger.info(
      'sanitizeSourcePayloadForPrompt: posture.allowPII=true — skipping DLP scan',
      { tenantId, correlationId },
    );
    const allowState: InjectionWalkState = { replacedAny: false };
    const allowed = replaceInjectionSignaturesDeep(parsed, allowState) as Record<string, unknown>;
    if (allowState.replacedAny) {
      metrics.recordPromptInjectionReplaced(tenantId);
      logger.warn(
        'sanitizeSourcePayloadForPrompt: prompt-injection signature replaced',
        { tenantId, correlationId },
      );
    }
    return allowed;
  }

  const scan = await dlpService.scanForPII(parsed, {
    allowPII: false, piiTypes: [], autoRedact: true, blockOnDetection: false,
  });

  if (scan.scanFailed) {
    metrics.recordDlpScanOutcome(tenantId, 'failed');
    logger.error(
      'sanitizeSourcePayloadForPrompt: DLP scan failed — fail-safe placeholder used',
      new Error('dlp_scan_failed'),
      { tenantId, correlationId },
    );
    return { _redaction: 'dlp_scan_failed', removed: true };
  }

  // PR-C3.1a R1 (Codex Medium) — `posture.piiTypes` allowlist applies at BOTH
  // the decision layer (does redaction trigger?) and the redaction surface
  // (which spans get substituted). Decision: `hasRelevantPII` triggers ONLY
  // on allowed-type findings. Redaction surface: we re-run DLPService's
  // pure `redactData` against `relevantFindings` (filtered to allowed types)
  // rather than reusing `scan.redactedData` — the latter covers ALL findings
  // the scan detected (DLPService doesn't honor `policy.piiTypes` for
  // narrowing), so reusing it would silently redact co-present non-allowed-
  // type PII (phone redacted even when the tenant only allowlisted email).
  const relevantFindings = filterRelevantFindings(scan.findings, posture);
  const hasRelevantPII = relevantFindings.length > 0;

  let post: Record<string, unknown>;
  if (hasRelevantPII) {
    // PR-C3.1a — posture.autoRedact=false: tenant has opted out of auto-redaction.
    // For this AI-prompt-prep path, leaking raw PII even with autoRedact=false
    // would violate the prompt-defense contract, so we fail to a placeholder
    // instead. Mirrors the existing redaction-unavailable branches.
    if (!posture.autoRedact) {
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.warn(
        'sanitizeSourcePayloadForPrompt: posture.autoRedact=false with findings — fail-safe placeholder used',
        { tenantId, correlationId, findingCount: relevantFindings.length },
      );
      return { _redaction: 'dlp_scan_failed', removed: true };
    }
    // PR-C3.1a R1 — narrowed redaction over `relevantFindings` (not all findings).
    const narrowed = dlpService.redactData(parsed, relevantFindings);
    if (!isPlainRecord(narrowed)) {
      // DLPService.redactData walks recursively and should preserve the
      // top-level object shape, but defensively fail-safe if it returned
      // a primitive or array (would break the `error_context: Record<string,
      // unknown>` contract downstream).
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.error(
        'sanitizeSourcePayloadForPrompt: narrowed redaction returned non-plain-object — fail-safe placeholder used',
        new Error('dlp_redacted_non_record'),
        { tenantId, correlationId, findingCount: relevantFindings.length },
      );
      return { _redaction: 'dlp_scan_failed', removed: true };
    }
    metrics.recordDlpScanOutcome(tenantId, 'redacted');
    logger.info(
      'sanitizeSourcePayloadForPrompt: DLP redacted findings',
      { tenantId, correlationId, findingCount: relevantFindings.length },
    );
    post = narrowed;
  } else {
    metrics.recordDlpScanOutcome(tenantId, 'clean');
    logger.info(
      'sanitizeSourcePayloadForPrompt: DLP scan clean',
      { tenantId, correlationId },
    );
    post = parsed;
  }

  const state: InjectionWalkState = { replacedAny: false };
  const result = replaceInjectionSignaturesDeep(post, state) as Record<string, unknown>;
  if (state.replacedAny) {
    metrics.recordPromptInjectionReplaced(tenantId);
    logger.warn(
      'sanitizeSourcePayloadForPrompt: prompt-injection signature replaced',
      { tenantId, correlationId },
    );
  }
  return result;
}

/**
 * Codex R1 #2 — `error_message` was interpolated raw into the user prompt by buildPrompt,
 * bypassing the DLP + injection-signature defense that `error_context` already gets via
 * sanitizeSourcePayloadForPrompt. This helper closes the gap: DLP-scan the message text
 * (autoRedact:true), then run the injection-signature walk on the redacted form. Returns
 * a safe string that buildPrompt can interpolate.
 *
 * Codex R2 — defensive length cap: the webhook payload schema caps errorMessage at 8KB,
 * but the polling-source path normalizes only "string or empty," so an unbounded NetSuite
 * error string could add synchronous DLP/regex latency outside the per-record timeout and
 * bloat the AI prompt. Truncate at MAX_ERROR_MESSAGE_LEN with a clear suffix before scanning.
 */
const MAX_ERROR_MESSAGE_LEN = 8192;

export async function sanitizeErrorMessageForPrompt(
  message: string,
  opts: SanitizeOpts,
): Promise<string> {
  const { dlpService, governanceService, correlationId, tenantId, logger, metrics } = opts;

  // Codex R2 — defensive cap. Codex R3 — `.slice(0, N)` slices by UTF-16 code units, so a
  // multi-byte character (emoji, CJK Extension B) crossing the cap boundary returns a string
  // with a lone surrogate, which propagates malformed Unicode into DLP scanning + prompt
  // construction. Back the cutoff off by 1 when it lands on a high surrogate so the pair
  // either fully lives in the truncated form or is fully dropped.
  let truncated: string;
  if (message.length > MAX_ERROR_MESSAGE_LEN) {
    let cutoff = MAX_ERROR_MESSAGE_LEN;
    const lastCharCode = message.charCodeAt(cutoff - 1);
    if (lastCharCode >= 0xD800 && lastCharCode <= 0xDBFF) cutoff -= 1; // lone high surrogate guard
    truncated = `${message.slice(0, cutoff)}…[truncated:${message.length - cutoff}]`;
  } else {
    truncated = message;
  }

  // PR-C3.1a — resolve per-tenant posture FIRST. `posture.allowPII=true` short-
  // circuits the DLP scan; the injection-signature walk still runs on the
  // truncated message. posture.blockOnDetection is N/A here (no "block"
  // outcome — only redact-or-pass into the AI prompt).
  const posture = await governanceService.getPostureForTenant(tenantId);
  if (posture.allowPII) {
    metrics.recordDlpScanOutcome(tenantId, 'clean');
    logger.info(
      'sanitizeErrorMessageForPrompt: posture.allowPII=true — skipping DLP scan',
      { tenantId, correlationId },
    );
    const allowState: InjectionWalkState = { replacedAny: false };
    const allowed = replaceInjectionSignaturesDeep(truncated, allowState);
    if (allowState.replacedAny) {
      metrics.recordPromptInjectionReplaced(tenantId);
      logger.warn('sanitizeErrorMessageForPrompt: prompt-injection signature replaced', {
        tenantId, correlationId,
      });
    }
    return typeof allowed === 'string' ? allowed : '[content removed]';
  }

  let scrubbed: string;
  try {
    const scan = await dlpService.scanText(truncated, {
      allowPII: false, piiTypes: [], autoRedact: true, blockOnDetection: false,
    });
    // PR-C3.1a R1 (Codex Medium) — apply posture.piiTypes allowlist at both
    // layers: decision (hasRelevantPII triggers redaction) AND redaction
    // surface (call back into dlpService.redactData with the filtered
    // findings so only allowed-type spans are substituted). See
    // filterRelevantFindings JSDoc for the two-layer rationale.
    const relevantFindings = filterRelevantFindings(scan.findings, posture);
    const hasRelevantPII = relevantFindings.length > 0;

    // PR-C3.1a — posture.autoRedact=false with findings: tenant opted out of
    // auto-redaction. Per the AI-prompt-prep contract we still can't leak raw
    // PII into the prompt, so substitute the placeholder.
    if (hasRelevantPII && !posture.autoRedact) {
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.warn('sanitizeErrorMessageForPrompt: posture.autoRedact=false with findings — using placeholder', {
        tenantId, correlationId, findingCount: relevantFindings.length,
      });
      return '[content removed: dlp_findings_without_redaction]';
    }
    if (hasRelevantPII) {
      // PR-C3.1a R1 — narrowed redaction over allowed-type findings only.
      // Codex R2 — fail-CLOSED when the narrowed redaction doesn't yield a
      // string (would only happen if DLPService.redactData behaved badly on
      // string input, e.g. returned a non-string). The source-payload
      // sanitizer already fails closed via the `_redaction: dlp_scan_failed`
      // placeholder; mirror that posture here rather than leaking the raw
      // truncated value.
      const narrowed = dlpService.redactData(truncated, relevantFindings);
      if (typeof narrowed !== 'string') {
        metrics.recordDlpScanOutcome(tenantId, 'failed');
        logger.warn('sanitizeErrorMessageForPrompt: narrowed redaction returned non-string — using placeholder', {
          tenantId, correlationId, findingCount: relevantFindings.length,
        });
        return '[content removed: dlp_findings_without_redaction]';
      }
      scrubbed = narrowed;
    } else {
      // No relevant findings — the truncated message is the source of truth.
      // (Co-present non-allowed-type findings stay raw; tenant policy did
      // not opt into action on those types.)
      scrubbed = truncated;
    }
  } catch (dlpErr) {
    metrics.recordDlpScanOutcome(tenantId, 'failed');                       // Codex R3 — mirror metric across all fail-CLOSED paths
    logger.warn('sanitizeErrorMessageForPrompt: DLP scan threw — using placeholder', {
      tenantId, correlationId, error: dlpErr instanceof Error ? dlpErr.message : String(dlpErr),
    });
    return '[content removed: dlp_scan_failed]';
  }

  const state: InjectionWalkState = { replacedAny: false };
  const result = replaceInjectionSignaturesDeep(scrubbed, state);
  if (state.replacedAny) {
    metrics.recordPromptInjectionReplaced(tenantId);
    logger.warn('sanitizeErrorMessageForPrompt: prompt-injection signature replaced', {
      tenantId, correlationId,
    });
  }
  return typeof result === 'string' ? result : '[content removed]';
}
