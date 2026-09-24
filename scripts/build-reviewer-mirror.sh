#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Default --source to the repo root (computed from this script's location)
# so the mirror builder doesn't silently depend on the caller's cwd. The
# user can still override by passing --source explicitly.
has_source=false
prev_was_source=false
for arg in "$@"; do
  if [ "$prev_was_source" = true ]; then
    has_source=true
    prev_was_source=false
    continue
  fi
  case "$arg" in
    --source)
      prev_was_source=true
      ;;
    --source=*)
      has_source=true
      ;;
  esac
done

if [ "$has_source" = true ]; then
  exec node "$ROOT_DIR/scripts/build-reviewer-mirror.mjs" "$@"
else
  exec node "$ROOT_DIR/scripts/build-reviewer-mirror.mjs" --source "$ROOT_DIR" "$@"
fi
