#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
# Node resolves paths passed as argv (MSYS auto-converts them when launching
# node.exe), but a path baked inside a `node -e` script string is NOT converted —
# on Git Bash for Windows the literal /tmp/... then resolves to a non-existent
# C:\tmp\... and ENOENTs. cygpath -m yields a Node-resolvable mixed path
# (C:/Users/.../Temp/...); it is absent on Linux/macOS, where TMP_DIR already is.
if command -v cygpath >/dev/null 2>&1; then
  TMP_DIR_NODE="$(cygpath -m "$TMP_DIR")"
  ROOT_DIR_NODE="$(cygpath -m "$ROOT_DIR")"
else
  TMP_DIR_NODE="$TMP_DIR"
  ROOT_DIR_NODE="$ROOT_DIR"
fi

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
  connectors: { production: 0, production_ready: 5, beta: 1, demo_only: 10, stub: 1, unknown: 0, items: [] },
  loc: { production_ts: 100, total_ts: 200 },
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
  "connectors": { "production": 0, "production_ready": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "loc": { "production_ts": 100, "total_ts": 200 }
}
JSON

cat > "$TMP_DIR/docs/status.md" <<'MD'
# Status

DLP: <!-- METRIC:dlp_patterns.count -->old<!-- /METRIC -->
Production connectors: <!-- METRIC:connectors.production -->9<!-- /METRIC -->
Production-ready connectors: <!-- METRIC:connectors.production_ready -->0<!-- /METRIC -->
MD

if node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" --check >"$TMP_DIR/metric-check.out" 2>"$TMP_DIR/metric-check.err"; then
  fail "Expected stale metric token check to fail"
fi
grep -q "docs/status.md" "$TMP_DIR/metric-check.err" || fail "Stale token check did not report the markdown path"

node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-sync.out"
grep -q '<!-- METRIC:dlp_patterns.count -->14<!-- /METRIC -->' "$TMP_DIR/docs/status.md" || fail "DLP token was not synced"
grep -q '<!-- METRIC:connectors.production -->0<!-- /METRIC -->' "$TMP_DIR/docs/status.md" || fail "Connector token was not synced (production should sync to 0)"
grep -q '<!-- METRIC:connectors.production_ready -->5<!-- /METRIC -->' "$TMP_DIR/docs/status.md" || fail "production_ready token was not synced"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --help | grep -q -- '--root <dir>' || fail "sync help omits --root"

# Regression: git worktrees under .claude/worktrees/ hold OTHER branches' copies
# of METRIC-token docs. The scanner must skip them, not flag their (rightly)
# stale tokens against this tree's metrics.json.
mkdir -p "$TMP_DIR/.claude/worktrees/other-branch"
cat > "$TMP_DIR/.claude/worktrees/other-branch/EVALUATION.md" <<'MD'
# Eval (other branch)
Stale on purpose: <!-- METRIC:dlp_patterns.count -->999<!-- /METRIC -->
MD
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" --check >"$TMP_DIR/metric-wt-check.out" 2>"$TMP_DIR/metric-wt-check.err" \
  || fail "sync --check must ignore stale tokens under .claude/worktrees/ (stderr: $(cat "$TMP_DIR/metric-wt-check.err"))"
rm -rf "$TMP_DIR/.claude"

node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-verify.out"
grep -q "Metrics verified" "$TMP_DIR/metric-verify.out" || fail "verify-metrics did not report success"
node "$TMP_DIR/scripts/verify-metrics.mjs" --help | grep -q -- '--root <dir>' || fail "verify help omits --root"

# Deterministic cloc totals are strict whenever regeneration produced numeric
# values. Each stale committed field must fail independently.
cp "$TMP_DIR/metrics.json" "$TMP_DIR/metrics-baseline.json"
for loc_field_name in total_ts; do
  cp "$TMP_DIR/metrics-baseline.json" "$TMP_DIR/metrics.json"
  node -e "const fs=require('fs');const p='$TMP_DIR_NODE/metrics.json';const m=JSON.parse(fs.readFileSync(p,'utf8'));m.loc[process.argv[1]]+=1;fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');" "$loc_field_name"
  if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-loc-stale.out" 2>"$TMP_DIR/metric-loc-stale.err"; then
    fail "verify-metrics passed stale loc.$loc_field_name"
  fi
  grep -q "metrics.json is stale" "$TMP_DIR/metric-loc-stale.err" || fail "stale loc.$loc_field_name failure was not explained"
done
cp "$TMP_DIR/metrics-baseline.json" "$TMP_DIR/metrics.json"
rm "$TMP_DIR/metrics-baseline.json"

node -e "const fs = require('fs'); const metrics = JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json', 'utf8')); metrics.dlp_patterns.count = 15; fs.writeFileSync('$TMP_DIR_NODE/metrics.json', JSON.stringify(metrics, null, 2) + '\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-stale.out" 2>"$TMP_DIR/metric-stale.err"; then
  fail "Expected stale generated metrics check to fail"
fi
grep -q "metrics.json is stale" "$TMP_DIR/metric-stale.err" || fail "Stale generated metrics failure was not explained"

# Tests-block drift exclusion: committed metrics.json populates tests.*
# from the PR-author's local jest --json --outputFile run, but the
# verify-metrics regen happens in reviewer-mirror.yml without running
# the suite, so the synthetic generator (and real generator without
# test-summary.json) emits a {status: "missing"} sentinel. Confirm the
# verify-metrics drift comparison excludes the populated tests block while
# retaining deterministic LOC totals. Reset to a clean baseline
# first so the dlp_patterns.count = 15 mutation above doesn't bleed in.
cat > "$TMP_DIR/metrics.json" <<'JSON'
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "abc123",
  "dlp_patterns": { "count": 14 },
  "connectors": { "production": 0, "production_ready": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "tests": { "source": "test-summary.json", "passing": 9330, "failed": 0, "skipped": 23, "suites": 392, "total": 9353 },
  "loc": { "production_ts": 100, "total_ts": 200 }
}
JSON
# Re-sync tokens against the reset file so sync --check passes.
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-resync.out"
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-tests-exclude.out" 2>"$TMP_DIR/metric-tests-exclude.err" || fail "verify-metrics rejected populated tests block (drift exclusion regression). Stderr: $(cat "$TMP_DIR/metric-tests-exclude.err")"
grep -q "Metrics verified" "$TMP_DIR/metric-tests-exclude.out" || fail "verify-metrics did not report success after tests-block drift exclusion"

# Confirm exclusion is value-blind, not just shape-blind: mutate
# tests.passing to a different number and verify the gate still passes.
node -e "const fs = require('fs'); const metrics = JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json', 'utf8')); metrics.tests.passing = 99999; fs.writeFileSync('$TMP_DIR_NODE/metrics.json', JSON.stringify(metrics, null, 2) + '\n');"
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
  "connectors": { "production": 0, "production_ready": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "tests": { "source": "test-summary.json", "passing": 11569, "failed": 0, "skipped": 0, "suites": 520, "total": 11569 },
  "coverage": { "source": "coverage/coverage-summary.json", "lines": 68.5, "branches": 57, "functions": 71, "statements": 68 },
  "loc": { "production_ts": 100, "total_ts": 200 }
}
JSON
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-strict-resync.out"

# Scenario: current tests/coverage (exact match) → strict mode passes (exit 0).
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-ok.out" 2>"$TMP_DIR/metric-strict-ok.err" || fail "strict mode rejected current tests/coverage. Stderr: $(cat "$TMP_DIR/metric-strict-ok.err")"
grep -q "Metrics verified" "$TMP_DIR/metric-strict-ok.out" || fail "strict mode did not report success on current metrics"

# Scenario: small env-jitter within tolerance → strict mode PASSES (the whole point —
# CI skips a few env-gated tests a dev box runs, so committed need not byte-match live).
# regen tests=11569; bump committed by +8 tests and +0.3pt coverage (both within tol).
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json','utf8'));m.tests.passing=11577;m.tests.total=11577;m.coverage.lines=68.8;m.coverage.statements=68.3;fs.writeFileSync('$TMP_DIR_NODE/metrics.json',JSON.stringify(m,null,2)+'\n');"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >/dev/null
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-jitter.out" 2>"$TMP_DIR/metric-strict-jitter.err" || fail "strict mode rejected within-tolerance jitter (should pass). Stderr: $(cat "$TMP_DIR/metric-strict-jitter.err")"
# Reset committed to the exact-match baseline before the gross-drift scenarios.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json','utf8'));m.tests.passing=11569;m.tests.total=11569;m.coverage.lines=68.5;m.coverage.statements=68;fs.writeFileSync('$TMP_DIR_NODE/metrics.json',JSON.stringify(m,null,2)+'\n');"
node "$TMP_DIR/scripts/sync-metric-tokens.mjs" --root "$TMP_DIR" >/dev/null

# Scenario: tests.passing stale BEYOND tolerance → strict mode FAILS (plain mode passes).
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json','utf8'));m.tests.passing=11301;m.tests.total=11301;fs.writeFileSync('$TMP_DIR_NODE/metrics.json',JSON.stringify(m,null,2)+'\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-stale.out" 2>"$TMP_DIR/metric-strict-stale.err"; then
  fail "strict mode passed a tests.passing stale beyond tolerance (should have failed)"
fi
grep -q "tests/coverage are stale" "$TMP_DIR/metric-strict-stale.err" || fail "strict-mode tolerance failure was not explained. Stderr: $(cat "$TMP_DIR/metric-strict-stale.err")"
grep -q "tests.passing: committed 11301 vs live 11569" "$TMP_DIR/metric-strict-stale.err" || fail "strict-mode failure did not name the drifted field"
# Sanity: the SAME stale file passes WITHOUT the flag (proves the flag is what catches it).
node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" >"$TMP_DIR/metric-strict-plainok.out" 2>"$TMP_DIR/metric-strict-plainok.err" || fail "plain mode should still pass the stale tests block. Stderr: $(cat "$TMP_DIR/metric-strict-plainok.err")"

# Scenario: coverage stale BEYOND tolerance → strict mode FAILS.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json','utf8'));m.tests.passing=11569;m.tests.total=11569;m.coverage.lines=66.0;fs.writeFileSync('$TMP_DIR_NODE/metrics.json',JSON.stringify(m,null,2)+'\n');"
if node "$TMP_DIR/scripts/verify-metrics.mjs" --root "$TMP_DIR" --include-test-coverage >"$TMP_DIR/metric-strict-cov.out" 2>"$TMP_DIR/metric-strict-cov.err"; then
  fail "strict mode passed coverage stale beyond tolerance (should have failed)"
fi
grep -q "coverage.lines: committed 66% vs live 68.5%" "$TMP_DIR/metric-strict-cov.err" || fail "strict-mode coverage failure not explained. Stderr: $(cat "$TMP_DIR/metric-strict-cov.err")"
# Reset for the next scenarios.
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('$TMP_DIR_NODE/metrics.json','utf8'));m.coverage.lines=68.5;fs.writeFileSync('$TMP_DIR_NODE/metrics.json',JSON.stringify(m,null,2)+'\n');"

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

# --- B5.1/B5.2: scripts/lib/loc-metrics.mjs LOC totals must depend only on
# Git-tracked content, not on whatever else sits in the working tree
# (untracked build output, ignored junk). Exercises the REAL
# scripts/lib/loc-metrics.mjs (not the synthetic generate-metrics.mjs stub
# above) against a throwaway Git repository.
#
# Uses a fixture-owned deterministic fake `cloc` on PATH instead of a host
# install (Copilot review on PR #1177): every fixture file below is built
# with zero blank or comment lines, so "code lines == non-empty lines"
# matches real cloc's own count for them exactly, while making the exact-
# number assertions hold in every environment (including `ci-minimal`, which
# intentionally has no cloc) instead of only wherever cloc happens to be
# installed. The B5.3 section further below deliberately keeps cloc OFF
# PATH to test the missing-cloc contract; it is unaffected by this stub
# because it fully replaces PATH via `env PATH=...` rather than appending.

FAKE_CLOC_DIR="$TMP_DIR/fake-cloc-bin"
mkdir -p "$FAKE_CLOC_DIR"
cat > "$FAKE_CLOC_DIR/cloc" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
list_file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--list-file" ]; then
    list_file="$arg"
  fi
  prev="$arg"
done
[ -n "$list_file" ] || { echo "fake-cloc: --list-file required" >&2; exit 1; }

ts_code=0
md_code=0
n_files=0
while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  [ -f "$path" ] || continue
  lines="$(grep -c . "$path" || true)"
  case "$path" in
    *.ts) ts_code=$((ts_code + lines)); n_files=$((n_files + 1)) ;;
    *.md) md_code=$((md_code + lines)); n_files=$((n_files + 1)) ;;
    */Dockerfile.hosted|Dockerfile.hosted)
      # force-lang'd, so cloc recognizes and counts the file, but it's
      # neither TypeScript nor Markdown.
      n_files=$((n_files + 1)) ;;
    *) : ;; # unrecognized language (e.g. .gitignore): real cloc excludes
             # these from SUM.nFiles entirely, so this stub does too.
  esac
done < "$list_file"

printf '{"TypeScript":{"code":%d},"Markdown":{"code":%d},"SUM":{"nFiles":%d}}\n' "$ts_code" "$md_code" "$n_files"
SH
chmod +x "$FAKE_CLOC_DIR/cloc"
PATH="$FAKE_CLOC_DIR:$PATH"
export PATH

loc_totals() {
  # pathToFileURL, not the bare path: Node 24 rejects a 'c:' protocol in
  # dynamic import() on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME), so the
  # cygpath -m mixed path this harness deliberately builds must be converted
  # to a file:// URL. On Linux/macOS the conversion is a no-op.
  node -e "
    import(require('node:url').pathToFileURL(process.argv[1]).href).then(({ computeLocMetrics }) => {
      console.log(JSON.stringify(computeLocMetrics(process.argv[2])));
    });
  " "$ROOT_DIR_NODE/scripts/lib/loc-metrics.mjs" "$1"
}

loc_field() {
  node -pe "JSON.parse(process.argv[1])[process.argv[2]]" "$1" "$2"
}

assert_loc_field() {
  local json="$1" field="$2" expected="$3"
  local actual
  actual="$(loc_field "$json" "$field")"
  [ "$actual" = "$expected" ] || fail "loc.$field expected $expected, got $actual ($json)"
}

LOC_FIXTURE="$TMP_DIR/loc-fixture"
if command -v cygpath >/dev/null 2>&1; then
  LOC_FIXTURE_NODE="$(cygpath -m "$LOC_FIXTURE")"
else
  LOC_FIXTURE_NODE="$LOC_FIXTURE"
fi

mkdir -p "$LOC_FIXTURE/src"
git -C "$LOC_FIXTURE" init -q
git -C "$LOC_FIXTURE" config user.email "test@example.com"
git -C "$LOC_FIXTURE" config user.name "Test"
{ for i in $(seq 1 10); do echo "export const line$i = $i;"; done; } > "$LOC_FIXTURE/src/tracked.ts"
{ for i in $(seq 1 5); do echo "Line $i of tracked docs."; done; } > "$LOC_FIXTURE/tracked.md"
echo "ignored/" > "$LOC_FIXTURE/.gitignore"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "seed tracked files"

baseline="$(loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$baseline" total_ts 10
assert_loc_field "$baseline" total_md 5
assert_loc_field "$baseline" total_files 2

# A large untracked file must not move the totals.
{ for i in $(seq 1 500); do echo "untracked line $i"; done; } > "$LOC_FIXTURE/src/untracked.ts"
after_untracked="$(loc_totals "$LOC_FIXTURE_NODE")"
[ "$after_untracked" = "$baseline" ] || fail "adding a large untracked file changed loc totals: $after_untracked vs $baseline"

# Modifying that untracked file must still not move the totals.
{ for i in $(seq 1 900); do echo "untracked line $i, modified"; done; } > "$LOC_FIXTURE/src/untracked.ts"
after_untracked_mod="$(loc_totals "$LOC_FIXTURE_NODE")"
[ "$after_untracked_mod" = "$baseline" ] || fail "modifying an untracked file changed loc totals: $after_untracked_mod vs $baseline"

# A large ignored file must not move the totals.
mkdir -p "$LOC_FIXTURE/ignored"
{ for i in $(seq 1 500); do echo "ignored line $i"; done; } > "$LOC_FIXTURE/ignored/junk.ts"
after_ignored="$(loc_totals "$LOC_FIXTURE_NODE")"
[ "$after_ignored" = "$baseline" ] || fail "adding a large ignored file changed loc totals: $after_ignored vs $baseline"

# Removing the untracked/ignored files must still leave totals unchanged.
rm -f "$LOC_FIXTURE/src/untracked.ts"
rm -rf "$LOC_FIXTURE/ignored"
after_removed="$(loc_totals "$LOC_FIXTURE_NODE")"
[ "$after_removed" = "$baseline" ] || fail "removing untracked/ignored files changed loc totals: $after_removed vs $baseline"

# Tracked files under a formerly cloc-excluded top-level directory name stay
# excluded even though they are now Git-tracked (documented filter policy:
# generated/vendored directories never count, tracked or not).
{ for i in $(seq 1 20); do echo "Coverage note line $i."; done; } > "$LOC_FIXTURE/coverage-note.md.tmp"
mkdir -p "$LOC_FIXTURE/coverage"
mv "$LOC_FIXTURE/coverage-note.md.tmp" "$LOC_FIXTURE/coverage/manual-note.md"
mkdir -p "$LOC_FIXTURE/dist"
{ for i in $(seq 1 15); do echo "export const distLine$i = $i;"; done; } > "$LOC_FIXTURE/dist/output.ts"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track files under excluded directory names"
after_excluded_dirs="$(loc_totals "$LOC_FIXTURE_NODE")"
[ "$after_excluded_dirs" = "$baseline" ] || fail "tracking files under coverage/ and dist/ should not move loc totals (documented exclusion): $after_excluded_dirs vs $baseline"

# A tracked path that merely CONTAINS "dist" as a substring (not a path
# segment) is not excluded — proves the filter is prefix/segment-based, not
# a substring match.
mkdir -p "$LOC_FIXTURE/src/dist-utils"
{ for i in $(seq 1 7); do echo "export const keepLine$i = $i;"; done; } > "$LOC_FIXTURE/src/dist-utils/keep.ts"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track a file whose path merely contains dist as a substring"
after_substring="$(loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$after_substring" total_ts 17
assert_loc_field "$after_substring" total_md 5
assert_loc_field "$after_substring" total_files 3

# Filenames with spaces and non-ASCII characters must be counted, proving the
# manifest is passed to cloc via a list file (no shell interpolation, no
# implicit tokenizing on whitespace).
{ for i in $(seq 1 6); do echo "export const resumeLine$i = $i;"; done; } > "$LOC_FIXTURE/src/résumé draft.ts"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track a file with spaces and non-ASCII in its name"
after_unicode_space="$(loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$after_unicode_space" total_ts 23
assert_loc_field "$after_unicode_space" total_files 4

# Git's -z manifest permits a literal newline in a tracked filename. The
# cloc transfer must preserve it as one file rather than re-splitting it in a
# newline-delimited --list-file.
newline_path=$'src/line\nbreak.ts'
{ for i in $(seq 1 4); do echo "export const newlinePathLine$i = $i;"; done; } > "$LOC_FIXTURE/$newline_path"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track a file with a newline in its name"
after_newline_path="$(loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$after_newline_path" total_ts 27
assert_loc_field "$after_newline_path" total_files 5

# Only regular Git blobs belong in the manifest. A tracked symlink must not
# follow host-local content outside the repository (and must not become a
# one-line placeholder count on Windows checkouts with core.symlinks=false).
EXTERNAL_TS="$TMP_DIR/external-source.ts"
{ for i in $(seq 1 50); do echo "export const externalLine$i = $i;"; done; } > "$EXTERNAL_TS"
ln -s "$EXTERNAL_TS" "$LOC_FIXTURE/src/external-link.ts"
# `ln -s` under MSYS/Git Bash silently COPIES unless MSYS=winsymlinks:* is set,
# so on a default Windows checkout this fixture is a regular 50-line blob and
# the assertion below would fail for a reason that has nothing to do with the
# manifest logic. Assert only where a real symlink exists; elsewhere drop the
# copy so the running totals stay on the symlink-excluded baseline that the
# following cases build on. Before cloc was launchable on Windows this whole
# section never executed there, which is why the gap surfaced only now.
if [ -L "$LOC_FIXTURE/src/external-link.ts" ]; then
  git -C "$LOC_FIXTURE" add -A
  git -C "$LOC_FIXTURE" commit -q -m "track a symlink to an external file"
  after_external_symlink="$(loc_totals "$LOC_FIXTURE_NODE")"
  assert_loc_field "$after_external_symlink" total_ts 27
  assert_loc_field "$after_external_symlink" total_files 5
else
  echo "SKIP: external-symlink LOC case — this platform's 'ln -s' copied instead of linking"
  rm -f "$LOC_FIXTURE/src/external-link.ts"
fi

# cloc 1.98 treats list-file lines matching /^\s*#/ as comments. Root-level
# tracked files with those legal names must be materialized safely instead of
# disappearing from the manifest.
{ for i in $(seq 1 3); do echo "Tracked note line $i."; done; } > "$LOC_FIXTURE/#tracked-notes.md"
leading_hash_ts=' #tracked-source.ts'
{ for i in $(seq 1 2); do echo "export const leadingHashLine$i = $i;"; done; } > "$LOC_FIXTURE/$leading_hash_ts"
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track root files that resemble list-file comments"
after_comment_paths="$(loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$after_comment_paths" total_ts 29
assert_loc_field "$after_comment_paths" total_md 8
assert_loc_field "$after_comment_paths" total_files 7


# cloc 1.98 on Windows does not auto-detect the Dockerfile.hosted suffix,
# while the same version on Linux does. Require the invocation to carry an
# explicit language override so total_files is stable across platforms and
# cloc versions instead of depending on filename heuristics.
cat > "$LOC_FIXTURE/Dockerfile.hosted" <<'DOCKERFILE'
FROM node:22-alpine
WORKDIR /app
COPY . .
DOCKERFILE
git -C "$LOC_FIXTURE" add -A
git -C "$LOC_FIXTURE" commit -q -m "track Dockerfile.hosted"

REAL_CLOC_BIN="$(command -v cloc)"
CLOC_ARG_GUARD="$TMP_DIR/cloc-arg-guard"
mkdir -p "$CLOC_ARG_GUARD"
cat > "$CLOC_ARG_GUARD/cloc" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
force_lang=false
no_timeout=false
for arg in "$@"; do
  [ "$arg" = "--force-lang=Dockerfile,hosted" ] && force_lang=true
  [ "$arg" = "--timeout=0" ] && no_timeout=true
done
if [ "$force_lang" = true ] && [ "$no_timeout" = true ]; then
  exec "$REAL_CLOC_BIN" "$@"
fi
echo "missing required --force-lang=Dockerfile,hosted or --timeout=0 override" >&2
exit 64
SH
chmod +x "$CLOC_ARG_GUARD/cloc"
after_dockerfile="$(PATH="$CLOC_ARG_GUARD:$PATH" REAL_CLOC_BIN="$REAL_CLOC_BIN" loc_totals "$LOC_FIXTURE_NODE")"
assert_loc_field "$after_dockerfile" total_files 8

# --- B5.3: the cloc contract is mode-specific --------------------------------
# Exercises the REAL scripts/generate-metrics.mjs (not the synthetic stub) with
# cloc removed from PATH but git and node still present.
#
# This PR #1195 follow-up INVERTED the default: a bare regeneration used to
# succeed with unavailable loc totals, which is how a degraded metrics.json reached
# reviewers looking like a successful run. Default mode and --require-cloc must
# now BOTH fail closed; the degraded path survives only behind the explicit
# --allow-missing-cloc opt-out, which is asserted here so removing that flag
# cannot pass silently. No mode may leave a partially written output file
# behind after a required-tool failure.

NODE_BIN="$(command -v node)"
GIT_BIN="$(command -v git)"
NOCLOC_BIN="$TMP_DIR/no-cloc-bin"
mkdir -p "$NOCLOC_BIN"
# A one-entry PATH holding a symlink to git is the cleanest way to remove cloc
# while keeping git. MSYS/Git Bash copies instead of symlinking, and the copy
# lands without the .exe suffix Windows needs to exec it, so fall back to git's
# own directory — which does not contain the npm cloc shim either. The
# precondition below is asserted rather than assumed: if cloc were still
# reachable, this case would silently stop testing the degraded path.
if ln -s "$GIT_BIN" "$NOCLOC_BIN/git" 2>/dev/null && [ -L "$NOCLOC_BIN/git" ]; then
  NOCLOC_PATH="$NOCLOC_BIN"
else
  rm -f "$NOCLOC_BIN/git"
  NOCLOC_PATH="$(dirname "$GIT_BIN")"
fi
if PATH="$NOCLOC_PATH" command -v cloc >/dev/null 2>&1; then
  fail "test setup error: cloc is still reachable from the reduced PATH ($NOCLOC_PATH)"
fi

GEN_OUTPUT="$TMP_DIR/generated-metrics.json"
if [ -f "$GEN_OUTPUT" ]; then
  fail "test setup error: $GEN_OUTPUT should not exist yet"
fi

# Default mode (no flag) must now fail closed, exactly like --require-cloc.
set +e
env PATH="$NOCLOC_PATH" "$NODE_BIN" "$ROOT_DIR_NODE/scripts/generate-metrics.mjs" --root "$ROOT_DIR_NODE" --output "$TMP_DIR_NODE/generated-metrics.json" \
  >"$TMP_DIR/gen-nocloc.out" 2>"$TMP_DIR/gen-nocloc.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "generate-metrics without cloc (default mode) must exit nonzero, not degrade to null totals"
grep -qi "cloc" "$TMP_DIR/gen-nocloc.err" || fail "default-mode failure message should mention cloc. Stderr: $(cat "$TMP_DIR/gen-nocloc.err")"
[ -f "$GEN_OUTPUT" ] && fail "default-mode failure must not leave a partially written output file"

# --allow-missing-cloc is the only remaining way to continue without cloc. When
# an earlier metrics artifact exists, the diagnostic output must preserve its
# last known total_ts instead of overwriting that factual claim with null.
cat > "$GEN_OUTPUT" <<'JSON'
{
  "loc": { "total_ts": 987 }
}
JSON
env PATH="$NOCLOC_PATH" "$NODE_BIN" "$ROOT_DIR_NODE/scripts/generate-metrics.mjs" --root "$ROOT_DIR_NODE" --output "$TMP_DIR_NODE/generated-metrics.json" --allow-missing-cloc \
  >"$TMP_DIR/gen-allowmissing.out" 2>"$TMP_DIR/gen-allowmissing.err" \
  || fail "generate-metrics --allow-missing-cloc should preserve prior totals. Stderr: $(cat "$TMP_DIR/gen-allowmissing.err")"
[ -f "$GEN_OUTPUT" ] || fail "generate-metrics --allow-missing-cloc did not write an output file"
node -pe "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).loc.total_ts === 987" "$GEN_OUTPUT" | grep -qx true \
  || fail "expected prior loc.total_ts to be preserved when cloc is missing (--allow-missing-cloc)"
grep -q 'preserving prior loc.total_ts=987' "$TMP_DIR/gen-allowmissing.err" \
  || fail "preservation warning should identify the retained prior total"
# Repo-census fields are no longer part of the committed contract. cloc is absent
# here, so total_ts is preserved from the prior artifact — but the two removed
# keys must be absent ENTIRELY, which is a different assertion than "present and
# null".
node -pe "const l=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).loc; ('total_md' in l) || ('total_files' in l)" "$GEN_OUTPUT" \
  | grep -qx false || fail "generate-metrics still emits loc.total_md / loc.total_files"
rm -f "$GEN_OUTPUT"

set +e
env PATH="$NOCLOC_PATH" "$NODE_BIN" "$ROOT_DIR_NODE/scripts/generate-metrics.mjs" --root "$ROOT_DIR_NODE" --output "$TMP_DIR_NODE/generated-metrics.json" --require-cloc \
  >"$TMP_DIR/gen-requirecloc.out" 2>"$TMP_DIR/gen-requirecloc.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "generate-metrics --require-cloc without cloc should exit nonzero"
grep -qi "cloc" "$TMP_DIR/gen-requirecloc.err" || fail "--require-cloc failure message should mention cloc. Stderr: $(cat "$TMP_DIR/gen-requirecloc.err")"
[ -f "$GEN_OUTPUT" ] && fail "--require-cloc failure must not leave a partially written output file"

# --- #1119 / #1190: sync-metric-tokens must fail closed, never corrupt --------
# Two distinct mechanisms in one scanner, so two independent red scenarios:
#   #1119 render defect  — a resolvable key whose value is null was rendered as
#                          the literal string "null" into reviewer-facing docs.
#   #1190 match defect   — TOKEN_PATTERN spanned newlines, so an unclosed opener
#                          in prose plus any later closer matched, and the write
#                          path replaced the ENTIRE span: every line between them
#                          was discarded on the SUCCESSFUL exit path.
# Plus the atomicity contract both fixes depend on: a failure anywhere must
# leave every target byte-unchanged, which the pre-fix incremental writer
# could not promise.

GUARD_ROOT="$TMP_DIR/token-guards"

# Rebuild a pristine fixture root. $1 = value for loc.total_ts (JSON literal).
guard_reset() {
  rm -rf "$GUARD_ROOT"
  mkdir -p "$GUARD_ROOT/scripts" "$GUARD_ROOT/docs"
  cp "$ROOT_DIR/scripts/sync-metric-tokens.mjs" "$GUARD_ROOT/scripts/sync-metric-tokens.mjs"
  cat > "$GUARD_ROOT/metrics.json" <<JSON
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "guardfixture",
  "dlp_patterns": { "count": 14 },
  "loc": { "production_ts": 100, "total_ts": $1 }
}
JSON
}

guard_sync() { node "$GUARD_ROOT/scripts/sync-metric-tokens.mjs" --root "$GUARD_ROOT" "$@"; }

# G1 (control): a valid same-line token span still syncs in both modes. This is
# what makes every failing scenario below evidence rather than a scanner that
# rejects everything.
guard_reset 200
cat > "$GUARD_ROOT/docs/ok.md" <<'MD'
# Fixture
DLP: <!-- METRIC:dlp_patterns.count -->0<!-- /METRIC -->
TS LOC: <!-- METRIC:loc.total_ts -->0<!-- /METRIC -->
MD
if guard_sync --check >"$GUARD_ROOT/g1-check.out" 2>"$GUARD_ROOT/g1-check.err"; then
  fail "G1 setup: stale-but-valid tokens should report stale"
fi
guard_sync >"$GUARD_ROOT/g1-sync.out" 2>"$GUARD_ROOT/g1-sync.err" \
  || fail "G1: valid same-line tokens must still sync. Stderr: $(cat "$GUARD_ROOT/g1-sync.err")"
grep -q '<!-- METRIC:dlp_patterns.count -->14<!-- /METRIC -->' "$GUARD_ROOT/docs/ok.md" \
  || fail "G1: dlp token was not synced"
grep -q '<!-- METRIC:loc.total_ts -->200<!-- /METRIC -->' "$GUARD_ROOT/docs/ok.md" \
  || fail "G1: total_ts token was not synced"
guard_sync --check >/dev/null 2>&1 || fail "G1: --check must pass once tokens are current"

# G2 (#1119): a resolvable key whose value is null must fail closed in BOTH
# modes, name the key and the file, and never write the literal "null".
guard_reset null
cat > "$GUARD_ROOT/docs/nullable.md" <<'MD'
# Fixture
TS LOC: <!-- METRIC:loc.total_ts -->200<!-- /METRIC -->
MD
cp "$GUARD_ROOT/docs/nullable.md" "$GUARD_ROOT/nullable.before"
for guard_mode in "--check" ""; do
  set +e
  guard_sync $guard_mode >"$GUARD_ROOT/g2.out" 2>"$GUARD_ROOT/g2.err"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "G2 (#1119): null metric value must exit nonzero in mode '${guard_mode:-write}'"
  grep -q "loc.total_ts" "$GUARD_ROOT/g2.err" \
    || fail "G2 (#1119): failure must name the metric key. Stderr: $(cat "$GUARD_ROOT/g2.err")"
  grep -q "docs/nullable.md" "$GUARD_ROOT/g2.err" \
    || fail "G2 (#1119): failure must name the file. Stderr: $(cat "$GUARD_ROOT/g2.err")"
  cmp -s "$GUARD_ROOT/docs/nullable.md" "$GUARD_ROOT/nullable.before" \
    || fail "G2 (#1119): target was modified during a failing run (mode '${guard_mode:-write}')"
  grep -q '<!-- METRIC:loc.total_ts -->null<!-- /METRIC -->' "$GUARD_ROOT/docs/nullable.md" \
    && fail "G2 (#1119): the literal string null was rendered into a reviewer-facing doc"
done

# G3 (#1190): an opener and a closer on DIFFERENT lines must never match, so the
# prose between them survives. Pre-fix this was the destructive path: the write
# replaced the whole span and exited 0.
guard_reset 200
{
  echo "# Fixture"
  echo 'Prose quoting the syntax: <!-- METRIC:loc.total_ts --> is how a span opens.'
  for i in $(seq 1 40); do echo "load-bearing plan line $i"; done
  echo 'Later, a real span: <!-- METRIC:dlp_patterns.count -->0<!-- /METRIC -->'
} > "$GUARD_ROOT/docs/spanning.md"
cp "$GUARD_ROOT/docs/spanning.md" "$GUARD_ROOT/spanning.before"
set +e
guard_sync >"$GUARD_ROOT/g3.out" 2>"$GUARD_ROOT/g3.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "G3 (#1190): an unclosed opener must fail closed, not exit 0"
cmp -s "$GUARD_ROOT/docs/spanning.md" "$GUARD_ROOT/spanning.before" \
  || fail "G3 (#1190): DESTRUCTIVE — content between a stray opener and a later closer was rewritten"
grep -q "load-bearing plan line 20" "$GUARD_ROOT/docs/spanning.md" \
  || fail "G3 (#1190): prose between the stray opener and the later closer was swallowed"

# G4 (#1190): a bare opener with no closer anywhere gets its own file:line
# diagnostic in both modes — distinct from the ordinary "stale" report, which is
# what left these instances dormant instead of visible.
guard_reset 200
cat > "$GUARD_ROOT/docs/unclosed.md" <<'MD'
# Fixture
Line two.
Prose naming the opener: <!-- METRIC:loc.total_ts --> and nothing closes it.
MD
cp "$GUARD_ROOT/docs/unclosed.md" "$GUARD_ROOT/unclosed.before"
for guard_mode in "--check" ""; do
  set +e
  guard_sync $guard_mode >"$GUARD_ROOT/g4.out" 2>"$GUARD_ROOT/g4.err"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "G4 (#1190): unclosed opener must exit nonzero in mode '${guard_mode:-write}'"
  grep -q "docs/unclosed.md:3" "$GUARD_ROOT/g4.err" \
    || fail "G4 (#1190): diagnostic must give file:line. Stderr: $(cat "$GUARD_ROOT/g4.err")"
  grep -qi "unclosed" "$GUARD_ROOT/g4.err" \
    || fail "G4 (#1190): diagnostic must be distinct from a stale report. Stderr: $(cat "$GUARD_ROOT/g4.err")"
  cmp -s "$GUARD_ROOT/docs/unclosed.md" "$GUARD_ROOT/unclosed.before" \
    || fail "G4 (#1190): target was modified during a failing run (mode '${guard_mode:-write}')"
done

# G5 (atomicity): validate everything before writing anything. File A holds a
# perfectly valid stale token; file B fails. A must come out byte-unchanged.
# The pre-fix writer wrote each file inside the scan loop, so A's fate depended
# on directory-walk order.
guard_reset 200
cat > "$GUARD_ROOT/docs/a-valid-stale.md" <<'MD'
# A
DLP: <!-- METRIC:dlp_patterns.count -->0<!-- /METRIC -->
MD
cat > "$GUARD_ROOT/docs/z-unclosed.md" <<'MD'
# Z
Opener with no closer: <!-- METRIC:dlp_patterns.count -->
MD
cp "$GUARD_ROOT/docs/a-valid-stale.md" "$GUARD_ROOT/a.before"
set +e
guard_sync >"$GUARD_ROOT/g5.out" 2>"$GUARD_ROOT/g5.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "G5: a run containing an unclosed opener must exit nonzero"
cmp -s "$GUARD_ROOT/docs/a-valid-stale.md" "$GUARD_ROOT/a.before" \
  || fail "G5: NON-ATOMIC — a valid file was written before an unrelated failure aborted the run"

rm -rf "$GUARD_ROOT"


# --- fail-closed cloc contract ------------------------------------------------
# Regression for the blind-gate defect: verify-metrics used to spawn the
# generator WITHOUT --require-cloc, so on a machine where cloc could not run the
# generator could not recompute loc.total_*, verify-metrics dropped exactly those
# null fields from the comparison, and it printed an unqualified
# "Metrics verified" over a metrics.json it had not actually checked. That
# passed nine consecutive pushes on PR #1183 and let PR #1193 merge a stale
# total_ts through every required check.
#
# The stub generator below models the real one's two cloc paths: fail closed by
# default (and under an explicit --require-cloc), preserve prior totals or omit
# them only under --allow-missing-cloc.
CLOC_ROOT="$TMP_DIR/cloc-contract"
mkdir -p "$CLOC_ROOT/scripts"
if command -v cygpath >/dev/null 2>&1; then
  CLOC_ROOT_NODE="$(cygpath -m "$CLOC_ROOT")"
else
  CLOC_ROOT_NODE="$CLOC_ROOT"
fi
cp "$ROOT_DIR/scripts/verify-metrics.mjs" "$CLOC_ROOT/scripts/verify-metrics.mjs"
cp "$ROOT_DIR/scripts/sync-metric-tokens.mjs" "$CLOC_ROOT/scripts/sync-metric-tokens.mjs"
cat > "$CLOC_ROOT/scripts/generate-metrics.mjs" <<'JS'
#!/usr/bin/env node
import fs from 'node:fs';

const argv = process.argv;
const output = argv[argv.indexOf('--output') + 1];
// Mirrors the real generator: fail-closed by default, preserve prior totals only
// on the diagnostics opt-in, and mark that output as reduced for the verifier.
const requireCloc = !argv.includes('--allow-missing-cloc');
const clocUnavailable = process.env.STUB_CLOC_UNAVAILABLE === '1';

if (clocUnavailable && requireCloc) {
  process.stderr.write('cloc required but unavailable: spawnSync cloc ENOENT\n');
  process.exit(1);
}

if (clocUnavailable && !requireCloc) {
  process.stderr.write('[loc-metrics] cloc unavailable; preserving prior loc.total_ts=200 for diagnostics-only output\n');
}

fs.writeFileSync(output, `${JSON.stringify({
  generated_at: '2026-04-28T00:00:01.000Z',
  git_sha: 'regenerated',
  dlp_patterns: { count: 14 },
  connectors: { production: 0, production_ready: 5, beta: 1, demo_only: 10, stub: 1, unknown: 0, items: [] },
  loc: { production_ts: 100, total_ts: 200 },
  tests: { source: 'test-summary.json', status: 'missing' },
  coverage: { source: 'coverage/coverage-summary.json', status: 'missing' },
}, null, 2)}\n`);
JS

write_cloc_metrics() {
  cat > "$CLOC_ROOT/metrics.json" <<JSON
{
  "generated_at": "2026-04-28T00:00:00.000Z",
  "git_sha": "abc123",
  "dlp_patterns": { "count": 14 },
  "connectors": { "production": 0, "production_ready": 5, "beta": 1, "demo_only": 10, "stub": 1, "unknown": 0, "items": [] },
  "loc": { "production_ts": 100, "total_ts": $1 },
  "tests": { "source": "test-summary.json", "status": "missing" },
  "coverage": { "source": "coverage/coverage-summary.json", "status": "missing" }
}
JSON
}

run_cloc_verify() {
  set +e
  ( cd "$CLOC_ROOT" && node "$CLOC_ROOT_NODE/scripts/verify-metrics.mjs" --root "$CLOC_ROOT_NODE" "$@" ) \
    >"$CLOC_ROOT/out" 2>"$CLOC_ROOT/err"
  CLOC_RC=$?
  set -e
}

# Baseline: cloc available and committed value current → plain success.
write_cloc_metrics 200
STUB_CLOC_UNAVAILABLE=0 run_cloc_verify
[ "$CLOC_RC" -eq 0 ] || fail "cloc-contract: current metrics with cloc available must pass (rc=$CLOC_RC): $(cat "$CLOC_ROOT/err")"
grep -q '^Metrics verified: ' "$CLOC_ROOT/out" || fail "cloc-contract: expected an unqualified success verdict when nothing was excluded"
grep -q 'REDUCED' "$CLOC_ROOT/out" && fail "cloc-contract: a fully-compared run must not claim REDUCED"

# Stale committed total_ts, cloc available → must fail. Guards the compare
# itself, so a later change that drops total_ts from the diff can't pass here.
write_cloc_metrics 199
STUB_CLOC_UNAVAILABLE=0 run_cloc_verify
[ "$CLOC_RC" -ne 0 ] || fail "cloc-contract: stale loc.total_ts must fail when cloc is available"
grep -q 'is stale' "$CLOC_ROOT/err" || fail "cloc-contract: stale run did not report staleness"

# THE DEFECT: cloc cannot run, no opt-out → must fail closed, and must never
# print the success line. Before the fix this exited 0 with "Metrics verified".
write_cloc_metrics 200
STUB_CLOC_UNAVAILABLE=1 run_cloc_verify
[ "$CLOC_RC" -ne 0 ] || fail "cloc-contract: unavailable cloc must fail closed by default (rc=$CLOC_RC)"
grep -q 'CANNOT be verified' "$CLOC_ROOT/err" || fail "cloc-contract: fail-closed run must say freshness cannot be verified"
grep -q 'Metrics verified' "$CLOC_ROOT/out" && fail "cloc-contract: fail-closed run must not print any success verdict"

# Same, but with the explicit diagnostics opt-out: allowed to exit 0, required
# to label itself REDUCED and name the field it did not compare. A bare
# "Metrics verified:" here would be the original defect wearing a flag.
STUB_CLOC_UNAVAILABLE=1 run_cloc_verify --allow-missing-cloc
[ "$CLOC_RC" -eq 0 ] || fail "cloc-contract: --allow-missing-cloc must not fail (rc=$CLOC_RC): $(cat "$CLOC_ROOT/err")"
grep -q 'REDUCED' "$CLOC_ROOT/out" || fail "cloc-contract: --allow-missing-cloc must report a REDUCED verdict"
grep -q 'total_ts' "$CLOC_ROOT/out" || fail "cloc-contract: REDUCED verdict must name the uncompared field"
grep -q '^Metrics verified: ' "$CLOC_ROOT/out" && fail "cloc-contract: REDUCED run must not also print the unqualified success line"

# The opt-out must stay out of every required gate.
grep -rq -- '--allow-missing-cloc' "$ROOT_DIR/.github/workflows" \
  && fail "cloc-contract: --allow-missing-cloc must not appear in any workflow"
grep -q -- '--allow-missing-cloc' "$ROOT_DIR/.husky/pre-push" 2>/dev/null \
  && fail "cloc-contract: --allow-missing-cloc must not appear in the pre-push hook"
node -e "const s=require('$ROOT_DIR_NODE/package.json').scripts; for (const [k,v] of Object.entries(s)) if (String(v).includes('--allow-missing-cloc')) { console.error('package script '+k+' uses --allow-missing-cloc'); process.exit(1); }" \
  || fail "cloc-contract: --allow-missing-cloc must not appear in a package script"

rm -rf "$CLOC_ROOT"

echo "metrics tool tests passed"
