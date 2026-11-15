// The canonical tenant-identity rule for the whole system.
//
// This module is deliberately DEPENDENCY-FREE. It was extracted out of
// `src/middleware/auth.ts` (Copilot review on A5 / PR #1128) because that
// module imports the inversify DI container at load time, so every consumer
// of the validator — including pure schema modules like
// `src/routes/syncErrorAssistWebhookSchema.ts` — was paying the whole
// container's import cost and risking a cycle. Keep it importing nothing:
// the validator has to be reusable from schemas, middleware, and services
// alike without dragging a graph behind it.
//
// Validate + normalize a tenantId claim. Returns the canonical string or
// `undefined` if the value is unsafe to propagate. Unsafe =
// empty/whitespace-only (would auto-register as an active tenant via the
// gate's seam — see TenantLifecycleService.requireActive), oversized, or
// shape-illegal — outside `[A-Za-z0-9_-]`. The allowlist rejects invisible /
// bidi / control characters (e.g. U+200B zero-width space, U+202E RTL
// override) that String.prototype.trim() does not strip, so a JWT cannot
// auto-register a tenant whose ID renders identically to an existing one but
// is byte-distinct, nor inject directional-override spoofing into downstream
// log/audit surfaces. Covers the conventional issuer formats (UUID, ULID,
// alphanumeric IDs from Auth0/Okta/Cognito/Azure AD); claims in any other
// shape fail closed at the gate (consistent with the fail-closed posture for
// JWTs without a tenantId claim).
//
// A5: 64 is THE tenant-identity boundary for the whole system, not a local
// choice. It was 255 (sized to the tenants.id column) while tenantIsolation
// and the sync-error-assist webhook schema each enforced 64 independently —
// so a 65..255-char claim passed auth, was refused tenantContext by
// tenantIsolation, but still reached tenantStatusGate's readTenantClaim
// (which applied no format check) and auto-registered a row via
// requireActive → ensureExists. Every registration-reachable ingress now
// routes through this function; do not reintroduce a second length constant
// or regex elsewhere. The tenants.id column stays VARCHAR(255) — the ingress
// bound is the security boundary, the column width is only storage.
//
// NOTE: this deliberately does NOT reject `SYSTEM_IDENTITY.tenantId`. The
// sentinel is a legitimate internal identity; rejecting it is the job of the
// consumers that must not accept it (tenantIsolation, tenantStatusGate,
// the webhook schema). Importing identityContext here would also break the
// zero-dependency property above.
const MAX_TENANT_ID_LENGTH = 64;
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeTenantIdClaim(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (s.length === 0) return undefined;
  if (s.length > MAX_TENANT_ID_LENGTH) return undefined;
  if (!TENANT_ID_PATTERN.test(s)) return undefined;
  return s;
}
