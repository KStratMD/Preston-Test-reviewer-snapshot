import { describe, it, expect } from '@jest/globals';
import type {
  EmbeddedContext,
  EmbeddedNavigationEntry,
  EmbeddedPlatform,
} from '../../../src/embedded/contract/EmbeddedSurfaceContract';
import {
  ENVELOPE_VERSION,
  MAX_RETAINED_TOKENS,
  MIN_ROTATION_INTERVAL_MS,
  ROTATION_GRACE_MS,
  SESSION_MAX_LIFETIME_MS,
} from '../../../src/embedded/contract/PostMessageProtocol';

describe('EmbeddedSurfaceContract — type shape', () => {
  it('EmbeddedContext is structurally complete', () => {
    const ctx: EmbeddedContext = {
      tenantId: 't1',
      userId: 'u1',
      userRoles: ['finance'],
      platform: 'netsuite',
      platformAccountId: '12345',
      sessionId: 'es_abc',
      sessionExpiresAt: new Date().toISOString(),
      expectedHostOrigin: 'https://12345.app.netsuite.com',
      csrfToken: 'csrf_xyz',
    };
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.platform).toBe('netsuite');
  });

  it('EmbeddedPlatform enumerates the contract-locked set', () => {
    const platforms: EmbeddedPlatform[] = ['netsuite', 'business_central', 'standalone'];
    // Verify each shape compiles + assignment works.
    platforms.forEach((p) => expect(typeof p).toBe('string'));
  });

  it('EmbeddedNavigationEntry covers the seven modules', () => {
    const entries: EmbeddedNavigationEntry[] = [
      { module: 'reconciliation', label: 'Recon', href: '/recon', requiredRoles: ['finance'] },
      { module: 'lineage', label: 'Lineage', href: '/lineage', requiredRoles: ['ops'] },
      { module: 'approvals', label: 'Approvals', href: '/approvals', requiredRoles: ['approver'] },
      { module: 'sync_health', label: 'Sync', href: '/sync', requiredRoles: ['ops'] },
      { module: 'compliance', label: 'Compliance', href: '/compliance', requiredRoles: ['admin'] },
      { module: 'flow_templates', label: 'Templates', href: '/flow-templates', requiredRoles: ['admin'] },
      { module: 'sync_error_triage', label: 'Sync Error Triage', href: '/embedded/sync-error-triage.html', requiredRoles: ['ops'] },
    ];
    expect(entries).toHaveLength(7);
  });
});

describe('PostMessageProtocol — constants drift tripwires', () => {
  it('SESSION_MAX_LIFETIME_MS is 8 hours', () => {
    expect(SESSION_MAX_LIFETIME_MS).toBe(8 * 60 * 60 * 1000);
  });

  it('ROTATION_GRACE_MS is 30 seconds', () => {
    expect(ROTATION_GRACE_MS).toBe(30_000);
  });

  it('MIN_ROTATION_INTERVAL_MS is 10 seconds', () => {
    expect(MIN_ROTATION_INTERVAL_MS).toBe(10_000);
  });

  it('MAX_RETAINED_TOKENS is the documented derived ceiling', () => {
    // ceil(30000 / 10000) + 1 = 4 — sized so the 30s grace is achievable
    // under the 10s rotation throttle without pre-grace eviction.
    expect(MAX_RETAINED_TOKENS).toBe(4);
  });

  it('ENVELOPE_VERSION is 1', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});
