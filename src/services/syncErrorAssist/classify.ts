import { SyncErrorAssistTimeoutError } from './errors';
import { GovernanceBlockedError, PendingApprovalError } from '../governance/OutboundGovernanceErrors';
import { AppError, ServiceUnavailableAppError } from '../../errors/AppError';
import type { ProcessedStatus } from './types';

/**
 * Pure function — never throws. Maps a thrown error + per-row attempt count
 * to a ProcessedStatus. Retryable errors become failed_non_retryable when
 * attempts >= 3 (the per-row attempt cap).
 */
export function classify(err: unknown, attempts: number): ProcessedStatus {
  // Per-record timeout — retryable until exhausted
  if (err instanceof SyncErrorAssistTimeoutError) {
    // NetSuite-create timeout: the underlying HTTP request may still complete
    // and write the record; retrying risks duplicate suggestion records.
    // Operator must investigate via NetSuite-side dedup before any manual retry.
    if (err.operation === 'NetSuite create') return 'failed_non_retryable';
    return attempts >= 3 ? 'failed_non_retryable' : 'failed_retryable';
  }

  // DLP / governance — non-retryable
  if (err instanceof GovernanceBlockedError) return 'failed_non_retryable';
  if (err instanceof PendingApprovalError) return 'failed_non_retryable';

  // AI parse error — non-retryable (same prompt → same response usually)
  if (err instanceof Error && /AI parse|unstructured/.test(err.message)) {
    return 'failed_non_retryable';
  }

  // 503 / 5xx / 429 / 408 — retryable until exhausted (positive-evidence only;
  // unknown errors fall through to failed_non_retryable)
  const status = (err as { status?: unknown; statusCode?: unknown })?.status
              ?? (err as { status?: unknown; statusCode?: unknown })?.statusCode;
  const httpRetryable =
    typeof status === 'number' &&
    (status >= 500 || status === 429 || status === 408);

  const isRetryable =
    (err instanceof ServiceUnavailableAppError) ||
    (err instanceof AppError && err.statusCode >= 500) ||
    (err instanceof AppError && err.statusCode === 429) ||
    httpRetryable;

  if (isRetryable) return attempts >= 3 ? 'failed_non_retryable' : 'failed_retryable';

  // Everything else — non-retryable
  return 'failed_non_retryable';
}
