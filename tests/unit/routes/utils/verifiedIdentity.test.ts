/**
 * The ai-proxy routers previously read identity through
 * extractIdentityContext, whose fallback attributes an unidentifiable request
 * to the retired __system__ sentinel. These helpers replace it with a
 * narrowing over the VERIFIED req.user that the F2 policy gate guarantees at
 * every one of those handlers, and return null rather than a sentinel when
 * that guarantee is somehow absent.
 */
import type { Request } from 'express';
import { verifiedUserId, verifiedIdentity, verifiedTenantId } from '../../../../src/routes/utils/verifiedIdentity';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

function reqWith(user?: unknown): Request {
  return { user } as unknown as Request;
}

describe('verified identity helpers', () => {
  describe('verifiedUserId', () => {
    it('returns the id for a verified user', () => {
      expect(verifiedUserId(reqWith({ id: 'user-1', tenantId: 't-1' }))).toBe('user-1');
    });

    it('returns the id even when no tenant claim is present (user-scoped sites)', () => {
      expect(verifiedUserId(reqWith({ id: 'user-1' }))).toBe('user-1');
    });

    it('returns null when there is no user at all', () => {
      expect(verifiedUserId(reqWith(undefined))).toBeNull();
    });

    it('returns null for a blank id', () => {
      expect(verifiedUserId(reqWith({ id: '', tenantId: 't-1' }))).toBeNull();
    });

    it('refuses the system sentinel rather than echoing it', () => {
      expect(verifiedUserId(reqWith({ id: SYSTEM_IDENTITY.userId, tenantId: 't-1' }))).toBeNull();
    });
  });

  describe('verifiedTenantId', () => {
    it('returns the tenant for a verified user', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: 't-1' }))).toBe('t-1');
    });

    it('returns the tenant even when no user id claim is present', () => {
      // Tenant-scoped READ handlers narrow the tenant alone; requiring an id
      // here would tighten those reads beyond the sentinel fix.
      expect(verifiedTenantId(reqWith({ tenantId: 't-1' }))).toBe('t-1');
    });

    it('returns null when there is no user at all', () => {
      expect(verifiedTenantId(reqWith(undefined))).toBeNull();
    });

    it('returns null for a blank tenant claim', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: '' }))).toBeNull();
    });

    it('returns null for a non-string tenant claim rather than coercing it', () => {
      expect(verifiedTenantId({ user: { id: 'u1', tenantId: 42 } } as unknown as Request)).toBeNull();
    });

    it('refuses the system tenant sentinel rather than echoing it', () => {
      expect(verifiedTenantId(reqWith({ id: 'user-1', tenantId: SYSTEM_IDENTITY.tenantId }))).toBeNull();
    });
  });

  describe('verifiedIdentity', () => {
    it('returns both claims when both are present', () => {
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: 't-1' })))
        .toEqual({ tenantId: 't-1', userId: 'user-1' });
    });

    it('returns null when the tenant claim is missing', () => {
      expect(verifiedIdentity(reqWith({ id: 'user-1' }))).toBeNull();
    });

    it('returns null for a blank tenant claim', () => {
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: '' }))).toBeNull();
    });

    it('refuses the system tenant sentinel', () => {
      expect(verifiedIdentity(reqWith({ id: 'user-1', tenantId: SYSTEM_IDENTITY.tenantId }))).toBeNull();
    });

    it('returns null when there is no user at all', () => {
      expect(verifiedIdentity(reqWith(undefined))).toBeNull();
    });
  });

  describe('no String() coercion (PR3)', () => {
    it('rejects a non-string user id instead of coercing it', () => {
      const req = { user: { id: 42, tenantId: 't1' } } as unknown as Request;
      expect(verifiedUserId(req)).toBeNull();
      expect(verifiedIdentity(req)).toBeNull();
    });

    it('rejects an object user id rather than producing "[object Object]"', () => {
      const req = { user: { id: {}, tenantId: 't1' } } as unknown as Request;
      expect(verifiedUserId(req)).toBeNull();
    });
  });

  /**
   * Copilot R1 (#1087). The sibling module `src/middleware/verifiedAdmin.ts`
   * already trims before comparing (`readActorId` :42, `readTenantId` :55-59),
   * so without trimming here the two disagree on the SAME token: a padded
   * sentinel is the sentinel to verifiedAdmin but a legitimate id to us — and
   * our value is what reaches guardedWrite and the durable audit_logs row.
   */
  describe('whitespace normalization (Copilot R1, #1087)', () => {
    const padded = (v: string) => ` ${v} `;

    it('rejects a whitespace-padded sentinel user id', () => {
      expect(verifiedUserId(reqWith({ id: padded(SYSTEM_IDENTITY.userId), tenantId: 't-1' }))).toBeNull();
    });

    it('rejects a whitespace-padded sentinel tenant id', () => {
      expect(verifiedTenantId(reqWith({ id: 'u-1', tenantId: padded(SYSTEM_IDENTITY.tenantId) }))).toBeNull();
    });

    it('rejects a padded sentinel through verifiedIdentity, in either claim', () => {
      expect(verifiedIdentity(reqWith({ id: padded(SYSTEM_IDENTITY.userId), tenantId: 't-1' }))).toBeNull();
      expect(verifiedIdentity(reqWith({ id: 'u-1', tenantId: padded(SYSTEM_IDENTITY.tenantId) }))).toBeNull();
    });

    it('rejects a whitespace-only user id rather than attributing a blank actor', () => {
      expect(verifiedUserId(reqWith({ id: '   ', tenantId: 't-1' }))).toBeNull();
      expect(verifiedUserId(reqWith({ id: '\t\n', tenantId: 't-1' }))).toBeNull();
    });

    it('rejects a whitespace-only tenant id rather than scoping to a blank tenant', () => {
      expect(verifiedTenantId(reqWith({ id: 'u-1', tenantId: '   ' }))).toBeNull();
    });

    it('returns the TRIMMED value so one operator cannot produce two audit identities', () => {
      expect(verifiedUserId(reqWith({ id: ' user-1 ', tenantId: ' t-1 ' }))).toBe('user-1');
      expect(verifiedTenantId(reqWith({ id: ' user-1 ', tenantId: ' t-1 ' }))).toBe('t-1');
      expect(verifiedIdentity(reqWith({ id: ' user-1 ', tenantId: ' t-1 ' })))
        .toEqual({ tenantId: 't-1', userId: 'user-1' });
    });
  });

  describe('sentinel rejection — the fullPipelineDemo/hubSpot gap (PR3)', () => {
    it('verifiedIdentity rejects a sentinel tenant with a real user', () => {
      const req = { user: { id: 'u1', tenantId: SYSTEM_IDENTITY.tenantId } } as unknown as Request;
      expect(verifiedIdentity(req)).toBeNull();
    });

    it('verifiedIdentity rejects a real tenant with a sentinel user', () => {
      const req = { user: { id: SYSTEM_IDENTITY.userId, tenantId: 't1' } } as unknown as Request;
      expect(verifiedIdentity(req)).toBeNull();
    });

    it('verifiedUserId rejects a sentinel user id', () => {
      const req = { user: { id: SYSTEM_IDENTITY.userId, tenantId: 't1' } } as unknown as Request;
      expect(verifiedUserId(req)).toBeNull();
    });

    it('verifiedUserId does NOT inspect tenantId — a sentinel tenant with a real user passes', () => {
      // Documents the platform-global contract deliberately. This is the shape
      // /api/sync-orchestrator accepts; asserting it prevents a future
      // "hardening" change from silently breaking that surface.
      const req = { user: { id: 'admin-1', tenantId: SYSTEM_IDENTITY.tenantId } } as unknown as Request;
      expect(verifiedUserId(req)).toBe('admin-1');
    });
  });
});
