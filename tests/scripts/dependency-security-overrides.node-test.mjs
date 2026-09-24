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
// versions these two packages publish.
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
// (GHSA-7w5x-hrqm-74c2) has exactly one consumer and no major-version
// constraint, so a single global floor is sufficient there.

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

test('every resolved smol-toml copy in the lockfile meets the patched floor (GHSA-7w5x-hrqm-74c2)', () => {
  const lock = readLock();
  const entries = resolvedVersionsFor(lock, 'smol-toml');
  assert.ok(entries.length > 0, 'expected at least one resolved smol-toml entry in package-lock.json');
  for (const { key, version } of entries) {
    assert.ok(
      versionAtLeast(version, '1.8.0'),
      `${key} resolved to smol-toml@${version}, which is below the patched floor 1.8.0`,
    );
  }
});
