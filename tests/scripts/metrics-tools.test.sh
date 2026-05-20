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

const output = process.argv[process.argv.indexOf('--output') + 1];
const metrics = {
  generated_at: '2026-04-28T00:00:01.000Z',
  git_sha: 'regenerated',
  dlp_patterns: { count: 14 },
  connectors: { production: 5, beta: 1, demo_only: 10, stub: 1, unknown: 0, items: [] },
  loc: { production_ts: 100, total_ts: 200, total_md: 300 },
};
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

echo "metrics tool tests passed"
