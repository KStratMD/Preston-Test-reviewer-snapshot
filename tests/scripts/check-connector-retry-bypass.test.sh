#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-connector-retry-bypass.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
count=0
connector_file=X.ts

check() {
  local expected="$1"; shift
  local actual=0
  node "$SCRIPT" "$@" >"$TMP_DIR/output" 2>&1 || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: expected $expected, got $actual: $*"
    cat "$TMP_DIR/output"
    exit 1
  fi
  count=$((count + 1))
}

check 0 --root "$ROOT_DIR"
mkdir -p "$TMP_DIR/fixture/src/connectors"
for sample in \
  'for (let attempt = 1; attempt <= 3; attempt++) {}' \
  'while (attempt < limit) {}' \
  'while (hasMore && attempt < maxRetries) {}' \
  'retryCount++;' \
  'import retry from "axios-retry";'; do
  printf '%s\n' "$sample" > "$TMP_DIR/fixture/src/connectors/X.ts"
  check 1 --root "$TMP_DIR/fixture"
  if ! grep -Fq "src/connectors/${connector_file}" "$TMP_DIR/output"; then
    echo 'FAIL: violation must identify its file'; exit 1
  fi
done
printf '%s\n' 'await this.makeRequest({ method: "GET" });' > "$TMP_DIR/fixture/src/connectors/X.ts"
check 0 --root "$TMP_DIR/fixture"
check 2 --root "$TMP_DIR/missing"
check 2 --root
check 2 --unknown
mkdir -p "$TMP_DIR/empty/src/connectors"
check 2 --root "$TMP_DIR/empty"
echo "PASS: $count connector retry bypass scenarios"
