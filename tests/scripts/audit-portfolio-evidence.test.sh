#!/usr/bin/env bash
# Regression test for scripts/audit-portfolio-evidence.mjs (PR 22 / Phase 4).
#
# Two halves:
#  1. Real-repo smoke: run the audit against the live repo and assert it
#     exits 0 with the expected OK summary line. Asserts the literal card
#     count from the OK summary so a future card add/remove that forgets to
#     re-stamp the manifest is caught here. The expected count moves with
#     the card set — bump EXPECTED_REAL_CARD_COUNT when adding/removing
#     a card from docs/review/squire-product-cards/.
#  2. Synthetic scenario coverage: spin up tmpdir corpora via --root and
#     assert each drift class behaves correctly. 14 scenarios total (A–N):
#
#       A: canonical 2-card corpus + matching manifest     -> accept
#       B: card added on disk, manifest stale              -> reject
#       C: card removed from disk, manifest still has it   -> reject
#       D: card status (anchor field) drifted              -> reject
#       E: card recommended-path (anchor field) drifted    -> reject
#       F: card owner drifted (non-anchor field still gated)-> reject
#       G: committed manifest file missing                 -> reject
#       H: committed manifest is malformed JSON            -> reject
#       I: extra key on a committed card not in parser out -> reject
#          (closes the bidirectional-diff blind spot — PR 22 whole-PR
#          review STRONG-CONSIDER #1. A typo'd partial revert that leaves
#          an extraneous key in the manifest used to greenwash.)
#       J: card has multi-paragraph "What it does today"   -> reject
#          (parseCard fail-loud — silent concat would hide content from
#          the manifest, silent drop would hide it from the surface.
#          PR 22 review STRONG-CONSIDER #3.)
#       K: committed manifest is wrong-shape (array, not   -> reject
#          object — valid JSON but malformed schema)
#          (Copilot R2 finding — hand-edits to wrong shape used to
#          throw opaque TypeErrors from inside diffManifests.)
#       L: committed manifest missing required 'cards' key -> reject
#          (paired with K — clean error message instead of
#          `committed.cards.map is not a function`.)
#       M: committed manifest has `cards: null` (valid JSON,  -> reject
#          but typeof null === 'object', so a naive typeof
#          check would mislabel the type in the error message)
#          (Copilot R3 NIT — pinned to make the friendlier
#          error stick.)
#       N: committed manifest has two cards with the SAME slug -> reject
#          (Copilot R8 substantive — diffManifests is keyed by
#          slug, so without this check the second copy would
#          silently replace the first and the audit would pass
#          even though the surface would render duplicates wrong.)
#
# Pattern follows tests/scripts/audit-proof-cards.test.sh: invoke the real
# audit script with --root <tmpdir> so the script's relative
# import of `./lib/portfolio-evidence.mjs` resolves to the live code.

set -euo pipefail

# Pinned expected card count for the real-repo smoke. Bump when adding or
# removing a Squire product card under docs/review/squire-product-cards/.
# Holds the smoke test honest if a future commit silently changes the
# count.
EXPECTED_REAL_CARD_COUNT=6

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------- Half 1: real-repo smoke ----------

REAL_OUT="$TMP_DIR/real.out"
REAL_ERR="$TMP_DIR/real.err"
if ! node "$ROOT_DIR/scripts/audit-portfolio-evidence.mjs" >"$REAL_OUT" 2>"$REAL_ERR"; then
  cat "$REAL_OUT" "$REAL_ERR" >&2
  fail "audit-portfolio-evidence should pass on the live repo (PR 22 cards)"
fi
grep -Fq "audit-portfolio-evidence: OK ($EXPECTED_REAL_CARD_COUNT cards in sync with public/portfolio-evidence.json)" "$REAL_OUT" \
  || fail "real-repo smoke: expected exactly $EXPECTED_REAL_CARD_COUNT cards -- got '$(cat "$REAL_OUT")'"

# ---------- Half 2: synthetic scenario coverage ----------

mkdir -p "$TMP_DIR/docs/review/squire-product-cards"
mkdir -p "$TMP_DIR/public"

# valid_card writes a minimally-conforming card. $1 = slug, $2 = name,
# $3 = owner, $4 = status, $5 = recommended-path tail.
valid_card() {
  local slug="$1" name="$2" owner="$3" status="$4" rec="$5"
  cat > "$TMP_DIR/docs/review/squire-product-cards/$slug.md" <<EOF
# Squire Product Card: $name

**Owner:** $owner
**Squire-side status:** $status
**Last reviewed:** 2026-05-22 · git sha \`abc1234\`

## What it does today

$name does the thing.

## Repo evidence

Some evidence.

## Recommended path today

**Recommended path today:** $rec
EOF
}

# rebuild_manifest re-runs the builder against the tmpdir so the manifest
# matches the current card set. Use this BEFORE introducing drift, so the
# baseline is in sync and the drift introduced by the test is the only delta.
rebuild_manifest() {
  node "$ROOT_DIR/scripts/build-portfolio-evidence-manifest.mjs" --root "$TMP_DIR" >/dev/null 2>&1 \
    || fail "rebuild_manifest helper failed"
}

run_audit() {
  local out_var="$1" err_var="$2"
  local out err status
  out="$TMP_DIR/scenario.out"
  err="$TMP_DIR/scenario.err"
  : >"$out"; : >"$err"
  set +e
  node "$ROOT_DIR/scripts/audit-portfolio-evidence.mjs" --root "$TMP_DIR" >"$out" 2>"$err"
  status=$?
  set -e
  printf -v "$out_var" '%s' "$(cat "$out")"
  printf -v "$err_var" '%s' "$(cat "$err")"
  return $status
}

reset_tmp() {
  rm -f "$TMP_DIR/docs/review/squire-product-cards/"*.md
  rm -f "$TMP_DIR/public/portfolio-evidence.json"
}

# Scenario A: canonical state -> accept
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
valid_card "two" "ProductTwo" "Owner Two" "Built first" "**Insufficient evidence.**"
rebuild_manifest
if ! run_audit OUT ERR; then
  fail "scenario A (canonical) should exit 0 -- err=$ERR"
fi
[[ "$OUT" == *"audit-portfolio-evidence: OK (2 cards in sync with public/portfolio-evidence.json)"* ]] \
  || fail "scenario A: unexpected OK summary -- got '$OUT'"

# Scenario B: card added on disk, manifest stale -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
valid_card "two" "ProductTwo" "Owner Two" "Built first" "**Insufficient evidence.**"
if run_audit OUT ERR; then
  fail "scenario B (card added) should exit non-zero"
fi
[[ "$ERR" == *"card added or renamed: 'two'"* ]] \
  || fail "scenario B: add error not surfaced -- err='$ERR'"

# Scenario C: card removed from disk, manifest stale -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
valid_card "two" "ProductTwo" "Owner Two" "Built first" "**Insufficient evidence.**"
rebuild_manifest
rm "$TMP_DIR/docs/review/squire-product-cards/two.md"
if run_audit OUT ERR; then
  fail "scenario C (card removed) should exit non-zero"
fi
[[ "$ERR" == *"card removed or renamed: 'two'"* ]] \
  || fail "scenario C: removal error not surfaced -- err='$ERR'"

# Scenario D: status anchor field drifted -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
valid_card "one" "ProductOne" "Owner One" "Now in beta" "**Integrate** — first slice."
if run_audit OUT ERR; then
  fail "scenario D (status drifted) should exit non-zero"
fi
[[ "$ERR" == *"one.status drifted"* ]] \
  || fail "scenario D: status-drift error not surfaced -- err='$ERR'"

# Scenario E: recommendedPath anchor field drifted -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Replace** — total rebuild."
if run_audit OUT ERR; then
  fail "scenario E (recommendedPath drifted) should exit non-zero"
fi
[[ "$ERR" == *"one.recommendedPath drifted"* ]] \
  || fail "scenario E: recommendedPath-drift error not surfaced -- err='$ERR'"

# Scenario F: owner (non-anchor field) drifted -> still reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
valid_card "one" "ProductOne" "Different Owner" "Sold to clients" "**Integrate** — first slice."
if run_audit OUT ERR; then
  fail "scenario F (owner drifted) should exit non-zero"
fi
[[ "$ERR" == *"one.owner drifted"* ]] \
  || fail "scenario F: owner-drift error not surfaced -- err='$ERR'"

# Scenario G: committed manifest missing -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
# intentionally do NOT rebuild — manifest absent
if run_audit OUT ERR; then
  fail "scenario G (manifest missing) should exit non-zero"
fi
[[ "$ERR" == *"committed manifest missing at public/portfolio-evidence.json"* ]] \
  || fail "scenario G: missing-manifest error not surfaced -- err='$ERR'"

# Scenario H: committed manifest is malformed JSON -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
echo '{ not: valid' > "$TMP_DIR/public/portfolio-evidence.json"
if run_audit OUT ERR; then
  fail "scenario H (manifest malformed) should exit non-zero"
fi
[[ "$ERR" == *"committed manifest is not valid JSON"* ]] \
  || fail "scenario H: malformed-JSON error not surfaced -- err='$ERR'"

# Scenario I: extra key on a committed card not in parser output -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
rebuild_manifest
# Inject an extraneous key into the committed manifest.
node -e "const fs=require('fs'); const p='$TMP_DIR/public/portfolio-evidence.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.cards[0].extraneousKey='leftover from partial revert'; fs.writeFileSync(p, JSON.stringify(m,null,2)+'\n');"
if run_audit OUT ERR; then
  fail "scenario I (extra committed key) should exit non-zero"
fi
[[ "$ERR" == *"one.extraneousKey drifted"* ]] \
  || fail "scenario I: extra-key error not surfaced -- err='$ERR'"

# Scenario J: card has multi-paragraph "What it does today" -> reject
reset_tmp
cat > "$TMP_DIR/docs/review/squire-product-cards/multi.md" <<'EOF'
# Squire Product Card: MultiPara

**Owner:** Owner
**Squire-side status:** Sold to clients
**Last reviewed:** 2026-05-22 · git sha `abc1234`

## What it does today

First paragraph here.

Second paragraph that should not be permitted under the authoring rules.

## Repo evidence

text

## Recommended path today

**Recommended path today:** **Integrate**.
EOF
# Audit short-circuits at parse time before consulting the manifest, so
# write a syntactically-valid placeholder manifest to prove the rejection
# isn't masquerading as a manifest-missing error.
echo '{"generatedFrom":"x","cardCount":0,"cards":[]}' > "$TMP_DIR/public/portfolio-evidence.json"
if run_audit OUT ERR; then
  fail "scenario J (multi-paragraph What-it-does) should exit non-zero"
fi
[[ "$ERR" == *"must be a single paragraph"* ]] \
  || fail "scenario J: multi-paragraph error not surfaced -- err='$ERR'"

# Scenario K: committed manifest is wrong-shape (JSON array, not object) -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
echo '[]' > "$TMP_DIR/public/portfolio-evidence.json"
if run_audit OUT ERR; then
  fail "scenario K (manifest is array, not object) should exit non-zero"
fi
[[ "$ERR" == *"expected an object, got array"* ]] \
  || fail "scenario K: array-shape error not surfaced -- err='$ERR'"

# Scenario L: committed manifest missing required 'cards' key -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
echo '{"generatedFrom":"x","cardCount":0}' > "$TMP_DIR/public/portfolio-evidence.json"
if run_audit OUT ERR; then
  fail "scenario L (manifest missing cards) should exit non-zero"
fi
[[ "$ERR" == *"missing required top-level field 'cards'"* ]] \
  || fail "scenario L: missing-cards error not surfaced -- err='$ERR'"

# Scenario M: committed manifest has `cards: null` -> reject with "got null"
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
echo '{"generatedFrom":"x","cardCount":0,"cards":null}' > "$TMP_DIR/public/portfolio-evidence.json"
if run_audit OUT ERR; then
  fail "scenario M (cards: null) should exit non-zero"
fi
[[ "$ERR" == *"top-level 'cards' must be an array, got null"* ]] \
  || fail "scenario M: null-cards error message did not say 'got null' -- err='$ERR'"

# Scenario N: committed manifest has duplicate slugs -> reject
reset_tmp
valid_card "one" "ProductOne" "Owner One" "Sold to clients" "**Integrate** — first slice."
# Manifest with two cards.slug='one' (hand-paste mistake)
cat > "$TMP_DIR/public/portfolio-evidence.json" <<'JSON'
{
  "generatedFrom": "docs/review/squire-product-cards/",
  "cardCount": 2,
  "cards": [
    {"slug": "one", "productName": "First Copy"},
    {"slug": "one", "productName": "Second Copy"}
  ]
}
JSON
if run_audit OUT ERR; then
  fail "scenario N (duplicate slugs) should exit non-zero"
fi
[[ "$ERR" == *"duplicates slug 'one'"* ]] \
  || fail "scenario N: duplicate-slug error not surfaced -- err='$ERR'"

echo "audit-portfolio-evidence test: PASS (real-repo smoke + 14 synthetic scenarios A–N)"
