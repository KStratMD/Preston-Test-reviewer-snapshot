/** Default upper bound on distinct tenants in one sandbox before FIFO eviction. */
export const DEFAULT_MAX_TENANTS = 10_000;

/** Pure factory: given a tenant id and a pinned seed time, returns a fresh deep store-set. */
export type SandboxSeed<S> = (args: { tenantId: string; nowMs: number }) => S;

export interface TenantSandboxOptions {
  /** Max distinct tenants retained; oldest-seeded is evicted past this. Default 10_000. */
  maxTenants?: number;
  /** Clock injection for tests. Default Date.now. */
  now?: () => number;
}

/**
 * Per-tenant lazy copy-on-write store container.
 *
 * `forTenant(id)` returns that tenant's store-set, deep-seeded on first touch via the injected
 * factory and pinned to a single `nowMs`. The whole store-set is the unit of seeding and eviction,
 * so a tenant's maps never end up half-reset. Backs the in-memory *demo* stores of the Central
 * families; durable Central data lives in DB-backed surfaces and is unaffected.
 */
export class TenantSandbox<S extends object> {
  // Map preserves insertion order, so keys().next() yields the oldest-seeded tenant (FIFO).
  private readonly tenants = new Map<string, S>();
  private readonly seededAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxTenants: number;

  constructor(private readonly seed: SandboxSeed<S>, opts: TenantSandboxOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTenants = opts.maxTenants ?? DEFAULT_MAX_TENANTS;
  }

  forTenant(tenantId: string): S {
    const existing = this.tenants.get(tenantId);
    if (existing !== undefined) {
      return existing;
    }
    const nowMs = this.now();
    const store = this.seed({ tenantId, nowMs });
    this.tenants.set(tenantId, store);
    this.seededAt.set(tenantId, nowMs);
    this.evictIfNeeded();
    return store;
  }

  evictTenant(tenantId: string): boolean {
    this.seededAt.delete(tenantId);
    return this.tenants.delete(tenantId);
  }

  seededAtMs(tenantId: string): number | undefined {
    return this.seededAt.get(tenantId);
  }

  get size(): number {
    return this.tenants.size;
  }

  private evictIfNeeded(): void {
    while (this.tenants.size > this.maxTenants) {
      const oldest: string | undefined = this.tenants.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.evictTenant(oldest);
    }
  }
}
