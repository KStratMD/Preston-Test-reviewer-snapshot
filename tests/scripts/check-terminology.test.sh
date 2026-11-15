#!/usr/bin/env bash
# Regression harness for scripts/check-terminology.mjs (tranche-1 D5).
#
# Every scenario asserts an EXIT CODE (0 clean, 1 hit, 2 environment/usage
# error) and, where the contract is about WHICH files are scanned, the
# `--list` output. The contract under test: regulated-medical vocabulary in
# prose fails; fenced code, inline code and HTML comments are not prose; a
# file opts in only through front matter at the very start of the file,
# whether its line endings are LF or CRLF; an exemption needs a reason.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${CHECK_TERMINOLOGY_SCRIPT:-$ROOT_DIR/scripts/check-terminology.mjs}" # override lets a mutation probe point at a mutant copy
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAILURES=0

run_gate() { node "$SCRIPT" --root "$1" "${@:2}" >"$TMP_DIR/out.txt" 2>&1; echo $?; }
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then echo "PASS: $label (exit $got)"; else
    echo "FAIL: $label — expected exit $want, got $got"; sed 's/^/      /' "$TMP_DIR/out.txt" | tail -6; FAILURES=$((FAILURES + 1)); fi
}
expect_out() { # $1 label, $2 grep -E pattern expected in the last output
  if grep -qE "$2" "$TMP_DIR/out.txt"; then echo "PASS: $1"; else
    echo "FAIL: $1 — output lacks /$2/"; sed 's/^/      /' "$TMP_DIR/out.txt" | tail -6; FAILURES=$((FAILURES + 1)); fi
}
expect_no_out() {
  if ! grep -qE "$2" "$TMP_DIR/out.txt"; then echo "PASS: $1"; else
    echo "FAIL: $1 — output unexpectedly matches /$2/"; sed 's/^/      /' "$TMP_DIR/out.txt" | tail -6; FAILURES=$((FAILURES + 1)); fi
}
fresh_root() { # $1 name -> prints a root with the three fixed directories present and empty
  local r="$TMP_DIR/$1"; mkdir -p "$r/docs/superpowers/specs" "$r/docs/superpowers/plans" "$r/docs/blueprint" "$r/docs/guides"
  echo "$r"
}
SPEC="docs/superpowers/specs/2026-09-02-example.md"

# ---- 1. real repo passes --------------------------------------------------------------
if node "$SCRIPT" >"$TMP_DIR/real.out" 2>&1; then echo "PASS: real repo (exit 0)"; else
  echo "FAIL: real repo should pass"; sed 's/^/      /' "$TMP_DIR/real.out"; FAILURES=$((FAILURES + 1)); fi
grep -qE '^\[terminology\] OK \([0-9]+ files in scope\)$' "$TMP_DIR/real.out" || { echo "FAIL: real repo OK line malformed"; FAILURES=$((FAILURES + 1)); }

# ---- 2. empty scope -------------------------------------------------------------------
R=$(fresh_root a)
expect_exit "empty scope passes" 0 "$(run_gate "$R")"
expect_out "empty scope reports 0 files" '^\[terminology\] OK \(0 files in scope\)$'
expect_exit "--list on an empty scope" 0 "$(run_gate "$R" --list)"
[ ! -s "$TMP_DIR/out.txt" ] || { echo "FAIL: --list printed files for an empty scope"; FAILURES=$((FAILURES + 1)); }

# ---- 3. each banned phrase in prose blocks; the message names file, line and phrase --------
for probe in "Built for patients first." "A patient-facing portal." "HIPAA controls apply." "PHI is stored here." "A clinical workflow." "Healthcare billing."; do
  printf '# Title\n\nSome prose.\n%s\n' "$probe" > "$R/$SPEC"
  expect_exit "prose hit blocks: $probe" 1 "$(run_gate "$R")"
done
expect_out "message names file:line and the phrase" "^  - $SPEC:4: healthcare: Healthcare billing\."
expect_out "message counts hits" '^\[terminology\] FAIL \(1\):'

# ---- 4. word boundaries and case: what is NOT a hit --------------------------------------
for ok in "An outpatient count." "The impatient user." "The phi coefficient." "hipaa in lowercase is a different token." "EHR means Effective Hourly Rate." "The payer of record." "Subclinical is not the banned token."; do
  printf '# Title\n\n%s\n' "$ok" > "$R/$SPEC"
  expect_exit "not a hit: $ok" 0 "$(run_gate "$R")"
done
printf '# Title\n\nSeen by patients.\n' > "$R/$SPEC"
expect_exit "plural before punctuation is a hit" 1 "$(run_gate "$R")"
printf '# Title\n\nSeen by PATIENTS.\n' > "$R/$SPEC"
expect_exit "case-insensitive for the word list" 1 "$(run_gate "$R")"

# ---- 5. fenced code, inline code and comments are not prose --------------------------------
printf '# Title\n\n```js\nconst banned = /patients?/;\n```\n\nClean prose.\n' > "$R/$SPEC"
expect_exit "backtick fence is skipped" 0 "$(run_gate "$R")"
printf '# Title\n\n~~~\npatients\n~~~\n' > "$R/$SPEC"
expect_exit "tilde fence is skipped" 0 "$(run_gate "$R")"
printf '# Title\n\n```\npatients\n~~~\nstill fenced: patients\n```\nProse after the fence with patients.\n' > "$R/$SPEC"
expect_exit "a fence closes only on its own marker; prose after it counts" 1 "$(run_gate "$R")"
expect_out "the hit is the line after the fence" "$SPEC:8: patient"
printf '# Title\n\n```\nunterminated fence, patients to EOF\n' > "$R/$SPEC"
expect_exit "an unterminated fence runs to EOF" 0 "$(run_gate "$R")"
printf '# Title\n\nThe regex `\\bpatients?\\b` and `` a`HIPAA`b `` are code.\n' > "$R/$SPEC"
expect_exit "inline code spans are skipped (single and double backtick)" 0 "$(run_gate "$R")"
printf '# Title\n\nThe word `x` and then patients in prose.\n' > "$R/$SPEC"
expect_exit "prose outside a span on the same line still counts" 1 "$(run_gate "$R")"
printf '# Title\n\n<!-- patients are mentioned in a comment -->\nClean.\n' > "$R/$SPEC"
expect_exit "single-line HTML comment is skipped" 0 "$(run_gate "$R")"
printf '# Title\n\n<!-- a comment\nspanning lines with patients\nends here --> then healthcare in prose\n' > "$R/$SPEC"
expect_exit "multi-line comment is skipped but prose after its close counts" 1 "$(run_gate "$R")"
expect_out "the post-comment hit is reported once, as healthcare" "$SPEC:5: healthcare:"
expect_no_out "the in-comment word is not reported" "$SPEC:4:"

# ---- 5b. Codex round-1 tokenizer findings: fences, spans and comments resolve as CommonMark does --
printf '# Title\n\n<!--\n```\n-->\npatients in prose after the comment.\n' > "$R/$SPEC"
expect_exit "a fence marker inside an HTML comment does not open a fence" 1 "$(run_gate "$R")"
printf '# Title\n\n```js`bad\npatients in prose: the opener above is invalid (backtick in its info string).\n' > "$R/$SPEC"
expect_exit "a backtick fence opener with a backtick in the info string is not a fence" 1 "$(run_gate "$R")"
printf '# Title\n\n~~~js`ok\npatients\n~~~\n' > "$R/$SPEC"
expect_exit "a tilde fence may carry a backtick in its info string" 0 "$(run_gate "$R")"
printf '# Title\n\n`````\n```\npatients still fenced\n`````\n' > "$R/$SPEC"
expect_exit "a shorter run does not close a longer fence" 0 "$(run_gate "$R")"
printf '# Title\n\n```\npatients\n````\nprose with patients after a longer close\n' > "$R/$SPEC"
expect_exit "a longer run closes a shorter fence" 1 "$(run_gate "$R")"
expect_out "the post-close line is the hit" "$SPEC:6: patient"
printf '# Title\n\n```\npatients\n``` trailing text\nstill fenced patients\n' > "$R/$SPEC"
expect_exit "a close with trailing text is not a close" 0 "$(run_gate "$R")"
printf '# Title\n\nSeen `patients`` in prose.\n' > "$R/$SPEC"
expect_exit "a longer backtick run does not close a shorter code span" 1 "$(run_gate "$R")"
printf '# Title\n\nThe token `<!--` patients in prose.\n' > "$R/$SPEC"
expect_exit "a comment opener inside a code span is code, not a comment" 1 "$(run_gate "$R")"
printf '# Title\n\n<!-- a `backtick` in a comment --> patients in prose.\n' > "$R/$SPEC"
expect_exit "a backtick inside a comment is comment; prose after it counts" 1 "$(run_gate "$R")"
printf '# Title\n\npatients `<!-- terminology-allow: code sample -->`\n' > "$R/$SPEC"
expect_exit "an exemption marker shown inside inline code exempts nothing" 1 "$(run_gate "$R")"

# ---- 5b2. Codex round-2 findings: tab-indented opener, escapes, empty comments ------------------
printf '# Title\n\n\t```js\npatients visible after a tab-indented line, which is indented code, not a fence.\n' > "$R/$SPEC"
expect_exit "a tab-indented backtick run is not a fence opener" 1 "$(run_gate "$R")"
printf '# Title\n\n   ```\npatients fenced by a three-space-indented opener\n```\n' > "$R/$SPEC"
expect_exit "up to three spaces of indentation still open a fence" 0 "$(run_gate "$R")"
printf '# Title\n\n\\`patients\\` rendered with literal backticks.\n' > "$R/$SPEC"
expect_exit "backslash-escaped backticks are literal text, not a code span" 1 "$(run_gate "$R")"
printf '# Title\n\n\\<!-- patients --> rendered as visible text.\n' > "$R/$SPEC"
expect_exit "a backslash-escaped comment opener is literal text" 1 "$(run_gate "$R")"
printf '# Title\n\n<!--> patients visible after an empty comment.\n' > "$R/$SPEC"
expect_exit "<!--> is a complete empty comment; prose after it counts" 1 "$(run_gate "$R")"
printf '# Title\n\n<!---> patients visible after an empty comment.\n' > "$R/$SPEC"
expect_exit "<!---> is a complete empty comment; prose after it counts" 1 "$(run_gate "$R")"
printf '# Title\n\n<!--> patients on the opener line\nlater line with a close -->\n' > "$R/$SPEC"
expect_exit "an empty comment closes at once even when a later line carries a close" 1 "$(run_gate "$R")"
printf '# Title\n\nSeen by pa\\*tient\\*s: escaped asterisks are literal, so this is not the word.\n' > "$R/$SPEC"
expect_exit "escaped emphasis markers stay literal and split the word" 0 "$(run_gate "$R")"

# ---- 5b3. Codex round-3 findings: escapes are prose-only; unclosed inline comments are text ------
printf '# Title\n\n`safe\\` patients `\n' > "$R/$SPEC"
expect_exit "a backslash inside a code span is literal, so the span closes and the prose after it counts" 1 "$(run_gate "$R")"
printf '# Title\n\n<!-- safe \\--> patients\n' > "$R/$SPEC"
expect_exit "a backslash inside a comment is literal, so the comment closes and the prose after it counts" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients\n' > "$R/$SPEC"
expect_exit "an inline comment opener that never closes is visible text" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- safe\n\npatients\n--> tail\n' > "$R/$SPEC"
expect_exit "an inline opener not closed before the next blank line is text; the later paragraph counts" 1 "$(run_gate "$R")"
expect_out "the hit is in the later paragraph" "$SPEC:5: patient"
printf '# Title\n\nprefix <!-- safe\npatients inside a multi-line inline comment --> tail\n' > "$R/$SPEC"
expect_exit "an inline comment may continue within its paragraph" 0 "$(run_gate "$R")"
printf '# Title\n\n<!-- block comment\n\npatients hidden across the blank line\n--> patients after the close are emitted raw and visible\nprose after the block with patients.\n' > "$R/$SPEC"
expect_exit "a line-start comment is an HTML block that crosses blank lines to the line containing its close" 1 "$(run_gate "$R")"
expect_no_out "the paragraph inside the block, past the blank line, is hidden" "$SPEC:5:"
expect_out "text after the close on the closing line is visible" "$SPEC:6: patient"
expect_out "the line after the block is a hit" "$SPEC:7: patient"
printf '# Title\n\nx\\_patient is one identifier when rendered.\n' > "$R/$SPEC"
expect_exit "an escaped underscore stays an underscore and joins the word" 0 "$(run_gate "$R")"
printf '# Title\n\n\\\\`patients` after an escaped backslash is a real code span.\n' > "$R/$SPEC"
expect_exit "an escaped backslash before a backtick leaves a real code span" 0 "$(run_gate "$R")"

# ---- 5b4. Codex round-4 findings: paragraph interruptions end the lookahead; ---> is not a close --
for interrupt in '# -->' '```' '- -->' '> -->' '***' '<!-- -->' '===' '<div>' '1. item' '<?xml?>' '<x>'; do # <x> is a type-7 HTML block, treated as interrupting on purpose (conservative)
  # a close follows on the line AFTER the interruption, so only the interruption rule keeps the opener literal
  printf '# Title\n\nprefix <!-- patients\n%s\n-->\n' "$interrupt" > "$R/$SPEC"
  expect_exit "an inline opener does not continue past a paragraph interruption ($interrupt)" 1 "$(run_gate "$R")"
done
for plain in '<' '| a | b |' '    indented' 'plain text'; do
  printf '# Title\n\nprefix <!-- patients\n%s\n-->\n' "$plain" > "$R/$SPEC"
  expect_exit "a line that does not interrupt a paragraph keeps the inline comment open ($plain)" 0 "$(run_gate "$R")"
done
printf '# Title\n\nprefix <!-- patients\n   \t\n-->\n' > "$R/$SPEC"
expect_exit "a whitespace-only line is blank and ends the lookahead" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients\ncontinued on a plain line -->\n' > "$R/$SPEC"
expect_exit "a plain continuation line keeps the inline comment open" 0 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients ---> suffix\n' > "$R/$SPEC"
expect_exit "---> does not close a comment (conservative), so the opener is literal text" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients --> suffix\n' > "$R/$SPEC"
expect_exit "--> after a non-dash closes a comment" 0 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients -- invalid --> suffix\n' > "$R/$SPEC"
expect_exit "-- inside an inline comment invalidates it (conservative), so the opener is literal text" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients - valid --> suffix\n' > "$R/$SPEC"
expect_exit "a single dash inside an inline comment is fine" 0 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients\ncontinued -- here -->\n' > "$R/$SPEC"
expect_exit "-- on an inline continuation line invalidates that close" 1 "$(run_gate "$R")"
printf '# Title\n\n<!--\npatients -- inside a block comment\n-->\nafter\n' > "$R/$SPEC"
expect_exit "a block comment ends on any line containing -->, -- inside notwithstanding" 0 "$(run_gate "$R")"
printf '# Title\n\n<!--\npatients --->\nafter the block, patients\n' > "$R/$SPEC"
expect_exit "a block comment ends on a line containing ---> too (HTML block end condition), so the next line is visible" 1 "$(run_gate "$R")"
expect_no_out "the ---> line is inside the block" "$SPEC:4:"
expect_out "the line after the block is a hit" "$SPEC:5: patient"
printf '# Title\n\nA patient-facing portal.\n' > "$R/$SPEC"
run_gate "$R" >/dev/null
expect_out "patient-facing is reported exactly once" '^\[terminology\] FAIL \(1\):'
expect_out "and under its own label" "$SPEC:3: patient-facing:"
printf '# Title\n\nprefix <!-- patients -- invalid\ncontinued -->\n' > "$R/$SPEC"
expect_exit "-- on the opener line of a multi-line inline comment invalidates it" 1 "$(run_gate "$R")"
printf '# Title\n\nprefix <!-- patients\ncontinued -- invalid\nfinal close -->\n' > "$R/$SPEC"
expect_exit "-- on a continuation line without a close invalidates the inline comment" 1 "$(run_gate "$R")"
printf '# Title\n\n<!-- patients -- inside --> patients after the close\nlater patients\n' > "$R/$SPEC"
expect_exit "a same-line block-level comment closes despite -- inside; text after it and later lines are visible" 1 "$(run_gate "$R")"
expect_out "the post-close text on the opener line is a hit" "$SPEC:3: patient"
expect_out "the later line is a hit (nothing was swallowed)" "$SPEC:4: patient"
printf '# Title\n\n<!--\npatients ---\n>\n--> patients visible after the close\n' > "$R/$SPEC"
expect_exit "an HTML block closes only on a valid --> (here at index 0 of line 6), and the text after it is visible" 1 "$(run_gate "$R")"
expect_no_out "the line ending in --- is inside the block" "$SPEC:4:"
expect_out "the text after the index-0 close is a hit" "$SPEC:6: patient"

# ---- 5c. normalisation: emphasis, zero-width and fullwidth evasions are hits --------------------
printf '# Title\n\nSeen by pa**tient**s.\n' > "$R/$SPEC"
expect_exit "emphasis markers inside a word are removed before matching" 1 "$(run_gate "$R")"
printf '# Title\n\nSeen by p\xE2\x80\x8Batients.\n' > "$R/$SPEC"
expect_exit "a zero-width space inside a word is removed before matching" 1 "$(run_gate "$R")"
printf '# Title\n\nSeen by \xEF\xBD\x90\xEF\xBD\x81\xEF\xBD\x94\xEF\xBD\x89\xEF\xBD\x85\xEF\xBD\x8E\xEF\xBD\x94s.\n' > "$R/$SPEC"
expect_exit "fullwidth letters fold to ASCII before matching" 1 "$(run_gate "$R")"
printf '# Title\n\nThe patient\xE2\x80\x99s record.\n' > "$R/$SPEC"
expect_exit "a curly apostrophe after the word is still a hit" 1 "$(run_gate "$R")"

# ---- 6. the allow marker needs a reason, on the same line -----------------------------------
printf '# Title\n\nWe do not serve patients. <!-- terminology-allow: explicit exclusion statement -->\n' > "$R/$SPEC"
expect_exit "allow marker with a reason exempts the line" 0 "$(run_gate "$R")"
printf '# Title\n\nWe do not serve patients. <!-- terminology-allow -->\n' > "$R/$SPEC"
expect_exit "allow marker without a reason is itself a finding" 1 "$(run_gate "$R")"
expect_out "the reason-less marker is named" "allow marker without a reason"
printf '# Title\n\nWe do not serve patients. <!-- terminology-allow: -->\n' > "$R/$SPEC"
expect_exit "allow marker with an empty reason is a finding" 1 "$(run_gate "$R")"
printf '# Title\n\n<!-- terminology-allow: wrong line -->\nWe do not serve patients.\n' > "$R/$SPEC"
expect_exit "a marker on another line exempts nothing" 1 "$(run_gate "$R")"
rm "$R/$SPEC"

# ---- 7. scope by path: prefix and namespace ----------------------------------------------------
printf '# Old\n\npatients\n' > "$R/docs/superpowers/specs/2026-08-01-old.md"
expect_exit "a spec without the 2026-09-02- prefix is out of scope" 0 "$(run_gate "$R")"
printf '# Plan\n\npatients\n' > "$R/docs/superpowers/plans/2026-09-02-plan.md"
expect_exit "a 2026-09-02- plan is in scope" 1 "$(run_gate "$R")"
rm "$R/docs/superpowers/plans/2026-09-02-plan.md"
mkdir -p "$R/docs/blueprint/customer/deep"
printf '# Blueprint\n\npatients\n' > "$R/docs/blueprint/customer/deep/proposal.md"
expect_exit "any .md under docs/blueprint is in scope, at any depth" 1 "$(run_gate "$R")"
rm "$R/docs/blueprint/customer/deep/proposal.md"
printf '{ "note": "patients" }\n' > "$R/docs/blueprint/customer/deep/spec.json"
expect_exit "a non-Markdown file under docs/blueprint is ignored" 0 "$(run_gate "$R")"
run_gate "$R" --list >/dev/null
expect_no_out "--list omits the spec without the prefix" '2026-08-01-old\.md'

# ---- 8. opt-in through front matter, LF and CRLF ------------------------------------------------
G="docs/guides/opted.md"
printf -- '---\ntitle: x\nterminology-policy: customer-scope\n---\n\nSeen by patients.\n' > "$R/$G"
expect_exit "LF front matter opts a file in" 1 "$(run_gate "$R")"
expect_out "the opted-in file is named" "^  - $G:6: patient"
printf -- '---\r\ntitle: x\r\nterminology-policy: customer-scope\r\n---\r\n\r\nSeen by patients\r\n' > "$R/$G"
expect_exit "CRLF front matter opts a file in, and a hit at end of a CRLF line is found" 1 "$(run_gate "$R")"
expect_out "the CRLF file is named with the right line" "^  - $G:6: patient"
# grep on a CRLF-aware platform (Git Bash) strips line-end CRs before matching, so
# a grep for a CR cannot fail there; inspect the bytes instead.
if [ "$(od -An -c "$TMP_DIR/out.txt" | grep -c '\\r')" = "0" ]; then echo "PASS: no carriage return leaks into the excerpt"; else
  echo "FAIL: a carriage return leaked into the excerpt"; od -An -c "$TMP_DIR/out.txt" | grep '\\r' | head -2; FAILURES=$((FAILURES + 1)); fi
printf -- '---\r\nterminology-policy: customer-scope\r\n---\r\n\r\nClean CRLF prose.\r\n' > "$R/$G"
expect_exit "a clean CRLF opted-in file passes" 0 "$(run_gate "$R")"
run_gate "$R" --list >/dev/null
expect_out "--list shows the clean CRLF opted-in file" "^$G\$"
printf -- '\xEF\xBB\xBF---\r\nterminology-policy: customer-scope\r\n---\r\n\r\npatients\r\n' > "$R/$G"
expect_exit "a BOM before CRLF front matter still opts in" 1 "$(run_gate "$R")"
printf -- '\n---\nterminology-policy: customer-scope\n---\n\npatients\n' > "$R/$G"
expect_exit "front matter not on line 1 opts nothing in" 0 "$(run_gate "$R")"
printf -- '---\nterminology-policy: customer-scope\n\npatients\n' > "$R/$G"
expect_exit "an unclosed front matter block opts nothing in" 0 "$(run_gate "$R")"
printf -- '---\nterminology-policy: other\n---\n\npatients\n' > "$R/$G"
expect_exit "a different policy value opts nothing in" 0 "$(run_gate "$R")"
printf -- '# Guide\n\nThe key `terminology-policy: customer-scope` mentioned in the body opts nothing in; patients.\n' > "$R/$G"
expect_exit "the key in the body (not front matter) opts nothing in" 0 "$(run_gate "$R")"
printf -- '# Guide\n\nterminology-policy: customer-scope\n\n---\n\npatients\n' > "$R/$G"
expect_exit "the key in the body followed by a horizontal rule still opts nothing in" 0 "$(run_gate "$R")"
run_gate "$R" --list >/dev/null
expect_no_out "--list omits the body-mention file" "^$G\$"
printf -- '---\nterminology-policy:   customer-scope   \n---\n\npatients\n' > "$R/$G"
expect_exit "surrounding spaces around the value are tolerated" 1 "$(run_gate "$R")"
printf -- '--- \nterminology-policy: customer-scope\n---\t\n\npatients\n' > "$R/$G"
expect_exit "trailing whitespace on the delimiters is tolerated" 1 "$(run_gate "$R")"
printf -- '---\nterminology-policy: "customer-scope"\n---\n\npatients\n' > "$R/$G"
expect_exit "a double-quoted value opts in" 1 "$(run_gate "$R")"
printf -- "---\nterminology-policy: 'customer-scope'\n---\n\npatients\n" > "$R/$G"
expect_exit "a single-quoted value opts in" 1 "$(run_gate "$R")"
printf -- '---\nterminology-policy: customer-scope-extended\n---\n\npatients\n' > "$R/$G"
expect_exit "a value that merely starts with customer-scope opts nothing in" 0 "$(run_gate "$R")"
printf -- '---\nterminology-policy: customer-scope # horizontal docs\n---\n\npatients\n' > "$R/$G"
expect_exit "a YAML inline comment after the value still opts in" 1 "$(run_gate "$R")"
printf -- '---\nterminology-policy: customer-scope#not-a-comment\n---\n\npatients\n' > "$R/$G"
expect_exit "a hash glued to the value is part of the value, not a comment" 0 "$(run_gate "$R")"
rm "$R/$G"

# ---- 9. several hits are all reported and counted ----------------------------------------------
printf '# Title\n\npatients\nHIPAA\nclinical\n' > "$R/$SPEC"
expect_exit "three hits block" 1 "$(run_gate "$R")"
expect_out "three hits are counted" '^\[terminology\] FAIL \(3\):'
rm "$R/$SPEC"

# ---- 10. environment and usage errors --------------------------------------------------------------
mkdir -p "$TMP_DIR/nodocs"
expect_exit "missing docs/ is an environment error" 2 "$(run_gate "$TMP_DIR/nodocs")"
expect_exit "unknown flag is a usage error" 2 "$(run_gate "$R" --bogus)"
node "$SCRIPT" --root >"$TMP_DIR/out.txt" 2>&1; expect_exit "--root without a value is a usage error" 2 "$?"

echo
if [ "$FAILURES" -eq 0 ]; then echo "check-terminology.test.sh: all scenarios passed"; exit 0; else
  echo "check-terminology.test.sh: $FAILURES failure(s)"; exit 1; fi
