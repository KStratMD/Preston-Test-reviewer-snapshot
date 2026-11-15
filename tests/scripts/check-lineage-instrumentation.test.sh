#!/usr/bin/env bash
# Regression test for scripts/check-lineage-instrumentation.mjs.
#
# Four cases:
#   1. Real-repo smoke: gate exits 0 against live FlowExecutor.ts.
#   2. Missing required call site: rename `lineage?.transform` →
#      `lineage?.NOOP_transform` in a temp copy. Gate exits 1.
#   3. Missing target file: empty temp dir with no FlowExecutor.ts.
#      Gate exits 2 (sanity failure).
#   4. Missing sourceRead call site (PR 12 follow-up): rename
#      `lineage?.sourceRead` → `lineage?.NOOP_sourceRead` in a temp copy.
#      Gate exits 1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# PASS/FAIL counters live in a sidecar file so they survive the subshells
# spawned by case 2 + case 3 (`( cd $TMP && ... )` to scope cwd changes).
# Direct variable mutation inside a subshell would be silently dropped.
COUNTER_DIR="$(mktemp -d)"
TMPDIR="$(mktemp -d)"
TMPDIR2="$(mktemp -d)"
TMPDIR3="$(mktemp -d)"
trap 'rm -rf "$COUNTER_DIR" "$TMPDIR" "$TMPDIR2" "$TMPDIR3"' EXIT
echo 0 > "$COUNTER_DIR/pass"
echo 0 > "$COUNTER_DIR/fail"

run() {
  local label="$1"; shift
  local want_exit="$1"; shift
  set +e
  "$@" >/dev/null 2>&1
  local got=$?
  set -e
  if [[ "$got" == "$want_exit" ]]; then
    echo "  PASS: $label (exit=$got)"
    echo $(($(cat "$COUNTER_DIR/pass") + 1)) > "$COUNTER_DIR/pass"
  else
    echo "  FAIL: $label (want exit=$want_exit, got $got)"
    echo $(($(cat "$COUNTER_DIR/fail") + 1)) > "$COUNTER_DIR/fail"
  fi
}

# Case 1: current main passes.
run "happy path on real FlowExecutor.ts" 0 node scripts/check-lineage-instrumentation.mjs

# Case 2: missing transform call → exit 1.
mkdir -p "$TMPDIR/src/flows/templates" "$TMPDIR/scripts"
cp scripts/check-lineage-instrumentation.mjs "$TMPDIR/scripts/"
sed 's/lineage?.transform/lineage?.NOOP_transform/g' src/flows/templates/FlowExecutor.ts > "$TMPDIR/src/flows/templates/FlowExecutor.ts"
( cd "$TMPDIR" && run "missing transform call → exit 1" 1 node scripts/check-lineage-instrumentation.mjs )

# Case 3: missing FlowExecutor.ts → exit 2.
mkdir -p "$TMPDIR2/scripts"
cp scripts/check-lineage-instrumentation.mjs "$TMPDIR2/scripts/"
( cd "$TMPDIR2" && run "missing FlowExecutor.ts → exit 2" 2 node scripts/check-lineage-instrumentation.mjs )

# Case 4 (PR 12 follow-up): missing sourceRead call → exit 1.
mkdir -p "$TMPDIR3/src/flows/templates" "$TMPDIR3/scripts"
cp scripts/check-lineage-instrumentation.mjs "$TMPDIR3/scripts/"
sed 's/lineage?.sourceRead/lineage?.NOOP_sourceRead/g' src/flows/templates/FlowExecutor.ts > "$TMPDIR3/src/flows/templates/FlowExecutor.ts"
( cd "$TMPDIR3" && run "missing sourceRead call → exit 1" 1 node scripts/check-lineage-instrumentation.mjs )

PASS=$(cat "$COUNTER_DIR/pass")
FAIL=$(cat "$COUNTER_DIR/fail")
echo ""
echo "lineage-instrumentation gate: $PASS pass / $FAIL fail"
[[ "$FAIL" == "0" ]]
