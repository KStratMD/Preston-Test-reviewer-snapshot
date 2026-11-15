#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/check-reviewer-mirror-public-visibility.sh \
  --branch-url <url> --head-url <url> --expected-sha <sha> \
  [--max-attempts <n>] [--sleep-seconds <n>]
EOF
}

BRANCH_URL=""
HEAD_URL=""
EXPECTED_SHA=""
MAX_ATTEMPTS=12
SLEEP_SECONDS=10

require_value() {
  local flag="$1"
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
    echo "$flag requires a value" >&2
    usage
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch-url)
      require_value "$@"
      BRANCH_URL="${2:-}"
      shift 2
      ;;
    --head-url)
      require_value "$@"
      HEAD_URL="${2:-}"
      shift 2
      ;;
    --expected-sha)
      require_value "$@"
      EXPECTED_SHA="${2:-}"
      shift 2
      ;;
    --max-attempts)
      require_value "$@"
      MAX_ATTEMPTS="${2:-}"
      shift 2
      ;;
    --sleep-seconds)
      require_value "$@"
      SLEEP_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$BRANCH_URL" ] || [ -z "$HEAD_URL" ] || [ -z "$EXPECTED_SHA" ]; then
  usage
  exit 2
fi

case "$MAX_ATTEMPTS" in
  ''|*[!0-9]*)
    echo "--max-attempts must be a positive integer" >&2
    exit 2
    ;;
esac

case "$SLEEP_SECONDS" in
  ''|*[!0-9]*)
    echo "--sleep-seconds must be a non-negative integer" >&2
    exit 2
    ;;
esac

if [ "$MAX_ATTEMPTS" -lt 1 ]; then
  echo "--max-attempts must be at least 1" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fetch_expected_with_retry() {
  local label="$1"
  local url="$2"
  local output="$3"
  local last_status="fetch_failed"
  local saw_sha_mismatch="false"

  for ((i = 1; i <= MAX_ATTEMPTS; i++)); do
    if curl -fsS -o "$output" -- "$url"; then
      if grep -Fq -- "$EXPECTED_SHA" "$output"; then
        return 0
      fi
      last_status="sha_mismatch"
      saw_sha_mismatch="true"
    else
      last_status="fetch_failed"
    fi

    if [ "$i" -lt "$MAX_ATTEMPTS" ]; then
      sleep "$SLEEP_SECONDS"
    fi
  done

  if [ "$last_status" = "sha_mismatch" ] || [ "$saw_sha_mismatch" = "true" ]; then
    echo "::error title=Public mirror smoke check failed::Expected upstream SHA $EXPECTED_SHA was not visible at $label URL $url after $MAX_ATTEMPTS attempts"
  else
    echo "::error title=Public mirror smoke check failed::Could not fetch SOURCE_COMMIT from $label URL $url after $MAX_ATTEMPTS attempts"
  fi
  return 1
}

BRANCH_OUTPUT="$TMP_DIR/source_commit_branch"
HEAD_OUTPUT="$TMP_DIR/source_commit_head"

fetch_expected_with_retry "published branch" "$BRANCH_URL" "$BRANCH_OUTPUT"
fetch_expected_with_retry "mirror default branch (HEAD)" "$HEAD_URL" "$HEAD_OUTPUT"

echo "Mirror public visibility OK (sha: $EXPECTED_SHA)"
