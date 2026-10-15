import { CENTRAL_FAMILY_DEMO_ALLOWLISTS } from '../../../src/middleware/setup/RouteSetup';
import { resolveRoutePolicy, type HttpMethod } from '../../../src/middleware/setup/routePolicy';

const ALL_TWELVE = [
  '/api/payment-central',
  '/api/supplier-central',
  '/api/customer-central',
  '/api/quality-central',
  '/api/payout-central',
  '/api/installer-central',
  '/api/service-central',
  '/api/inventory-central',
  '/api/finance-central',
  '/api/contract-central',
  '/api/portal-central',
  '/api/workflow-central',
];

describe('CENTRAL_FAMILY_DEMO_ALLOWLISTS (F5b)', () => {
  it('covers exactly the twelve central families', () => {
    expect(Object.keys(CENTRAL_FAMILY_DEMO_ALLOWLISTS).sort()).toEqual([...ALL_TWELVE].sort());
  });

  it('is READ-ONLY — no entry permits a mutating method (Kerry decision 2026-07-27)', () => {
    for (const [prefix, entries] of Object.entries(CENTRAL_FAMILY_DEMO_ALLOWLISTS)) {
      for (const entry of entries) {
        expect({ prefix, methods: [...entry.methods].sort() }).toEqual({
          prefix,
          methods: ['GET', 'HEAD'],
        });
      }
    }
  });

  it('portal-central has an empty allowlist (no demo-page caller)', () => {
    expect(CENTRAL_FAMILY_DEMO_ALLOWLISTS['/api/portal-central']).toEqual([]);
  });

  it('every pattern is fully anchored (fail-closed exact matching)', () => {
    for (const entries of Object.values(CENTRAL_FAMILY_DEMO_ALLOWLISTS)) {
      for (const entry of entries) {
        expect(entry.pattern.source.startsWith('^')).toBe(true);
        expect(entry.pattern.source.endsWith('$')).toBe(true);
        expect(entry.pattern.flags).toBe('');
      }
    }
  });

  it('no pattern tolerates a trailing slash', () => {
    for (const entries of Object.values(CENTRAL_FAMILY_DEMO_ALLOWLISTS)) {
      for (const entry of entries) {
        expect(entry.pattern.source).not.toContain('\\/?$');
      }
    }
  });
});

const PHASE_ONE = [
  '/api/customer-central',
  '/api/quality-central',
  '/api/payout-central',
  '/api/installer-central',
  '/api/service-central',
  '/api/inventory-central',
  '/api/contract-central',
  '/api/portal-central',
];

/**
 * Derive a concrete mount-relative path from an anchored allowlist pattern so
 * the lockstep check below holds for ANY entry shape rather than only
 * '/dashboard' (Phase 2 adds '/vendors/[^/]+/purchase-orders' and friends).
 * Param segments collapse to a literal sample. The derived probe is
 * self-checked against the pattern it came from, so a shape this derivation
 * cannot handle fails loudly instead of silently weakening the assertion.
 */
function probePathFor(pattern: RegExp): string {
  const path = pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[\^\/\]\+/g, 'sample')
    .replace(/\\\//g, '/');
  expect({ source: pattern.source, derived: path, matches: pattern.test(path) }).toEqual({
    source: pattern.source,
    derived: path,
    matches: true,
  });
  return path;
}

describe('F5b manifest refinements — Phase 1 families', () => {
  it('every allowlist entry is covered by a hosted_demo_public policy (table↔manifest lockstep)', () => {
    for (const prefix of PHASE_ONE) {
      for (const entry of CENTRAL_FAMILY_DEMO_ALLOWLISTS[prefix]) {
        const probe = `${prefix}${probePathFor(entry.pattern)}`;
        for (const method of entry.methods) {
          const policy = resolveRoutePolicy(probe, method as HttpMethod);
          expect({ prefix, method, auth: policy?.auth }).toEqual({
            prefix,
            method,
            auth: 'hosted_demo_public',
          });
        }
      }
    }
  });

  it('probe derivation handles every entry shape in the table, including param segments', () => {
    // Exercises the '[^/]+' branch against the real param-bearing entries
    // (supplier vendors), which Phase 1's all-'/dashboard' families would
    // otherwise leave untested. probePathFor self-checks each derivation.
    const derived = Object.values(CENTRAL_FAMILY_DEMO_ALLOWLISTS).flatMap((entries) =>
      entries.map((entry) => probePathFor(entry.pattern)),
    );
    expect(derived).toContain('/vendors/sample');
    expect(derived).toContain('/vendors/sample/purchase-orders');
    expect(derived).toContain('/invoices/statistics');
  });

  it('declares the health probe public for every Phase 1 family', () => {
    for (const prefix of PHASE_ONE) {
      const policy = resolveRoutePolicy(`${prefix}/health`, 'GET');
      expect({ prefix, auth: policy?.auth }).toEqual({ prefix, auth: 'public' });
    }
  });

  it('does NOT make health descendants public (exact match on the longer prefix)', () => {
    for (const prefix of PHASE_ONE) {
      const policy = resolveRoutePolicy(`${prefix}/health/detail`, 'GET');
      expect({ prefix, auth: policy?.auth }).toEqual({ prefix, auth: 'required' });
    }
  });

  it('does NOT make a mutating method on the health path public', () => {
    for (const prefix of PHASE_ONE) {
      expect(resolveRoutePolicy(`${prefix}/health`, 'POST')?.auth).toBe('required');
    }
  });

  it('leaves every non-refined subpath on the strict base policy', () => {
    for (const prefix of PHASE_ONE) {
      const policy = resolveRoutePolicy(`${prefix}/metrics`, 'GET');
      expect({ prefix, auth: policy?.auth, lifecycle: policy?.lifecycle }).toEqual({
        prefix,
        auth: 'required',
        lifecycle: 'enforce',
      });
    }
  });

  it('portal-central declares NO hosted_demo_public policy at all', () => {
    for (const path of ['/api/portal-central/dashboard', '/api/portal-central/users']) {
      expect(resolveRoutePolicy(path, 'GET')?.auth).toBe('required');
    }
  });

  it('POST on a demo-read subpath stays strict (reads-only rule)', () => {
    expect(resolveRoutePolicy('/api/customer-central/dashboard', 'POST')?.auth).toBe('required');
  });
});

describe('F5b manifest refinements — Phase 2 families', () => {
  it.each([
    ['/api/payment-central', ['/dashboard', '/analytics', '/processors', '/transactions', '/invoices', '/invoices/statistics', '/disputes', '/credit-memos']],
    ['/api/supplier-central', ['/dashboard', '/vendors', '/vendors/v1', '/vendors/v1/purchase-orders']],
    ['/api/finance-central', ['/dashboard']],
    ['/api/workflow-central', ['/dashboard']],
  ])('%s declares hosted_demo_public for every allowlisted read', (prefix, paths) => {
    for (const p of paths) {
      expect(resolveRoutePolicy(`${prefix}${p}`, 'GET')?.auth).toBe('hosted_demo_public');
    }
  });

  it.each(['/api/payment-central', '/api/supplier-central', '/api/finance-central', '/api/workflow-central'])(
    '%s keeps writes, non-allowlisted reads, and health descendants strict',
    (prefix) => {
      expect(resolveRoutePolicy(`${prefix}/dashboard`, 'POST')?.auth).toBe('required');
      expect(resolveRoutePolicy(`${prefix}/settings`, 'GET')?.auth).toBe('required');
      expect(resolveRoutePolicy(`${prefix}/health`, 'GET')?.auth).toBe('public');
      expect(resolveRoutePolicy(`${prefix}/health/detail`, 'GET')?.auth).toBe('required');
    },
  );

  it('payment-central write endpoints the demo pages call are NOT hosted_demo_public', () => {
    for (const p of [
      '/api/payment-central/invoices/i1/approve',
      '/api/payment-central/invoices/i1/dispute',
      '/api/payment-central/invoices/i1/auto-match',
      '/api/payment-central/disputes/d1/resolve',
      '/api/payment-central/transactions/t1/sync',
      '/api/payment-central/transactions/bulk-sync',
      '/api/payment-central/reconciliation/reports',
    ]) {
      expect(resolveRoutePolicy(p, 'POST')?.auth).toBe('required');
    }
  });

  it('supplier and finance write endpoints the demo pages call are NOT hosted_demo_public', () => {
    expect(resolveRoutePolicy('/api/supplier-central/purchase-orders/p1/acknowledge', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/finance-central/approvals/a1/approve', 'POST')?.auth).toBe('required');
    expect(resolveRoutePolicy('/api/finance-central/approvals/a1/reject', 'POST')?.auth).toBe('required');
  });
});
