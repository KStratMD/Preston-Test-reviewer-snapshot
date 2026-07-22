#!/usr/bin/env bash
# Regression test for scripts/audit-status-claims.mjs.
#
# Two halves:
#  1. Real-repo smoke: run the script against the live repo and assert it
#     exits 0 with the expected partition string. Pins the Phase 3 partition
#     so a future connector addition that forgets to tag will be caught here
#     before CI.
#  2. Failure-path coverage: spin up temp connector files via --root and
#     assert each rejection branch fires with the expected error text:
#       A: valid production+proofCard -> OK (positive control)
#       B: missing productionStatus
#       C: invalid status value ('shipped')
#       D: production without proofCard
#       E: proofCard outside docs/review/proof-cards/
#       F: proofCard with non-.md extension
#       G: proofCard nested in a subdirectory
#       H: metrics.json count drift vs source-level scan
#       I: missing statusEvidence
#       J: blank/whitespace-only statusEvidence
#       K: proofCard with `..` traversal segment
#       L: --check-proof-cards flag (Phase 4 gate) -- default Phase 3 mode
#          passes on absent files, --check-proof-cards rejects them
#
# Added in response to Copilot round-3 review on PR #692 (no script tests
# existed for this CI-gated script previously).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------- Half 1: real-repo smoke ----------

REAL_OUT="$TMP_DIR/real.out"
REAL_ERR="$TMP_DIR/real.err"
if ! node "$ROOT_DIR/scripts/audit-status-claims.mjs" >"$REAL_OUT" 2>"$REAL_ERR"; then
  cat "$REAL_OUT" "$REAL_ERR" >&2
  fail "audit-status-claims should pass on the live repo (Phase 3 partition)"
fi
grep -Eq "audit-status-claims: OK \([0-9]+ connectors; production=[0-9]+ beta=[0-9]+ demo_only=[0-9]+ stub=[0-9]+\)" "$REAL_OUT" \
  || fail "audit-status-claims did not print the expected OK line on the live repo (got: $(cat "$REAL_OUT"))"

# ---------- Half 2: synthetic failure coverage ----------

# Build a temp root that the audit script can scan. We invoke the *real*
# script (so the import of `typescript` from node_modules resolves) but
# point it at our temp tree via --root. Only need src/connectors/ and
# metrics.json populated.
mkdir -p "$TMP_DIR/src/connectors"

write_connector() {
  local file="$1"
  local body="$2"
  cat > "$TMP_DIR/src/connectors/$file" <<EOF
export class TestConnector {
$body
}
EOF
}

write_metrics() {
  local prod="$1" beta="$2" demo="$3" stub="$4" unknown="$5"
  cat > "$TMP_DIR/metrics.json" <<EOF
{
  "connectors": {
    "production": $prod,
    "beta": $beta,
    "demo_only": $demo,
    "stub": $stub,
    "unknown": $unknown
  }
}
EOF
}

run_audit() {
  local out_var="$1" err_var="$2"
  local out err status
  out="$TMP_DIR/scenario.out"
  err="$TMP_DIR/scenario.err"
  : >"$out"; : >"$err"
  set +e
  node "$ROOT_DIR/scripts/audit-status-claims.mjs" --root "$TMP_DIR" >"$out" 2>"$err"
  status=$?
  set -e
  printf -v "$out_var" '%s' "$(cat "$out")"
  printf -v "$err_var" '%s' "$(cat "$err")"
  return $status
}

# Scenario A: valid production connector with a proper proof card -> OK
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "AlphaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'real';
  static readonly proofCard = 'docs/review/proof-cards/alpha.md';"
write_metrics 1 0 0 0 0
if ! run_audit OUT ERR; then
  fail "scenario A (valid production) should exit 0 -- err=$ERR"
fi
[[ "$OUT" == *"audit-status-claims: OK (1 connectors; production=1 beta=0 demo_only=0 stub=0)"* ]] \
  || fail "scenario A: unexpected OK summary -- got '$OUT'"

# Scenario B: missing productionStatus -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "BetaConnector.ts" "  static readonly statusEvidence = 'no status';"
write_metrics 0 0 0 0 1
if run_audit OUT ERR; then
  fail "scenario B (missing productionStatus) should exit non-zero"
fi
[[ "$ERR" == *"missing static productionStatus field"* ]] \
  || fail "scenario B: missing productionStatus error not surfaced -- err='$ERR'"

# Scenario C: invalid status value -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "GammaConnector.ts" "  static readonly productionStatus = 'shipped' as const;
  static readonly statusEvidence = 'wrong';"
write_metrics 0 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario C (invalid status) should exit non-zero"
fi
[[ "$ERR" == *"is not one of"* ]] \
  || fail "scenario C: invalid-status error not surfaced -- err='$ERR'"

# Scenario D: production without proofCard -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "DeltaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'no card';"
write_metrics 1 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario D (production missing proofCard) should exit non-zero"
fi
[[ "$ERR" == *"requires a static proofCard"* ]] \
  || fail "scenario D: missing-proofCard error not surfaced -- err='$ERR'"

# Scenario E: proofCard outside the proof-cards dir -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "EpsilonConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'wrong dir';
  static readonly proofCard = 'docs/other/epsilon.md';"
write_metrics 1 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario E (proofCard outside dir) should exit non-zero"
fi
[[ "$ERR" == *"must live under docs/review/proof-cards/"* ]] \
  || fail "scenario E: outside-dir error not surfaced -- err='$ERR'"

# Scenario F: non-.md proofCard -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "ZetaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'wrong ext';
  static readonly proofCard = 'docs/review/proof-cards/zeta.txt';"
write_metrics 1 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario F (proofCard non-.md) should exit non-zero"
fi
[[ "$ERR" == *"must end with .md"* ]] \
  || fail "scenario F: non-.md error not surfaced -- err='$ERR'"

# Scenario G: proofCard nested in subdir -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "EtaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'subdir';
  static readonly proofCard = 'docs/review/proof-cards/sub/eta.md';"
write_metrics 1 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario G (proofCard nested) should exit non-zero"
fi
[[ "$ERR" == *"single .md file directly under"* ]] \
  || fail "scenario G: nested-path error not surfaced -- err='$ERR'"

# Scenario H: metrics.json drift -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "ThetaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'ok';
  static readonly proofCard = 'docs/review/proof-cards/theta.md';"
write_metrics 99 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario H (metrics drift) should exit non-zero"
fi
[[ "$ERR" == *"metrics.json connectors.production = 99 but source-level scan found 1"* ]] \
  || fail "scenario H: metrics-drift error not surfaced -- err='$ERR'"

# Scenario I: missing statusEvidence -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "IotaConnector.ts" "  static readonly productionStatus = 'demo_only' as const;"
write_metrics 0 0 1 0 0
if run_audit OUT ERR; then
  fail "scenario I (missing statusEvidence) should exit non-zero"
fi
[[ "$ERR" == *"missing static statusEvidence string"* ]] \
  || fail "scenario I: missing-statusEvidence error not surfaced -- err='$ERR'"

# Scenario J: blank statusEvidence (whitespace-only) -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "KappaConnector.ts" "  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = '   ';"
write_metrics 0 0 1 0 0
if run_audit OUT ERR; then
  fail "scenario J (blank statusEvidence) should exit non-zero"
fi
[[ "$ERR" == *"missing static statusEvidence string"* ]] \
  || fail "scenario J: blank-statusEvidence error not surfaced -- err='$ERR'"

# Scenario K: proofCard with .. traversal segment -> reject
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "LambdaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'traversal';
  static readonly proofCard = 'docs/review/proof-cards/../../../etc/passwd.md';"
write_metrics 1 0 0 0 0
if run_audit OUT ERR; then
  fail "scenario K (proofCard traversal) should exit non-zero"
fi
[[ "$ERR" == *"single .md file directly under"* ]] \
  || fail "scenario K: traversal-segment error not surfaced -- err='$ERR'"

# Scenario L: --check-proof-cards on missing file -> reject (Phase 4 gate)
rm -f "$TMP_DIR/src/connectors/"*.ts
write_connector "MuConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'phase 4 gate';
  static readonly proofCard = 'docs/review/proof-cards/mu.md';"
write_metrics 1 0 0 0 0
# Without --check-proof-cards: passes (Phase 3 default)
if ! run_audit OUT ERR; then
  fail "scenario L (Phase 3 default with absent file) should exit 0 -- err='$ERR'"
fi
# With --check-proof-cards: fails (Phase 4 gate)
out="$TMP_DIR/scenario.out"; err="$TMP_DIR/scenario.err"
set +e
node "$ROOT_DIR/scripts/audit-status-claims.mjs" --root "$TMP_DIR" --check-proof-cards >"$out" 2>"$err"
status=$?
set -e
if (( status == 0 )); then
  fail "scenario L (--check-proof-cards on absent file) should exit non-zero"
fi
grep -q "does not exist on disk" "$err" \
  || fail "scenario L: missing-file error not surfaced under --check-proof-cards -- err=$(cat "$err")"

echo "audit-status-claims tool tests passed"
