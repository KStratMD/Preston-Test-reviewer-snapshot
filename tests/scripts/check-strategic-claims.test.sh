#!/usr/bin/env bash
# Regression test for scripts/check-strategic-claims.mjs.
#
# Synthetic scenario coverage via --root: spin up temp fixture files,
# run the script, assert exit code. 9 scenarios — A-I.
#
#   A: file with no numbers                                -> accept (exit 0)
#   B: number tagged inline `<!-- claim:evidence -->`      -> accept
#   C: number tagged with `<!-- claim:labeled-projection`  -> accept
#   D: unclassified percentage (e.g., "95-99%")            -> reject (exit 1)
#   E: year stamp (2026) — allowlist pattern               -> accept
#   F: version number (v3.4.0) — allowlist pattern         -> accept
#   G: number inside a fenced code block                   -> accept (skipped)
#   H: number inside a URL                                 -> accept (skipped)
#   I: number inside an HTML comment (not a claim tag)     -> accept (skipped)
#
# Run with: bash tests/scripts/check-strategic-claims.test.sh
# Exits 0 on all scenarios passing; non-zero with diagnostic on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-strategic-claims.mjs"

if [ ! -f "$GATE" ]; then
  echo "FAIL: $GATE does not exist" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Helper — build a minimal --root layout and run the gate.
# Args: $1 = fixture file contents; $2 = expected exit code; $3 = scenario label
run_scenario() {
  local contents="$1"
  local expected="$2"
  local label="$3"
  local root="$TMP/$label"
  mkdir -p "$root"
  printf '%s' "$contents" > "$root/CLAUDE.md"
  # Empty allowlist by default — override per scenario below.
  if [ ! -f "$root/strategic-claims.allowlist.json" ]; then
    cat > "$root/strategic-claims.allowlist.json" <<'EOF'
{ "patterns": [], "literals": [] }
EOF
  fi
  local actual=0
  node "$GATE" --root "$root" --targets CLAUDE.md --allowlist "$root/strategic-claims.allowlist.json" >/dev/null 2>&1 || actual=$?
  if [ "$actual" != "$expected" ]; then
    echo "FAIL ($label): expected exit $expected, got $actual" >&2
    node "$GATE" --root "$root" --targets CLAUDE.md --allowlist "$root/strategic-claims.allowlist.json" 2>&1 | head -20 >&2 || true
    exit 1
  fi
  echo "PASS ($label): exit $actual"
}

# Helper variant — write a custom allowlist before running.
run_scenario_with_allowlist() {
  local contents="$1"
  local allowlist="$2"
  local expected="$3"
  local label="$4"
  local root="$TMP/$label"
  mkdir -p "$root"
  printf '%s' "$contents" > "$root/CLAUDE.md"
  printf '%s' "$allowlist" > "$root/strategic-claims.allowlist.json"
  local actual=0
  node "$GATE" --root "$root" --targets CLAUDE.md --allowlist "$root/strategic-claims.allowlist.json" >/dev/null 2>&1 || actual=$?
  if [ "$actual" != "$expected" ]; then
    echo "FAIL ($label): expected exit $expected, got $actual" >&2
    node "$GATE" --root "$root" --targets CLAUDE.md --allowlist "$root/strategic-claims.allowlist.json" 2>&1 | head -20 >&2 || true
    exit 1
  fi
  echo "PASS ($label): exit $actual"
}

# ---------- A: no numbers -> accept ----------
run_scenario "# Product
The wedge is embedded ERP operations.
" 0 scenario-A-no-numbers

# ---------- B: tagged evidence -> accept ----------
run_scenario "# Tests
We have 10,124 passing tests <!-- claim:evidence --> across 462 suites <!-- claim:evidence -->.
" 0 scenario-B-tagged-evidence

# ---------- C: tagged labeled-projection -> accept ----------
run_scenario "# Roadmap
Pilot accuracy target is 95% <!-- claim:labeled-projection --> by Q3.
" 0 scenario-C-tagged-projection

# ---------- D: unclassified percentage -> reject ----------
run_scenario "# AI System
Field mapping accuracy: 95-99% across all schemas.
" 1 scenario-D-unclassified-pct

# ---------- E: year stamp via allowlist pattern -> accept ----------
run_scenario_with_allowlist "# Release
Released in May 2026.
" '{ "patterns": [{"regex": "^(20[12]\\d)$", "reason": "year stamps"}], "literals": [] }' 0 scenario-E-year-allowlist

# ---------- F: version number via allowlist pattern -> accept ----------
run_scenario_with_allowlist "# Components
NL Action Gate v3.3.0 — shipping.
MDM v3.4.0 — shipping.
" '{ "patterns": [{"regex": "^v?\\d+\\.\\d+(?:\\.\\d+)?$", "reason": "version numbers"}], "literals": [] }' 0 scenario-F-version-allowlist

# ---------- G: number inside fenced code block -> accept (skipped) ----------
run_scenario '# Setup
```bash
PORT=3003
TIMEOUT=120000
```
' 0 scenario-G-code-block-skip

# ---------- H: number inside URL -> accept (skipped) ----------
run_scenario "# Links
See https://example.com/sandbox/2698307 for details.
" 0 scenario-H-url-skip

# ---------- I: number inside HTML comment (not a claim tag) -> accept (skipped) ----------
run_scenario "# Internal
<!-- TODO: revisit after 30 days -->
" 0 scenario-I-html-comment-skip

echo
echo "All 9 scenarios passed."
