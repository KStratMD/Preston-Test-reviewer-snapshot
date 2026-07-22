// Typed error hierarchy for the tenant kill switch.
//
// Living in its own file so both TenantLifecycleService and
// TenantLifecycleRepository can import from it without creating a cycle.
// Admin route narrows on these classes for the HTTP-status dispatch:
//   - TenantNotFoundError                → 404 (no row exists for this id)
//   - InvalidTenantStatusTransitionError → 400 (caller asked impossible)
//   - TenantStatusConcurrencyError       → 409 (someone got there first)
//   - PartialTenantRevocationError       → 500 with `code: partial_revocation_failed`
//   - TenantBlockedError                 → raised by requireActive() in the gate; 403

import type { TenantStatus } from './TenantStatus';

// Raised by setStatus (pre-check via peekStatus) and by the repository when an
// updateStatus targets a tenant id that has no row. Distinct from
// TenantStatusConcurrencyError (which means "row exists but status changed
// between read and write"). Admin route maps to 404.
export class TenantNotFoundError extends Error {
  name = 'TenantNotFoundError';
  constructor(public readonly tenantId: string) {
    super(`tenant ${tenantId} not found`);
  }
}

export class TenantBlockedError extends Error {
  name = 'TenantBlockedError';
  constructor(
    public readonly tenantId: string,
    public readonly status: TenantStatus,
    public readonly reason: string,
  ) {
    super(`tenant ${tenantId} is ${status}`);
  }
}

export class InvalidTenantStatusTransitionError extends Error {
  name = 'InvalidTenantStatusTransitionError';
  constructor(
    public readonly tenantId: string,
    public readonly fromStatus: TenantStatus,
    public readonly toStatus: TenantStatus,
  ) {
    super(`invalid transition for tenant ${tenantId}: ${fromStatus} -> ${toStatus}`);
  }
}

// Raised by the repository's CAS path when a concurrent update changed the
// row between the service's read and the conditional UPDATE. Different from
// InvalidTenantStatusTransitionError (400-level "you asked for an impossible
// transition") — this is 409 "someone got there first, retry".
export class TenantStatusConcurrencyError extends Error {
  name = 'TenantStatusConcurrencyError';
  constructor(public readonly tenantId: string, public readonly expectedFrom: TenantStatus) {
    super(`tenant ${tenantId} status changed concurrently (expected previous=${expectedFrom})`);
  }
}

// Raised when the status flip committed successfully but the side-effect to
// revoke embedded service tokens failed. The tenant IS now blocked at the
// status layer, but stale tokens may still be in flight until the failure
// is reconciled. The admin route surfaces this with a distinguishable
// `code: 'partial_revocation_failed'` so an operator knows to re-attempt
// revocation explicitly. A best-effort audit row with
// actor_source='partial_revocation_failed' is also written before throwing.
export class PartialTenantRevocationError extends Error {
  name = 'PartialTenantRevocationError';
  constructor(
    public readonly tenantId: string,
    public readonly newStatus: TenantStatus,
    public readonly cause: unknown,
  ) {
    super(`tenant ${tenantId} flipped to ${newStatus} but token revocation failed`);
  }
}
