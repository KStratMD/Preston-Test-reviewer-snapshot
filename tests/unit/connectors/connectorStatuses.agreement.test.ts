/**
 * The status vocabulary lives twice by necessity -- the CI gates import the
 * .mjs (no TS toolchain at gate time) and the registry types itself from the
 * .ts. This is the assertion that stops them drifting: if a value is added to
 * one and not the other, this fails before any gate can silently ignore it.
 *
 * Why it matters: `production_ready` was introduced as a relabel of connectors
 * with no live evidence. A relabel must not loosen enforcement. Every gate
 * that used to compare against the literal 'production' now consults
 * READINESS_GATED_STATUSES / PRODUCTION_TIER_STATUSES from the shared module,
 * so the only way a new status could escape gating is if the two copies of
 * the module disagreed -- which is exactly what this test forbids.
 *
 * The .mjs is compared as TEXT: ts-jest runs CommonJS and cannot load an ESM
 * .mjs via require() or a reliably-transformed import(). Extracting the array
 * literals from both sources is dependency-free and catches the same drift.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONNECTOR_STATUSES,
  PRODUCTION_TIER_STATUSES,
  READINESS_GATED_STATUSES,
  isProductionTier,
  isReadinessGated,
} from '../../../src/connectors/connectorStatuses';

const ROOT = path.resolve(__dirname, '../../..');
const MJS_PATH = path.join(ROOT, 'scripts/lib/connectorStatuses.mjs');
const MJS = fs.readFileSync(MJS_PATH, 'utf8');

/** Extract the quoted strings of `export const NAME = Object.freeze([ ... ])`. */
function mjsList(name: string): string[] {
  const m = MJS.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`${name} not found in connectorStatuses.mjs`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe('connector status vocabulary: the .ts and .mjs copies agree', () => {
  it('lists exactly the same statuses in the same order', () => {
    expect([...CONNECTOR_STATUSES]).toEqual(mjsList('CONNECTOR_STATUSES'));
  });

  it('agrees on the production tier', () => {
    expect([...PRODUCTION_TIER_STATUSES]).toEqual(mjsList('PRODUCTION_TIER_STATUSES'));
  });

  it('agrees on what is readiness-gated (the .mjs spreads the tier, then adds beta)', () => {
    // READINESS_GATED_STATUSES in the .mjs is `[...PRODUCTION_TIER_STATUSES, 'beta']`,
    // so its literal only names the additions; reconstruct and compare.
    const additions = mjsList('READINESS_GATED_STATUSES');
    expect([...READINESS_GATED_STATUSES]).toEqual([...mjsList('PRODUCTION_TIER_STATUSES'), ...additions]);
  });

  it('the .mjs helpers agree with the .ts helpers on every status (behaviour, not text)', () => {
    // Text agreement of the arrays says nothing about the helper bodies. Run the
    // real .mjs in a child process (ESM cannot be required here) and compare
    // answers for every status plus near-miss strings a lax helper might accept.
    const probe = [...CONNECTOR_STATUSES, 'production ', 'PRODUCTION', 'production-ready', 'nope', ''];
    const code =
      `import * as m from ${JSON.stringify(pathToFileURL(MJS_PATH).href)};` +
      `console.log(JSON.stringify(${JSON.stringify(probe)}.map((s) => [s, m.isProductionTier(s), m.isReadinessGated(s)])));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const fromMjs = JSON.parse(r.stdout.trim());
    const fromTs = probe.map((s) => [s, isProductionTier(s as never), isReadinessGated(s as never)]);
    expect(fromMjs).toEqual(fromTs);
    // and the answers themselves are the D4 contract, not just mutually consistent
    expect(fromMjs.filter(([, tier]) => tier).map(([s]) => s)).toEqual(['production', 'production_ready']);
  });

  it('production_ready is production-tier and readiness-gated', () => {
    // This is the whole point of the relabel: same obligations, no live evidence.
    expect(isProductionTier('production_ready')).toBe(true);
    expect(isReadinessGated('production_ready')).toBe(true);
  });

  it('beta is gated but not production-tier; demo_only and stub are neither', () => {
    expect(isReadinessGated('beta')).toBe(true);
    expect(isProductionTier('beta')).toBe(false);
    for (const s of ['demo_only', 'stub'] as const) {
      expect(isReadinessGated(s)).toBe(false);
      expect(isProductionTier(s)).toBe(false);
    }
  });
});
