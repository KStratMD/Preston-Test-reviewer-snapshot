#!/usr/bin/env bash
# Regression test for scripts/check-source-of-truth-coverage.mjs.
#
# Two halves:
#  1. Real-repo smoke: run against the live worktree, assert PASS.
#  2. Synthetic scenarios.
#       16: manifest entry missing conflictPolicyRationale            -> reject (exit 1)
#       17: fieldOverrides[].owner references undeclared SourceSystem -> reject (exit 1)
#       18: SOURCE_SYSTEM_TO_CONNECTOR_KEY maps to non-existent key   -> reject (exit 1)
#       19: flow template registers undeclared canonicalEntity        -> reject (exit 1)
#       20: manifest entry conflictPolicy: 'merge_field_level'        -> accept (exit 0)
#       21: manifest entry conflictPolicy: 'queue_for_human'          -> accept (exit 0)
#       22: clean manifest + registry + flows                         -> accept (exit 0)
#       23: duplicate entity declaration in manifest                  -> reject (exit 1)
#       24: merge_field_level without fieldOverrides                  -> reject (exit 1)
#       25: guardedWrite context fieldPaths without fieldLevelPayload -> reject (exit 1)
#       26: guardedWrite non-literal context without fieldLevelPayload -> reject (exit 1)
#       27: guardedWrite non-literal context with fieldLevelPayload   -> accept (exit 0)

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
if ! node "$ROOT_DIR/scripts/check-source-of-truth-coverage.mjs" >"$REAL_OUT" 2>"$REAL_ERR"; then
  cat "$REAL_OUT" "$REAL_ERR" >&2
  fail "live repo should pass"
fi
grep -q "source-of-truth-coverage. PASS" "$REAL_OUT" \
  || fail "expected PASS line on live repo (got: $(cat "$REAL_OUT"))"

# ---------- Half 2: synthetic scenarios ----------

setup_scenario() {
  local name="$1"
  local scenario_root="$TMP_DIR/$name"
  rm -rf "$scenario_root"
  mkdir -p "$scenario_root/src/governance/sourceOfTruth"
  mkdir -p "$scenario_root/src/connectors"
  mkdir -p "$scenario_root/src/flows/templates/samples"
  echo "$scenario_root"
}

run_script() {
  local root="$1"
  local out="$TMP_DIR/$2.out"
  local err="$TMP_DIR/$2.err"
  set +e
  node "$ROOT_DIR/scripts/check-source-of-truth-coverage.mjs" --root "$root" >"$out" 2>"$err"
  local rc=$?
  set -e
  echo "$rc"
}

# Minimal connector registry that has every key the manifest references
# (including 'squire' — the real CONNECTOR_REGISTRY has a demo-only
# squire entry for DI parity, and SOURCE_SYSTEM_TO_CONNECTOR_KEY now
# maps 'squire' → 'squire' as of PR 13 R2).
write_connector_registry() {
  local file="$1"
  cat >"$file" <<'EOF'
export const CONNECTOR_REGISTRY = [
  { key: 'netsuite' },
  { key: 'businesscentral' },
  { key: 'salesforce' },
  { key: 'hubspot' },
  { key: 'shipstation' },
  { key: 'squire' },
  { key: 'stripe' },
  { key: 'shopify' },
];
EOF
}

# Minimal flow registry.
write_flow_registry() {
  local file="$1"
  local canonical_entity="${2:-customer}"
  cat >"$file" <<EOF
export const FLOW_TEMPLATE_REGISTRY = [
  {
    id: 'fixture-v1',
    target: {
      system: 'netsuite',
      recordType: 'Contact',
      canonicalEntity: '$canonical_entity',
      operation: 'create',
    },
  },
];
EOF
}

# Minimal manifest. Args: file, [conflictPolicy=reject_with_alert],
# [omit_rationale=false], [bad_override_owner=false], [bad_key_mapping=false].
write_manifest() {
  local file="$1"
  local policy="${2:-reject_with_alert}"
  local omit_rationale="${3:-false}"
  local bad_override="${4:-false}"
  local bad_key="${5:-false}"

  local rationale_line='conflictPolicyRationale: "test",'
  [[ "$omit_rationale" == "true" ]] && rationale_line=''

  local override_block=''
  if [[ "$bad_override" == "true" ]]; then
    override_block='fieldOverrides: [{ fieldPath: "x", owner: "made_up_system", rationale: "test" }],'
  elif [[ "$policy" == "merge_field_level" ]]; then
    override_block='fieldOverrides: [{ fieldPath: "salesPipelineStage", owner: "salesforce", rationale: "test" }],'
  fi

  local keymap='netsuite: "netsuite", business_central: "businesscentral", salesforce: "salesforce", hubspot: "hubspot", shipstation: "shipstation", squire: "squire", stripe: "stripe", shopify: "shopify"'
  [[ "$bad_key" == "true" ]] && keymap='netsuite: "DOES_NOT_EXIST", business_central: "businesscentral", salesforce: "salesforce", hubspot: "hubspot", shipstation: "shipstation", squire: "squire", stripe: "stripe", shopify: "shopify"'

  cat >"$file" <<EOF
export const SOURCE_SYSTEM_TO_CONNECTOR_KEY = { $keymap };
export const SOURCE_OF_TRUTH_MANIFEST = [
  {
    entity: "customer",
    owner: "netsuite",
    consumers: ["salesforce"],
    $override_block
    conflictPolicy: "$policy",
    $rationale_line
  },
];
EOF
}

# 16 — manifest missing conflictPolicyRationale → reject
{
  R=$(setup_scenario 16)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert' 'true'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 16)
  [[ "$rc" == "1" ]] || fail "16: expected exit 1 (missing rationale), got $rc — $(cat "$TMP_DIR/16.err")"
}

# 17 — fieldOverrides[].owner is undeclared SourceSystem → reject
{
  R=$(setup_scenario 17)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert' 'false' 'true'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 17)
  [[ "$rc" == "1" ]] || fail "17: expected exit 1 (bad override owner), got $rc — $(cat "$TMP_DIR/17.err")"
}

# 18 — SOURCE_SYSTEM_TO_CONNECTOR_KEY maps to non-existent registry key → reject
{
  R=$(setup_scenario 18)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert' 'false' 'false' 'true'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 18)
  [[ "$rc" == "1" ]] || fail "18: expected exit 1 (bad key mapping), got $rc — $(cat "$TMP_DIR/18.err")"
}

# 19 — flow template registers undeclared canonicalEntity → reject
{
  R=$(setup_scenario 19)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts" 'made_up_entity'
  rc=$(run_script "$R" 19)
  [[ "$rc" == "1" ]] || fail "19: expected exit 1 (undeclared entity), got $rc — $(cat "$TMP_DIR/19.err")"
}

# 20 — manifest entry uses 'merge_field_level' with fieldOverrides → accept
{
  R=$(setup_scenario 20)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'merge_field_level'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 20)
  [[ "$rc" == "0" ]] || fail "20: expected exit 0 (implemented policy merge_field_level), got $rc — $(cat "$TMP_DIR/20.err")"
}

# 21 — manifest entry uses 'queue_for_human' → accept
{
  R=$(setup_scenario 21)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'queue_for_human'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 21)
  [[ "$rc" == "0" ]] || fail "21: expected exit 0 (implemented policy queue_for_human), got $rc — $(cat "$TMP_DIR/21.err")"
}

# 22 — clean manifest + registry + flows → accept
{
  R=$(setup_scenario 22)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 22)
  [[ "$rc" == "0" ]] || fail "22: expected exit 0 (clean), got $rc — $(cat "$TMP_DIR/22.err")"
}

# 23 — duplicate entity declaration in manifest → reject (Copilot R5)
{
  R=$(setup_scenario 23)
  cat >"$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" <<'EOF'
export const SOURCE_SYSTEM_TO_CONNECTOR_KEY = {
  netsuite: "netsuite", business_central: "businesscentral", salesforce: "salesforce",
  hubspot: "hubspot", shipstation: "shipstation", squire: "squire", stripe: "stripe", shopify: "shopify"
};
export const SOURCE_OF_TRUTH_MANIFEST = [
  { entity: "customer", owner: "netsuite", consumers: ["salesforce"], conflictPolicy: "reject_with_alert", conflictPolicyRationale: "test" },
  { entity: "customer", owner: "hubspot",  consumers: ["netsuite"],   conflictPolicy: "source_wins",       conflictPolicyRationale: "duplicate" },
];
EOF
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 23)
  [[ "$rc" == "1" ]] || fail "23: expected exit 1 (duplicate entity), got $rc — $(cat "$TMP_DIR/23.err")"
  grep -q "duplicate entity declaration" "$TMP_DIR/23.err" \
    || fail "23: expected 'duplicate entity declaration' in stderr (got: $(cat "$TMP_DIR/23.err"))"
}

# 24 — merge_field_level without fieldOverrides → reject
{
  R=$(setup_scenario 24)
  cat >"$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" <<'EOF'
export const SOURCE_SYSTEM_TO_CONNECTOR_KEY = {
  netsuite: "netsuite", business_central: "businesscentral", salesforce: "salesforce",
  hubspot: "hubspot", shipstation: "shipstation", squire: "squire", stripe: "stripe", shopify: "shopify"
};
export const SOURCE_OF_TRUTH_MANIFEST = [
  { entity: "customer", owner: "netsuite", consumers: ["salesforce"], conflictPolicy: "merge_field_level", conflictPolicyRationale: "test" },
];
EOF
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  rc=$(run_script "$R" 24)
  [[ "$rc" == "1" ]] || fail "24: expected exit 1 (merge_field_level without fieldOverrides), got $rc — $(cat "$TMP_DIR/24.err")"
  grep -q "merge_field_level but declares no fieldOverrides" "$TMP_DIR/24.err" \
    || fail "24: expected fieldOverrides message in stderr (got: $(cat "$TMP_DIR/24.err"))"
}

# 25 — guardedWrite context with fieldPaths but no sibling fieldLevelPayload → reject
{
  R=$(setup_scenario 25)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  cat >"$R/src/bad-guarded-write.ts" <<'EOF'
declare function guardedWrite(args: unknown, deps: unknown): Promise<unknown>;
guardedWrite(
  {
    context: { fieldPaths: ['salesPipelineStage'] },
    do: async () => ({ ok: true }),
  },
  {},
);
EOF
  rc=$(run_script "$R" 25)
  [[ "$rc" == "1" ]] || fail "25: expected exit 1 (fieldPaths without fieldLevelPayload), got $rc — $(cat "$TMP_DIR/25.err")"
  grep -q "fieldPaths but the args object has no sibling fieldLevelPayload" "$TMP_DIR/25.err" \
    || fail "25: expected guardedWrite contract message in stderr (got: $(cat "$TMP_DIR/25.err"))"
}

# 26 — guardedWrite non-literal context without sibling fieldLevelPayload → reject fail-closed
{
  R=$(setup_scenario 26)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  cat >"$R/src/bad-guarded-write.ts" <<'EOF'
declare function guardedWrite(args: unknown, deps: unknown): Promise<unknown>;
const context = { fieldPaths: ['salesPipelineStage'] };
guardedWrite(
  {
    context,
    do: async () => ({ ok: true }),
  },
  {},
);
EOF
  rc=$(run_script "$R" 26)
  [[ "$rc" == "1" ]] || fail "26: expected exit 1 (non-literal context without fieldLevelPayload), got $rc — $(cat "$TMP_DIR/26.err")"
  grep -q "non-literal context without sibling fieldLevelPayload" "$TMP_DIR/26.err" \
    || fail "26: expected non-literal context message in stderr (got: $(cat "$TMP_DIR/26.err"))"
}

# 27 — guardedWrite non-literal context with sibling fieldLevelPayload → accept
{
  R=$(setup_scenario 27)
  write_manifest "$R/src/governance/sourceOfTruth/SourceOfTruthManifest.ts" 'reject_with_alert'
  write_connector_registry "$R/src/connectors/connectorRegistry.ts"
  write_flow_registry "$R/src/flows/templates/registry.ts"
  cat >"$R/src/good-guarded-write.ts" <<'EOF'
declare function guardedWrite(args: unknown, deps: unknown): Promise<unknown>;
const context = { fieldPaths: ['salesPipelineStage'] };
guardedWrite(
  {
    context,
    fieldLevelPayload: { payload: { salesPipelineStage: 'qualified' }, mode: 'drop_disallowed' },
    do: async (payload: unknown) => payload,
  },
  {},
);
EOF
  rc=$(run_script "$R" 27)
  [[ "$rc" == "0" ]] || fail "27: expected exit 0 (non-literal context with fieldLevelPayload), got $rc — $(cat "$TMP_DIR/27.err")"
}

echo "PASS: all synthetic scenarios + live-repo smoke"
