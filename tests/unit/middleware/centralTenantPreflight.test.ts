import {
  resolveCentralTenantPreflight,
  type CentralTenantPreflightInput,
} from '../../../src/middleware/setup/centralTenantPreflight';
import type { RoutePolicy } from '../../../src/middleware/setup/routePolicy';

function decide(input: Omit<CentralTenantPreflightInput, 'policies'>) {
  return resolveCentralTenantPreflight(input);
}

describe('resolveCentralTenantPreflight', () => {
  it.each([
    ['/api/payment-central/health', 'GET', false, false, 'defer'],
    ['/api/payment-central/health/', 'HEAD', false, false, 'defer'],
    ['/api/payment-central/health/detail', 'GET', false, false, 'defer'],
    ['/api/payment-central/health', 'POST', false, false, 'defer'],
    ['/api/customer-central/dashboard', 'GET', true, false, 'defer'],
    ['/api/customer-central/dashboard', 'GET', false, false, 'isolate'],
    ['/api/customer-central/dashboard', 'GET', false, true, 'defer'],
    ['/api/customer-central/dashboard/detail', 'GET', true, false, 'defer'],
    ['/api/testing/mcp-schema', 'POST', false, false, 'defer'],
    ['/api/finance-central/approvals/a1/approve', 'POST', true, false, 'isolate'],
    ['/api/governance/approvals/a1', 'GET', false, false, 'isolate'],
  ])(
    '%s %s demo=%s credential=%s -> %s',
    (path, method, isDemoRuntime, hasPresentedIdentity, expected) => {
      expect(
        decide({
          path,
          method: method as CentralTenantPreflightInput['method'],
          isDemoRuntime,
          hasPresentedIdentity,
        }).action,
      ).toBe(expected);
    },
  );

  it.each([
    ['/api/embedded/host-bootstrap/anything', 'POST'],
    ['/api/embedded/context/anything', 'POST'],
    ['/api/embedded/sessions/anything', 'DELETE'],
    ['/api/embedded/lineage/anything', 'GET'],
    ['/api/embedded/reconciliation/anything', 'POST'],
    ['/api/governance/approvals', 'GET'],
    ['/api/governance/approvals/', 'GET'],
    ['/api/governance/approvals/a1/approve', 'POST'],
    ['/api/governance/approvals/a1/reject', 'POST'],
    ['/api/governance/approvals/a1/reset-claim', 'POST'],
    ['/api/governance/ownership-rejections', 'GET'],
    ['/api/governance/loop-detections', 'GET'],
    ['/api/governance/dlp-pattern-metadata', 'GET'],
    ['/api/sync-error-assist/ingest', 'POST'],
    ['/api/sync-error-assist/ingest/', 'POST'],
    ['/api/sync-error-assist/suggestions', 'GET'],
    ['/api/sync-error-assist/suggestions/e1/accept', 'POST'],
    ['/api/sync-error-assist/suggestions/e1/reject', 'POST'],
    ['/api/sync-error-assist/suggestions/e1/escalate', 'POST'],
  ])('%s %s is deferred to its route-owned validator', (path, method) => {
    expect(
      decide({
        path,
        method: method as CentralTenantPreflightInput['method'],
        isDemoRuntime: false,
        hasPresentedIdentity: false,
      }).action,
    ).toBe('defer');
  });

  it.each([
    ['/api/governance-public/anything', 'GET'],
    ['/api/embedded-public/anything', 'GET'],
    ['/api/governance/approvals/a1', 'GET'],
    ['/api/embedded/contextual/anything', 'POST'],
    ['/api/sync-error-assist/ingest-extra', 'POST'],
  ])('%s %s does not match a trusted or health bypass', (path, method) => {
    expect(
      decide({
        path,
        method: method as CentralTenantPreflightInput['method'],
        isDemoRuntime: false,
        hasPresentedIdentity: false,
      }).action,
    ).toBe('isolate');
  });

  it('defers health descendants without treating a detail-like suffix as the exact probe', () => {
    const decision = decide({
      path: '/api/payment-central/health/detailish',
      method: 'GET',
      isDemoRuntime: false,
      hasPresentedIdentity: false,
    });
    expect(decision).toEqual({ action: 'defer', reason: 'health-subtree' });
  });

  it('fails closed when the injected policy list has no matching policy', () => {
    expect(
      resolveCentralTenantPreflight({
        path: '/api/synthetic/unknown',
        method: 'GET',
        isDemoRuntime: false,
        hasPresentedIdentity: false,
        policies: [],
      }).action,
    ).toBe('isolate');
  });

  it('surfaces route-policy ambiguity instead of converting it to a bypass', () => {
    const ambiguousPolicies: readonly RoutePolicy[] = [
      {
        match: { pathPrefix: '/api/synthetic' },
        auth: 'required',
        lifecycle: 'enforce',
        rateProfile: 'tenant_api',
      },
      {
        match: { pathPrefix: '/api/synthetic' },
        auth: 'public',
        lifecycle: 'not_applicable',
        rateProfile: 'anonymous_read',
      },
    ];

    expect(() =>
      resolveCentralTenantPreflight({
        path: '/api/synthetic/anything',
        method: 'GET',
        isDemoRuntime: false,
        hasPresentedIdentity: false,
        policies: ambiguousPolicies,
      }),
    ).toThrow(/Ambiguous route policy/);
  });
});
