/**
 * Typed HTTP-domain errors for the SuiteCentral control plane.
 *
 * Routes dispatch on the error CLASS (or the numeric `status`), never on
 * message text. Each carries a stable machine `code` and a sanitized `message`
 * safe to surface; secrets and raw upstream detail must never be placed here.
 */

export abstract class SuiteCentralControlPlaneError extends Error {
  abstract readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SuiteCentralNotFoundError extends SuiteCentralControlPlaneError {
  readonly status = 404;
}

export class SuiteCentralConflictError extends SuiteCentralControlPlaneError {
  readonly status = 409;
}

export class SuiteCentralValidationError extends SuiteCentralControlPlaneError {
  readonly status = 400;
}

/**
 * The actor is authenticated but lacks the required access mode — raised when a
 * `tenant_admin` reaches a platform-scoped surface (the allowed-host registry).
 * Distinct from 404: platform surfaces are not tenant-owned, so there is no
 * existence to leak by admitting the resource is real but forbidden.
 */
export class SuiteCentralForbiddenError extends SuiteCentralControlPlaneError {
  readonly status = 403;
}

export class SuiteCentralDestinationRejectedError extends SuiteCentralControlPlaneError {
  readonly status = 422;
}

export class SuiteCentralDependencyError extends SuiteCentralControlPlaneError {
  readonly status = 503;
}

export class SuiteCentralUpstreamError extends SuiteCentralControlPlaneError {
  readonly status = 502;
}

/**
 * An unexpected failure that is not one of the modelled domain errors.
 *
 * Exists so no non-domain error escapes the service raw: connector, factory, and
 * secret-provider failures carry unstructured third-party text that can quote a
 * request — and with it credential material — into a route response or a log.
 * Those are converted to this, which carries only a stable code.
 */
export class SuiteCentralInternalError extends SuiteCentralControlPlaneError {
  readonly status = 500;
}

/**
 * Read a stable machine `code` off a thrown value, trusting SOURCE not SHAPE.
 *
 * Only codes authored here — on a {@link SuiteCentralControlPlaneError} — are
 * propagated. Everything else collapses to `fallback`.
 *
 * An earlier version accepted any `error.code` matching a token-shaped regex.
 * That is a shape check masquerading as a trust boundary: API keys are routinely
 * just a prefix plus letters and digits, which satisfies any
 * letters/digits/underscore pattern perfectly. A provider that puts credential
 * material in `.code` would sail straight through into
 * `audit_logs.error_message`, health history, and alert codes — all durable, all
 * readable. There is no regex that separates "a stable code" from "a secret that
 * happens to look like one".
 *
 * The cost is losing third-party codes like `ECONNREFUSED` from these fields.
 * That is the right trade: those are diagnostics, and diagnostics belong in logs
 * (sanitized, ephemeral), not in the durable audit trail. This function guards
 * what gets persisted, not what gets debugged.
 */
export function stableErrorCode(error: unknown, fallback: string): string {
  return error instanceof SuiteCentralControlPlaneError ? error.code : fallback;
}
