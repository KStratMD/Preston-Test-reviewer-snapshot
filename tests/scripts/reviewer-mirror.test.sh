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

assert_file() {
  local path="$1"
  [ -f "$path" ] || fail "Expected file: $path"
}

assert_no_path() {
  local path="$1"
  [ ! -e "$path" ] || fail "Expected path to be absent: $path"
}

SRC="$TMP_DIR/source"
STAGE="$TMP_DIR/stage"
ALLOWLIST="$TMP_DIR/allowlist.json"

mkdir -p "$SRC/src" "$SRC/docs/archive" "$SRC/public/wiki" "$SRC/public/Squire-Executive-Package-v2" "$SRC/scripts"
mkdir -p "$SRC/public/assets"
printf '# Demo\n' > "$SRC/README.md"
printf '{"scripts":{}}\n' > "$SRC/package.json"
printf 'module.exports = {};\n' > "$SRC/jest.base.config.cjs"
printf 'console.log("ok");\n' > "$SRC/src/index.ts"
printf '# Reviewer guide\n' > "$SRC/docs/guide.md"
printf '# Archived\n' > "$SRC/docs/archive/old.md"
printf 'generated wiki\n' > "$SRC/public/wiki/index.md"
printf 'binary-ish K:\\private\\path\n' > "$SRC/public/assets/logo.png"
printf 'internal deck\n' > "$SRC/public/Squire-Executive-Package-v2/deck.md"
printf 'SECRET=bad\n' > "$SRC/.env.example"
printf 'utility\n' > "$SRC/scripts/tool.sh"

cat > "$ALLOWLIST" <<'JSON'
{
  "include": [
    "README.md",
    "package.json",
    "jest*.config.cjs",
    "src/**",
    "docs/**",
    "public/**",
    "scripts/**"
  ],
  "exclude": [
    "docs/archive/**"
  ]
}
JSON

"$ROOT_DIR/scripts/build-reviewer-mirror.sh" \
  --source "$SRC" \
  --staging "$STAGE" \
  --allowlist "$ALLOWLIST" \
  --dry-run \
  --skip-secret-scan >"$TMP_DIR/reviewer-mirror-dry-run.out"

grep -q "README.md" "$TMP_DIR/reviewer-mirror-dry-run.out" || fail "dry-run did not print staged tree"
assert_file "$STAGE/README.md"
assert_file "$STAGE/jest.base.config.cjs"
assert_file "$STAGE/src/index.ts"
assert_file "$STAGE/docs/guide.md"
assert_file "$STAGE/scripts/tool.sh"
assert_file "$STAGE/public/assets/logo.png"
assert_no_path "$STAGE/docs/archive"
assert_no_path "$STAGE/public/wiki"
assert_no_path "$STAGE/public/Squire-Executive-Package-v2"
assert_no_path "$STAGE/.env.example"

printf 'leak K:%sprivate/path\n' "/" > "$SRC/docs/guide.md"
if "$ROOT_DIR/scripts/build-reviewer-mirror.sh" \
  --source "$SRC" \
  --staging "$STAGE" \
  --allowlist "$ALLOWLIST" \
  --dry-run \
  --skip-secret-scan >"$TMP_DIR/reviewer-mirror-leak.out" 2>"$TMP_DIR/reviewer-mirror-leak.err"; then
  fail "Expected mirror build to fail on forbidden K:/ string"
fi

grep -q "Forbidden content" "$TMP_DIR/reviewer-mirror-leak.err" || fail "Forbidden string failure was not explained"

printf 'leak K:\\private\\path\n' > "$SRC/docs/guide.md"
if "$ROOT_DIR/scripts/build-reviewer-mirror.sh" \
  --source "$SRC" \
  --staging "$STAGE" \
  --allowlist "$ALLOWLIST" \
  --dry-run \
  --skip-secret-scan >"$TMP_DIR/reviewer-mirror-backslash-leak.out" 2>"$TMP_DIR/reviewer-mirror-backslash-leak.err"; then
  fail "Expected mirror build to fail on forbidden K:\\ string"
fi

grep -q "Forbidden content" "$TMP_DIR/reviewer-mirror-backslash-leak.err" || fail "Forbidden backslash failure was not explained"

if "$ROOT_DIR/scripts/build-reviewer-mirror.sh" \
  --source "$SRC" \
  --staging "$TMP_DIR" \
  --allowlist "$ALLOWLIST" \
  --dry-run \
  --skip-secret-scan >"$TMP_DIR/reviewer-mirror-unsafe-staging.out" 2>"$TMP_DIR/reviewer-mirror-unsafe-staging.err"; then
  fail "Expected mirror build to reject unsafe staging directory"
fi

grep -q "dangerous staging directory" "$TMP_DIR/reviewer-mirror-unsafe-staging.err" || fail "Unsafe staging failure was not explained"

printf '# Reviewer guide\n' > "$SRC/docs/guide.md"
FAKE_BIN="$TMP_DIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gitleaks" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$TMPDIR/gitleaks.args"
case " $* " in
  *" --no-git "*) exit 0 ;;
  *) exit 1 ;;
esac
SH
cat > "$FAKE_BIN/trufflehog" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$TMPDIR/trufflehog.args"
case " $* " in
  *" --no-update "*) exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$FAKE_BIN/gitleaks" "$FAKE_BIN/trufflehog"

PATH="$FAKE_BIN:$PATH" TMPDIR="$TMP_DIR" "$ROOT_DIR/scripts/build-reviewer-mirror.sh" \
  --source "$SRC" \
  --staging "$STAGE" \
  --allowlist "$ALLOWLIST" \
  --dry-run >"$TMP_DIR/reviewer-mirror-scanned.out"

grep -q -- "--no-git" "$TMP_DIR/gitleaks.args" || fail "gitleaks was not run with --no-git"
grep -q -- "--no-update" "$TMP_DIR/trufflehog.args" || fail "trufflehog was not run with --no-update"

echo "reviewer mirror tests passed"
