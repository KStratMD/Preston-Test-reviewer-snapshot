/**
 * F5b-3: the dedicated tenant that owns the *-central demo fixtures.
 *
 * Gate-attested anonymous demo reads resolve HERE (resolveCentralTenantId),
 * and the boot-time demo seeds write HERE — never to SYSTEM_IDENTITY. The
 * double-underscore marks it reserved: no JWT is ever minted with this
 * tenantId, and the tenant-lifecycle gate never sees it (hosted_demo_public
 * policies are lifecycle: 'not_applicable').
 *
 * Kept OUT of identityContext.ts deliberately — that file is the single
 * subject of scripts/check-system-identity-isolation.mjs, and the demo
 * tenant is not a system identity.
 */
export const CENTRAL_DEMO_TENANT_ID = '__central_demo__';

/**
 * F5b-3 seed gate: demo fixtures seed in every non-production environment
 * EXCEPT test (where fixed-id rows would race with per-test DB resets), and in
 * production ONLY under the explicit HOSTED_DEMO deployment flag (Kerry scope
 * decision, 2026-07-29) — that is what lets the hosted demo dashboards show
 * seeded content. Ordinary production never seeds.
 *
 * Fail-closed on unset/empty NODE_ENV: those are treated as production — the
 * same canonicalization every booted process already went through in
 * src/config/env.ts — so they seed only under the explicit HOSTED_DEMO flag,
 * never by default. A predicate that returned true for them unconditionally
 * would seed demo rows into a deployment that merely forgot to set NODE_ENV.
 */
export function shouldSeedDemoData(nodeEnv: string | undefined, hostedDemo: boolean): boolean {
  const effectiveEnv = nodeEnv?.trim() || 'production';
  if (effectiveEnv === 'test') return false;
  if (effectiveEnv === 'production') return hostedDemo;
  return true;
}
