#!/usr/bin/env node
// @ts-check
//
// check-audit-allowed.mjs
//
// Runs `npm audit --json --audit-level=high --omit=dev` and fails CI if any
// advisory appears that is NOT in the explicit GHSA allowlist. The allowlist
// mirrors the "accepted with compensating controls" entries in
// .github/audit-exceptions.md.
//
// Why advisory-ID scoped: `npm audit` cannot distinguish accepted-risk
// advisories from new ones. A plain `npm audit` fail is too noisy when we
// have a documented, wrapper-mitigated exception. Per-GHSA allowlisting is
// the minimum compromise that keeps the gate useful while honoring it.
//
// Usage:
//   node scripts/check-audit-allowed.mjs
//   # exit 0 if only allowlisted advisories remain
//   # exit 1 on any new advisory

import { spawnSync } from 'node:child_process';

// Advisory IDs accepted under .github/audit-exceptions.md. Any change here
// MUST land alongside a docs update to audit-exceptions.md explaining the
// compensating control + re-check trigger.
const ALLOWED_GHSAS = new Set([
  // @azure/msal-node auth_code-flow origin validation (via @azure/identity).
  // No @azure/identity release accepts the patched msal-node 7.1.0 yet, and
  // this repo never runs the auth_code flow; see audit-exceptions.md. Remove
  // as soon as @azure/identity resolves msal-node >= 7.1.0.
  'GHSA-xcx6-jx8p-x3h5',
]);

// Windows exposes npm through npm.cmd; Linux CI continues to use npm.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const result = spawnSync(
  npmCommand,
  ['audit', '--json', '--audit-level=high', '--omit=dev'],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: process.platform === 'win32' },
);

// npm audit exits non-zero when advisories exist. That's expected — we parse
// the JSON regardless.
if (result.error) {
  console.error('[audit-allowed] FAIL: could not execute npm audit');
  console.error(result.error.message);
  process.exit(2);
}

const stdout = result.stdout || '';
if (!stdout.trim()) {
  console.error('[audit-allowed] FAIL: npm audit produced no JSON output');
  console.error(result.stderr);
  process.exit(2);
}

let data;
try {
  data = JSON.parse(stdout);
} catch (err) {
  console.error('[audit-allowed] FAIL: could not parse npm audit JSON');
  console.error(stdout.slice(0, 500));
  process.exit(2);
}

// Fail-CLOSED on error payloads or unexpected shape. npm emits JSON with
// `error`/`errors`/`message` and NO `vulnerabilities` key when the audit
// endpoint is unreachable (registry DNS fails, proxy blocks, endpoint
// outage). If we defaulted to {} here we would silently exit 0 with
// "OK: 0 advisories" on every audit-backend failure — a fail-open gate.
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  console.error('[audit-allowed] FAIL: npm audit JSON had an unexpected top-level shape');
  console.error(stdout.slice(0, 500));
  process.exit(2);
}

if (data.error || (Array.isArray(data.errors) && data.errors.length > 0)) {
  console.error('[audit-allowed] FAIL: npm audit reported an error (registry/proxy/endpoint failure)');
  const errDetail = data.error ?? data.errors;
  console.error(typeof errDetail === 'string' ? errDetail : JSON.stringify(errDetail, null, 2));
  if (data.message) console.error(`message: ${data.message}`);
  process.exit(2);
}

// Require a PLAIN object (reject arrays — `typeof [] === 'object'` would otherwise
// slip through and Object.entries(array) would iterate numeric index keys, producing
// confusing downstream errors). Any format drift fails the gate explicitly.
if (
  !('vulnerabilities' in data) ||
  typeof data.vulnerabilities !== 'object' ||
  data.vulnerabilities === null ||
  Array.isArray(data.vulnerabilities)
) {
  console.error('[audit-allowed] FAIL: npm audit JSON missing or malformed "vulnerabilities" key');
  console.error('This usually means the audit endpoint returned an error or the JSON format changed.');
  console.error(stdout.slice(0, 500));
  process.exit(2);
}

const vulns = data.vulnerabilities;
/** @type {Array<{name: string, severity: string, ghsas: string[]}>} */
const violations = [];

// GHSA IDs behind one vulnerability entry. A `via` item is either an advisory
// object (with a GHSA URL) or a string naming another vulnerable package whose
// own advisories are the cause (npm reports a dependent such as
// `@azure/identity` with `via: ["@azure/msal-node"]`). Follow such strings to
// that package's entry so an allowlisted advisory is recognised through its
// dependents. Every branch that cannot be resolved (a name that is not an own
// key, a malformed or empty entry, a cycle on the active path, or an advisory
// without an exact GitHub advisory URL) contributes a non-allowlisted marker, so
// an allowlisted sibling can never mask it. The active recursion path is
// tracked so a shared dependency (a diamond) is not mistaken for a cycle.
function collectGhsas(pkg, seen) {
  const unknown = ['(missing-ghsa-id)'];
  if (!Object.hasOwn(vulns, pkg) || seen.has(pkg)) return unknown;

  const entry = vulns[pkg];
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    !Array.isArray(entry.via) ||
    entry.via.length === 0
  ) return unknown;

  const active = new Set(seen);
  active.add(pkg);
  const found = [];

  for (const v of entry.via) {
    if (typeof v === 'string') {
      found.push(...collectGhsas(v, active));
      continue;
    }

    const match =
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof v.url === 'string'
        ? v.url.match(
            /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/,
          )
        : null;

    found.push(match ? match[1] : '(missing-ghsa-id)');
  }

  return found;
}

for (const [name, vuln] of Object.entries(vulns)) {
  // Fail-CLOSED on malformed entries: if an advisory entry isn't a plain object
  // we can't tell whether it's allowlisted, so treat format drift as a gate error.
  if (!vuln || typeof vuln !== 'object' || Array.isArray(vuln)) {
    console.error(`[audit-allowed] FAIL: vulnerability entry for "${name}" is not a plain object`);
    console.error(stdout.slice(0, 500));
    process.exit(2);
  }
  // Validate severity is a string before later `.padEnd()` calls. Missing or
  // non-string severity is audit-output drift → exit 2, not a crash.
  if (typeof vuln.severity !== 'string') {
    console.error(`[audit-allowed] FAIL: vulnerability entry for "${name}" is missing a string "severity" field`);
    console.error(stdout.slice(0, 500));
    process.exit(2);
  }
  // Distinguish audit-output schema drift from a real allowlist violation:
  // if `via` is PRESENT but not an array, that's format drift (exit 2). An
  // absent `via` falls through to the empty-ghsas violation path (exit 1) —
  // unknown advisory → fail closed.
  if (Object.prototype.hasOwnProperty.call(vuln, 'via') && !Array.isArray(vuln.via)) {
    console.error(`[audit-allowed] FAIL: vulnerability entry for "${name}" has non-array "via"`);
    console.error(stdout.slice(0, 500));
    process.exit(2);
  }
  const ghsas = collectGhsas(name, new Set());
  // Fail closed: if npm audit reports a vulnerability but we can't extract at
  // least one GHSA ID, treat it as unallowlisted instead of silently allowing it.
  const unknownGhsas =
    ghsas.length === 0 ? ['(missing-ghsa-id)'] : ghsas.filter(g => !ALLOWED_GHSAS.has(g));
  if (unknownGhsas.length > 0) {
    violations.push({
      name,
      severity: vuln.severity,
      ghsas: unknownGhsas,
    });
  }
}

if (violations.length > 0) {
  console.error('[audit-allowed] FAIL: advisories outside the allowlist:');
  for (const v of violations) {
    console.error(`  - ${v.severity.padEnd(10)} ${v.name.padEnd(30)} ${v.ghsas.join(', ')}`);
  }
  console.error('');
  console.error('[audit-allowed] Each must be either fixed (npm audit fix), overridden with a');
  console.error('[audit-allowed] documented mitigation in .github/audit-exceptions.md, or explicitly');
  console.error('[audit-allowed] added to ALLOWED_GHSAS in this script with reviewer sign-off.');
  process.exit(1);
}

// "Vulnerability entries" is npm's term for per-package entries. One entry can
// aggregate multiple GHSAs (e.g., expr-eval has two), so calling these
// "advisories" would undercount. Use "vulnerability entries" in the OK message
// to match what `npm audit` actually reports.
const allowedCount = Object.values(vulns).length;
if (allowedCount === 0) {
  console.log('[audit-allowed] OK: 0 vulnerability entries.');
} else {
  console.log(`[audit-allowed] OK: ${allowedCount} vulnerability entr${allowedCount === 1 ? 'y' : 'ies'}, all allowlisted:`);
  for (const [name, vuln] of Object.entries(vulns)) {
    console.log(`  - ${vuln.severity.padEnd(10)} ${name}`);
  }
}
