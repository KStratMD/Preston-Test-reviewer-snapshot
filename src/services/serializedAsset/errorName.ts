/**
 * The serialized-asset profile's one rule for putting an error anywhere
 * observable: emit its CLASS NAME, never its message.
 *
 * This is decision 8 (privacy) enforced structurally rather than by discipline.
 * The messages in play are not ours: a Salesforce error body can quote the
 * payload it rejected, and a Postgres unique/CHECK violation's `DETAIL` carries
 * the WHOLE failing row — for `deferred_serialized_units` that includes
 * `normalized_payload`, i.e. the serial. So no error message from a connector,
 * a driver, or a repository may reach a log line, a metric label, an audit
 * detail, a thrown message, or an HTTP response.
 *
 * Extracted from `SerializedAssetSyncService`, which already applied the rule
 * throughout, after a review found `SerializedAssetReadinessService` logging
 * `error.message` verbatim at two sites — the same module whose header claims
 * the guarantee. One shared helper is harder to drift from than two conventions.
 *
 * CLASSIFYING on a message is still legitimate (`isPermissionRefusal` pattern
 * -matches one to tell a permission refusal from an outage). Reading is not
 * emitting; what this helper governs is what ESCAPES.
 */
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
