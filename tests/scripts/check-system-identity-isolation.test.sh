#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-system-identity-isolation.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_gate() {
  local root="$1"
  set +e
  node "$SCRIPT" --root "$root" >"$TMP_DIR/out.txt" 2>"$TMP_DIR/err.txt"
  local status=$?
  set -e
  return "$status"
}

write_file() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

if [ ! -f "$SCRIPT" ]; then
  fail "$SCRIPT not found"
fi

PASS=0

# A: allowed canonical identityContext literal.
CASE="$TMP_DIR/A"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
run_gate "$CASE" || fail "canonical identityContext literal should pass"
PASS=$((PASS + 1))

# B: any other src literal fails.
CASE="$TMP_DIR/B"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/services/ai/providers/BadProvider.ts" <<'TS'
export const tenantId = '__system__';
TS
if run_gate "$CASE"; then
  fail "provider literal should fail"
fi
grep -q "BadProvider.ts" "$TMP_DIR/err.txt" || fail "failure should name BadProvider.ts"
PASS=$((PASS + 1))

# C: comments outside the canonical file do not trip the gate.
CASE="$TMP_DIR/C"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/commentOnly.ts" <<'TS'
// Mentioning '__system__' in a comment is not a runtime identity source.
export const ok = true;
TS
run_gate "$CASE" || fail "comment-only mention should pass"
PASS=$((PASS + 1))

# D: double-quoted literals outside the canonical file also fail.
CASE="$TMP_DIR/D"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/doubleQuoted.ts" <<'TS'
export const userId = "__system__";
TS
if run_gate "$CASE"; then
  fail "double-quoted literal should fail"
fi
PASS=$((PASS + 1))

# E: no-substitution template literals outside the canonical file fail.
CASE="$TMP_DIR/E"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/templateLiteral.ts" <<'TS'
export const userId = `__system__`;
TS
if run_gate "$CASE"; then
  fail "template literal should fail"
fi
grep -q "templateLiteral.ts" "$TMP_DIR/err.txt" || fail "failure should name templateLiteral.ts"
PASS=$((PASS + 1))

# F: multiple findings are all reported.
CASE="$TMP_DIR/F"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/first.ts" <<'TS'
export const tenantId = '__system__';
TS
write_file "$CASE/src/nested/second.ts" <<'TS'
export const userId = "__system__";
TS
if run_gate "$CASE"; then
  fail "multiple hardcoded literals should fail"
fi
grep -q "first.ts" "$TMP_DIR/err.txt" || fail "failure should name first.ts"
grep -q "nested/second.ts" "$TMP_DIR/err.txt" || fail "failure should name nested/second.ts"
PASS=$((PASS + 1))

# G: script extensions covered by the scanner fail when they contain the literal.
CASE="$TMP_DIR/G"
write_file "$CASE/src/services/governance/identityContext.ts" <<'TS'
export const SYSTEM_IDENTITY = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});
TS
write_file "$CASE/src/component.tsx" <<'TSX'
export const Component = () => '__system__';
TSX
write_file "$CASE/src/module.mjs" <<'MJS'
export const tenantId = '__system__';
MJS
write_file "$CASE/src/common.cjs" <<'CJS'
exports.userId = '__system__';
CJS
if run_gate "$CASE"; then
  fail "script-extension literals should fail"
fi
grep -q "component.tsx" "$TMP_DIR/err.txt" || fail "failure should name component.tsx"
grep -q "module.mjs" "$TMP_DIR/err.txt" || fail "failure should name module.mjs"
grep -q "common.cjs" "$TMP_DIR/err.txt" || fail "failure should name common.cjs"
PASS=$((PASS + 1))

# H: --root requires an argument and prints usage.
set +e
node "$SCRIPT" --root >"$TMP_DIR/out.txt" 2>"$TMP_DIR/err.txt"
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ]; then
  fail "--root without an argument should fail"
fi
grep -q "Usage:" "$TMP_DIR/err.txt" || fail "--root argument failure should print usage"
PASS=$((PASS + 1))

# I: allowlist drift fails if the canonical file is missing.
CASE="$TMP_DIR/I"
write_file "$CASE/src/other.ts" <<'TS'
export const ok = true;
TS
if run_gate "$CASE"; then
  fail "missing allowlisted canonical file should fail"
fi
grep -q "Allowlisted file missing" "$TMP_DIR/err.txt" || fail "allowlist drift failure should name missing allowlist"
PASS=$((PASS + 1))

echo "check-system-identity-isolation tests passed ($PASS scenarios)"
