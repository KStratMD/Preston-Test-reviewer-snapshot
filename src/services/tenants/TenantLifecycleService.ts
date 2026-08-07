import { injectable, inject, optional, unmanaged } from 'inversify';
import { TYPES } from '../../inversify/types';
import { TenantLifecycleRepository } from './TenantLifecycleRepository';
import { TenantStatus, isValidTransition, isBlocked, gateReason } from './TenantStatus';
import type { EmbeddedServiceTokenRepository } from '../embedded/EmbeddedServiceTokenRepository';
import {
  TenantBlockedError,
  InvalidTenantStatusTransitionError,
  TenantStatusConcurrencyError,
  PartialTenantRevocationError,
  TenantNotFoundError,
} from './TenantErrors';

// Re-export typed errors so existing call sites (admin route, gate, tests)
// can keep importing from the service module — TenantErrors.ts is the
// internal home but this module is the public surface.
export {
  TenantBlockedError,
  InvalidTenantStatusTransitionError,
  TenantStatusConcurrencyError,
  PartialTenantRevocationError,
  TenantNotFoundError,
} from './TenantErrors';

export interface SetStatusInput {
  tenantId: string;
  newStatus: TenantStatus;
  actorUserId: string;
  actorSource: string;
  reason?: string;
}

export interface TenantLifecycleServiceOptions {
  ttlMs?: number;
  // TTL for negative cache entries (peekStatus calls that returned null
  // because the row did not exist). Kept much shorter than ttlMs so a real
  // registration is observable promptly. Defaults to 5_000 ms.
  missTtlMs?: number;
  cacheMaxEntries?: number;
}

// status === null is the negative-cache sentinel: the tenant row did not
// exist as of the last DB read. Cached with the shorter TTL below so that a
// real registration is reflected quickly without spamming the DB on each
// admin GET against a typo'd id.
interface CacheEntry { status: TenantStatus | null; expiresAt: number; }

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MISS_TTL_MS = 5_000;
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

@injectable()
export class TenantLifecycleService {
  // Map preserves insertion order, so the oldest entry is at the head — used for
  // FIFO eviction when we hit cacheMaxEntries. Keeps the cache bounded for
  // long-lived processes where the tenant-id set can grow without limit.
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly missTtlMs: number;
  private readonly cacheMaxEntries: number;

  constructor(
    @inject(TYPES.TenantLifecycleRepository) private readonly repo: TenantLifecycleRepository,
    @inject(TYPES.EmbeddedServiceTokenRepository) @optional()
      private readonly tokenRepo: EmbeddedServiceTokenRepository | undefined,
    @unmanaged() options: TenantLifecycleServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.missTtlMs = options.missTtlMs ?? DEFAULT_MISS_TTL_MS;
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  }

  async getStatus(tenantId: string): Promise<TenantStatus> {
    const cached = this.cache.get(tenantId);
    // Only positive cache entries short-circuit here; negative entries fall
    // through so we re-attempt registration (getStatus is the auto-register
    // path used by the gate, which must NOT bail on stale miss).
    if (cached && cached.status !== null && cached.expiresAt > Date.now()) return cached.status;
    let row = await this.repo.findById(tenantId);
    if (!row) {
      await this.repo.ensureExists(tenantId);
      row = await this.repo.findById(tenantId);
    }
    const status = (row?.status ?? 'active') as TenantStatus;
    this.writeCache(tenantId, status, this.ttlMs);
    return status;
  }

  // Read-only variant of getStatus. Returns null for unknown tenant ids
  // WITHOUT inserting a row, so GET endpoints and gate-style probes stay
  // side-effect-free and can't be used to spam-create tenant rows. Callers
  // (e.g. the admin GET route) distinguish "tenant exists" from "no such
  // tenant" via this null vs status return value.
  async peekStatus(tenantId: string): Promise<TenantStatus | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
    const row = await this.repo.findById(tenantId);
    if (!row) {
      // Negative cache with a shorter TTL so a real registration is observed
      // quickly while repeat probes against typo'd ids don't hammer the DB.
      this.writeCache(tenantId, null, this.missTtlMs);
      return null;
    }
    const status = row.status as TenantStatus;
    this.writeCache(tenantId, status, this.ttlMs);
    return status;
  }

  async setStatus(input: SetStatusInput): Promise<void> {
    // Read the current row DIRECTLY from the repo (bypassing both positive AND
    // negative cache). The negative cache has a short TTL by design, but a
    // stale miss would otherwise block writes for up to missTtlMs against a
    // tenant that was JUST registered through another path (different process,
    // direct migration, future caller). The write path needs ground truth.
    const fresh = await this.repo.findById(input.tenantId);
    if (!fresh) {
      throw new TenantNotFoundError(input.tenantId);
    }
    const current = fresh.status;
    if (!isValidTransition(current, input.newStatus)) {
      // Invalid-transition throw (R10 / Codex IMPORTANT): we just read
      // `current` from the repo, BUT another writer can commit a status
      // change in the window between this findById and the moment we cache.
      // Writing `current` to the cache here would re-populate a value that
      // is already known to be possibly-stale, and peekStatus (which DOES
      // read the cache) would then return the stale value to the admin GET
      // for up to ttlMs. Delete the cache entry instead so the next non-gate
      // reader pays one DB round-trip and gets ground truth. This is the
      // safer-default Codex recommended; the (small) optimization of pre-
      // warming on the happy invalid-transition path is not worth the
      // staleness window on the unhappy one.
      this.cache.delete(input.tenantId);
      throw new InvalidTenantStatusTransitionError(input.tenantId, current, input.newStatus);
    }
    // CAS-conditioned UPDATE inside a tx; throws TenantStatusConcurrencyError
    // if the row's status moved between our read and the write. On that throw
    // path, our local `current` is now KNOWN-STALE (someone else committed
    // between our findById and our conditional UPDATE), so we MUST NOT cache
    // it — we invalidate the cache entry instead. Bubbles the error up
    // unchanged for the admin route to translate to 409.
    try {
      await this.repo.updateStatus({
        tenantId: input.tenantId, previousStatus: current, newStatus: input.newStatus,
        actorUserId: input.actorUserId, actorSource: input.actorSource, reason: input.reason,
      });
    } catch (err) {
      if (err instanceof TenantStatusConcurrencyError) {
        this.cache.delete(input.tenantId);
      }
      throw err;
    }
    // Pre-warm cache with the new status instead of deleting it. With a delete,
    // a concurrent gate request that had already started a findById against
    // the OLD row would re-cache the stale value after we returned. Writing
    // the freshest known value here narrows that window (a concurrent reader
    // that wrote AFTER our write still creates a residual race, but it would
    // immediately re-read on next expiry — bounded staleness of ttlMs).
    // Fully closing the race needs cache versioning, which is a bigger
    // refactor and out of scope for this PR.
    this.writeCache(input.tenantId, input.newStatus, this.ttlMs);

    // Revoke embedded session tokens on transition into a blocked state.
    // Reactivation (blocked → active) is NOT a revocation event.
    // If revocation fails, the status flip has already committed — record a
    // distinguishable audit entry (so the operator surface can show "status
    // flipped but tokens stale") and throw PartialTenantRevocationError so
    // the route returns a typed 500 instead of an opaque generic Error.
    if (isBlocked(input.newStatus) && this.tokenRepo) {
      try {
        await this.tokenRepo.revokeAllForTenant(input.tenantId);
      } catch (cause) {
        await this.recordPartialRevocationAudit(input, cause);
        throw new PartialTenantRevocationError(input.tenantId, input.newStatus, cause);
      }
    }
  }

  private async recordPartialRevocationAudit(
    input: SetStatusInput,
    cause: unknown,
  ): Promise<void> {
    // Audit-only. previousStatus = newStatus marks this as a side-effect
    // audit (not a real state transition). Wrapped in try/catch so audit
    // failure can't also drop the original revocation error.
    const msg = cause instanceof Error ? cause.message : String(cause);
    try {
      await this.repo.recordAuditOnly({
        tenantId: input.tenantId,
        previousStatus: input.newStatus,
        newStatus: input.newStatus,
        actorUserId: input.actorUserId,
        actorSource: 'partial_revocation_failed',
        reason: `${input.reason ? input.reason + ' | ' : ''}revocation failed: ${msg.slice(0, 256)}`,
      });
    } catch {
      // Swallow audit-recording failures: they would mask the underlying
      // PartialTenantRevocationError that's about to be thrown.
    }
  }

  async requireActive(tenantId: string): Promise<void> {
    // BLOCKS-MERGE-class fix: the gate must read durable status DIRECTLY,
    // bypassing the positive-status cache. Otherwise the kill switch's
    // "stop cold on next request" semantics is undermined for up to ttlMs
    // by a stale 'active' cache entry written before another process
    // flipped the tenant to disabled. The cache stays useful for
    // non-enforcement reads (admin peek, internal lookups), but every
    // gate hit pays the DB round-trip in exchange for promptness.
    //
    // Auto-register cold path: if the tenant has no row, ensureExists is
    // called inline. This is the same auto-register seam as getStatus, just
    // without the positive-cache short-circuit.
    //
    // Security note (R7-6): the auto-register here CAN materialize a
    // tenants row from a tenantId derived from an authenticated JWT claim.
    // To keep that safe, callers MUST normalize/validate the claim BEFORE
    // it reaches this function: see `normalizeTenantIdClaim` in
    // `src/middleware/auth.ts` which trims, rejects empty/whitespace, and
    // length-bounds the value. The gate code here treats anything reaching
    // it as already-validated. A future hardening (gated provisioning,
    // known-issuer allowlist) would tighten this further but is out of
    // scope for PR A.
    let row = await this.repo.findById(tenantId);
    if (!row) {
      await this.repo.ensureExists(tenantId);
      row = await this.repo.findById(tenantId);
    }
    const status = (row?.status ?? 'active') as TenantStatus;
    // CACHE COHERENCE NOTE (R8-3): requireActive DOES NOT READ from the
    // cache on entry above (security correctness — the kill switch must
    // see durable status), but it DOES write to the cache here on exit.
    // The intent is to make the gate's freshly-confirmed value available
    // to NON-GATE readers (peekStatus from the admin GET, internal lookups)
    // so they don't pay a redundant DB round-trip moments later.
    //
    // Tradeoff: every gate hit moves the entry to the tail of the FIFO
    // eviction order, so a long-tail of one-off tenant probes through the
    // gate path could evict legitimately-cached entries. cacheMaxEntries
    // (default 10k) is sized to absorb realistic tenant fan-out; if this
    // proves problematic we can split the cache or have the gate skip the
    // write. For PR A this is intentionally a shared cache across read
    // paths because the alternative (separate caches per consumer) doubles
    // memory and adds coherence headaches.
    this.writeCache(tenantId, status, this.ttlMs);
    if (isBlocked(status)) {
      throw new TenantBlockedError(tenantId, status, gateReason(status));
    }
  }

  async listAudit(tenantId: string, limit = 100) {
    return this.repo.listAudit(tenantId, limit);
  }

  private writeCache(tenantId: string, status: TenantStatus | null, ttlMs: number): void {
    // Re-inserting moves the key to the tail so it is freshest in FIFO order.
    if (this.cache.has(tenantId)) this.cache.delete(tenantId);
    this.cache.set(tenantId, { status, expiresAt: Date.now() + ttlMs });
    // Cheap opportunistic eviction: when we hit the cap, drop the oldest entry.
    // Map iteration order is insertion order, so the head key is the oldest.
    if (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }
}
