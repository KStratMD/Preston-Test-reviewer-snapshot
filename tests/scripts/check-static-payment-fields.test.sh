#!/usr/bin/env bash
# Regression: scripts/check-static-payment-fields.mjs
#
# No HTML under public/ may collect payment-card data. There is no allowlist, so
# the scenarios are only: clean, violating, and env error.
#
# Exit codes: 0 = clean, 1 = violation found, 2 = env/usage error.
#
# Scenario 2 uses the exact binding the deleted customer-payment-portal.html
# carried (x-model="cardNumber"), so this suite fails if the gate ever stops
# catching the defect it was written for.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-static-payment-fields.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

status_for() {
  set +e
  node "$SCRIPT" --root "$1" >"$TMP_DIR/out.txt" 2>"$TMP_DIR/err.txt"
  local rc=$?
  set -e
  echo "$rc"
}

[ -f "$SCRIPT" ] || fail "$SCRIPT not found"

# 1. Real repo is clean.
node "$SCRIPT" >/dev/null 2>&1 || fail "scenario 1: real repo should be clean"
echo "PASS: real repo clean"

# 2. Alpine binding, as used by the deleted portal.
mkdir -p "$TMP_DIR/v1/public"
printf '%s\n' '<input x-model="cardNumber" type="text">' > "$TMP_DIR/v1/public/p.html"
rc="$(status_for "$TMP_DIR/v1")"
[ "$rc" -eq 1 ] || fail "scenario 2: expected 1, got $rc"
grep -Fq "cardNumber" "$TMP_DIR/err.txt" || fail "scenario 2: stderr did not name the match"
echo "PASS: Alpine card binding detected"

# 3. autocomplete token, nested directory.
mkdir -p "$TMP_DIR/v2/public/sub"
printf '%s\n' '<input autocomplete="cc-csc">' > "$TMP_DIR/v2/public/sub/p.html"
rc="$(status_for "$TMP_DIR/v2")"
[ "$rc" -eq 1 ] || fail "scenario 3: expected 1, got $rc"
echo "PASS: cc- autocomplete token detected in a nested directory"

# 4. Field named for a CVV.
mkdir -p "$TMP_DIR/v3/public"
printf '%s\n' '<input name="cvv2">' > "$TMP_DIR/v3/public/p.html"
rc="$(status_for "$TMP_DIR/v3")"
[ "$rc" -eq 1 ] || fail "scenario 4: expected 1, got $rc"
echo "PASS: CVV field name detected"

# 5. Prose is not a violation — the gate targets form plumbing, not words. A
#    page explaining that Squire never stores card numbers must stay green.
mkdir -p "$TMP_DIR/ok/public"
printf '%s\n' '<p>We never store your card number or CVV. Payment is handled by the processor.</p>' > "$TMP_DIR/ok/public/p.html"
rc="$(status_for "$TMP_DIR/ok")"
[ "$rc" -eq 0 ] || fail "scenario 5: prose should not fail, got $rc"
echo "PASS: prose mentioning card number stays clean"

# 6. Missing public/ is an env error, not a pass.
mkdir -p "$TMP_DIR/nopublic"
rc="$(status_for "$TMP_DIR/nopublic")"
[ "$rc" -eq 2 ] || fail "scenario 6: expected 2, got $rc"
echo "PASS: missing public/ is an env error"

# 7. --root without a value is a usage error.
set +e
node "$SCRIPT" --root >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 2 ] || fail "scenario 7: expected 2, got $rc"
echo "PASS: --root without value is a usage error"

# 8. Bypasses demonstrated during review of PR #1234: a bare "pan" field name,
#    and a Livewire binding whose prefix the first pattern set did not know.
mkdir -p "$TMP_DIR/v4/public"
printf '%s\n' '<label>Card number<input name="pan"></label>' > "$TMP_DIR/v4/public/p.html"
rc="$(status_for "$TMP_DIR/v4")"
[ "$rc" -eq 1 ] || fail "scenario 8a: name=pan should fail, got $rc"
printf '%s\n' '<input wire:model="payment.cardNumber">' > "$TMP_DIR/v4/public/p.html"
rc="$(status_for "$TMP_DIR/v4")"
[ "$rc" -eq 1 ] || fail "scenario 8b: wire:model binding should fail, got $rc"
printf '%s\n' '<input name=cardnumber>' > "$TMP_DIR/v4/public/p.html"
rc="$(status_for "$TMP_DIR/v4")"
[ "$rc" -eq 1 ] || fail "scenario 8c: unquoted attribute should fail, got $rc"
echo "PASS: review bypasses (bare pan, wire:model, unquoted attribute) detected"

# 9. The widened patterns must not fire on ordinary markup. "panel" and "panic"
#    start with "pan"; prose about card numbers is not a collection form.
mkdir -p "$TMP_DIR/v5/public"
printf '%s\n' '<div id="panel" class="panic">We never store your card number or CVV.</div>' > "$TMP_DIR/v5/public/p.html"
rc="$(status_for "$TMP_DIR/v5")"
[ "$rc" -eq 0 ] || fail "scenario 9: panel/panic/prose should stay clean, got $rc"
echo "PASS: widened patterns do not fire on panel, panic or prose"

echo ""
echo "check-static-payment-fields.test.sh: all scenarios passed"
