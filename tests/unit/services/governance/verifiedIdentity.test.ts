/**
 * Core-profile suite for the strict verified-identity helpers.
 *
 * This imports the IMPLEMENTATION module (src/services/governance/
 * verifiedIdentity.ts) directly, not the src/routes/utils/verifiedIdentity.ts
 * alias. The sibling suite tests/unit/routes/utils/verifiedIdentity.test.ts
 * deliberately imports through the alias to prove the re-export forwards; that
 * is a different assertion and it belongs in the route-layer profile. Here the
 * point is the coverage floor in .core-coverage-budget.json, so the import must
 * name the file the ratchet measures — otherwise a future change to the alias
 * (or its deletion) would decide whether this security module is measured.
 *
 * Every branch of all three exports is exercised: the module is the single
 * place that decides whether a request can attribute a durable write, and a
 * per-file floor is only meaningful if it starts high.
 */
import type { Request } from 'express';
import {
  verifiedUserId,
  verifiedTenantId,
  verifiedIdentity,
} from '../../../../src/services/governance/verifiedIdentity';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

function reqWith(user?: unknown): Request {
  return { user } as unknown as Request;
}

describe('verifiedIdentity (services/governance) — core profile', () => {
  describe('verifiedUserId', () => {
    it('returns the verified id', () => {
      expect(verifiedUserId(reqWith({ id: 'user-1', tenantId: 't-1' }))).toBe('user-1');
    });

    it('returns the id with no tenant claim present — it does not read tenantId', () => {
      expect(verifiedUserId(reqWith({ id: 'user-1' }))).toBe('user-1');
    });

    it('accepts a real id alongside a SENTINEL tenant (the platform-global contract)', () => {
      // /api/sync-orchestrator relies on this: a platform-admin surface has no
      // tenant to name, so the tenant claim is out of scope for this helper.
      expect(verifiedUserId(reqWith({ id: 'admin-1', tenantId: SYSTEM_IDENTITY.tenantId })))
        .toBe('admin-1');
    });

    it('returns null when req.user is absent', () => {
      expect(verifiedUserId(reqWith(undefined))).toBeNull();
    });

    it('returns null for a non-string id rather than coercing it', () => {
      expect(verifiedUserId(reqWith({ id: 42, tenantId: 't-1' }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: {}, tenantId: 't-1' }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: null, tenantId: 't-1' }))).toBeNull();
    });

    it('returns null for an empty or whitespace-only id', () => {
      expect(verifiedUserId(reqWith({ id: '', tenantId: 't-1' }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: '   ', tenantId: 't-1' }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: '\t\n', tenantId: 't-1' }))).toBeNull();
    });

    it('returns null for the sentinel id, padded or not', () => {
      expect(verifiedUserId(reqWith({ id: SYSTEM_IDENTITY.userId }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: ` ${SYSTEM_IDENTITY.userId} ` }))).toBeNull();
    });

    it('returns the TRIMMED id so one operator cannot mint two audit identities', () => {
      expect(verifiedUserId(reqWith({ id: ' user-1 ' }))).toBe('user-1');
    });
  });

  describe('verifiedTenantId', () => {
    it('returns the verified tenant', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: 't-1' }))).toBe('t-1');
    });

    it('returns the tenant with no id claim present — it does not read id', () => {
      expect(verifiedTenantId(reqWith({ tenantId: 't-1' }))).toBe('t-1');
    });

    it('accepts a real tenant alongside a SENTINEL user id (tenant-scoped reads)', () => {
      expect(verifiedTenantId(reqWith({ id: SYSTEM_IDENTITY.userId, tenantId: 't-1' }))).toBe('t-1');
    });

    it('returns null when req.user is absent', () => {
      expect(verifiedTenantId(reqWith(undefined))).toBeNull();
    });

    it('returns null for a non-string tenant claim rather than coercing it', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: 42 }))).toBeNull();
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: {} }))).toBeNull();
    });

    it('returns null for an empty or whitespace-only tenant claim', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: '' }))).toBeNull();
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: '   ' }))).toBeNull();
    });

    it('returns null for the sentinel tenant, padded or not', () => {
      expect(verifiedTenantId(reqWith({ tenantId: SYSTEM_IDENTITY.tenantId }))).toBeNull();
      expect(verifiedTenantId(reqWith({ tenantId: ` ${SYSTEM_IDENTITY.tenantId} ` }))).toBeNull();
    });

    it('returns the TRIMMED tenant', () => {
      expect(verifiedTenantId(reqWith({ tenantId: ' t-1 ' }))).toBe('t-1');
    });
  });

  describe('verifiedIdentity', () => {
    it('returns both trimmed claims when both are verified', () => {
      expect(verifiedIdentity(reqWith({ id: ' user-1 ', tenantId: ' t-1 ' })))
        .toEqual({ tenantId: 't-1', userId: 'user-1' });
    });

    it('returns null when req.user is absent', () => {
      expect(verifiedIdentity(reqWith(undefined))).toBeNull();
    });

    it('returns null when only the user id is verifiable', () => {
      expect(verifiedIdentity(reqWith({ id: 'user-1' }))).toBeNull();
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: '' }))).toBeNull();
    });

    it('returns null when only the tenant is verifiable', () => {
      expect(verifiedIdentity(reqWith({ tenantId: 't-1' }))).toBeNull();
      expect(verifiedIdentity(reqWith({ id: '', tenantId: 't-1' }))).toBeNull();
    });

    it('returns null for a sentinel in EITHER claim', () => {
      expect(verifiedIdentity(reqWith({ id: SYSTEM_IDENTITY.userId, tenantId: 't-1' }))).toBeNull();
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: SYSTEM_IDENTITY.tenantId }))).toBeNull();
    });

    it('returns null for a padded sentinel in EITHER claim', () => {
      expect(verifiedIdentity(reqWith({ id: ` ${SYSTEM_IDENTITY.userId} `, tenantId: 't-1' }))).toBeNull();
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: ` ${SYSTEM_IDENTITY.tenantId} ` }))).toBeNull();
    });
  });
});
