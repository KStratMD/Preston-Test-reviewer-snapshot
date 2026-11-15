/**
 * Demo-tenant constant + seed-gate predicate (PR-F5b-3).
 *
 * shouldSeedDemoData is the ONE predicate all three seed sites share
 * (src/index.ts's boot block via demoSeedBoot, seedFinanceCentralDemoData,
 * seedWorkflowCentralDemoTasks) so they cannot drift apart.
 */
import {
  CENTRAL_DEMO_TENANT_ID,
  shouldSeedDemoData,
} from '../../../../src/services/governance/demoTenant';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';

describe('CENTRAL_DEMO_TENANT_ID', () => {
  it('is a reserved, non-system tenant id', () => {
    expect(CENTRAL_DEMO_TENANT_ID).toBe('__central_demo__');
    expect(CENTRAL_DEMO_TENANT_ID).not.toBe(SYSTEM_IDENTITY.tenantId);
    // Double-underscore convention marks it unregistrable, like the system id.
    expect(CENTRAL_DEMO_TENANT_ID.startsWith('__')).toBe(true);
    expect(CENTRAL_DEMO_TENANT_ID.endsWith('__')).toBe(true);
  });
});

describe('shouldSeedDemoData (F5b-3 hosted seeding gate)', () => {
  it.each([
    ['development', false, true],
    ['development', true, true],
    // Fail closed: unset/empty behave as production, mirroring the
    // canonicalization in src/config/env.ts.
    [undefined, false, false],
    ['', false, false],
    [' ', false, false],
    [undefined, true, true],
    ['production', false, false], // ordinary production NEVER seeds
    ['production', true, true], // hosted demo seeds (Kerry decision 2026-07-29)
    ['test', false, false], // test NEVER seeds (unit-DB race protection)
    ['test', true, false],
  ])('nodeEnv=%s hostedDemo=%s -> %s', (nodeEnv, hosted, expected) => {
    expect(shouldSeedDemoData(nodeEnv as string | undefined, hosted as boolean)).toBe(expected);
  });

  it('never seeds under the test environment, whatever the hosted flag says', () => {
    expect(shouldSeedDemoData('test', true)).toBe(false);
    expect(shouldSeedDemoData('test', false)).toBe(false);
  });

  it('requires the explicit hosted flag to seed a production-strength boot', () => {
    expect(shouldSeedDemoData('production', false)).toBe(false);
    expect(shouldSeedDemoData(undefined, false)).toBe(false);
    expect(shouldSeedDemoData('', false)).toBe(false);
  });
});
