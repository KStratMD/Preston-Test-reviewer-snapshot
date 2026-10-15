import { describe, it, expect, jest } from '@jest/globals';
import {
  TenantLifecycleService,
  InvalidTenantStatusTransitionError,
  TenantStatusConcurrencyError,
  PartialTenantRevocationError,
  TenantNotFoundError,
} from '../../../../src/services/tenants/TenantLifecycleService';
import type { TenantLifecycleRepository } from '../../../../src/services/tenants/TenantLifecycleRepository';

const mkRepo = (statusByTenant: Record<string, string> = {}): jest.Mocked<TenantLifecycleRepository> => ({
  findById: jest.fn(async (id: string) => statusByTenant[id]
    ? { id, status: statusByTenant[id], statusChangedAt: null, statusChangedBy: null,
        statusReason: null, createdAt: '', updatedAt: '' }
    : undefined) as any,
  ensureExists: jest.fn(async () => {}) as any,
  updateStatus: jest.fn(async () => {}) as any,
  recordAuditOnly: jest.fn(async () => {}) as any,
  listAudit: jest.fn(async () => []) as any,
}) as any;

describe('TenantLifecycleService', () => {
  it('auto-registers unknown tenant with active status on first read', async () => {
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    expect(await svc.getStatus('new-tenant')).toBe('active');
    expect(repo.ensureExists).toHaveBeenCalledWith('new-tenant');
  });

  it('caches reads within TTL', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    await svc.getStatus('t1');
    await svc.getStatus('t1');
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('pre-warms cache with the new status on setStatus (R5-2)', async () => {
    // R5-2 fix: setStatus replaces cache.delete with writeCache(newStatus).
    // After setStatus returns, the next getStatus must observe the new value
    // WITHOUT hitting the repo (cache hit, not miss).
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    await svc.setStatus({
      tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    });
    // Reset the findById counter; subsequent getStatus must serve from cache.
    const beforeCalls = (repo.findById as jest.Mock).mock.calls.length;
    expect(await svc.getStatus('t1')).toBe('disabled');
    expect((repo.findById as jest.Mock).mock.calls.length).toBe(beforeCalls);
  });

  it('setStatus throws TenantNotFoundError for unknown tenants (does NOT auto-register)', async () => {
    // R3-5: setStatus must NOT auto-register a typo'd tenant id. The R4-2
    // fresh-repo-read also means it doesn't go through the (cached)
    // peekStatus path either — it reads the repo directly so it can never be
    // blocked by a stale negative-cache miss.
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 'no-such-tenant', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(repo.ensureExists).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('setStatus bypasses negative-cache stale miss (R4-2)', async () => {
    // Stage 1: peekStatus on unknown sets a 60s negative cache entry.
    // Stage 2: row appears via another path (test stubs it on next findById call).
    // Stage 3: setStatus must observe the new row (bypassing the cached miss)
    // and succeed instead of throwing TenantNotFoundError.
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000, missTtlMs: 60_000 });
    expect(await svc.peekStatus('late-bloomer')).toBeNull(); // populates negative cache
    // Now a row exists (e.g. registered by another process).
    (repo.findById as jest.Mock).mockResolvedValueOnce({
      id: 'late-bloomer', status: 'active', statusChangedAt: null, statusChangedBy: null,
      statusReason: null, createdAt: '', updatedAt: '',
    } as any);
    // setStatus must NOT throw TenantNotFoundError — it reads the repo directly.
    await expect(svc.setStatus({
      tenantId: 'late-bloomer', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    })).resolves.toBeUndefined();
    expect(repo.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid transitions with a typed InvalidTenantStatusTransitionError', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'active', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(InvalidTenantStatusTransitionError);
    // Re-run to inspect the error's typed fields.
    let captured: unknown;
    try {
      await svc.setStatus({
        tenantId: 't1', newStatus: 'active', actorUserId: 'admin', actorSource: 'admin_route',
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(InvalidTenantStatusTransitionError);
    const e = captured as InvalidTenantStatusTransitionError;
    expect(e.fromStatus).toBe('active');
    expect(e.toStatus).toBe('active');
    expect(e.tenantId).toBe('t1');
  });

  it('peekStatus returns null for unknown tenants WITHOUT inserting a row', async () => {
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    expect(await svc.peekStatus('unknown-tenant')).toBeNull();
    expect(repo.ensureExists).not.toHaveBeenCalled();
  });

  it('peekStatus returns the current status for known tenants and caches it', async () => {
    const repo = mkRepo({ 't1': 'suspended' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    expect(await svc.peekStatus('t1')).toBe('suspended');
    expect(await svc.peekStatus('t1')).toBe('suspended');
    expect(repo.findById).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('peekStatus negative-caches unknown tenants (does not hammer the DB on repeat misses)', async () => {
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000, missTtlMs: 60_000 });
    expect(await svc.peekStatus('typo-tenant')).toBeNull();
    expect(await svc.peekStatus('typo-tenant')).toBeNull();
    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('getStatus IGNORES negative-cache entries (auto-register path must not bail on stale miss)', async () => {
    // Stage 1: peekStatus on unknown sets a negative-cache entry.
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000, missTtlMs: 60_000 });
    expect(await svc.peekStatus('late-bloomer')).toBeNull();
    // Stage 2: row appears in the DB (e.g. a real registration just happened).
    (repo.findById as jest.Mock).mockResolvedValueOnce(undefined as any);
    (repo.findById as jest.Mock).mockResolvedValueOnce({
      id: 'late-bloomer', status: 'active', statusChangedAt: null, statusChangedBy: null,
      statusReason: null, createdAt: '', updatedAt: '',
    } as any);
    // Stage 3: gate hits getStatus, must NOT short-circuit on the stale miss.
    expect(await svc.getStatus('late-bloomer')).toBe('active');
    expect(repo.ensureExists).toHaveBeenCalledWith('late-bloomer');
  });

  it('setStatus propagates TenantStatusConcurrencyError from the repository', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const conflictErr = new TenantStatusConcurrencyError('t1', 'active');
    (repo.updateStatus as jest.Mock).mockRejectedValueOnce(conflictErr);
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(TenantStatusConcurrencyError);
  });

  it('setStatus INVALIDATES cache on TenantStatusConcurrencyError (R8-2)', async () => {
    // R8-2: on CAS-race, local `current` is known-stale (concurrent writer
    // committed between our read and write). The cache must NOT be left with
    // the stale value — invalidate so the next read pulls fresh.
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    // Pre-populate cache.
    await svc.peekStatus('t1'); // caches 'active'
    expect((repo.findById as jest.Mock).mock.calls.length).toBe(1);
    // CAS race on next setStatus.
    (repo.updateStatus as jest.Mock).mockRejectedValueOnce(
      new TenantStatusConcurrencyError('t1', 'active'),
    );
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(TenantStatusConcurrencyError);
    // Cache should now be empty for t1; next peekStatus hits the repo.
    (repo.findById as jest.Mock).mockClear();
    await svc.peekStatus('t1');
    expect((repo.findById as jest.Mock).mock.calls.length).toBe(1);
  });

  it('setStatus INVALIDATES cache on invalid-transition throw (R10 / Codex IMPORTANT)', async () => {
    // Reverses R7-8's pre-warm behavior. Codex pointed out that `current` is
    // already possibly-stale by the time we go to cache it (a concurrent writer
    // could have committed between our findById and now). Caching it would
    // re-populate a known-possibly-stale value for up to ttlMs, and peekStatus
    // would return that to the admin GET. The safer default is cache.delete():
    // the next non-gate reader pays one DB round-trip and gets ground truth.
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    // Pre-populate cache so we can observe the invalidation.
    await svc.peekStatus('t1');
    expect((repo.findById as jest.Mock).mock.calls.length).toBe(1);
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'active', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(InvalidTenantStatusTransitionError);
    // Cache should now be empty for t1; next peekStatus must hit the repo.
    (repo.findById as jest.Mock).mockClear();
    expect(await svc.peekStatus('t1')).toBe('active');
    expect((repo.findById as jest.Mock).mock.calls.length).toBe(1);
  });

  it('invalid-transition throw does NOT mask a concurrent writer (R10 race-safety pin)', async () => {
    // Pins the exact race Codex called out:
    //   T1: setStatus reads `current = active`, computes invalid-transition.
    //   T2 (concurrent): another writer commits `disabled` and updates the row.
    //   T1: writes `current` (= 'active') to cache → would shadow disabled
    //       for up to ttlMs.
    // With the R10 fix, T1 instead deletes the cache entry, so the very next
    // peekStatus pulls 'disabled' from the repo on the first round-trip.
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'active', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(InvalidTenantStatusTransitionError);
    // Concurrent writer's effect: the next repo read returns 'disabled'.
    (repo.findById as jest.Mock).mockResolvedValueOnce({
      id: 't1', status: 'disabled', statusChangedAt: null, statusChangedBy: null,
      statusReason: null, createdAt: '', updatedAt: '',
    } as any);
    // peekStatus must reflect ground truth, not a stale cached 'active'.
    expect(await svc.peekStatus('t1')).toBe('disabled');
  });

  it('setStatus throws PartialTenantRevocationError + writes audit when revoke fails after commit', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const revokeErr = new Error('downstream token store unreachable');
    const tokenRepo = { revokeAllForTenant: jest.fn(async () => { throw revokeErr; }) } as any;
    const svc = new TenantLifecycleService(repo, tokenRepo, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route', reason: 'kill it',
    })).rejects.toBeInstanceOf(PartialTenantRevocationError);
    // updateStatus committed FIRST, then revoke failed.
    expect(repo.updateStatus).toHaveBeenCalledTimes(1);
    expect(tokenRepo.revokeAllForTenant).toHaveBeenCalledWith('t1');
    // Side-effect audit row written with the distinguishable actor_source.
    expect(repo.recordAuditOnly).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1',
      previousStatus: 'disabled',
      newStatus: 'disabled',
      actorSource: 'partial_revocation_failed',
      reason: expect.stringContaining('downstream token store unreachable'),
    }));
  });

  it('setStatus still throws PartialTenantRevocationError even if audit insert also fails', async () => {
    // Audit failure must NOT mask the original revocation error.
    const repo = mkRepo({ 't1': 'active' });
    (repo.recordAuditOnly as jest.Mock).mockRejectedValueOnce(new Error('audit DB down'));
    const tokenRepo = { revokeAllForTenant: jest.fn(async () => { throw new Error('revoke down'); }) } as any;
    const svc = new TenantLifecycleService(repo, tokenRepo, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(PartialTenantRevocationError);
  });

  it('caches getStatus reads with FIFO eviction when cacheMaxEntries is exceeded', async () => {
    const repo = mkRepo({ 't1': 'active', 't2': 'active', 't3': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000, cacheMaxEntries: 2 });
    await svc.getStatus('t1');
    await svc.getStatus('t2');
    await svc.getStatus('t3'); // evicts t1 (oldest)
    // Counters reset before re-reads — t1 must re-hit repo because evicted.
    (repo.findById as jest.Mock).mockClear();
    await svc.getStatus('t1');
    expect(repo.findById).toHaveBeenCalledTimes(1);
    (repo.findById as jest.Mock).mockClear();
    await svc.getStatus('t3');
    expect(repo.findById).not.toHaveBeenCalled(); // t3 still cached
  });

  it('requireActive throws TenantBlockedError for blocked tenants', async () => {
    const repo = mkRepo({ 't1': 'suspended' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.requireActive('t1')).rejects.toMatchObject({
      name: 'TenantBlockedError', status: 'suspended', reason: 'tenant_suspended',
    });
  });

  it('requireActive passes for active tenants', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.requireActive('t1')).resolves.toBeUndefined();
  });

  it('requireActive BYPASSES positive cache so the kill switch stops cold (Codex P1)', async () => {
    // Codex P1: getStatus caches positive status for ttlMs, so if another
    // process flips a tenant to disabled, the local cache would still let
    // requests through for up to ttlMs. requireActive must read DURABLE
    // status directly. This test pins the bypass:
    //   1. Pre-populate cache by calling requireActive against an active tenant.
    //   2. Switch the repo's underlying value to 'disabled' (simulating
    //      another process flipping it).
    //   3. The very next requireActive() call MUST hit the repo and throw
    //      TenantBlockedError — NOT short-circuit on the stale cache entry.
    const statusByTenant = { 't1': 'active' };
    const repo = mkRepo(statusByTenant);
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    await svc.requireActive('t1'); // populates cache as 'active'
    // Concurrent process flips the tenant.
    (repo.findById as jest.Mock).mockResolvedValueOnce({
      id: 't1', status: 'disabled', statusChangedAt: null, statusChangedBy: null,
      statusReason: null, createdAt: '', updatedAt: '',
    } as any);
    await expect(svc.requireActive('t1')).rejects.toMatchObject({
      name: 'TenantBlockedError', status: 'disabled',
    });
  });

  it('requireActive auto-registers an unknown tenant id (gate cold-path)', async () => {
    const repo = mkRepo();
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 60_000 });
    // First call: no row exists, ensureExists fires, then a second findById.
    await expect(svc.requireActive('cold-tenant')).resolves.toBeUndefined();
    expect(repo.ensureExists).toHaveBeenCalledWith('cold-tenant');
  });

  it('revokes embedded service tokens when transitioning into blocked state', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const tokenRepo = { revokeAllForTenant: jest.fn(async () => 3) } as any;
    const svc = new TenantLifecycleService(repo, tokenRepo, { ttlMs: 1000 });
    await svc.setStatus({ tenantId: 't1', newStatus: 'disabled', actorUserId: 'admin', actorSource: 'admin_route' });
    expect(tokenRepo.revokeAllForTenant).toHaveBeenCalledWith('t1');
  });

  it('does NOT revoke tokens when transitioning blocked->active', async () => {
    const repo = mkRepo({ 't1': 'suspended' });
    const tokenRepo = { revokeAllForTenant: jest.fn(async () => 0) } as any;
    const svc = new TenantLifecycleService(repo, tokenRepo, { ttlMs: 1000 });
    await svc.setStatus({ tenantId: 't1', newStatus: 'active', actorUserId: 'admin', actorSource: 'admin_route' });
    expect(tokenRepo.revokeAllForTenant).not.toHaveBeenCalled();
  });

  it('works without a tokenRepo (optional dependency)', async () => {
    const repo = mkRepo({ 't1': 'active' });
    const svc = new TenantLifecycleService(repo, undefined, { ttlMs: 1000 });
    await expect(svc.setStatus({
      tenantId: 't1', newStatus: 'suspended', actorUserId: 'admin', actorSource: 'admin_route',
    })).resolves.toBeUndefined();
  });
});
