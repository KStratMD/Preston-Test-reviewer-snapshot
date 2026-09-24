/**
 * Correlation-id sanitation for the SuiteCentral control plane.
 *
 * The correlation id is CALLER-SUPPLIED (a request header, once PR-A6 mounts the
 * routes), so it is untrusted input that happens to look like infrastructure.
 * It is also the single most-copied value in this subsystem: it rides on every
 * audit row and nearly every log line. Both destinations are durable and
 * operator-readable, so an unvetted id is arbitrary attacker-controlled text
 * written wherever we thought we were writing a trace handle — including places
 * governance never scans.
 *
 * Hence one shared definition rather than a per-file check: the same value must
 * be sanitized identically at every sink, and a private copy in one file leaves
 * the others exposed (which is exactly what happened before this existed).
 */

/** Generated identifiers only: no whitespace, punctuation, prose, or control characters. */
const SAFE_CORRELATION_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;

/** Substituted for anything that fails validation. */
export const INVALID_CORRELATION_ID = 'invalid_correlation_id';

/**
 * Return the correlation id if it looks like a generated identifier, else a
 * fixed marker.
 *
 * Substitutes rather than throws: a malformed id is a bad trace handle, and it
 * must not cost us the audit row or the log line it was attached to. Losing the
 * record would be a worse outcome than losing the handle.
 */
export function safeCorrelationId(correlationId: unknown): string {
  return typeof correlationId === 'string' && SAFE_CORRELATION_ID.test(correlationId)
    ? correlationId
    : INVALID_CORRELATION_ID;
}
