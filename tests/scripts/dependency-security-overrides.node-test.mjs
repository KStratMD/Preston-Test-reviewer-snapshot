import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const lockPath = path.join(repoRoot, 'package-lock.json');

function readLock() {
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

// Minimal `X.Y.Z[-prerelease]` comparator, avoiding a dependency on the
// undeclared transitive `semver` package. Sufficient for the plain numeric
// versions checked by these security-floor tests.
function versionAtLeast(version, floor) {
  const toParts = (v) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  const [vMajor, vMinor, vPatch] = toParts(version);
  const [fMajor, fMinor, fPatch] = toParts(floor);
  if (vMajor !== fMajor) return vMajor > fMajor;
  if (vMinor !== fMinor) return vMinor > fMinor;
  if (vPatch !== fPatch) return vPatch > fPatch;
  // Numeric parts are equal: a prerelease (e.g. 5.4.1-alpha.1) is lower than
  // the final release it is a prerelease of, so only a plain version (no
  // `-` suffix) satisfies the floor here. Floors themselves are always
  // plain final releases.
  return !version.includes('-');
}

function resolvedVersionsFor(lock, packageName) {
  const suffix = `node_modules/${packageName}`;
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .map(([key, value]) => ({ key, version: value.version }));
}

// Regression guard for the security-sensitive js-yaml / smol-toml override
// batch. `js-yaml` is a direct dependency (package.json `dependencies`
// controls the root copy), but markdownlint-cli@0.49.1 pins its own nested
// js-yaml to ~5.2.1, which is below the GHSA-2883-xcg3-v3hh patched floor and
// is only fixed via a scoped `overrides["markdownlint-cli"]["js-yaml"]`
// entry. Two other consumers (@apidevtools/json-schema-ref-parser,
// @istanbuljs/load-nyc-config) intentionally stay pinned to older js-yaml
// majors (4.x / 3.x) via `js-yaml@4` / `js-yaml@3` overrides for
// compatibility, both raised to their GHSA-2883-xcg3-v3hh patched floors
// (4.3.2 / 3.15.2). Rather than hard-coding each consumer's lockfile path
// (which silently misses any future consumer introducing another nested
// js-yaml copy), this enumerates every resolved js-yaml entry in the
// lockfile and checks it against a per-major patched-floor table, failing
// loudly if an entry's major version has no known floor. `smol-toml`
// (GHSA-7w5x-hrqm-74c2, GHSA-r4xh-jqrq-34v2) has exactly one consumer and no
// major-version constraint, so a single global floor is sufficient there.

const JS_YAML_PATCHED_FLOORS = {
  3: '3.15.2',
  4: '4.3.2',
  5: '5.4.1',
};

test('every resolved js-yaml copy in the lockfile meets its major version patched floor (GHSA-2883-xcg3-v3hh)', () => {
  const lock = readLock();
  const entries = resolvedVersionsFor(lock, 'js-yaml');
  assert.ok(entries.length > 0, 'expected at least one resolved js-yaml entry in package-lock.json');
  for (const { key, version } of entries) {
    const major = Number.parseInt(version.split('-')[0].split('.')[0], 10);
    const floor = JS_YAML_PATCHED_FLOORS[major];
    assert.ok(
      floor,
      `${key} resolved to js-yaml@${version} on major ${major}, which has no known patched floor - ` +
        'add one to JS_YAML_PATCHED_FLOORS after confirming this major is unaffected by GHSA-2883-xcg3-v3hh, ' +
        'or add a version override if it is affected',
    );
    assert.ok(
      versionAtLeast(version, floor),
      `${key} resolved to js-yaml@${version}, which is below the major ${major} patched floor ${floor}`,
    );
  }
});

test('every resolved smol-toml copy in the lockfile meets the patched floor (GHSA-7w5x-hrqm-74c2, GHSA-r4xh-jqrq-34v2)', () => {
  const lock = readLock();
  const entries = resolvedVersionsFor(lock, 'smol-toml');
  assert.ok(entries.length > 0, 'expected at least one resolved smol-toml entry in package-lock.json');
  for (const { key, version } of entries) {
    assert.ok(
      versionAtLeast(version, '1.9.0'),
      `${key} resolved to smol-toml@${version}, which is below the patched floor 1.9.0 (GHSA-r4xh-jqrq-34v2)`,
    );
  }
});

const AUDIT_PATCHED_FLOORS = {
  // GHSA-6qxp-vccf-f47h: first patched 1.x release.
  '@modelcontextprotocol/sdk': { 1: '1.31.0' },
  'brace-expansion': { 5: '5.0.12' },
  // GHSA-vc2v-76pw-4v95.
  compression: { 1: '1.8.2' },
  // GHSA-jggr-w7fw-pc2j.
  'fast-copy': { 4: '4.1.0' },
  // GHSA-mrwp-f3q8-3g9p: cross-realm sensitiveHeaders arrays discarded on redirect.
  'follow-redirects': { 1: '1.16.2' },
  'fast-uri': { 2: '2.4.7', 3: '3.1.8', 4: '4.1.5' },
  'ip-address': { 10: '10.7.4' },
  // GHSA-238p-pmpm-9mq7: affects >=0.11.0 <0.18.2; micromark-extension-math
  // declares ^0.16.0, so the root `katex` override is what lifts the dev-only copy.
  katex: { 0: '0.18.2' },
  // GHSA-gfr2-rv44-r23c and GHSA-vfgh-jcmw-g37q: affect <14.3.3 on the 14.x line.
  'markdown-it': { 14: '14.3.3' },
  multer: { 2: '2.4.0' },
  // GHSA-jqcg-44mw-7w3h.
  'proxy-addr': { 2: '2.0.8' },
  // GHSA-68fv-2mgg-jv7q.
  'source-map-js': { 1: '1.2.2' },
};

function meetsAuditFloor(packageName, version) {
  const major = Number.parseInt(version.split('-')[0].split('.')[0], 10);
  const floor = AUDIT_PATCHED_FLOORS[packageName]?.[major];
  return floor !== undefined && versionAtLeast(version, floor);
}

for (const [packageName, floors] of Object.entries(AUDIT_PATCHED_FLOORS)) {
  test(`every resolved ${packageName} copy meets its major-specific security audit floor`, () => {
    const entries = resolvedVersionsFor(readLock(), packageName);
    assert.ok(entries.length > 0, `expected at least one resolved ${packageName} entry in package-lock.json`);
    for (const { key, version } of entries) {
      const major = Number.parseInt(version.split('-')[0].split('.')[0], 10);
      const floor = floors[major];
      assert.ok(floor, `${key} resolved to ${packageName}@${version} on unaudited major ${major}`);
      assert.ok(
        meetsAuditFloor(packageName, version),
        `${key} resolved to ${packageName}@${version}, below major ${major} patched floor ${floor}`,
      );
    }
  });
}

test('fast-uri 4.x rejects vulnerable patches and accepts its own patched floor', () => {
  assert.equal(meetsAuditFloor('fast-uri', '4.1.4'), false);
  assert.equal(meetsAuditFloor('fast-uri', '4.1.5'), true);
});

test('an unaudited major does not satisfy a package floor', () => {
  assert.equal(meetsAuditFloor('fast-uri', '5.0.0'), false);
});

// GHSA-g3hv-75wg-m249 (minimatch <11.0.1) and GHSA-3g3m-2fjr-6pw4 (glob 9 to 14.0.1).
// The production audit gate omits development dependencies, so this guard covers the
// production copies only: archiver-utils, readdir-glob and swagger-jsdoc are lifted by
// scoped overrides. Development copies (eslint, jest, nodemon) are outside the gate.
const PRODUCTION_GLOB_FLOORS = { glob: '14.0.2', minimatch: '11.0.1' };
for (const [packageName, floor] of Object.entries(PRODUCTION_GLOB_FLOORS)) {
  test(`every production ${packageName} copy meets the patched floor ${floor}`, () => {
    const lock = readLock();
    const production = resolvedVersionsFor(lock, packageName).filter(({ key }) => lock.packages[key].dev !== true);
    assert.ok(production.length > 0, `expected at least one production ${packageName} entry in package-lock.json`);
    for (const { key, version } of production) {
      assert.ok(versionAtLeast(version, floor), `${key} resolved to ${packageName}@${version}, below the patched floor ${floor}`);
    }
  });
}
