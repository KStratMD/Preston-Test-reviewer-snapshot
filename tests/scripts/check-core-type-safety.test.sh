#!/usr/bin/env bash
# Regression test for scripts/check-core-type-safety.mjs.
#
# Pattern mirrors tests/scripts/check-core-coverage-budget.test.sh: invoke the
# REAL script via a synthetic fixture root (the script is copied into
# $TMP/scripts/, so it computes REPO_ROOT as $TMP and resolves CORE_PATHS +
# the budget file there). Scenario A is a real-repo smoke; B–H are synthetic.
#
# Exit codes the script under test uses:
#   0 — total == budget, or --write/--list succeeded
#   1 — ratchet violation (total > budget, OR total < budget needs re-stamp)
#   2 — input error (missing budget file, non-digit budget, MISSING CORE PATH)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-core-type-safety.mjs"

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT not found"
  exit 1
fi

PASS=0
FAIL=0
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

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

# CORE_PATHS as declared in the script. Directory entries get a placeholder
# .ts file; file entries are created directly. Mirror of the script's list so
# a synthetic fixture satisfies the fail-closed check; if the script's list
# changes, scenario A (real-repo smoke) still validates the real set and these
# synthetic scenarios will surface the drift via an unexpected exit 2.
CORE_DIRS=(
  src/governance/sourceOfTruth
  src/services/security
  src/services/governance
  src/services/tenants
  src/services/workflowCentral
  src/services/financeCentral
  src/services/syncErrorAssist
  src/services/lineage
  src/services/reconciliationCenter
  src/services/cost
)
CORE_FILES=(
  src/services/WorkflowCentralService.ts
  src/services/mcp/MCPAggregatorService.ts
  src/database/repositories/TenantConfigurationRepository.ts
  src/services/ai/orchestrator/GovernanceService.ts
  src/flows/templates/FlowExecutor.ts
  src/middleware/rbac.ts
  src/middleware/tenantStatusGate.ts
  src/middleware/workflowCentralReady.ts
  src/middleware/syncErrorAssistWebhook.ts
)

# Seed a fixture root with the script + a clean core tree (zero escapes).
seed_root() {
  local root="$1"
  mkdir -p "$root/scripts"
  cp "$SCRIPT" "$root/scripts/check-core-type-safety.mjs"
  # The gate imports `typescript`; node resolves it by walking up from the
  # script's dir, so symlink the repo's node_modules into the fixture root
  # (same approach the reviewer-mirror execution proof uses).
  ln -s "$REPO_ROOT/node_modules" "$root/node_modules"
  local d f
  for d in "${CORE_DIRS[@]}"; do
    mkdir -p "$root/$d"
    printf 'export const x: number = 1;\n' > "$root/$d/placeholder.ts"
  done
  for f in "${CORE_FILES[@]}"; do
    mkdir -p "$(dirname "$root/$f")"
    printf 'export const x: number = 1;\n' > "$root/$f"
  done
}

run_gate() {  # run_gate <root> [arg]; echoes nothing, sets global rc
  set +e
  ( cd "$1" && node scripts/check-core-type-safety.mjs ${2:-} >/dev/null 2>&1 )
  rc=$?
  set -e
}

# ---- Scenario A: real-repo smoke (uses the repo's actual files + budget) ----
if [ -f "$REPO_ROOT/.core-type-safety-budget" ]; then
  set +e
  ( cd "$REPO_ROOT" && node "$SCRIPT" >/dev/null 2>&1 )
  rc=$?
  set -e
  assert_exit "A: real-repo smoke (count == committed budget)" 0 "$rc"
else
  echo "SKIP: A: real-repo smoke (.core-type-safety-budget not present)"
fi

# ---- Scenario B: clean tree, budget 0 → exit 0 ----
TMP="$TMPROOT/B"; seed_root "$TMP"
printf '0\n' > "$TMP/.core-type-safety-budget"
run_gate "$TMP"
assert_exit "B: clean tree == budget 0 → exit 0" 0 "$rc"

# ---- Scenario C: a new `as any` in a core file → total 1 > budget 0 → exit 1 ----
TMP="$TMPROOT/C"; seed_root "$TMP"
printf '0\n' > "$TMP/.core-type-safety-budget"
printf 'export const y = (z: unknown) => z as any;\n' >> "$TMP/src/services/security/placeholder.ts"
run_gate "$TMP"
assert_exit "C: new core as-any → exit 1 (regression)" 1 "$rc"

# ---- Scenario C2: comment/string mentioning `as any` is NOT counted → exit 0 ----
TMP="$TMPROOT/C2"; seed_root "$TMP"
printf '0\n' > "$TMP/.core-type-safety-budget"
printf '// this is a comment about as any\nexport const s = "value cast as any here";\n' \
  >> "$TMP/src/services/governance/placeholder.ts"
run_gate "$TMP"
assert_exit "C2: as-any in comment/string not counted → exit 0" 0 "$rc"

# ---- Scenario D: budget stamped above real count → total 0 < budget 5 → exit 1 ----
TMP="$TMPROOT/D"; seed_root "$TMP"
printf '5\n' > "$TMP/.core-type-safety-budget"
run_gate "$TMP"
assert_exit "D: count below budget → exit 1 (re-stamp)" 1 "$rc"

# ---- Scenario E: --write stamps current total, then re-check passes ----
TMP="$TMPROOT/E"; seed_root "$TMP"
printf '99\n' > "$TMP/.core-type-safety-budget"
run_gate "$TMP" "--write"
assert_exit "E: --write succeeds → exit 0" 0 "$rc"
if [ "$(tr -d '[:space:]' < "$TMP/.core-type-safety-budget")" = "0" ]; then
  echo "PASS: E2: --write recorded total = 0"; PASS=$((PASS + 1))
else
  echo "FAIL: E2: --write did not record 0 (got '$(cat "$TMP/.core-type-safety-budget")')"; FAIL=$((FAIL + 1))
fi
run_gate "$TMP"
assert_exit "E3: post-write re-check → exit 0" 0 "$rc"

# ---- Scenario F: missing budget file → exit 2 ----
TMP="$TMPROOT/F"; seed_root "$TMP"
run_gate "$TMP"
assert_exit "F: missing budget file → exit 2" 2 "$rc"

# ---- Scenario G: non-digit budget → exit 2 ----
TMP="$TMPROOT/G"; seed_root "$TMP"
printf 'five\n' > "$TMP/.core-type-safety-budget"
run_gate "$TMP"
assert_exit "G: non-digit budget → exit 2" 2 "$rc"

# ---- Scenario H: FAIL-CLOSED — a core path is missing → exit 2 (Codex R2 #1) ----
TMP="$TMPROOT/H"; seed_root "$TMP"
printf '0\n' > "$TMP/.core-type-safety-budget"
rm -rf "$TMP/src/services/security"   # simulate a renamed/deleted governance dir
run_gate "$TMP"
assert_exit "H: missing core path → exit 2 (fail-closed)" 2 "$rc"

echo ""
echo "===================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "===================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
