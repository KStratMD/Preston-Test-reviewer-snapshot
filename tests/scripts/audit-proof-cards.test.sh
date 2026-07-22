#!/usr/bin/env bash
# Regression test for scripts/audit-proof-cards.mjs.
#
# Two halves:
#  1. Real-repo smoke: run the script against the live repo and assert it
#     exits 0 with the expected count line. Pins Phase 4's initial card set
#     so a future card removal that forgets to update connector tags will
#     be caught here before CI.
#  2. Synthetic scenario coverage: spin up temp connector + card files via
#     --root and assert each branch behaves as expected. 14 scenarios total
#     (A–N) — 11 reject (failure paths) + 3 accept (positive controls).
#     Positive controls are deliberately interleaved so a future change
#     that over-tightens validation breaks one of them, not just the smoke.
#
#       A: valid production+card+all sections                  -> accept
#       B: production connector with no proofCard              -> reject
#       C: proofCard string but file missing                   -> reject
#       D: card missing "# Proof Card:" heading                -> reject
#       E: card missing "**Status:**" line                     -> reject
#       F: card missing "**Last verified:**" line              -> reject
#       G: card missing a required ## section                  -> reject
#       H: card Status mismatches connector tag                -> reject
#       I: section heading with trailing descriptive text      -> accept
#          (e.g. "## Verification (60-second AI-reviewer recipe)")
#       J: directory walk catches malformed service-level card -> reject
#       K: _template.md is excluded from directory walk        -> accept
#       L: card Status value is not in the enum (typo)         -> reject
#          (Codex review on PR #693 — the previous `[a-z_]+` regex
#          accepted any lowercase token, so service-level cards with
#          `**Status:** prodution` slipped through.)
#       M: connector points proofCard at _template.md          -> reject
#          (Copilot review on PR #693 — the template's
#          `**Status:** production | beta | ...` line could match
#          `production` via a leading-token shortcut. Two-layer defense:
#          end-of-line anchor on the regex AND explicit _template.md
#          rejection at the path-shape stage.)
#       N: connector proofCard outside docs/review/proof-cards/ -> reject
#          (Copilot review on PR #693 — audit-proof-cards used to rely on
#          audit-status-claims for path-shape checks, but the two scripts
#          are documented as standing alone in CI. Path-shape rules now
#          duplicated here.)
#
# Pattern follows tests/scripts/audit-status-claims.test.sh: invoke the
# *real* script with --root <tmpdir> rather than copying it (which would
# break the relative import of `./lib/connector-scan.mjs`).

set -euo pipefail

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
if ! node "$ROOT_DIR/scripts/audit-proof-cards.mjs" >"$REAL_OUT" 2>"$REAL_ERR"; then
  cat "$REAL_OUT" "$REAL_ERR" >&2
  fail "audit-proof-cards should pass on the live repo (Phase 4 cards)"
fi
grep -Eq "audit-proof-cards: OK \([0-9]+ connector-tagged \+ [0-9]+ service-level cards verified\)" "$REAL_OUT" \
  || fail "audit-proof-cards did not print the expected OK line on the live repo (got: $(cat "$REAL_OUT"))"

# ---------- Half 2: synthetic failure coverage ----------

mkdir -p "$TMP_DIR/src/connectors"
mkdir -p "$TMP_DIR/docs/review/proof-cards"

write_connector() {
  local file="$1"
  local body="$2"
  cat > "$TMP_DIR/src/connectors/$file" <<EOF
export class TestConnector {
$body
}
EOF
}

write_card() {
  local name="$1"
  local body="$2"
  cat > "$TMP_DIR/docs/review/proof-cards/$name" <<EOF
$body
EOF
}

valid_card_body() {
  local status="$1" name="${2:-Test}"
  cat <<EOF
# Proof Card: $name

**Status:** $status
**Last verified:** 2026-04-28 · git sha \`abc1234\`

## Claim

A real claim.

## Source

- Implementation: \`src/test.ts:1-10\`

## Tests

- Unit: \`tests/test.ts\`

## Live vs Fixture

- Real HTTP wired? **Yes**

## Known Gaps

none currently identified

## Verification

\`\`\`bash
npm test
\`\`\`
EOF
}

run_audit() {
  local out_var="$1" err_var="$2"
  local out err status
  out="$TMP_DIR/scenario.out"
  err="$TMP_DIR/scenario.err"
  : >"$out"; : >"$err"
  set +e
  node "$ROOT_DIR/scripts/audit-proof-cards.mjs" --root "$TMP_DIR" >"$out" 2>"$err"
  status=$?
  set -e
  printf -v "$out_var" '%s' "$(cat "$out")"
  printf -v "$err_var" '%s' "$(cat "$err")"
  return $status
}

reset_tmp() {
  rm -f "$TMP_DIR/src/connectors/"*.ts
  rm -f "$TMP_DIR/docs/review/proof-cards/"*.md
}

# Scenario A: valid production connector with valid card -> OK
reset_tmp
write_connector "AlphaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'real';
  static readonly proofCard = 'docs/review/proof-cards/alpha.md';"
write_card "alpha.md" "$(valid_card_body production Alpha)"
if ! run_audit OUT ERR; then
  fail "scenario A (valid card) should exit 0 -- err=$ERR"
fi
[[ "$OUT" == *"audit-proof-cards: OK (1 connector-tagged + 0 service-level cards verified)"* ]] \
  || fail "scenario A: unexpected OK summary -- got '$OUT'"

# Scenario B: production connector without proofCard -> reject
reset_tmp
write_connector "BetaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'no card';"
if run_audit OUT ERR; then
  fail "scenario B (production missing proofCard) should exit non-zero"
fi
[[ "$ERR" == *"requires a static proofCard"* ]] \
  || fail "scenario B: missing-proofCard error not surfaced -- err='$ERR'"

# Scenario C: proofCard string set but file missing -> reject
reset_tmp
write_connector "GammaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'has tag, no file';
  static readonly proofCard = 'docs/review/proof-cards/gamma.md';"
# (no card file written)
if run_audit OUT ERR; then
  fail "scenario C (proofCard file missing) should exit non-zero"
fi
[[ "$ERR" == *"proofCard file missing at docs/review/proof-cards/gamma.md"* ]] \
  || fail "scenario C: missing-file error not surfaced -- err='$ERR'"

# Scenario D: card missing "# Proof Card:" heading -> reject
reset_tmp
write_connector "DeltaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'wrong heading';
  static readonly proofCard = 'docs/review/proof-cards/delta.md';"
write_card "delta.md" "# Just a regular header

**Status:** production
**Last verified:** 2026-04-28

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification
text"
if run_audit OUT ERR; then
  fail "scenario D (card missing # Proof Card heading) should exit non-zero"
fi
[[ "$ERR" == *"missing level-1 heading"* ]] \
  || fail "scenario D: missing-heading error not surfaced -- err='$ERR'"

# Scenario E: card missing "**Status:**" line -> reject
reset_tmp
write_connector "EpsilonConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'no status';
  static readonly proofCard = 'docs/review/proof-cards/epsilon.md';"
write_card "epsilon.md" "# Proof Card: Epsilon

**Last verified:** 2026-04-28

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification
text"
if run_audit OUT ERR; then
  fail "scenario E (card missing Status line) should exit non-zero"
fi
[[ "$ERR" == *'missing "**Status:**" line'* ]] \
  || fail "scenario E: missing-Status error not surfaced -- err='$ERR'"

# Scenario F: card missing "**Last verified:**" line -> reject
reset_tmp
write_connector "ZetaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'no lastverified';
  static readonly proofCard = 'docs/review/proof-cards/zeta.md';"
write_card "zeta.md" "# Proof Card: Zeta

**Status:** production

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification
text"
if run_audit OUT ERR; then
  fail "scenario F (card missing Last verified line) should exit non-zero"
fi
[[ "$ERR" == *'missing "**Last verified:**" line'* ]] \
  || fail "scenario F: missing-Last-verified error not surfaced -- err='$ERR'"

# Scenario G: card missing a required ## section -> reject
reset_tmp
write_connector "EtaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'no source section';
  static readonly proofCard = 'docs/review/proof-cards/eta.md';"
write_card "eta.md" "# Proof Card: Eta

**Status:** production
**Last verified:** 2026-04-28

## Claim
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification
text"
if run_audit OUT ERR; then
  fail "scenario G (card missing ## Source) should exit non-zero"
fi
[[ "$ERR" == *'missing required section "## Source"'* ]] \
  || fail "scenario G: missing-section error not surfaced -- err='$ERR'"

# Scenario H: card Status mismatches connector productionStatus -> reject
reset_tmp
write_connector "ThetaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'mismatch';
  static readonly proofCard = 'docs/review/proof-cards/theta.md';"
write_card "theta.md" "$(valid_card_body beta Theta)"
if run_audit OUT ERR; then
  fail "scenario H (card Status mismatch) should exit non-zero"
fi
[[ "$ERR" == *"declares Status: beta but source-level productionStatus is 'production'"* ]] \
  || fail "scenario H: status-mismatch error not surfaced -- err='$ERR'"

# Scenario I: section heading with trailing descriptive text -> accept
# This is the regression test for the regex tweak that was needed when the
# initial cards used "## Verification (60-second AI-reviewer recipe)".
reset_tmp
write_connector "IotaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'trailing text';
  static readonly proofCard = 'docs/review/proof-cards/iota.md';"
write_card "iota.md" "# Proof Card: Iota

**Status:** production
**Last verified:** 2026-04-28

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification (60-second AI-reviewer recipe)
\`\`\`bash
npm test
\`\`\`"
if ! run_audit OUT ERR; then
  fail "scenario I (## Verification with trailing text) should exit 0 -- err=$ERR"
fi

# Scenario J: directory walk catches a malformed service-level card.
# A card sits on disk with no connector referencing it (the "service-level"
# pattern); audit-proof-cards walks the directory and validates structure.
reset_tmp
write_connector "KappaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'tagged ok';
  static readonly proofCard = 'docs/review/proof-cards/kappa.md';"
write_card "kappa.md" "$(valid_card_body production Kappa)"
# Add a malformed service-level card with no connector counterpart
write_card "service-level-broken.md" "# Proof Card: Service-Level

**Status:** production
**Last verified:** 2026-04-28

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text"
# (deliberately missing ## Verification section)
if run_audit OUT ERR; then
  fail "scenario J (malformed service-level card on disk) should exit non-zero"
fi
[[ "$ERR" == *"service-level-broken.md: missing required section \"## Verification\""* ]] \
  || fail "scenario J: directory-walk validation not surfaced -- err='$ERR'"

# Scenario K: _template.md is excluded from the directory walk.
# The authoring template intentionally has placeholder Status that doesn't
# pick a single value; auditing it would always fail. Confirm the audit
# passes when only a tagged card + the template are present.
reset_tmp
write_connector "LambdaConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'with template';
  static readonly proofCard = 'docs/review/proof-cards/lambda.md';"
write_card "lambda.md" "$(valid_card_body production Lambda)"
write_card "_template.md" "# Proof Card: <Component Name>

**Status:** production | beta | demo_only | stub
**Last verified:** YYYY-MM-DD

(intentionally missing required sections — placeholder template body)"
if ! run_audit OUT ERR; then
  fail "scenario K (_template.md should be excluded from directory walk) should exit 0 -- err='$ERR'"
fi
[[ "$OUT" == *"audit-proof-cards: OK (1 connector-tagged + 0 service-level cards verified)"* ]] \
  || fail "scenario K: _template.md leaked into service-level count -- got '$OUT'"

# Scenario L: card "**Status:**" value is outside the documented enum.
# Service-level card with a typo like `prodution` must be rejected. The
# previous regex `[a-z_]+` accepted any lowercase token; this scenario
# pins the tightened enum check (Codex review on PR #693).
reset_tmp
# Service-level card only — no connector counterpart, so the enum check
# is the only line of defense.
write_card "service-typo.md" "# Proof Card: Service-Typo

**Status:** prodution
**Last verified:** 2026-04-28

## Claim
text
## Source
text
## Tests
text
## Live vs Fixture
text
## Known Gaps
text
## Verification
text"
if run_audit OUT ERR; then
  fail "scenario L (service-level card with typo'd Status value) should exit non-zero"
fi
[[ "$ERR" == *'"**Status:** prodution" is not one of production|beta|demo_only|stub'* ]] \
  || fail "scenario L: enum-violation error not surfaced -- err='$ERR'"

# Scenario M: connector points proofCard at _template.md.
# The template's "**Status:** production | beta | demo_only | stub" line
# could match `production` via a leading-token regex shortcut. We block
# this two ways: (1) the end-of-line anchor on extractCardStatus rejects
# the multi-token tail, and (2) we explicitly reject _template.md at the
# path-shape stage (this scenario pins the path-shape rejection path).
reset_tmp
write_connector "MuConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'points at template';
  static readonly proofCard = 'docs/review/proof-cards/_template.md';"
write_card "_template.md" "# Proof Card: <Component Name>

**Status:** production | beta | demo_only | stub
**Last verified:** YYYY-MM-DD

(intentionally missing required sections)"
if run_audit OUT ERR; then
  fail "scenario M (connector points proofCard at _template.md) should exit non-zero"
fi
[[ "$ERR" == *"proofCard cannot point at '_template.md'"* ]] \
  || fail "scenario M: template-as-target error not surfaced -- err='$ERR'"

# Scenario N: connector proofCard outside docs/review/proof-cards/.
# Mirrors audit-status-claims scenario E. audit-proof-cards now applies
# its own path-shape gate so it stands alone in CI.
reset_tmp
write_connector "NuConnector.ts" "  static readonly productionStatus = 'production' as const;
  static readonly statusEvidence = 'wrong dir';
  static readonly proofCard = 'docs/other/nu.md';"
if run_audit OUT ERR; then
  fail "scenario N (connector proofCard outside dir) should exit non-zero"
fi
[[ "$ERR" == *"must live under docs/review/proof-cards/"* ]] \
  || fail "scenario N: outside-dir error not surfaced -- err='$ERR'"

echo "audit-proof-cards tool tests passed"
