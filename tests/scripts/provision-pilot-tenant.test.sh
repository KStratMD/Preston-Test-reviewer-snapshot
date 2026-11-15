#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/provision-pilot-tenant.mjs"

# Single tempdir per run keeps the test portable across GNU and BSD mktemp
# (`mktemp -d` is the most consistent form across both) and lets a single
# trap clean up every artifact on success or failure.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Portable mode read: GNU `stat -c` and BSD `stat -f` differ; Node is already
# required for this test, so reuse it for the permission check.
read_mode() {
  node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"
}

# Compute sha256(rawToken) so the stub fixture matches the integrity check
# that verify mode now enforces. Mirrors `hashToken()` in the script and
# `EmbeddedServiceTokenRepository.hashToken` in src/.
sha256_hex() {
  node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$1"
}

TOK_RAW="tok_test_raw"
TOK_HASH="$(sha256_hex "$TOK_RAW")"
STUB_JSON="{\"rawToken\":\"$TOK_RAW\",\"tokenHash\":\"$TOK_HASH\"}"

# --- dry-run ---------------------------------------------------------------
node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --dry-run > "$TMP_DIR/dry-run.json"
grep -Fq '"mode": "dry-run"' "$TMP_DIR/dry-run.json"
grep -Fq '"tenantId": "t_demo"' "$TMP_DIR/dry-run.json"
grep -Fq '"platform": "netsuite"' "$TMP_DIR/dry-run.json"

# --- arg-validation regressions --------------------------------------------
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 2>"$TMP_DIR/missing-mode.err"; then
  echo "expected missing mode to fail" >&2
  exit 1
fi
grep -Fq "Pass exactly one of --dry-run, --apply, or --verify" "$TMP_DIR/missing-mode.err"

if node "$SCRIPT" --tenant t_demo --platform netsutie --platform-account-id acct_1 --dry-run 2>"$TMP_DIR/bad-platform.err"; then
  echo "expected bad platform to fail" >&2
  exit 1
fi
grep -Fq -- "--platform must be one of netsuite, business_central" "$TMP_DIR/bad-platform.err"

if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply 2>"$TMP_DIR/apply-no-output.err"; then
  echo "expected apply without --output to fail" >&2
  exit 1
fi
grep -Fq -- "--output is required for --apply" "$TMP_DIR/apply-no-output.err"

if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify 2>"$TMP_DIR/verify-no-output.err"; then
  echo "expected verify without --provisioning-output to fail" >&2
  exit 1
fi
grep -Fq -- "--provisioning-output is required for --verify" "$TMP_DIR/verify-no-output.err"

if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --dry-run --apply 2>"$TMP_DIR/multi-mode.err"; then
  echo "expected multi-mode to fail" >&2
  exit 1
fi
grep -Fq "Pass exactly one of --dry-run, --apply, or --verify" "$TMP_DIR/multi-mode.err"

if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --dry-run --frobnicate 2>"$TMP_DIR/unknown-arg.err"; then
  echo "expected unknown arg to fail" >&2
  exit 1
fi
grep -Fq "Unknown argument: --frobnicate" "$TMP_DIR/unknown-arg.err"

if node "$SCRIPT" --platform netsuite --platform-account-id acct_1 --dry-run 2>"$TMP_DIR/missing-tenant.err"; then
  echo "expected missing --tenant to fail" >&2
  exit 1
fi
grep -Fq -- "--tenant is required" "$TMP_DIR/missing-tenant.err"

if node "$SCRIPT" --tenant t_demo --platform netsuite --dry-run 2>"$TMP_DIR/missing-acct.err"; then
  echo "expected missing --platform-account-id to fail" >&2
  exit 1
fi
grep -Fq -- "--platform-account-id is required" "$TMP_DIR/missing-acct.err"

if node "$SCRIPT" --tenant --platform netsuite --platform-account-id acct_1 --dry-run 2>"$TMP_DIR/tenant-no-value.err"; then
  echo "expected --tenant without value to fail" >&2
  exit 1
fi
grep -Fq -- "--tenant requires a value" "$TMP_DIR/tenant-no-value.err"

# --- apply (stubbed token CLI) ---------------------------------------------
TMP_OUT="$TMP_DIR/provisioning.json"
PROVISION_PILOT_TENANT_TEST_MODE=1 \
PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_OUT" > "$TMP_DIR/apply.json"
grep -Fq '"mode": "apply"' "$TMP_DIR/apply.json"
grep -Fq '"embeddedServiceToken"' "$TMP_DIR/apply.json"
grep -Fq '"rawTokenRedacted": true' "$TMP_DIR/apply.json"
# The raw bearer token MUST NOT appear on stdout — the artifact file is the
# only place it should live.
if grep -Fq '"rawToken"' "$TMP_DIR/apply.json"; then
  echo "apply stdout leaked rawToken; should only live in the artifact" >&2
  exit 1
fi
if grep -Fq "$TOK_RAW" "$TMP_DIR/apply.json"; then
  echo "apply stdout leaked the raw token VALUE; should only live in the artifact" >&2
  exit 1
fi
test -s "$TMP_OUT"
grep -Fq "\"rawToken\": \"$TOK_RAW\"" "$TMP_OUT"
grep -Fq "\"tokenHash\": \"$TOK_HASH\"" "$TMP_OUT"

# Artifact must land at mode 0600 on first apply.
PERMS="$(read_mode "$TMP_OUT")"
test "$PERMS" = "600" || { echo "expected first-apply artifact mode 600, got $PERMS" >&2; exit 1; }

# --apply must preflight that the output directory is writable BEFORE the
# token mint runs — otherwise a failed write would burn the previous active
# token without leaving the new one persisted anywhere.
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_DIR/does/not/exist/x.json" 2>"$TMP_DIR/preflight.err"; then
  echo "expected unwritable --output to fail preflight" >&2
  exit 1
fi
grep -Fq "cannot write provisioning artifact" "$TMP_DIR/preflight.err"
grep -Fq "directory does not exist" "$TMP_DIR/preflight.err"

# Preflight must also fail closed when --output IS a directory, not just
# when the parent is missing. Otherwise the parent-dir-only check would
# pass and the EISDIR error would land AFTER the token was minted.
OUTPUT_IS_DIR="$TMP_DIR/output-as-dir"
mkdir -p "$OUTPUT_IS_DIR"
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$OUTPUT_IS_DIR" 2>"$TMP_DIR/preflight-isdir.err"; then
  echo "expected --output pointing at a directory to fail preflight" >&2
  exit 1
fi
grep -Fq "path is a directory" "$TMP_DIR/preflight-isdir.err"

# Preflight must also fail closed when --output ends with a trailing slash.
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_DIR/trailing-slash/" 2>"$TMP_DIR/preflight-trailing.err"; then
  echo "expected --output with trailing slash to fail preflight" >&2
  exit 1
fi
grep -Fq "looks like a directory" "$TMP_DIR/preflight-trailing.err"

# Preflight must reject when dirname(--output) is a regular file, not a
# directory. accessSync(W_OK|X_OK) can pass on a regular file with those
# permission bits, which would let the script burn the token then fail
# the write with ENOTDIR.
echo "not a directory" > "$TMP_DIR/parent-is-file"
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_DIR/parent-is-file/artifact.json" 2>"$TMP_DIR/preflight-parent-file.err"; then
  echo "expected --output whose parent is a regular file to fail preflight" >&2
  exit 1
fi
grep -Fq "parent path is not a directory" "$TMP_DIR/preflight-parent-file.err"

# apply must refuse to persist an artifact whose tokenHash doesn't match
# sha256(rawToken) — defense in depth against a buggy stub / future CLI.
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON='{"rawToken":"abc","tokenHash":"deadbeef"}' \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_DIR/should-not-write.json" 2>"$TMP_DIR/apply-bad-hash.err"; then
  echo "expected apply with mismatched stub hash to fail" >&2
  exit 1
fi
grep -Fq "tokenHash that does not match" "$TMP_DIR/apply-bad-hash.err"
test ! -f "$TMP_DIR/should-not-write.json"

# Malformed test stub env JSON must produce a clear error naming the env var.
if PROVISION_PILOT_TENANT_TEST_MODE=1 \
   PROVISION_PILOT_TENANT_TEST_TOKEN_JSON='not json' \
   node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_DIR/should-not-write-2.json" 2>"$TMP_DIR/stub-bad-json.err"; then
  echo "expected malformed stub env to fail" >&2
  exit 1
fi
grep -Fq "PROVISION_PILOT_TENANT_TEST_TOKEN_JSON is not valid JSON" "$TMP_DIR/stub-bad-json.err"

# Pre-loosen the artifact and rerun --apply; the atomic-rename path must
# guarantee 0600 even when the target already exists with broader perms.
chmod 0644 "$TMP_OUT"
PROVISION_PILOT_TENANT_TEST_MODE=1 \
PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="$STUB_JSON" \
node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$TMP_OUT" > "$TMP_DIR/apply2.json"
PERMS2="$(read_mode "$TMP_OUT")"
test "$PERMS2" = "600" || { echo "expected rerun artifact mode 600, got $PERMS2" >&2; exit 1; }

# --- verify ----------------------------------------------------------------
node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$TMP_OUT" > "$TMP_DIR/verify.json"
grep -Fq '"tenantId": "t_demo"' "$TMP_DIR/verify.json"
grep -Fq '"embeddedTokenPresent": true' "$TMP_DIR/verify.json"

# verify mode rejects a mismatched tenant
if node "$SCRIPT" --tenant t_other --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$TMP_OUT" 2>"$TMP_DIR/verify-mismatch.err"; then
  echo "expected verify mismatch to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact mismatch on: tenantId" "$TMP_DIR/verify-mismatch.err"

# verify mode rejects a mismatched platform
if node "$SCRIPT" --tenant t_demo --platform business_central --platform-account-id acct_1 --verify --provisioning-output "$TMP_OUT" 2>"$TMP_DIR/verify-platform-mismatch.err"; then
  echo "expected verify platform mismatch to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact mismatch on: platform" "$TMP_DIR/verify-platform-mismatch.err"

# verify mode rejects a mismatched platform-account-id
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_2 --verify --provisioning-output "$TMP_OUT" 2>"$TMP_DIR/verify-acct-mismatch.err"; then
  echo "expected verify platform-account-id mismatch to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact mismatch on: platformAccountId" "$TMP_DIR/verify-acct-mismatch.err"

# verify mode fails closed when artifact is missing
MISSING="$TMP_DIR/missing.json"   # nonexistent path inside the cleanup dir
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$MISSING" 2>"$TMP_DIR/verify-missing.err"; then
  echo "expected verify with missing artifact to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact not found" "$TMP_DIR/verify-missing.err"

# verify mode reports "not readable" when the path exists but is a directory
# (EISDIR) rather than a regular file. Distinguishes from ENOENT for clarity.
IS_DIR="$TMP_DIR/artifact-dir"
mkdir -p "$IS_DIR"
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$IS_DIR" 2>"$TMP_DIR/verify-isdir.err"; then
  echo "expected verify with directory path to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact not readable" "$TMP_DIR/verify-isdir.err"

# verify mode fails closed when artifact has malformed JSON
MALFORMED="$TMP_DIR/malformed.json"
echo "not json" > "$MALFORMED"
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$MALFORMED" 2>"$TMP_DIR/verify-malformed.err"; then
  echo "expected verify with malformed JSON to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact is not valid JSON" "$TMP_DIR/verify-malformed.err"

# verify mode fails closed when artifact JSON is not an object (null/array)
NOT_OBJECT="$TMP_DIR/not-object.json"
echo "null" > "$NOT_OBJECT"
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$NOT_OBJECT" 2>"$TMP_DIR/verify-not-object.err"; then
  echo "expected verify with non-object JSON to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact must be a JSON object" "$TMP_DIR/verify-not-object.err"

echo "[]" > "$NOT_OBJECT"
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$NOT_OBJECT" 2>"$TMP_DIR/verify-array.err"; then
  echo "expected verify with array JSON to fail" >&2
  exit 1
fi
grep -Fq "provisioning artifact must be a JSON object" "$TMP_DIR/verify-array.err"

# verify mode fails closed when artifact is missing embeddedServiceToken
NO_TOKEN="$TMP_DIR/no-token.json"
cat > "$NO_TOKEN" <<'EOF'
{
  "tenantId": "t_demo",
  "platform": "netsuite",
  "platformAccountId": "acct_1"
}
EOF
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$NO_TOKEN" 2>"$TMP_DIR/verify-no-token.err"; then
  echo "expected verify with no token to fail" >&2
  exit 1
fi
grep -Fq "missing embeddedServiceToken" "$TMP_DIR/verify-no-token.err"

# verify mode fails closed when rawToken/tokenHash disagree (integrity gate)
TAMPERED="$TMP_DIR/tampered.json"
cat > "$TAMPERED" <<EOF
{
  "tenantId": "t_demo",
  "platform": "netsuite",
  "platformAccountId": "acct_1",
  "embeddedServiceToken": { "rawToken": "$TOK_RAW", "tokenHash": "0000000000000000000000000000000000000000000000000000000000000000" }
}
EOF
if node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --verify --provisioning-output "$TAMPERED" 2>"$TMP_DIR/verify-tampered.err"; then
  echo "expected verify with tampered hash to fail" >&2
  exit 1
fi
grep -Fq "hash mismatch" "$TMP_DIR/verify-tampered.err"

# cwd-independence smoke: the script must run cleanly when invoked from a
# directory that is NOT the repo root. The token-stub env vars bypass the
# real npm spawn (so we don't need a DB), but the REPO_ROOT computation
# still runs and the script still has to load relative imports correctly.
CWD_OUT="$TMP_DIR/cwd-independence.json"
CWD_TOK="tok_cwd"
CWD_HASH="$(sha256_hex "$CWD_TOK")"
(
  cd "$TMP_DIR"
  PROVISION_PILOT_TENANT_TEST_MODE=1 \
  PROVISION_PILOT_TENANT_TEST_TOKEN_JSON="{\"rawToken\":\"$CWD_TOK\",\"tokenHash\":\"$CWD_HASH\"}" \
  node "$SCRIPT" --tenant t_demo --platform netsuite --platform-account-id acct_1 --apply --output "$CWD_OUT" > "$TMP_DIR/cwd-apply.json"
)
grep -Fq "\"tokenHash\": \"$CWD_HASH\"" "$CWD_OUT"

echo "provision-pilot-tenant test: PASS"
