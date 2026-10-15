#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
checker="$repo_root/scripts/check-order-to-cash-fixtures.mjs"
generator="$repo_root/scripts/fixtures/generate-order-to-cash.mjs"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
kit="$scratch/kit"
dataset="$kit/tests/fixtures/order-to-cash"
mkdir -p "$kit"
passed=0
failed=0
expect_exit() {
  local want="$1" label="$2" actual=0
  shift 2
  "$@" >"$scratch/output" 2>&1 || actual=$?
  if [[ "$actual" == "$want" ]] && { [[ "$label" != *'invalid root'* ]] || grep -Fq 'fixture freshness: invalid root: ' "$scratch/output"; }; then
    printf 'PASS %s (exit %s)\n' "$label" "$actual"
    passed=$((passed + 1))
  else
    printf 'FAIL %s expected %s got %s\n' "$label" "$want" "$actual"
    cat "$scratch/output"
    failed=$((failed + 1))
  fi
}
reset_dataset() {
  # Only task-owned files inside mktemp's fixed child directory are removed.
  rm -rf "$dataset"
  node "$generator" --seed 42 --orders 200 --out "$dataset" >/dev/null
}
reset_dataset
expect_exit 0 'identical dataset without Git index' node "$checker" --root "$kit"
for name in orders.json erp-documents.json payouts.json expected-detections.json; do
  printf '[]\n' > "$dataset/$name"
  expect_exit 1 "stale $name" node "$checker" --root "$kit"
  reset_dataset
done
rm "$dataset/orders.json"
expect_exit 1 'missing committed output' node "$checker" --root "$kit"
reset_dataset
printf '{}\n' > "$dataset/unexpected.json"
expect_exit 1 'unexpected untracked output' node "$checker" --root "$kit"
reset_dataset
rm "$dataset/orders.json"
mkdir "$dataset/orders.json"
expect_exit 1 'directory replacing output' node "$checker" --root "$kit"
reset_dataset
cp "$dataset/orders.json" "$scratch/orders.json"
rm "$dataset/orders.json"
ln -s "$scratch/orders.json" "$dataset/orders.json"
expect_exit 1 'symlink replacing output' node "$checker" --root "$kit"
rm -rf "$dataset"
expect_exit 1 'absent dataset' node "$checker" --root "$kit"
expect_exit 2 'invalid root: absent path' node "$checker" --root "$scratch/absent"
expect_exit 2 'invalid root: file path' node "$checker" --root "$checker"
expect_exit 2 'unknown flag' node "$checker" --unknown
expect_exit 2 'missing root argument' node "$checker" --root
expect_exit 2 'duplicate root argument' node "$checker" --root "$kit" --root "$kit"
printf '%s passed; %s failed\n' "$passed" "$failed"
[[ "$failed" == 0 && "$passed" == 15 ]]
