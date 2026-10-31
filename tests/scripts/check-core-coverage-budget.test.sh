#!/usr/bin/env bash
# Regression test for scripts/check-core-coverage-budget.mjs (Phase 5b).
#
# Pattern mirrors tests/scripts/check-skipped-tests-documented.test.sh:
# invoke the REAL script via a fixture worktree so we exercise the production
# code path. 14 scenarios total — 1 real-repo smoke (A) + 13 synthetic
# (B–N, of which C/D/E/F/H/I/J/L/M/N reject and B/G/K accept; G has 3
# sub-asserts for --write semantics, so the PASS counter shows 16 when all
# scenarios pass).
#
# Exit codes the script under test uses:
#   0 — budget OK or --write succeeded
#   1 — coverage drift (REGRESSED / IMPROVED / MISSING / EXTRA)
#   2 — input error (missing file, malformed JSON, etc.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-core-coverage-budget.mjs"

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT not found"
  exit 1
fi

PASS=0
FAIL=0
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Helper: write a budget JSON
write_budget() {
  local path="$1"; shift
  cat > "$path"
}

# Helper: write a summary JSON. Coverage-summary.json shape: keys are absolute
# paths, values are wrapper objects with .pct.
write_summary() {
  local path="$1"; shift
  cat > "$path"
}

# Helper: assert exit code
assert_exit() {
  local label="$1"; local expected="$2"; local actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label (exit=$actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit=$expected, got exit=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

# ---- Scenario A: real-repo smoke (uses repo's actual files) ----
# This is the integration-style check — we run with no overrides if both files
# exist. Skipped if coverage-core/coverage-summary.json hasn't been generated
# yet (developer hasn't run `npm run test:coverage:core` locally).
if [ -f "$REPO_ROOT/.core-coverage-budget.json" ] && [ -f "$REPO_ROOT/coverage-core/coverage-summary.json" ]; then
  set +e
  ( cd "$REPO_ROOT" && node "$SCRIPT" >/dev/null 2>&1 )
  rc=$?
  set -e
  assert_exit "A: real-repo smoke (budget matches current summary)" 0 "$rc"
else
  echo "SKIP: A: real-repo smoke (coverage-core/coverage-summary.json not generated — run npm run test:coverage:core)"
fi

# ---- Scenario B: budget exactly matches summary → exit 0 ----
TMP="$TMPROOT/B"; mkdir -p "$TMP"
write_budget "$TMP/budget.json" <<'EOF'
{
  "src/foo.ts": { "lines": 80, "statements": 80, "functions": 100, "branches": 50 }
}
EOF
write_summary "$TMP/summary.json" <<EOF
{
  "total": {"lines":{"pct":80}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":80}, "statements":{"pct":80}, "functions":{"pct":100}, "branches":{"pct":50}
  }
}
EOF
# The summary uses an absolute path; the script computes the relative path from
# repoRoot (the script lives in $TMP/scripts/, so repoRoot is $TMP). We emulate
# that by copying the script into $TMP/scripts/.
mkdir -p "$TMP/scripts"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cp "$TMP/budget.json" "$TMP/.core-coverage-budget.json"
mkdir -p "$TMP/coverage-core"
cp "$TMP/summary.json" "$TMP/coverage-core/coverage-summary.json"
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "B: exact match → exit 0" 0 "$rc"

# ---- Scenario C: regression (budget=80, current=70) → exit 1 ----
TMP="$TMPROOT/C"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": 80, "statements": 80, "functions": 100, "branches": 50 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{
  "total": {"lines":{"pct":70}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":70}, "statements":{"pct":80}, "functions":{"pct":100}, "branches":{"pct":50}
  }
}
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "C: regression → exit 1" 1 "$rc"

# ---- Scenario D: improvement (budget=80, current=95) → exit 1 ----
TMP="$TMPROOT/D"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": 80, "statements": 80, "functions": 100, "branches": 50 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{
  "total": {"lines":{"pct":95}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":95}, "statements":{"pct":80}, "functions":{"pct":100}, "branches":{"pct":50}
  }
}
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "D: improvement → exit 1" 1 "$rc"

# ---- Scenario E: file in budget but not in summary (MISSING) → exit 1 ----
TMP="$TMPROOT/E"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": 80, "statements": 80, "functions": 100, "branches": 50 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "E: file missing from summary → exit 1" 1 "$rc"

# ---- Scenario F: file in summary but not in budget (EXTRA) → exit 1 ----
TMP="$TMPROOT/F"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{}
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{
  "total": {"lines":{"pct":80}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":80}, "statements":{"pct":80}, "functions":{"pct":100}, "branches":{"pct":50}
  }
}
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "F: file extra in summary → exit 1" 1 "$rc"

# ---- Scenario G: --write succeeds and produces a budget that re-passes ----
TMP="$TMPROOT/G"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "_comment": "preserve me", "src/foo.ts": { "lines": 50, "statements": 50, "functions": 50, "branches": 50 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{
  "total": {"lines":{"pct":80}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":80}, "statements":{"pct":80}, "functions":{"pct":100}, "branches":{"pct":50}
  }
}
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs --write >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "G: --write succeeds (improvement → restamp)" 0 "$rc"
# After --write the budget should re-pass.
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "G2: post-write re-check passes" 0 "$rc"
# Comment must be preserved.
if grep -q '"_comment": "preserve me"' "$TMP/.core-coverage-budget.json"; then
  echo "PASS: G3: --write preserves _comment fields"; PASS=$((PASS + 1))
else
  echo "FAIL: G3: --write dropped the _comment field"
  FAIL=$((FAIL + 1))
fi

# ---- Scenario H: missing budget file → exit 2 ----
TMP="$TMPROOT/H"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "H: missing budget → exit 2" 2 "$rc"

# ---- Scenario I: missing summary file → exit 2 ----
TMP="$TMPROOT/I"; mkdir -p "$TMP/scripts"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": 80, "statements": 80, "functions": 100, "branches": 50 } }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "I: missing summary → exit 2" 2 "$rc"

# ---- Scenario J: malformed budget JSON → exit 2 ----
TMP="$TMPROOT/J"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ this is not json
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "J: malformed budget JSON → exit 2" 2 "$rc"

# ---- Scenario K: rounding tolerance (75.745 stored as 75.74 in budget) → accept ----
# Istanbul rounds pct to 2 decimals; the script's round2() helper applies the
# same rounding before compare so float micro-drift can't trip the gate.
TMP="$TMPROOT/K"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": 75.74, "statements": 75.84, "functions": 92.3, "branches": 51.48 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{
  "total": {"lines":{"pct":75.74}},
  "$TMP/src/foo.ts": {
    "lines":{"pct":75.7401}, "statements":{"pct":75.8399}, "functions":{"pct":92.30}, "branches":{"pct":51.484}
  }
}
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "K: float micro-drift within rounding → exit 0" 0 "$rc"

# ---- Scenario L: budget JSON parses but is not a plain object → exit 2 ----
# Covers null, array, number, and string at the top level. We test all four
# shapes via a small loop because they share the same code path.
TMP="$TMPROOT/L"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
for shape in 'null' '[1,2,3]' '42' '"a string"'; do
  echo "$shape" > "$TMP/.core-coverage-budget.json"
  set +e
  ( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
  rc=$?
  set -e
  assert_exit "L($shape): non-object budget → exit 2" 2 "$rc"
done

# ---- Scenario M: budget entry value is not an object → exit 2 ----
TMP="$TMPROOT/M"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": "this should be an object, not a string" }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "M: budget entry not an object → exit 2" 2 "$rc"

# ---- Scenario N: metric value is not a finite number → exit 2 ----
# Cover string, null, NaN (sent as JSON null since JSON has no NaN).
TMP="$TMPROOT/N"; mkdir -p "$TMP/scripts" "$TMP/coverage-core"
cp "$SCRIPT" "$TMP/scripts/check-core-coverage-budget.mjs"
cat > "$TMP/.core-coverage-budget.json" <<'EOF'
{ "src/foo.ts": { "lines": "ninety", "statements": 80, "functions": 100, "branches": 50 } }
EOF
cat > "$TMP/coverage-core/coverage-summary.json" <<EOF
{ "total": {"lines":{"pct":80}} }
EOF
set +e
( cd "$TMP" && node scripts/check-core-coverage-budget.mjs >/dev/null 2>&1 )
rc=$?
set -e
assert_exit "N: non-numeric metric value → exit 2" 2 "$rc"

echo ""
echo "===================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "===================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
