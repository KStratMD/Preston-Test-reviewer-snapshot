export type TenantStatus = 'active' | 'suspended' | 'disabled' | 'trial_expired';

// Narrow type for the three "tenant is blocked from interacting with the
// system" states. Used to constrain gateReason() so the empty-string sentinel
// for 'active' is unreachable by construction — callers can't pass 'active'
// because TypeScript will reject the call site.
export type BlockedTenantStatus = Exclude<TenantStatus, 'active'>;

export const ALL_TENANT_STATUSES: readonly TenantStatus[] = [
  'active',
  'suspended',
  'disabled',
  'trial_expired',
];
const TENANT_STATUS_SET = new Set<string>(ALL_TENANT_STATUSES);

export const ACTIVE_STATES = new Set<TenantStatus>(['active']);
export const BLOCKED_STATES = new Set<TenantStatus>(['suspended', 'disabled', 'trial_expired']);

export function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === 'string' && TENANT_STATUS_SET.has(value);
}

// Defence-in-depth runtime check for values read out of the DB. The CHECK
// constraint guards writes through Kysely, but a manual UPDATE, a forked
// migration, or a future schema change could surface a row whose status is
// outside the union — without this assert, downstream code (gate response,
// cache, audit list) would silently propagate the bad value. Throw loudly
// instead so the bug surfaces at the read boundary.
export function assertTenantStatus(value: unknown, ctx: string): TenantStatus {
  if (!isTenantStatus(value)) {
    throw new Error(
      `invalid TenantStatus from DB (${ctx}): ${String(value)} ` +
      `(allowed: ${ALL_TENANT_STATUSES.join(', ')})`,
    );
  }
  return value;
}

const ALLOWED: Record<TenantStatus, TenantStatus[]> = {
  active: ['suspended', 'disabled', 'trial_expired'],
  suspended: ['active', 'disabled'],
  disabled: ['active'],
  trial_expired: ['active'],
};

export function isValidTransition(from: TenantStatus, to: TenantStatus): boolean {
  if (from === to) return false;
  return ALLOWED[from].includes(to);
}

// User-defined type guard: after isBlocked(s) narrows s to BlockedTenantStatus
// so gateReason(s) typechecks without a cast at the call site.
export function isBlocked(status: TenantStatus): status is BlockedTenantStatus {
  return BLOCKED_STATES.has(status);
}

// Constrained to BlockedTenantStatus so the compiler rejects gateReason('active')
// at the call site. The exhaustive switch over the three blocked states gives
// us a real string in every reachable branch.
export function gateReason(status: BlockedTenantStatus): string {
  switch (status) {
    case 'suspended': return 'tenant_suspended';
    case 'disabled': return 'tenant_disabled';
    case 'trial_expired': return 'trial_expired';
  }
}
