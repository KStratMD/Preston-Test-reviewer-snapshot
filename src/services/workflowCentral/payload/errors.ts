/**
 * Typed error classes for WorkflowPayload resolution (Phase 1 T2). Enumerated
 * UPFRONT per feedback_copilot_typed_error_pressure — covers every HTTP-status
 * path the resolver + route layer can produce.
 *
 * Route mapping: only EphemeralPayload* errors bubble to route-level HTTP
 * codes (410 expired, 403 not-allowed). PayloadRef* errors are caught by the
 * resolver and carried inside the 200-response `resolution[i].error` per the
 * partial-success contract (T3/T4). The route mapper extends the existing
 * mapper at src/routes/workflowCentral.ts with two new instanceof clauses
 * (T11) — it does NOT add a PayloadRef* clause.
 *
 * Phase 1 deliberately omits a typed DLP-block class — DLP is redact-and-
 * continue (matches MCPAggregatorService). A blocking DLP policy (451 +
 * PAYLOAD_REF_DLP_BLOCKED) is a Tier-2 follow-up.
 *
 * The DLP-scan-failure outcome the resolver emits on scanned.scanFailed is
 * NOT a typed class either — it's an internal-server error class distinct
 * from per-ref connector failures, and lives only inside the 200-response
 * resolution[i].error block (statusCode 500, code PAYLOAD_REF_DLP_SCAN_FAILED).
 */

export abstract class PayloadRefError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class PayloadRefRecordNotFoundError extends PayloadRefError {
  readonly statusCode = 404;
  readonly code = 'PAYLOAD_REF_RECORD_NOT_FOUND';
}

export class PayloadRefConnectorUnavailableError extends PayloadRefError {
  readonly statusCode = 503;
  readonly code = 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE';
}

export class PayloadRefAuthExpiredError extends PayloadRefError {
  readonly statusCode = 401;
  readonly code = 'PAYLOAD_REF_AUTH_EXPIRED';
}

/**
 * Semantically distinct from PayloadRefAuthExpiredError: 403 means
 * "authenticated but not authorized for this record" (tenant lacks scope /
 * record-level permission). Collapsing 403 into 401/AUTH_EXPIRED would mislead
 * the operator UI to prompt re-auth when the real cause is a permission gap.
 * Copilot R1 finding on PR #811.
 */
export class PayloadRefForbiddenError extends PayloadRefError {
  readonly statusCode = 403;
  readonly code = 'PAYLOAD_REF_FORBIDDEN';
}

export class PayloadRefSystemUnknownError extends PayloadRefError {
  readonly statusCode = 400;
  readonly code = 'PAYLOAD_REF_SYSTEM_UNKNOWN';
}

export class PayloadRefSchemaInvalidError extends PayloadRefError {
  readonly statusCode = 400;
  readonly code = 'PAYLOAD_REF_SCHEMA_INVALID';
}

export class EphemeralPayloadExpiredError extends PayloadRefError {
  readonly statusCode = 410;
  readonly code = 'EPHEMERAL_PAYLOAD_EXPIRED';
}

export class EphemeralPayloadNotAllowedError extends PayloadRefError {
  readonly statusCode = 403;
  readonly code = 'EPHEMERAL_PAYLOAD_NOT_ALLOWED';
}
