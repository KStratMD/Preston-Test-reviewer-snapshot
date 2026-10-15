import { describe, it, expect } from '@jest/globals';
import {
  TenantStatus,
  isValidTransition,
  ACTIVE_STATES,
  BLOCKED_STATES,
  ALL_TENANT_STATUSES,
  isTenantStatus,
  assertTenantStatus,
} from '../../../../src/services/tenants/TenantStatus';

describe('TenantStatus state machine', () => {
  it('exposes all four states', () => {
    const all: TenantStatus[] = ['active', 'suspended', 'disabled', 'trial_expired'];
    expect(all).toHaveLength(4);
  });

  it('classifies active vs blocked states', () => {
    expect(ACTIVE_STATES).toEqual(new Set(['active']));
    expect(BLOCKED_STATES).toEqual(new Set(['suspended', 'disabled', 'trial_expired']));
  });

  it('allows active→suspended, active→disabled, active→trial_expired', () => {
    expect(isValidTransition('active', 'suspended')).toBe(true);
    expect(isValidTransition('active', 'disabled')).toBe(true);
    expect(isValidTransition('active', 'trial_expired')).toBe(true);
  });

  it('allows reactivation from any blocked state', () => {
    expect(isValidTransition('suspended', 'active')).toBe(true);
    expect(isValidTransition('disabled', 'active')).toBe(true);
    expect(isValidTransition('trial_expired', 'active')).toBe(true);
  });

  it('allows suspended→disabled escalation', () => {
    expect(isValidTransition('suspended', 'disabled')).toBe(true);
  });

  it('rejects same-state and disabled→trial_expired non-transitions', () => {
    expect(isValidTransition('active', 'active')).toBe(false);
    expect(isValidTransition('disabled', 'trial_expired')).toBe(false);
    expect(isValidTransition('trial_expired', 'suspended')).toBe(false);
  });
});

describe('TenantStatus runtime validation (assert/normalize helpers)', () => {
  it('ALL_TENANT_STATUSES is the canonical union enumeration', () => {
    expect([...ALL_TENANT_STATUSES].sort()).toEqual(
      ['active', 'disabled', 'suspended', 'trial_expired'],
    );
  });

  it('isTenantStatus accepts every valid status', () => {
    for (const s of ALL_TENANT_STATUSES) expect(isTenantStatus(s)).toBe(true);
  });

  it('isTenantStatus rejects bogus strings, numbers, null, undefined, objects', () => {
    expect(isTenantStatus('bogus')).toBe(false);
    expect(isTenantStatus('')).toBe(false);
    expect(isTenantStatus(42 as unknown)).toBe(false);
    expect(isTenantStatus(null)).toBe(false);
    expect(isTenantStatus(undefined)).toBe(false);
    expect(isTenantStatus({})).toBe(false);
  });

  it('assertTenantStatus returns the narrowed status for valid input', () => {
    const got = assertTenantStatus('disabled', 'unit-test');
    expect(got).toBe('disabled');
  });

  it('assertTenantStatus throws loudly with context for invalid input', () => {
    expect(() => assertTenantStatus('bogus', 'tenants.status (id=t1)'))
      .toThrow(/invalid TenantStatus from DB \(tenants\.status \(id=t1\)\): bogus/);
  });
});
