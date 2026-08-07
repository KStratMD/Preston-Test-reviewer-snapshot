/**
 * Adapter conformance tests (PR 10b).
 *
 * Each `<basename>.adapter.ts` file under src/embedded/adapters/ must have
 * a matching `test('<basename>: ...', ...)` block in this file — the
 * basename-literal pairing is enforced by scripts/check-adapter-conformance.mjs
 * via the regex /test\((['"`])<basename>:/, so the test name MUST start with
 * the literal basename followed by `:` (NOT a template-substituted basename
 * — the gate scans source text, not runtime test names).
 *
 * Descriptor-shape assertions live here. Runtime scenarios that the original
 * PR 10a placeholder lists (session-refresh fast-forward, frame-ancestors
 * blocking, real bootstrap handshake) require a live page + mock server and
 * are tracked as Known Gaps on docs/review/proof-cards/embedded-platform-adapters.md.
 */
import { test, expect } from '@playwright/test';
import { netsuiteSuiteAppAdapter } from '../../../src/embedded/adapters/netsuite-suiteapp.adapter';
import { businessCentralExtensionAdapter } from '../../../src/embedded/adapters/business-central-extension.adapter';
import {
  assertEmbeddedPlatformAdapter,
  type EmbeddedPlatformAdapter,
} from '../../../src/embedded/adapters/EmbeddedPlatformAdapter';

const ALL_EMBEDDED_MODULES = [
  'reconciliation',
  'lineage',
  'approvals',
  'sync_health',
  'compliance',
  'flow_templates',
  'sync_error_triage',
] as const;

function assertBootstrapContract(adapter: EmbeddedPlatformAdapter): void {
  expect(adapter.hostBootstrap.method).toBe('server_to_server');
  expect(adapter.hostBootstrap.browserBearerExposed).toBe(false);
  expect(adapter.requiredConfigKeys.some((key) => /token/i.test(key))).toBe(true);
  expect(() => assertEmbeddedPlatformAdapter(adapter)).not.toThrow();
}

function assertModuleCoverage(adapter: EmbeddedPlatformAdapter): void {
  expect(adapter.supportedModules).toEqual([...ALL_EMBEDDED_MODULES]);
}

// NetSuite SuiteApp adapter (paired with src/embedded/adapters/netsuite-suiteapp.adapter.ts)

test('netsuite-suiteapp: bootstrap contract never exposes browser bearer', () => {
  assertBootstrapContract(netsuiteSuiteAppAdapter);
  expect(netsuiteSuiteAppAdapter.hostBootstrap.platformApi).toBe('N/https');
});

test('netsuite-suiteapp: module nav covers all embedded modules', () => {
  assertModuleCoverage(netsuiteSuiteAppAdapter);
});

// Business Central extension adapter (paired with src/embedded/adapters/business-central-extension.adapter.ts)

test('business-central-extension: bootstrap contract never exposes browser bearer', () => {
  assertBootstrapContract(businessCentralExtensionAdapter);
  expect(businessCentralExtensionAdapter.hostBootstrap.platformApi).toBe('AL HttpClient');
});

test('business-central-extension: module nav covers all embedded modules', () => {
  assertModuleCoverage(businessCentralExtensionAdapter);
});
