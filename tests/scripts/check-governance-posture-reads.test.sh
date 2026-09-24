#!/usr/bin/env bash
# Regression: scripts/check-governance-posture-reads.mjs (C3.1c)
#
# Banned in src/ (except GovernanceService.ts):
#   - Reading any tenant configuration key starting with 'governance.'
#     via methods: getString, getBoolean, getBooleanStrict, getInt, getSecretString
#
# Assertion rigor — every drift scenario asserts BOTH (a) exit code
# exactly 1 (violations-found per the repo's AST-gate convention), AND
# (b) the offending key appears in stderr. No-violation scenarios assert
# exit code exactly 0.
# Env/usage errors (missing src/, bad --root) exit 2.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-governance-posture-reads.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- stderr ---" >&2
  cat "$TMP_DIR/err.txt" 2>/dev/null >&2 || true
  echo "--- stdout ---" >&2
  cat "$TMP_DIR/out.txt" 2>/dev/null >&2 || true
  exit 1
}

write_file() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

run_gate_status() {
  local root="$1"
  set +e
  node "$SCRIPT" --root "$root" >"$TMP_DIR/out.txt" 2>"$TMP_DIR/err.txt"
  local status=$?
  set -e
  echo "$status"
}

expect_drift() {
  local label="$1" root="$2" key="$3"
  local status
  status="$(run_gate_status "$root")"
  if [ "$status" -ne 1 ]; then
    fail "$label: expected exit 1 (gate found violation), got $status"
  fi
  if ! grep -Fq -- "$key" "$TMP_DIR/err.txt"; then
    fail "$label: stderr did not mention offending key '$key'"
  fi
}

expect_pass() {
  local label="$1" root="$2"
  local status
  status="$(run_gate_status "$root")"
  if [ "$status" -ne 0 ]; then
    fail "$label: expected exit 0 (no violations), got $status"
  fi
}

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT not found" >&2
  exit 1
fi

PASS=0

# ---- 1. Baseline (real src/, no --root) --------------------------------
set +e
node "$SCRIPT" >"$TMP_DIR/out.txt" 2>"$TMP_DIR/err.txt"
BASELINE_STATUS=$?
set -e
if [ "$BASELINE_STATUS" -ne 0 ]; then
  echo "FAIL: baseline — current src/ contains direct governance.* reads outside GovernanceService.ts" >&2
  cat "$TMP_DIR/err.txt"
  exit 1
fi
echo "PASS: baseline (real src/)"
PASS=$((PASS + 1))

# ---- 2-6. Drift: different configuration-reading methods ----------------
declare -a DRIFT_SCENARIOS=(
  "getString:governance.pii_types_csv"
  "getBoolean:governance.allow_pii"
  "getBooleanStrict:governance.block_on_detection"
  "getInt:governance.max_payload_bytes"
  "getSecretString:governance.secret_token"
)
for entry in "${DRIFT_SCENARIOS[@]}"; do
  method="${entry%%:*}"
  key="${entry#*:}"
  CASE="$TMP_DIR/drift-$method"
  write_file "$CASE/src/foo.ts" <<TS
import type { TenantConfigurationRepository } from './tcr';
export async function bad(repo: TenantConfigurationRepository, t: string): Promise<any> {
  return repo.$method(t, '$key');
}
TS
  expect_drift "drift ($method)" "$CASE" "$key"
  PASS=$((PASS + 1))
  echo "PASS: drift ($method)"
done

# ---- 7. No-violation: non-governance key via getString ------------------
CASE="$TMP_DIR/case-ok-nongov"
write_file "$CASE/src/foo.ts" <<'TS'
import type { TenantConfigurationRepository } from './tcr';
export async function good(repo: TenantConfigurationRepository, t: string): Promise<string | null> {
  return repo.getString(t, 'sync_error_assist.webhook_hmac_secret');
}
TS
expect_pass "non-governance key" "$CASE"
PASS=$((PASS + 1))
echo "PASS: non-governance key (no-violation)"

# ---- 8. No-violation: comment-only mention -----------------------------
CASE="$TMP_DIR/case-ok-comment"
write_file "$CASE/src/foo.ts" <<'TS'
// Reference: do NOT call repo.getBoolean(t, 'governance.allow_pii') directly.
export const PLACEHOLDER = 0;
TS
expect_pass "comment-only mention" "$CASE"
PASS=$((PASS + 1))
echo "PASS: comment-only mention (no-violation)"

# ---- 9. No-violation: inside allowlisted GovernanceService.ts ------------
CASE="$TMP_DIR/case-ok-governanceservice"
write_file "$CASE/src/services/ai/orchestrator/GovernanceService.ts" <<'TS'
import type { TenantConfigurationRepository } from './tcr';
export class GovernanceService {
  async getPosture(repo: TenantConfigurationRepository, t: string) {
    return repo.getBoolean(t, 'governance.allow_pii');
  }
}
TS
expect_pass "GovernanceService.ts is allowlisted" "$CASE"
PASS=$((PASS + 1))
echo "PASS: GovernanceService.ts is allowlisted (no-violation)"

# ---- 10. No-violation: inside tests/ scoped out -------------------------
CASE="$TMP_DIR/case-ok-tests"
write_file "$CASE/tests/foo.test.ts" <<'TS'
import type { TenantConfigurationRepository } from '../src/tcr';
export async function setup(repo: TenantConfigurationRepository, t: string) {
  return repo.getBoolean(t, 'governance.allow_pii');
}
TS
write_file "$CASE/src/placeholder.ts" <<'TS'
export const PLACEHOLDER = 1;
TS
expect_pass "tests/ scoped out" "$CASE"
PASS=$((PASS + 1))
echo "PASS: tests/ scoped out (no-violation)"

# ---- 11. No-violation: inside scripts/ scoped out -----------------------
CASE="$TMP_DIR/case-ok-scripts"
write_file "$CASE/scripts/audit.ts" <<'TS'
import type { TenantConfigurationRepository } from '../src/tcr';
export async function audit(repo: TenantConfigurationRepository, t: string) {
  return repo.getBoolean(t, 'governance.allow_pii');
}
TS
write_file "$CASE/src/placeholder.ts" <<'TS'
export const PLACEHOLDER = 1;
TS
expect_pass "scripts/ scoped out" "$CASE"
PASS=$((PASS + 1))
echo "PASS: scripts/ scoped out (no-violation)"

# ---- 12. Drift (AST advantage 1): MULTI-LINE call -----------------------
CASE="$TMP_DIR/case-multiline"
write_file "$CASE/src/foo.ts" <<'TS'
import type { TenantConfigurationRepository } from './tcr';
export async function bad(repo: TenantConfigurationRepository, t: string): Promise<boolean> {
  return repo.getBoolean(
    t,
    'governance.allow_pii',
  );
}
TS
expect_drift "multi-line getBoolean" "$CASE" "governance.allow_pii"
PASS=$((PASS + 1))
echo "PASS: AST catches multi-line call"

# ---- 13. Drift (AST advantage 2): arg1 with commas ---------------------
CASE="$TMP_DIR/case-nested"
write_file "$CASE/src/foo.ts" <<'TS'
import type { TenantConfigurationRepository } from './tcr';
function getTenant(a: string, b: string): string { return a + b; }
export async function bad(repo: TenantConfigurationRepository): Promise<boolean> {
  return repo.getBoolean(getTenant('t', '1'), 'governance.block_on_detection');
}
TS
expect_drift "getBoolean with comma in arg1" "$CASE" "governance.block_on_detection"
PASS=$((PASS + 1))
echo "PASS: AST catches call with comma in arg1"

# ---- 14. Drift (AST advantage 3): optional-chain receiver --------------
CASE="$TMP_DIR/case-optchain"
write_file "$CASE/src/foo.ts" <<'TS'
import type { TenantConfigurationRepository } from './tcr';
export async function bad(repo: TenantConfigurationRepository | undefined, t: string): Promise<boolean | undefined> {
  return repo?.getBoolean(t, 'governance.block_on_detection');
}
TS
expect_drift "repo?.getBoolean(...)" "$CASE" "governance.block_on_detection"
PASS=$((PASS + 1))
echo "PASS: AST catches repo?.getBoolean(...)"

echo ""
echo "ALL PASS — check-governance-posture-reads.mjs regression suite ($PASS scenarios)"
