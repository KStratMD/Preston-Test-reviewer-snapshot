import type { ChatMessage } from '../ai/providers/types';
import type { DLPService } from '../security/DLPService';
import type { Logger } from '../../utils/Logger';
import type { SyncErrorAssistMetrics } from './SyncErrorAssistMetrics';

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
  correlationId: string;
  tenantId: string;
  logger: Logger;
  metrics: SyncErrorAssistMetrics;
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
  const { dlpService, correlationId, tenantId, logger, metrics } = opts;

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

  let post: Record<string, unknown>;
  if (scan.findings.length > 0) {
    if (!scan.redactedData) {
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.error(
        'sanitizeSourcePayloadForPrompt: DLP findings detected but redactedData missing — fail-safe placeholder used',
        new Error('dlp_findings_without_redaction'),
        { tenantId, correlationId, findingCount: scan.findings.length },
      );
      return { _redaction: 'dlp_scan_failed', removed: true };
    }
    if (!isPlainRecord(scan.redactedData)) {
      // DLPService types redactedData as `unknown`; if a redaction returned a non-object
      // (e.g., a primitive or array), our `error_context: Record<string, unknown>` contract
      // would break downstream. Fail safe to the placeholder.
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.error(
        'sanitizeSourcePayloadForPrompt: DLP redactedData not a plain object — fail-safe placeholder used',
        new Error('dlp_redacted_non_record'),
        { tenantId, correlationId, findingCount: scan.findings.length },
      );
      return { _redaction: 'dlp_scan_failed', removed: true };
    }
    metrics.recordDlpScanOutcome(tenantId, 'redacted');
    logger.info(
      'sanitizeSourcePayloadForPrompt: DLP redacted findings',
      { tenantId, correlationId, findingCount: scan.findings.length },
    );
    post = scan.redactedData;
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
  const { dlpService, correlationId, tenantId, logger, metrics } = opts;

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

  let scrubbed: string;
  try {
    const scan = await dlpService.scanText(truncated, {
      allowPII: false, piiTypes: [], autoRedact: true, blockOnDetection: false,
    });
    // Codex R2 — fail-CLOSED when findings exist but redactedData is missing or wrong type.
    // The source-payload sanitizer already fails closed via the `_redaction: dlp_scan_failed`
    // placeholder; the error-message path was failing open (returning the raw `truncated`
    // value), which would leak PII into the AI prompt despite findings being detected.
    // Codex R3 — emit recordDlpScanOutcome('failed') here too so the metric tracks all
    // fail-CLOSED paths uniformly (sanitizeSourcePayloadForPrompt already does this for its
    // equivalent branches at lines 125, 137, 149).
    if (scan.findings.length > 0 && typeof scan.redactedData !== 'string') {
      metrics.recordDlpScanOutcome(tenantId, 'failed');
      logger.warn('sanitizeErrorMessageForPrompt: findings detected but redactedData missing — using placeholder', {
        tenantId, correlationId, findingCount: scan.findings.length,
      });
      return '[content removed: dlp_findings_without_redaction]';
    }
    scrubbed = typeof scan.redactedData === 'string' ? scan.redactedData : truncated;
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
