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
mkdir -p "$TMP_DIR/docs/evidence"
: > "$TMP_DIR/docs/evidence/fixture.txt"

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28

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
[[ "$ERR" == *'"**Status:** prodution" is not one of production|production_ready|beta|demo_only|stub'* ]] \
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

# ---------- Half 3: claim classes, evidence levels, recipes, baseline ----------
#
# Added with the claim-class gate. These build a fixture root with its own
# package.json, workflow and mirror manifest so the recipe-execution check can
# be exercised without depending on the real repo's contents.

CARD_DIR="$TMP_DIR/docs/review/proof-cards"

write_pkg() { printf '%s\n' "{\"name\":\"fixture\",\"scripts\":{$1}}" > "$TMP_DIR/package.json"; }

write_workflow() {
  mkdir -p "$TMP_DIR/.github/workflows"
  {
    echo 'jobs:'
    echo '  test:'
    echo '    steps:'
    echo '      - name: step'
    echo '        run: |'
    printf '%s\n' "$1" | sed 's/^/          /'
  } > "$TMP_DIR/.github/workflows/ci-minimal.yml"
}

write_manifest() {
  mkdir -p "$TMP_DIR/scripts"
  printf '%s\n' "$1" > "$TMP_DIR/scripts/reviewer-mirror.test-manifest.json"
}

# A standalone (service-level) card with arbitrary claim lines.
write_claim_card() {
  local name="$1" status="$2" extra="$3"
  cat > "$CARD_DIR/$name" <<EOF
# Proof Card: Claim Fixture

**Status:** $status
**Last verified:** 2026-04-28 · git sha \`abc1234\`
$extra

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

reset_claims() {
  rm -f "$TMP_DIR/src/connectors/"*.ts
  rm -f "$CARD_DIR/"*.md
  rm -f "$TMP_DIR/.proof-card-threshold-baseline"
  write_pkg '"unit":"jest"'
  write_workflow 'npm run unit'
  write_manifest '{"additionalProbes":[],"auditRecipes":[]}'
}

DEPLOY_OK="**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/fixture.txt — 2026-04-28"

expect_claim_fail() {
  local label="$1" needle="$2"
  if run_audit OUT ERR; then fail "$label should exit non-zero"; fi
  [[ "$ERR" == *"$needle"* ]] || fail "$label: expected '$needle' -- err='$ERR'"
  echo "PASS: $label"
}

expect_claim_ok() {
  local label="$1"
  if ! run_audit OUT ERR; then fail "$label should exit 0 -- err=$ERR"; fi
  echo "PASS: $label"
}

# P: missing Claim class
reset_claims
write_claim_card "p.md" beta ""
expect_claim_fail "P missing claim class" 'missing or unknown "**Claim class:**"'

# Q: unknown Claim class
reset_claims
write_claim_card "q.md" beta "**Claim class:** wishful_thinking
**Evidence level:** rung 1 — official contract"
expect_claim_fail "Q unknown claim class" 'missing or unknown "**Claim class:**"'

# R: evidence label must match the rung
reset_claims
write_claim_card "r.md" beta "**Claim class:** deployment_operation
**Evidence level:** rung 1 — ERP sandbox"
expect_claim_fail "R wrong label for rung" 'label for rung 1 must be'

# S: connector_interoperability at production rung 2, not baselined -> fail
reset_claims
write_claim_card "s.md" production "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
expect_claim_fail "S connector production below rung 4" 'requires rung >= 4'

# T: the same card, baselined -> pass
printf '%s\n' 'docs/review/proof-cards/s.md' > "$TMP_DIR/.proof-card-threshold-baseline"
expect_claim_ok "T baselined threshold violation is tolerated"

# U: --init refuses to overwrite an existing baseline
set +e
node "$ROOT_DIR/scripts/audit-proof-cards.mjs" --root "$TMP_DIR" --init >"$TMP_DIR/i.out" 2>"$TMP_DIR/i.err"
INIT_STATUS=$?
set -e
[[ "$INIT_STATUS" -ne 0 ]] || fail "U --init should refuse when a baseline exists"
echo "PASS: U --init refuses when a baseline exists"

# V: --write drops an entry that no longer violates, and never adds one
reset_claims
write_claim_card "v.md" beta "**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract"
printf '%s\n' 'docs/review/proof-cards/gone.md' > "$TMP_DIR/.proof-card-threshold-baseline"
node "$ROOT_DIR/scripts/audit-proof-cards.mjs" --root "$TMP_DIR" --write >/dev/null 2>&1
if grep -q 'gone.md' "$TMP_DIR/.proof-card-threshold-baseline"; then
  fail "V --write kept an entry that no longer violates"
fi
[[ ! -s "$TMP_DIR/.proof-card-threshold-baseline" ]] || fail "V --write added entries"
echo "PASS: V --write shrinks and never adds"

# W: a service_behavior card with no recipe fails whatever its status.
#    beta is the regression case: threshold checks only apply to production, so
#    a status-gated implementation would let this through.
reset_claims
write_claim_card "w.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation"
expect_claim_fail "W service card without a recipe (beta)" 'requires "**Verification recipe:**'

# X: recipe naming an npm script that does not exist
reset_claims
write_claim_card "x.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** no-such-script"
expect_claim_fail "X recipe is neither script nor path" 'is neither an npm script nor an existing path'

# Y: npm script exists but nothing runs it
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
write_workflow 'npm run unit'
write_claim_card "y.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "Y npm script exists but is never run" 'is not run by any'

# Z: recipe appears only inside a YAML comment (js-yaml drops it)
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
mkdir -p "$TMP_DIR/.github/workflows"
cat > "$TMP_DIR/.github/workflows/ci-minimal.yml" <<'YEOF'
jobs:
  test:
    steps:
      # npm run orphan
      - name: step
        run: |
          npm run unit
YEOF
write_claim_card "z.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "Z recipe only in a YAML comment" 'is not run by any'

# AA: recipe appears only on a whole-line shell comment inside run: |
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
write_workflow '# npm run orphan
npm run unit'
write_claim_card "aa.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "AA recipe only on a whole-line shell comment" 'is not run by any'

# AB: Codex finding AC-05 -- recipe appears only in an INLINE shell comment.
#     This is the case a whole-line-only stripper accepts. It cannot be
#     demonstrated against the real workflow, which contains no inline comments
#     at all, so it is constructed here.
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
write_workflow 'npm run unit # npm run orphan'
write_claim_card "ab.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "AB AC-05 recipe only in an inline shell comment" 'is not run by any'

# AC: a path recipe must not be satisfied by a superstring
reset_claims
mkdir -p "$TMP_DIR/tests/unit"
: > "$TMP_DIR/tests/unit/a.test.ts"
write_workflow 'npx jest tests/unit/a.test.ts.bak'
write_claim_card "ac.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** tests/unit/a.test.ts"
expect_claim_fail "AC path recipe not satisfied by a superstring" 'is not run by any'

# AD: an npm recipe must not be satisfied by a longer script name
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
write_workflow 'npm run orphan-extra'
write_claim_card "ad.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "AD npm recipe not satisfied by a longer script name" 'is not run by any'

# AE: a recipe mentioned only in an unrelated manifest field does not count
reset_claims
mkdir -p "$TMP_DIR/tests/unit"
: > "$TMP_DIR/tests/unit/a.test.ts"
write_manifest '{"_comment":"tests/unit/a.test.ts","additionalProbes":[],"auditRecipes":[]}'
write_claim_card "ae.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** tests/unit/a.test.ts"
expect_claim_fail "AE recipe only in an unrelated manifest field" 'is not run by any'

# AF: a recipe listed in additionalProbes counts as executed
reset_claims
mkdir -p "$TMP_DIR/tests/unit"
: > "$TMP_DIR/tests/unit/a.test.ts"
write_manifest '{"additionalProbes":["tests/unit/a.test.ts"],"auditRecipes":[]}'
write_claim_card "af.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** tests/unit/a.test.ts"
expect_claim_ok "AF recipe registered in additionalProbes"

# AG: an npm recipe actually invoked by an uncommented line counts
reset_claims
write_pkg '"unit":"jest","real":"jest real"'
write_workflow 'npm run real'
write_claim_card "ag.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** real"
expect_claim_ok "AG npm recipe invoked by an uncommented line"

# AH: an evidence artifact that does not exist is a hard error
reset_claims
write_claim_card "ah.md" beta "**Claim class:** deployment_operation
**Evidence level:** rung 1 — official contract
**Evidence artifact:** docs/evidence/missing.txt — 2026-04-28"
expect_claim_fail "AH dangling evidence artifact" 'does not exist'


# AI: a step disabled with a literal-false `if` proves nothing (Codex finding).
reset_claims
write_pkg '"unit":"jest","orphan":"jest orphan"'
mkdir -p "$TMP_DIR/.github/workflows"
cat > "$TMP_DIR/.github/workflows/ci-minimal.yml" <<'YEOF'
jobs:
  test:
    steps:
      - name: disabled
        if: false
        run: npm run orphan
      - name: live
        run: npm run unit
YEOF
write_claim_card "ai.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** orphan"
expect_claim_fail "AI recipe only in an if:false step" 'is not run by any'

# AJ: additionalProbes as a STRING is not a list, so it cannot substring-match
#     (Codex finding). The mirror coerces non-arrays to [] and the audit must
#     agree with it rather than be looser.
reset_claims
mkdir -p "$TMP_DIR/tests/unit"
: > "$TMP_DIR/tests/unit/a.test.ts"
write_manifest '{"additionalProbes":"prefix-tests/unit/a.test.ts-suffix","auditRecipes":[]}'
write_claim_card "aj.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** tests/unit/a.test.ts"
expect_claim_fail "AJ additionalProbes as a string does not substring-match" 'is not run by any'

# AK: an npm script whose name carries a regex metacharacter must match itself
#     exactly and nothing else. This is the case that exposed the corrupted
#     escapeRe -- every earlier fixture name was metacharacter-free.
reset_claims
write_pkg '"test.unit":"jest"'
write_workflow 'npm run test.unit'
write_claim_card "ak.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** test.unit"
expect_claim_ok "AK metacharacter script name matches itself"
reset_claims
write_pkg '"test.unit":"jest"'
write_workflow 'npm run testXunit'
write_claim_card "ak2.md" beta "**Claim class:** service_behavior
**Evidence level:** rung 2 — contract fixtures and simulation
**Verification recipe:** test.unit"
expect_claim_fail "AK2 metacharacter is escaped, not a wildcard" 'is not run by any'

# ---- D4 (option B): production_ready threshold = rung >= 2 + the sentence ----
# AL: rung 2 with the Known Gaps sentence -> pass
reset_claims
write_claim_card "al.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/al.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- No live-credential evidence is on record: **no live evidence on record**.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_ok "AL production_ready at rung 2 with the sentence"

# AM: rung 2 WITHOUT the sentence -> the sentence is the claim; its absence fails
reset_claims
write_claim_card "am.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
expect_claim_fail "AM production_ready without the no-live-evidence sentence" 'requires Known Gaps to state'

# AN: rung 1 -> below the production_ready bar even with the sentence
reset_claims
write_claim_card "an.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 1 — official contract"
python - "$CARD_DIR/an.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- No live-credential evidence is on record: **no live evidence on record**.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AN production_ready at rung 1" 'requires rung >= 2'

# AO: production_ready is NOT held to the production bar (rung 4 + artifact)
#     -- that would make the relabel meaningless -- but IS a production-tier
#     card, so a missing recipe on a service card etc. still applies elsewhere.
reset_claims
write_claim_card "ao.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/ao.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- No live-credential evidence is on record: **no live evidence on record**.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
if run_audit OUT ERR; then :; else fail "AO production_ready must not require rung 4 + artifact -- err=$ERR"; fi
[[ "$ERR" != *"requires rung >= 4"* ]] || fail "AO production_ready wrongly held to the production bar"
echo "PASS: AO production_ready is not held to the production (rung 4 + artifact) bar"


# ---- F2 (Codex, D4): the sentence is a claim only as an affirmative template bullet
#      inside Known Gaps. Each evasion below satisfied the old substring check.
# AP: negated sentence -> FAIL
reset_claims
write_claim_card "ap.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/ap.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- It is not true that there is no live evidence on record.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AP negated sentence in Known Gaps" 'requires Known Gaps to state'

# AQ: the bullet in a LATER section, Known Gaps empty -> FAIL
reset_claims
write_claim_card "aq.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/aq.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\nnone currently identified\n\n## Verification\n\n- No live-credential evidence is on record.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AQ bullet only in a later section" 'requires Known Gaps to state'

# AR: the bullet inside a code fence -> FAIL
reset_claims
write_claim_card "ar.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/ar.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n```\n- No live-credential evidence is on record.\n```')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AR bullet inside a code fence" 'requires Known Gaps to state'

# AS: the bullet struck through -> FAIL
reset_claims
write_claim_card "as.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/as.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- No live-credential evidence is on record: ~~no live evidence on record~~.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AS bullet struck through" 'requires Known Gaps to state'

# AS2: a free-form bullet with the phrase but not the template form -> FAIL
reset_claims
write_claim_card "as2.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 2 — contract fixtures and simulation"
python - "$CARD_DIR/as2.md" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
s=s.replace('## Known Gaps\n\nnone currently identified','## Known Gaps\n\n- Readiness complete; **no live evidence on record**.')
io.open(p,'w',encoding='utf-8',newline='\n').write(s)
PY
expect_claim_fail "AS2 phrase without the template bullet" 'requires Known Gaps to state'

# ---- F3 (Codex, D4): --write / --init must not end green while a violation is live.
# AT: --write with an unbaselined live violation -> exit 1, file still written (empty)
reset_claims
write_claim_card "at.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 1 — official contract"
: > "$TMP_DIR/.proof-card-threshold-baseline"
set +e
node "$ROOT_DIR/scripts/audit-proof-cards.mjs" --root "$TMP_DIR" --write >"$TMP_DIR/w.out" 2>"$TMP_DIR/w.err"
WRITE_STATUS=$?
set -e
[[ "$WRITE_STATUS" -eq 1 ]] || fail "AT --write must exit 1 while an unbaselined violation is live (got $WRITE_STATUS)"
grep -q "not covered by .proof-card-threshold-baseline" "$TMP_DIR/w.err" || fail "AT --write did not name the live violation -- err=$(cat "$TMP_DIR/w.err")"
[[ ! -s "$TMP_DIR/.proof-card-threshold-baseline" ]] || fail "AT --write grew the baseline"
echo "PASS: AT --write exits 1 while a live violation is uncovered, and still never adds"

# AU: --init refuses to re-seed a baseline that git tracks but the worktree lacks -> exit 2
reset_claims
write_claim_card "au.md" production_ready "**Claim class:** connector_interoperability
**Evidence level:** rung 1 — official contract"
: > "$TMP_DIR/.proof-card-threshold-baseline"
( cd "$TMP_DIR" && git init -q . && git add .proof-card-threshold-baseline && git -c user.email=t@t -c user.name=t commit -q -m seed ) >/dev/null 2>&1
rm -f "$TMP_DIR/.proof-card-threshold-baseline"
set +e
node "$ROOT_DIR/scripts/audit-proof-cards.mjs" --root "$TMP_DIR" --init >"$TMP_DIR/i2.out" 2>"$TMP_DIR/i2.err"
INIT2_STATUS=$?
set -e
[[ "$INIT2_STATUS" -eq 2 ]] || fail "AU --init must refuse a tracked-but-deleted baseline (got $INIT2_STATUS)"
[[ ! -e "$TMP_DIR/.proof-card-threshold-baseline" ]] || fail "AU --init re-seeded the deleted baseline"
rm -rf "$TMP_DIR/.git"
echo "PASS: AU --init refuses to re-seed a git-tracked baseline that was deleted"

echo "audit-proof-cards claim-class regression tests passed"
