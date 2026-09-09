#!/usr/bin/env bash
# Regression harness for scripts/check-otel-graph.mjs (OpenTelemetry graph gate).
# Every scenario is a function of `npm ls` output, so the harness drives the
# checker's explicit testability seams — `--ls-json <file>` (a captured
# `npm ls --all --json` document) and `--ls-exit <code>` (a simulated
# subprocess exit code) — plus a fixture package.json per scenario. No real
# broken node_modules trees and no PATH-shimmed fake npm (plan contract:
# both are slower, more fragile, and unprecedented in this suite). The
# default no-flag invocation always runs the real `npm ls`.
set -u

SCRIPT="scripts/check-otel-graph.mjs"
FAILURES=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run_case() {
  local name="$1" expected_exit="$2" expect_substr="$3"; shift 3
  local out exit_code
  out=$(node "$SCRIPT" "$@" 2>&1)
  exit_code=$?
  if [ "$exit_code" -ne "$expected_exit" ]; then
    echo "FAIL [$name]: expected exit $expected_exit, got $exit_code"; echo "$out" | head -10
    FAILURES=$((FAILURES+1)); return
  fi
  if ! printf '%s' "$out" | grep -qF -- "$expect_substr"; then
    echo "FAIL [$name]: output missing '$expect_substr'"; echo "$out" | head -10
    FAILURES=$((FAILURES+1)); return
  fi
  echo "ok  [$name]"
}

write_pkg() {
  # $1 = dir, $2 = JSON body for package.json
  mkdir -p "$1"
  printf '%s' "$2" > "$1/package.json"
}

# ---------------------------------------------------------------------------
# Scenario 1: healthy unique graph — two direct deps, one nested transitive
# copy at the SAME version (copy count is not the risk; versions are).
H="$TMP/healthy"
write_pkg "$H" '{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":"^1.9.0","@opentelemetry/core":"^1.30.0"}}'
cat > "$H/ls.json" <<'EOF'
{"name":"fx","version":"1.0.0","dependencies":{
  "@opentelemetry/api":{"version":"1.9.1"},
  "@opentelemetry/core":{"version":"1.30.0","dependencies":{"@opentelemetry/api":{"version":"1.9.1"}}}
}}
EOF
run_case "healthy-unique-graph" 0 "single resolved version" --root "$H" --ls-json "$H/ls.json"

# ---------------------------------------------------------------------------
# Scenario 2: duplicate resolved versions of a transitive @opentelemetry pkg
# (nested copy at a different version than the hoisted one).
D="$TMP/dup"
write_pkg "$D" '{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":"^1.9.0","carrier":"^1.0.0"}}'
cat > "$D/ls.json" <<'EOF'
{"name":"fx","version":"1.0.0","dependencies":{
  "@opentelemetry/api":{"version":"1.9.1"},
  "carrier":{"version":"1.0.0","dependencies":{"@opentelemetry/api":{"version":"2.1.0"}}}
}}
EOF
run_case "duplicate-otel-versions" 1 "multiple resolved versions" --root "$D" --ls-json "$D/ls.json"

# ---------------------------------------------------------------------------
# Scenario 3: nonzero `npm ls` (simulated subprocess exit) -> fail immediately,
# never parse partial JSON as a healthy tree.
run_case "nonzero-npm-ls" 1 "npm ls" --root "$H" --ls-json "$H/ls.json" --ls-exit 1

# ---------------------------------------------------------------------------
# Scenario 4: npm ls JSON carries problems -> fail even with a zero exit.
P="$TMP/problems"
write_pkg "$P" '{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":"^1.9.0"}}'
cat > "$P/ls.json" <<'EOF'
{"name":"fx","version":"1.0.0","problems":["extraneous: leftover@1.0.0"],"dependencies":{"@opentelemetry/api":{"version":"1.9.1"}}}
EOF
run_case "ls-json-problems" 1 "problems" --root "$P" --ls-json "$P/ls.json"

# ---------------------------------------------------------------------------
# Scenario 5: missing direct dep with a clean-looking tree — the declared
# direct dep has zero resolved versions in the graph.
Z="$TMP/zero"
write_pkg "$Z" '{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":"^1.9.0","@opentelemetry/core":"^1.30.0"}}'
cat > "$Z/ls.json" <<'EOF'
{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/core":{"version":"1.30.0"}}}
EOF
run_case "direct-dep-zero-versions" 1 "no resolved version" --root "$Z" --ls-json "$Z/ls.json"

# ---------------------------------------------------------------------------
# Scenario 6: a NEWLY ADDED direct @opentelemetry dependency is discovered
# from package.json without editing the checker (proven against a
# previously-passing tree document).
N="$TMP/newdep"
write_pkg "$N" '{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":"^1.9.0"},"devDependencies":{"@opentelemetry/sdk-metrics":"^2.0.0"}}'
cat > "$N/ls.json" <<'EOF'
{"name":"fx","version":"1.0.0","dependencies":{"@opentelemetry/api":{"version":"1.9.1"}}}
EOF
run_case "new-direct-dep-discovered" 1 "@opentelemetry/sdk-metrics" --root "$N" --ls-json "$N/ls.json"

# ---------------------------------------------------------------------------
# Scenario 7: unreadable --ls-json -> infrastructure failure, exit 2 (fail closed).
run_case "unreadable-ls-json" 2 "cannot" --root "$H" --ls-json "$TMP/does-not-exist.json"

# ---------------------------------------------------------------------------
# Scenario 8: --ls-exit without --ls-json is a harness misuse -> exit 2, so the
# seam can never silently masquerade as a real run.
run_case "ls-exit-requires-ls-json" 2 "--ls-exit" --root "$H" --ls-exit 1

# ---------------------------------------------------------------------------
if [ "$FAILURES" -ne 0 ]; then
  echo "check-otel-graph.test.sh: $FAILURES failing scenario(s)"
  exit 1
fi
echo "check-otel-graph.test.sh: all scenarios passed"
