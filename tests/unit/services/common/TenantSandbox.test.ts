import { TenantSandbox, DEFAULT_MAX_TENANTS } from '../../../../src/services/common/TenantSandbox';

interface Stores { items: Map<string, { v: number }>; }

function buildSeed({ tenantId, nowMs }: { tenantId: string; nowMs: number }): Stores {
  const items = new Map<string, { v: number }>();
  items.set('seed', { v: nowMs });
  items.set('tenant', { v: tenantId.length });
  return { items };
}

describe('TenantSandbox', () => {
  it('lazily seeds an unseen tenant on first touch', () => {
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => 1000 });
    expect(sandbox.size).toBe(0);
    const a = sandbox.forTenant('tenant-a');
    expect(sandbox.size).toBe(1);
    expect(a.items.get('seed')!.v).toBe(1000);
  });

  it('isolates writes between tenants', () => {
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => 1000 });
    sandbox.forTenant('a').items.set('x', { v: 1 });
    expect(sandbox.forTenant('b').items.has('x')).toBe(false);
  });

  it('returns the same store-set on repeat access (no re-seed)', () => {
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => 1000 });
    const first = sandbox.forTenant('a');
    first.items.set('x', { v: 9 });
    expect(sandbox.forTenant('a')).toBe(first);
    expect(sandbox.forTenant('a').items.get('x')!.v).toBe(9);
  });

  it('pins one seed time per tenant even as the clock advances', () => {
    let clock = 1000;
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => clock });
    sandbox.forTenant('a');
    clock = 5000;
    expect(sandbox.seededAtMs('a')).toBe(1000);
    expect(sandbox.forTenant('a').items.get('seed')!.v).toBe(1000);
  });

  it('FIFO-evicts the oldest tenant past the cap and re-seeds on next access', () => {
    let clock = 1;
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => clock++, maxTenants: 2 });
    sandbox.forTenant('a');
    sandbox.forTenant('b');
    sandbox.forTenant('c');                 // evicts 'a'
    expect(sandbox.size).toBe(2);
    expect(sandbox.seededAtMs('b')).toBe(2); // oldest survivor preserved
    expect(sandbox.seededAtMs('a')).toBeUndefined();
    sandbox.forTenant('a');                 // re-seeds with a fresh time
    expect(sandbox.seededAtMs('a')).toBeGreaterThan(0);
  });

  it('evictTenant drops the whole store-set and reports whether it existed', () => {
    const sandbox = new TenantSandbox<Stores>(buildSeed, { now: () => 1 });
    sandbox.forTenant('a');
    expect(sandbox.evictTenant('a')).toBe(true);
    expect(sandbox.evictTenant('a')).toBe(false);
    expect(sandbox.size).toBe(0);
    expect(sandbox.seededAtMs('a')).toBeUndefined();
  });

  it('exposes a non-trivial default cap', () => {
    expect(DEFAULT_MAX_TENANTS).toBe(10_000);
  });
});
