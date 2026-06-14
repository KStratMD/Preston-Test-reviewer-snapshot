#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$TMP_DIR/docs" "$TMP_DIR/scripts"
cp "$ROOT_DIR/scripts/sync-metric-tokens.mjs" "$TMP_DIR/scripts/sync-metric-tokens.mjs"
cp "$ROOT_DIR/scripts/verify-metrics.mjs" "$TMP_DIR/scripts/verify-metrics.mjs"
cat > "$TMP_DIR/scripts/generate-metrics.mjs" <<'JS'
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv;
const output = argv[argv.indexOf('--output') + 1];
const rootIdx = argv.indexOf('--root');
const root = rootIdx >= 0 ? argv[rootIdx + 1] : '.';

const metrics = {
  generated_at: '2026-04-28T00:00:01.000Z',
  git_sha: 'regenerated',
  dlp_patterns: { count: 14 },
  connectors: { production: 5, beta: 1, demo_only: 10, stub: 1, unknown: 0, items: [] },
  loc: { production_ts: 100, total_ts: 200, total_md: 300 },
};

// Mirror the real generator's input-driven tests/coverage blocks so the
// --include-test-coverage strict-mode scenarios are exercised faithfully:
// populated when the inputs exist, missing-sentinel otherwise.
const summaryPath = path.join(root, 'test-summary.json');
if (fs.existsSync(summaryPath)) {
  const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  metrics.tests = {
    source: 'test-summary.json',
    passing: s.numPassedTests, failed: s.numFailedTests, skipped: s.numPendingTests,
    suites: s.numTotalTestSuites, total: s.numTotalTests,
  };
} else {
  metrics.tests = { source: 'test-summary.json', status: 'missing' };
}
const covPath = path.join(root, 'coverage', 'coverage-summary.json');
if (fs.existsSync(covPath)) {
  const c = JSON.parse(fs.readFileSync(covPath, 'utf8'));
  metrics.coverage = {
    source: 'coverage/coverage-summary.json',
    lines: c.total.lines.pct, branches: c.total.branches.pct,
    functions: c.total.functions.pct, statements: c.total.statements.pct,
  };
} else {
  metrics.coverage = { source: 'coverage/coverage-summary.json', status: 'missing' };
}

fs.writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`);
JS

cat > "$TMP_DIR/metrics.json" <<'JSON'
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "abc123",
  "dlp_patterns": { "count": 14 },
  "connectors": { "production": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "loc": { "production_ts": 100, "total_ts": 200, "total_md": 300 }
}
JSON

cat > "$TMP_DIR/docs/status.md" <<'MD'
# Status

DLP: <!-- METRIC:dlp_patterns.count -->old<!-- /METRIC -->
Production connectors: <!-- METRIC:connectors.production -->0<!-- /METRIC -->
MD

if node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" --check >"$TMP_DIR/metric-check.out" 2>"$TMP_DIR/metric-check.err"; then
  fail "Expected stale metric token check to fail"
fi
grep -q "docs/status.md" "$TMP_DIR/metric-check.err" || fail "Stale token check did not report the markdown path"

node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-sync.out"
grep -q '<!-- METRIC:dlp_patterns.count -->14<!-- /METRIC -->' "$TMP_DIR/docs/status.md" || fail "DLP token was not synced"
grep -q '<!-- METRIC:connectors.production -->5<!-- /METRIC -->' "$TMP_DIR/docs/status.md" || fail "Connector token was not synced"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --help | grep -q -- '--root <dir>' || fail "sync help omits --root"

node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-verify.out"
grep -q "Metrics verified" "$TMP_DIR/metric-verify.out" || fail "verify-metrics did not report success"
node "$TMP_DIR/scripts/verify-metrics.mjs" --help | grep -q -- '--root <dir>' || fail "verify help omits --root"

node -e "const fs = require('fs'); const metrics = JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json', 'utf8')); metrics.dlp_patterns.count = 15; fs.writeFileSync('$TMP_DIR/metrics.json', JSON.stringify(metrics, null, 2) + '\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-stale.out" 2>"$TMP_DIR/metric-stale.err"; then
  fail "Expected stale generated metrics check to fail"
fi
grep -q "metrics.json is stale" "$TMP_DIR/metric-stale.err" || fail "Stale generated metrics failure was not explained"

# Tests-block drift exclusion: committed metrics.json populates tests.*
# from the PR-author's local jest --json --outputFile run, but the
# verify-metrics regen happens in reviewer-mirror.yml without running
# the suite, so the synthetic generator (and real generator without
# test-summary.json) emits a {status: "missing"} sentinel. Confirm the
# verify-metrics drift comparison excludes the populated tests block
# the same way it excludes loc.total_*. Reset to a clean baseline
# first so the dlp_patterns.count = 15 mutation above doesn't bleed in.
cat > "$TMP_DIR/metrics.json" <<'JSON'
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "abc123",
  "dlp_patterns": { "count": 14 },
  "connectors": { "production": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "tests": { "source": "test-summary.json", "passing": 9330, "failed": 0, "skipped": 23, "suites": 392, "total": 9353 },
  "loc": { "production_ts": 100, "total_ts": 200, "total_md": 300 }
}
JSON
# Re-sync tokens against the reset file so sync --check passes.
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-resync.out"
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-tests-exclude.out" 2>"$TMP_DIR/metric-tests-exclude.err" || fail "verify-metrics rejected populated tests block (drift exclusion regression). Stderr: $(cat "$TMP_DIR/metric-tests-exclude.err")"
grep -q "Metrics verified" "$TMP_DIR/metric-tests-exclude.out" || fail "verify-metrics did not report success after tests-block drift exclusion"

# Confirm exclusion is value-blind, not just shape-blind: mutate
# tests.passing to a different number and verify the gate still passes.
node -e "const fs = require('fs'); const metrics = JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json', 'utf8')); metrics.tests.passing = 99999; fs.writeFileSync('$TMP_DIR/metrics.json', JSON.stringify(metrics, null, 2) + '\n');"
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-tests-mutate.out" 2>"$TMP_DIR/metric-tests-mutate.err" || fail "verify-metrics rejected mutated tests.passing (drift exclusion should be value-blind). Stderr: $(cat "$TMP_DIR/metric-tests-mutate.err")"

# --- --include-test-coverage (CI-strict) mode ---------------------------------
# In ci-minimal.yml the suite runs BEFORE verify-metrics, so test-summary.json +
# coverage/coverage-summary.json exist and tests.*/coverage.* become comparable.
# This closes the committed-undercount gap. Seed inputs the strict mode requires.
cat > "$TMP_DIR/test-summary.json" <<'JSON'
{ "numPassedTests": 11569, "numFailedTests": 0, "numPendingTests": 0, "numTotalTestSuites": 520, "numTotalTests": 11569 }
JSON
mkdir -p "$TMP_DIR/coverage"
cat > "$TMP_DIR/coverage/coverage-summary.json" <<'JSON'
{ "total": { "lines": {"pct":68.5}, "branches": {"pct":57}, "functions": {"pct":71}, "statements": {"pct":68} } }
JSON
# Committed metrics.json with tests/coverage EXACTLY matching what the stub
# regen will derive from those inputs (so current → pass).
cat > "$TMP_DIR/metrics.json" <<'JSON'
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "abc123",
  "dlp_patterns": { "count": 14 },
  "connectors": { "production": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "tests": { "source": "test-summary.json", "passing": 11569, "failed": 0, "skipped": 0, "suites": 520, "total": 11569 },
  "coverage": { "source": "coverage/coverage-summary.json", "lines": 68.5, "branches": 57, "functions": 71, "statements": 68 },
  "loc": { "production_ts": 100, "total_ts": 200, "total_md": 300 }
}
JSON
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-strict-resync.out"

# Scenario: current tests/coverage (exact match) → strict mode passes (exit 0).
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-ok.out" 2>"$TMP_DIR/metric-strict-ok.err" || fail "strict mode rejected current tests/coverage. Stderr: $(cat "$TMP_DIR/metric-strict-ok.err")"
grep -q "Metrics verified" "$TMP_DIR/metric-strict-ok.out" || fail "strict mode did not report success on current metrics"

# Scenario: small env-jitter within tolerance → strict mode PASSES (the whole point —
# CI skips a few env-gated tests a dev box runs, so committed need not byte-match live).
# regen tests=11569; bump committed by +8 tests and +0.3pt coverage (both within tol).
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json','utf8'));m.tests.passing=11577;m.tests.total=11577;m.coverage.lines=68.8;m.coverage.statements=68.3;fs.writeFileSync('$TMP_DIR/metrics.json',JSON.stringify(m,null,2)+'\n');"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >/dev/null
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-jitter.out" 2>"$TMP_DIR/metric-strict-jitter.err" || fail "strict mode rejected within-tolerance jitter (should pass). Stderr: $(cat "$TMP_DIR/metric-strict-jitter.err")"
# Reset committed to the exact-match baseline before the gross-drift scenarios.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json','utf8'));m.tests.passing=11569;m.tests.total=11569;m.coverage.lines=68.5;m.coverage.statements=68;fs.writeFileSync('$TMP_DIR/metrics.json',JSON.stringify(m,null,2)+'\n');"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >/dev/null

# Scenario: tests.passing stale BEYOND tolerance → strict mode FAILS (plain mode passes).
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json','utf8'));m.tests.passing=11301;m.tests.total=11301;fs.writeFileSync('$TMP_DIR/metrics.json',JSON.stringify(m,null,2)+'\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-stale.out" 2>"$TMP_DIR/metric-strict-stale.err"; then
  fail "strict mode passed a tests.passing stale beyond tolerance (should have failed)"
fi
grep -q "tests/coverage are stale" "$TMP_DIR/metric-strict-stale.err" || fail "strict-mode tolerance failure was not explained. Stderr: $(cat "$TMP_DIR/metric-strict-stale.err")"
grep -q "tests.passing: committed 11301 vs live 11569" "$TMP_DIR/metric-strict-stale.err" || fail "strict-mode failure did not name the drifted field"
# Sanity: the SAME stale file passes WITHOUT the flag (proves the flag is what catches it).
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-strict-plainok.out" 2>"$TMP_DIR/metric-strict-plainok.err" || fail "plain mode should still pass the stale tests block. Stderr: $(cat "$TMP_DIR/metric-strict-plainok.err")"

# Scenario: coverage stale BEYOND tolerance → strict mode FAILS.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json','utf8'));m.tests.passing=11569;m.tests.total=11569;m.coverage.lines=66.0;fs.writeFileSync('$TMP_DIR/metrics.json',JSON.stringify(m,null,2)+'\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-cov.out" 2>"$TMP_DIR/metric-strict-cov.err"; then
  fail "strict mode passed coverage stale beyond tolerance (should have failed)"
fi
grep -q "coverage.lines: committed 66% vs live 68.5%" "$TMP_DIR/metric-strict-cov.err" || fail "strict-mode coverage failure not explained. Stderr: $(cat "$TMP_DIR/metric-strict-cov.err")"
# Reset for the next scenarios.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR/metrics.json','utf8'));m.coverage.lines=68.5;fs.writeFileSync('$TMP_DIR/metrics.json',JSON.stringify(m,null,2)+'\n');"

# Scenario: inputs PRESENT but malformed so the regen tests block is unpopulated →
# strict mode must FAIL-CLOSED (not silently skip + report success). test-summary.json
# exists (passes the existence guard) but lacks numPassedTests, so the synthetic
# generator emits a non-numeric tests.passing. (Copilot review on PR #877.)
echo '{ "note": "valid json, but no numPassedTests" }' > "$TMP_DIR/test-summary.json"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-failclosed.out" 2>"$TMP_DIR/metric-strict-failclosed.err"; then
  fail "strict mode passed when the live tests block was unpopulated (should fail-closed)"
fi
grep -q "live (regenerated) tests block is missing/unpopulated" "$TMP_DIR/metric-strict-failclosed.err" || fail "fail-closed message for missing live tests block not shown. Stderr: $(cat "$TMP_DIR/metric-strict-failclosed.err")"
# Restore a valid test-summary.json for the final scenario.
cat > "$TMP_DIR/test-summary.json" <<'JSON'
{ "numPassedTests": 11569, "numFailedTests": 0, "numPendingTests": 0, "numTotalTestSuites": 520, "numTotalTests": 11569 }
JSON

# Scenario: flag without inputs → exit 2 (fail-closed, not a confusing drift fail).
rm -f "$TMP_DIR/test-summary.json"
set +e
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-noinput.out" 2>"$TMP_DIR/metric-strict-noinput.err"
rc=$?
set -e
[ "$rc" -eq 2 ] || fail "strict mode without inputs should exit 2, got $rc"
grep -q "requires test-summary.json" "$TMP_DIR/metric-strict-noinput.err" || fail "strict-mode missing-input message not shown"

echo "metrics tool tests passed"
