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

FAKE_BIN="$TMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[ -n "$output" ] || exit 2

count_file="${CURL_COUNT_FILE:?}"
count=0
[ -f "$count_file" ] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" > "$count_file"

if [ "${CURL_MODE:-eventual}" = "stale" ]; then
  printf 'upstream-sha: stale-sha\n' > "$output"
  exit 0
fi

if [ "${CURL_MODE:-eventual}" = "stale_then_fetch_fail" ]; then
  if [ "$count" -eq 1 ]; then
    printf 'upstream-sha: stale-sha\n' > "$output"
    exit 0
  fi
  exit 22
fi

if [ "$count" -lt 3 ]; then
  printf 'upstream-sha: stale-sha\n' > "$output"
else
  printf 'upstream-sha: expected-sha\n' > "$output"
fi
SH
chmod +x "$FAKE_BIN/curl"

COUNT_FILE="$TMP_DIR/curl-count"
PATH="$FAKE_BIN:$PATH" CURL_COUNT_FILE="$COUNT_FILE" \
  bash "$ROOT_DIR/scripts/check-reviewer-mirror-public-visibility.sh" \
    --branch-url "https://example.invalid/branch/SOURCE_COMMIT" \
    --head-url "https://example.invalid/head/SOURCE_COMMIT" \
    --expected-sha "expected-sha" \
    --max-attempts 4 \
    --sleep-seconds 0 >"$TMP_DIR/eventual.out"

grep -q "Mirror public visibility OK" "$TMP_DIR/eventual.out" \
  || fail "eventual-current response did not pass"

set +e
PATH="$FAKE_BIN:$PATH" CURL_COUNT_FILE="$TMP_DIR/stale-count" CURL_MODE=stale \
  bash "$ROOT_DIR/scripts/check-reviewer-mirror-public-visibility.sh" \
    --branch-url "https://example.invalid/branch/SOURCE_COMMIT" \
    --head-url "https://example.invalid/head/SOURCE_COMMIT" \
    --expected-sha "expected-sha" \
    --max-attempts 3 \
    --sleep-seconds 0 >"$TMP_DIR/stale.out" 2>"$TMP_DIR/stale.err"
rc=$?
set -e

[ "$rc" -eq 1 ] || fail "permanent stale response should fail with exit 1, got $rc"
grep -q "Expected upstream SHA expected-sha was not visible" "$TMP_DIR/stale.out" \
  || fail "permanent stale response did not explain SHA mismatch"

set +e
PATH="$FAKE_BIN:$PATH" CURL_COUNT_FILE="$TMP_DIR/stale-then-fetch-fail-count" CURL_MODE=stale_then_fetch_fail \
  bash "$ROOT_DIR/scripts/check-reviewer-mirror-public-visibility.sh" \
    --branch-url "https://example.invalid/branch/SOURCE_COMMIT" \
    --head-url "https://example.invalid/head/SOURCE_COMMIT" \
    --expected-sha "expected-sha" \
    --max-attempts 3 \
    --sleep-seconds 0 >"$TMP_DIR/stale-then-fetch-fail.out" 2>"$TMP_DIR/stale-then-fetch-fail.err"
rc=$?
set -e

[ "$rc" -eq 1 ] || fail "stale-then-fetch-fail response should fail with exit 1, got $rc"
grep -q "Expected upstream SHA expected-sha was not visible" "$TMP_DIR/stale-then-fetch-fail.out" \
  || fail "stale-then-fetch-fail response did not preserve SHA mismatch diagnosis"

set +e
bash "$ROOT_DIR/scripts/check-reviewer-mirror-public-visibility.sh" \
  --branch-url >"$TMP_DIR/missing-value.out" 2>"$TMP_DIR/missing-value.err"
rc=$?
set -e

[ "$rc" -eq 2 ] || fail "missing option value should fail with exit 2, got $rc"
grep -q -- "--branch-url requires a value" "$TMP_DIR/missing-value.err" \
  || fail "missing option value did not print a flag-specific usage error"

echo "reviewer mirror public visibility tests passed"
