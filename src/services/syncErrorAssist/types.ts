import type { AIProvider } from '../ai/providers/types';

export type ProcessedStatus =
  | 'processing'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_non_retryable';

export interface ProcessedClaim {
  id: string;
  tenantId: string;
  errorRecordId: string;
  attempts: number;
}

export interface ResolvedProvider {
  provider: AIProvider;
  providerId: string;
}

export interface CycleResult {
  tenantId: string;
  errorsScanned: number;
  suggestionsWritten: number;
  skipped: number;
  failedRetryable: number;
  failedNonRetryable: number;
  durationMs: number;
  aborted?: true;
  abortReason?: string;
}

export type ErrorCategory =
  | 'item-not-found'
  | 'customer-not-found'
  | 'vendor-not-found'
  | 'currency-mismatch'
  | 'tax-rate-mismatch'
  | 'missing-required-field'
  | 'locked-record'
  | 'duplicate-external-id'
  | 'schema-drift'
  | 'unauthorized-write';

export interface FixtureRow {
  id: string;                                   // 'S01' through 'S10'
  category: ErrorCategory;
  errorRecord: {
    id: string;
    lastModified: string;
    error_message: string;
    error_context: Record<string, unknown>;
  };
  expectedConfidence: 'high' | 'mid' | 'low';
  expectedShapeAssertions: {
    suggestionType: string;
    referencesField?: string;
    mentionsTerms?: string[];
  };
}

/**
 * Operator-facing disposition state machine.
 *
 *   pending (default after PR 17a write)
 *     → applying (lease held by accept handler — internal only, not user-visible in list)
 *       → accepted (terminal: connector write succeeded + lease released)
 *       → pending (failure path: connector write failed, lease released for retry)
 *     → rejected (terminal: operator dismissal)
 *     → escalated (terminal: handed off to engineering)
 *
 * The 'applying' state prevents two concurrent operators from both invoking
 * connector.create/update against the same suggestion. The lease is held only
 * for the duration of one connector write; failure releases it back to pending.
 */
export type OperatorDisposition = 'pending' | 'applying' | 'accepted' | 'rejected' | 'escalated';

/** Terminal/visible-only subset surfaced in audit log details. */
export type OperatorDispositionUserVisible = Exclude<OperatorDisposition, 'applying'>;

export interface PendingSuggestion {
  errorRecordId: string;
  suggestionRecordId: string | null;   // NetSuite-side fix-suggestion record id (nullable: PR 17a back-rows may not have one)
  tenantId: string;
  confidence: 'high' | 'mid' | 'low' | null;
  suggestionType: string | null;       // 'create_missing_record' | 'fix_field_value' | 'manual_review' | null for back-rows
  suggestionText: string | null;
  referencesField: string | null;
  reasoningTraceId: string | null;
  providerUsed: string | null;
  costEstimateUsdCents: number | null;
  createdAt: string;                   // ISO 8601
}

/**
 * Terminal outcome of processing a single claimed error record.
 * Returned from processClaimedRecord and runSingleErrorCycle so that runCycle
 * can accumulate the CycleResult counters from the per-record loop.
 *
 * The webhook fire-and-forget caller discards the resolved value; only the
 * .catch() rejection path emits the fire-and-forget-error metric. The
 * persisted status (via updateSucceeded / updateFailed) remains the source
 * of truth — this enum is informational for the caller's counter accumulation.
 */
export type ProcessClaimedRecordOutcome =
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_non_retryable';

/**
 * Webhook payload shape, defined here (not in the route file) so that
 * `SyncErrorAssistService.ingestWebhook` (Task 8) can import it BEFORE the
 * Zod schema lands in Task 9. The route file's `WebhookPayloadSchema` will
 * be typed `z.ZodType<WebhookPayload>` to keep the schema constrained to
 * this canonical shape — `z.infer` from the schema would create a
 * forward-import that breaks Task 8's typecheck order.
 *
 * Field semantics match §3.5 of the spec — camelCase from SuiteScript;
 * polling reads use snake_case and run through normalizeErrorRecordForPrompt
 * before reaching the AI prompt builder.
 */
export interface WebhookPayload {
  tenantId: string;                                     // matches tenantIsolation.ts:61 regex
  errorRecordId: string;                                // ≤128 chars, [a-zA-Z0-9_-]
  lastModified: string;                                 // ISO 8601 datetime
  errorType: string;                                    // 1..64 chars
  errorMessage: string;                                 // ≤8192 chars; DLP-scanned
  sourcePayload?: Record<string, unknown>;              // ≤32KB UTF-8 bytes, depth ≤6
  attemptCount?: number;                                // non-negative integer
}
