#!/usr/bin/env bash
# Regression test for scripts/check-no-loopback-self-fetch.mjs.
#
# Every scenario builds a synthetic repo root under mktemp and runs the gate
# with --root, so nothing here depends on the live tree. Each scenario pins
# ONE rule in both directions where a legitimate pass case exists, so a change
# that over-tightens or over-loosens detection breaks a named scenario rather
# than only the real-repo run.
#
# NOTE: this file is in SOURCE_FILE_EXCLUSIONS in scripts/check-inbound-links.mjs
# because the fixtures below write bare `src/`-shaped paths for files that do
# not exist. Scenario I of tests/scripts/check-inbound-links.test.sh pins that
# entry. Do not remove either without removing the other.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO/scripts/check-no-loopback-self-fetch.mjs"
PASS=0
FAIL=0
SKIP=0
ROOTS=()

cleanup() {
  # `${ROOTS[@]}` on an empty array is an unbound expansion under `set -u`
  # on older bash; guard so the early-exit path below cannot abort in the trap.
  if [ "${#ROOTS[@]}" -gt 0 ]; then
    for root in "${ROOTS[@]}"; do
      rm -rf "$root"
    done
  fi
}
trap cleanup EXIT

expect_exit() {
  local expected="$1"
  local root="$2"
  local label="$3"
  local actual
  if node "$SCRIPT" --root "$root" >"$root/out.txt" 2>&1; then
    actual=0
  else
    actual=$?
  fi

  if [ "$actual" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    echo "FAIL: $label (expected $expected, got $actual)"
    cat "$root/out.txt"
    FAIL=$((FAIL + 1))
  fi
}

# Same as expect_exit, but also requires a specific rule name in the output.
# Needed where two independent guards enforce one invariant: asserting only the
# exit code lets either guard be deleted with the scenario still "passing".
expect_exit_rule() {
  local expected="$1"
  local root="$2"
  local rule="$3"
  local label="$4"
  local actual
  if node "$SCRIPT" --root "$root" >"$root/out.txt" 2>&1; then
    actual=0
  else
    actual=$?
  fi

  if [ "$actual" -eq "$expected" ] && grep -q "$rule" "$root/out.txt"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    echo "FAIL: $label (expected $expected + rule '$rule', got $actual)"
    cat "$root/out.txt"
    FAIL=$((FAIL + 1))
  fi
}

make_root() {
  local root
  root="$(mktemp -d)"
  ROOTS+=("$root")
  mkdir -p "$root/src" "$root/public" "$root/scripts"
  for page in \
    public/sync-central-dashboard.html \
    public/SuiteCentral-BusinessCentral-Integration-hub.html \
    public/admin-templates.html \
    public/integration-wizard-enhanced.html; do
    printf '<html><body></body></html>\n' >"$root/$page"
  done
  printf '{"sinks":[]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
  printf '%s' "$root"
}

# Revoke read permission on a file, portably enough for the two platforms this
# suite runs on. `chmod 000` works on Linux CI; it is a no-op on NTFS under Git
# Bash, so Windows falls back to a deny ACE. Returns 0 ONLY when the file is
# afterwards genuinely unreadable, verified by an actual read — a scenario that
# asserted exit 2 against a still-readable file would pass vacuously.
make_unreadable() {
  local f="$1"
  chmod 000 "$f" 2>/dev/null || true
  if node -e "require('fs').readFileSync(process.argv[1],'utf8')" "$f" >/dev/null 2>&1; then
    if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
      MSYS_NO_PATHCONV=1 icacls "$(cygpath -w "$f")" /deny "${USERNAME:-${USER:-}}:(R)" >/dev/null 2>&1 || true
    fi
  fi
  if node -e "require('fs').readFileSync(process.argv[1],'utf8')" "$f" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# Undo make_unreadable so the cleanup trap can always delete the temp root.
restore_readable() {
  local f="$1"
  chmod 644 "$f" 2>/dev/null || true
  if command -v icacls >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    MSYS_NO_PATHCONV=1 icacls "$(cygpath -w "$f")" /remove:d "${USERNAME:-${USER:-}}" >/dev/null 2>&1 || true
  fi
}

# Honest red phase: without this guard every `expect_exit 1` scenario would
# "pass" for the wrong reason (node exits 1 when the script file is absent).
if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT does not exist"
  exit 1
fi

# ---- Rule 1: retired identifiers ----
root="$(make_root)"
printf 'const moduleHttpClient = true;\n' >"$root/src/bad.ts"
expect_exit 1 "$root" "retired identifier fails"

# ---- Rule 2: literal self-fetch ----
root="$(make_root)"
printf "await fetch('/api/sync-orchestrator/dashboard');\n" >"$root/src/bad.ts"
expect_exit 1 "$root" "literal self-fetch fails"

# ---- Rule 2: same-file constant folding ----
root="$(make_root)"
printf "const endpoint = '/api/sync-orchestrator/dashboard';\nawait fetch(endpoint);\n" >"$root/src/bad.ts"
expect_exit 1 "$root" "same-file constant self-fetch fails"

# ---- Rule 2: retired prefix behind a known absolute host ----
# Heredoc (quoted delimiter) rather than a double-quoted printf: `${base}`
# inside double quotes would be expanded by bash and abort under `set -u`.
root="$(make_root)"
cat >"$root/src/bad.ts" <<'TS'
const base = 'http://localhost:3000';
await fetch(`${base}/api/sync-orchestrator/tiers`);
TS
expect_exit 1 "$root" "absolute-host retired-prefix self-fetch fails"

# ---- Sink discovery: computed `globalThis['fetch']` ----
# A computed member access is the same call as `globalThis.fetch(...)`, but a
# collector that only reads Identifier and PropertyAccessExpression callees
# records NO sink for it — so it escapes Rule 3 (nothing to declare) as well as
# Rule 2. The inventory below declares the sink under the canonical spelling, so
# the ONLY thing that can fail this scenario is Rule 2 finding the URL.
root="$(make_root)"
printf "await globalThis['fetch']('/api/health');\n" >"$root/src/computed.ts"
printf '{"sinks":[{"file":"src/computed.ts","enclosing":"<module>","callee":"globalThis.fetch","argFingerprint":"Str:/api/health","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "computed globalThis['fetch'] is a sink and Rule 2 sees its URL"

# ---- Sink discovery: `fetch.call(thisArg, url)` ----
# The URL is argument ONE here, not zero. A collector that reads argument 0
# fingerprints the thisArg, so the declared key would not match and this would
# fail on `inventory-missing` instead — which is why the rule name is asserted.
root="$(make_root)"
printf "await fetch.call(globalThis, '/api/health');\n" >"$root/src/called.ts"
printf '{"sinks":[{"file":"src/called.ts","enclosing":"<module>","callee":"fetch.call","argFingerprint":"Str:/api/health","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "fetch.call takes its URL from argument 1"

# ---- Sink discovery: `fetch.bind(thisArg)(url)` ----
# The URL is on the OUTER call, and the bind itself must not double-count.
root="$(make_root)"
printf "await fetch.bind(globalThis)('/api/health');\n" >"$root/src/bound.ts"
printf '{"sinks":[{"file":"src/bound.ts","enclosing":"<module>","callee":"fetch.bind()","argFingerprint":"Str:/api/health","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "invoked fetch.bind takes its URL from the outer call"

# ---- Rule 2: a `let` that is never reassigned is folded ----
# Folding `let` is DETECTION only: it can raise a violation, never clear one.
# Without it, `let endpoint = '<self>'` plus any classification and any sentence
# of justification shipped a real self-fetch. Declared in the inventory so only
# Rule 2 can fail it.
root="$(make_root)"
printf "let endpoint = '/api/sync-orchestrator/dashboard';\nawait fetch(endpoint);\n" >"$root/src/letbad.ts"
printf '{"sinks":[{"file":"src/letbad.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "never-reassigned let hiding a self-target fails"

# ---- Rule 2 negative control: a REASSIGNED let is not folded ----
# The other half of the ruling. Once the file assigns to the name, the
# initializer is not the value, and folding it anyway would manufacture a false
# positive out of code that never fetches the initializer's URL at all.
root="$(make_root)"
cat >"$root/src/letok.ts" <<'TS'
let endpoint = '/api/sync-orchestrator/dashboard';
endpoint = 'https://api.openai.com/v1/models';
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/letok.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "reassigned let is not folded (no false positive)"

# ---- Rule 2: a name the file binds TWICE is never folded ----
# The fold map is keyed by NAME with no scope resolution behind it, so two
# bindings of one name make it guess. Here the fetched `endpoint` is the
# PARAMETER; the module-level `const` of the same name is a different binding the
# call never reads. Folding it anyway reported a self-fetch in code that fetches
# whatever its caller passes. `const` on purpose: the scope-blindness predates
# the `let` fold and this pins the fix for both keywords. Declared in the
# inventory, so the only thing that can fail this scenario is Rule 2.
root="$(make_root)"
cat >"$root/src/shadow.ts" <<'TS'
const endpoint = '/api/sync-orchestrator/dashboard';
export function load(endpoint: string): Promise<Response> {
    return fetch(endpoint);
}
TS
printf '{"sinks":[{"file":"src/shadow.ts","enclosing":"load","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider-wrapper","justification":"Synthetic scenario fixture: the caller supplies the URL, which is exactly why the module-level const must not answer for it."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "a name bound twice is not folded (parameter shadows a module const)"

# ---- Rule 2 GAP PIN: the other half of scope-blindness is still not caught ----
# NOT a red-to-green regression — this scenario passed identically before the
# fold refusal existed, and it is here to keep the header's claim honest. The
# fetched `endpoint` is the INNER self-target; before the fix the name-keyed map
# kept the outer external initializer and Rule 2 announced a destination that was
# not the one the call uses. Refusing to fold stops the false statement; it does
# not turn the inner self-target into a Rule 2 violation, because proving that
# needs the scope analysis this gate deliberately does not do. What stands behind
# the sink is its Rule 3 entry, which a human had to justify.
root="$(make_root)"
cat >"$root/src/masked.ts" <<'TS'
const endpoint = 'https://api.openai.com/v1/models';
export function load(): Promise<Response> {
    const endpoint = '/api/sync-orchestrator/dashboard';
    return fetch(endpoint);
}
TS
printf '{"sinks":[{"file":"src/masked.ts","enclosing":"load","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: pins a KNOWN gap — Rule 2 does not resolve scopes, so this sink is held by Rule 3 alone."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "inner-scope self-target is a documented Rule 3 case, not a Rule 2 proof"

# ---- Rule 2: DESTRUCTURING assignment counts as a reassignment ----
# `[endpoint] = [...]` writes the name exactly as `endpoint = ...` does. While the
# reassignment walk read the identifier case only, the initializer still answered
# for a name the file had since overwritten — a false positive here, and in the
# mirror image a fold that spoke for a value the call never uses.
root="$(make_root)"
cat >"$root/src/destructured.ts" <<'TS'
let endpoint = '/api/sync-orchestrator/dashboard';
[endpoint] = ['https://api.openai.com/v1/models'];
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/destructured.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "destructuring assignment is a reassignment, so the let is not folded"

# ---- Rule 2: a `for...of` loop target counts as a reassignment ----
# Same class as the destructuring case, different syntax: the loop head assigns
# to an EXISTING binding, so the initializer stops being the value.
root="$(make_root)"
cat >"$root/src/forof.ts" <<'TS'
let endpoint = '/api/sync-orchestrator/dashboard';
for (endpoint of ['https://api.openai.com/v1/models']) {
    void endpoint;
}
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/forof.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "for...of over an existing binding is a reassignment, so the let is not folded"

# ---- Rule 2 CONTROL: an unambiguously bound const still folds ----
# The counterweight to the four scenarios above. Refusing to fold is safe only
# while it stays narrow: an implementation that refused whenever the FILE had any
# repeated binding would pass all of them and detect nothing. `value` is bound
# twice here and `endpoint` once, so `endpoint` must still fold and must still
# catch the self-target behind it. Verified by mutation.
root="$(make_root)"
cat >"$root/src/control.ts" <<'TS'
const endpoint = '/api/sync-orchestrator/dashboard';
export function helper(value: string): string {
    return value;
}
export function other(value: string): string {
    return value;
}
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/control.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "a uniquely-bound const still folds in a file with other repeated names"

# ---- Rule 2: an `import x = y` alias is a BINDING, so the name is ambiguous ----
# TypeScript import-equals declares a runtime value binding, and a namespace member
# can carry the same name as a module-level const. While the binding walk missed
# it, the name looked uniquely bound: the outer initializer answered for a
# reference that reaches the namespace alias instead, and Rule 2 announced a
# destination the call never uses. The fetched `endpoint` here is the ALIAS
# (external); the outer const is the self-target, so a run that still folds fails
# with a loopback violation this file does not contain.
root="$(make_root)"
cat >"$root/src/importequals.ts" <<'TS'
const endpoint = '/api/sync-orchestrator/dashboard';
namespace URLs {
    export const external = 'https://api.openai.com/v1/models';
}
namespace Loader {
    export import endpoint = URLs.external;
    export function load(): Promise<Response> {
        return fetch(endpoint);
    }
}
TS
printf '{"sinks":[{"file":"src/importequals.ts","enclosing":"load","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: pins that an import-equals alias counts as a binding, so the module const cannot answer for it."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "an import-equals alias counts as a binding, so the name is not folded"

# ---- Rule 2: an ERASED parameter must not cost a fold ----
# The mirror image of the scenario above, and a coverage regression rather than a
# bypass: an interface method's parameter binds nothing at runtime, so counting it
# made a genuinely unique `endpoint` look doubly bound and refused a fold that was
# safe. The self-target below must still be caught by Rule 2, not deferred to a
# human classification.
root="$(make_root)"
cat >"$root/src/typeparam.ts" <<'TS'
const endpoint = '/api/sync-orchestrator/dashboard';
export interface Loader {
    load(endpoint: string): void;
}
export type Fetcher = (endpoint: string) => void;
export declare function preload(endpoint: string): void;
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/typeparam.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "type-only parameter positions do not block folding"

# ---- Rule 2: a TYPE-ONLY import must not cost a fold either ----
# Same class, different erased form: `import type { endpoint }` is deleted by the
# compiler and can never be referenced from a value position.
#
# HONEST CAVEAT: unlike the interface-parameter scenario above, this fixture is
# not code `tsc` would accept as written — `./contract` does not exist here, and
# had it existed, a type-only import colliding with a local const of the same
# name raises TS2440 when the imported symbol is a value export. (The earlier
# wording asserted TS2440 flatly; that overstated it, since the diagnostic
# depends on what the module exports.) Either way the fixture is not compiling
# source. It is kept because the gate PARSES rather than type-checks, so what it
# pins is the WALKER's rule ("erased positions bind nothing"), one form per
# scenario. The interface-parameter scenario above is fully legal TypeScript and
# is the load-bearing one.
root="$(make_root)"
cat >"$root/src/typeimport.ts" <<'TS'
import type { endpoint } from './contract';
import { type helper, other } from './contract';
const endpoint = '/api/sync-orchestrator/dashboard';
void other;
await fetch(endpoint);
TS
printf '{"sinks":[{"file":"src/typeimport.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "type-only imports do not block folding"

# ---- Sink discovery: a SPREAD array literal moves the URL's true position ----
# `fetch.call(...[undefined, '/api/x'])` executes a real self-fetch whose URL
# lands at index 1, while the source has no argument at index 1 at all. Reading
# the written positions found nothing, so Rule 2 got no value and the sink was
# fingerprinted `None` — an inventory entry could then classify it
# `external-provider`. The rule name is asserted because an unexpanded run fails
# on `inventory-missing` instead, which exit 1 alone cannot tell apart.
root="$(make_root)"
printf "await fetch.call(...[undefined, '/api/sync-orchestrator/dashboard']);\n" >"$root/src/spread.ts"
printf '{"sinks":[{"file":"src/spread.ts","enclosing":"<module>","callee":"fetch.call","argFingerprint":"Str:/api/sync-orchestrator/dashboard","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "spread array literal is expanded so fetch.call's URL is found at index 1"

# ---- ...and the same through an immediately-invoked bind ----
root="$(make_root)"
printf "await fetch.bind(...[globalThis, '/api/sync-orchestrator/dashboard'])();\n" >"$root/src/spreadbind.ts"
printf '{"sinks":[{"file":"src/spreadbind.ts","enclosing":"<module>","callee":"fetch.bind()","argFingerprint":"Str:/api/sync-orchestrator/dashboard","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "spread array literal is expanded through an invoked fetch.bind"

# ---- A spread the AST cannot expand still RECORDS the sink ----
# Expansion is static, so `...parts` resolves to nothing and Rule 2 gets no
# value. That must cost the proof only: the sink is still discovered, so Rule 3
# demands a classification and a written justification for it. Asserting the rule
# name is what proves the sink was recorded rather than skipped.
root="$(make_root)"
cat >"$root/src/dynspread.ts" <<'TS'
const parts: [undefined, string] = [undefined, '/api/sync-orchestrator/dashboard'];
await fetch.call(...parts);
TS
expect_exit_rule 1 "$root" inventory-missing "a non-expandable spread still records the sink for Rule 3"

# ---- An unexpandable spread must not let a LATER argument answer for the URL ----
# The dangerous half of the case above. `fetch.call(...args, '<external>')` really
# passes the URL from inside `args` — the written argument at index 1 is not the
# URL at all. Reading it anyway did not merely lose a proof: it AFFIRMATIVELY
# resolved the sink to an external host and cleared Rule 2, so a self-target
# hidden in the spread read as an OpenAI call. The URL must be UNKNOWN whenever an
# unexpandable spread can occupy or precede its position, which re-fingerprints the
# sink to `None` — asserted here as inventory-missing against the old key, because
# a run that still reads argument 1 finds `Str:https://api.openai.com/v1/models`
# declared and exits 0.
root="$(make_root)"
cat >"$root/src/spreadmask.ts" <<'TS'
const args: [undefined, string] = [undefined, '/api/sync-orchestrator/dashboard'];
await fetch.call(...args, 'https://api.openai.com/v1/models');
TS
printf '{"sinks":[{"file":"src/spreadmask.ts","enclosing":"<module>","callee":"fetch.call","argFingerprint":"Str:https://api.openai.com/v1/models","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing "an unexpandable spread makes fetch.call's URL unknown, not the next fixed argument"

# ---- ...and the same through an invoked bind, where the fallback lived ----
# `boundArgs[1] ?? args[0]` was the exact false-clearance path: an unreadable bind
# argument list fell through to the OUTER call's fixed URL, which is not the URL
# the bound function receives.
root="$(make_root)"
cat >"$root/src/spreadbindmask.ts" <<'TS'
const args: [unknown, string] = [globalThis, '/api/sync-orchestrator/dashboard'];
await fetch.bind(...args)('https://api.openai.com/v1/models');
TS
printf '{"sinks":[{"file":"src/spreadbindmask.ts","enclosing":"<module>","callee":"fetch.bind()","argFingerprint":"Str:https://api.openai.com/v1/models","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing "an unexpandable spread in bind() does not fall back to the outer call's URL"

# ---- ...and on a plain fetch with a leading unexpandable spread ----
# No false clearance here before the fix (a SpreadElement folds to nothing), but
# the sink was fingerprinted on the spread's own text as though that were the URL
# argument. One rule now covers all three spellings: unreadable position, `None`.
root="$(make_root)"
cat >"$root/src/spreadplain.ts" <<'TS'
const args: [string] = ['/api/sync-orchestrator/dashboard'];
await fetch(...args, 'https://api.openai.com/v1/models');
TS
printf '{"sinks":[{"file":"src/spreadplain.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Raw:...args","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing "a leading unexpandable spread makes a plain fetch's URL unknown"

# ---- Rule 3: unclassified sink ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"UNCLASSIFIED"}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-unclassified "unclassified sink fails"

# ---- Rule 3: self-fetch is never an escape hatch ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"self-fetch"}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-self-fetch "self-fetch classification is never an escape hatch"

# ---- Rule 3: duplicate inventory key ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."},{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "duplicate inventory key fails"

# ---- Rule 3: stale inventory entry ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/gone.ts","enclosing":"gone","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "stale inventory entry fails"

# ---- Rule 2 ISOLATED: the sink IS declared, so only Rule 2 can fail it ----
# Without this, the three Rule 2 scenarios above pass for the wrong reason:
# their sinks are also absent from the inventory, so deleting Rule 2 entirely
# leaves them still failing on `inventory-missing`. Verified by mutation.
root="$(make_root)"
printf "await fetch('/api/sync-orchestrator/dashboard');\n" >"$root/src/bad.ts"
printf '{"sinks":[{"file":"src/bad.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:/api/sync-orchestrator/dashboard","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "declared-but-self-fetching sink still fails (Rule 2 isolated)"

# ---- Rule 2 const-folding ISOLATED: the sink IS declared ----
# Same wrong-reason trap as above: without the inventory entry, deleting
# same-file const folding leaves the scenario failing on `inventory-missing`.
root="$(make_root)"
printf "const endpoint = '/api/sync-orchestrator/dashboard';\nawait fetch(endpoint);\n" >"$root/src/bad.ts"
printf '{"sinks":[{"file":"src/bad.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Id:endpoint","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "declared sink hiding the URL in a same-file const still fails (folding isolated)"

# ---- Rule 2: root-relative NON-/api/ path is still a self-fetch ----
# This repo really serves /operations/* and /docs/search. A root-relative URL has
# no origin on the server, so it can only resolve to this app whatever its path.
# Declared in the inventory so ONLY Rule 2 can fail it, and the rule name is
# asserted so `inventory-*` cannot pass this scenario for the wrong reason.
root="$(make_root)"
printf "await fetch('/operations/health');\n" >"$root/src/ops.ts"
printf '{"sinks":[{"file":"src/ops.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:/operations/health","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "root-relative non-/api/ path is a self-fetch"

# ---- Rule 2: loopback host with a NON-/api/ path is still a self-fetch ----
root="$(make_root)"
printf "await fetch('http://127.0.0.1:3000/operations/metrics');\n" >"$root/src/ops.ts"
printf '{"sinks":[{"file":"src/ops.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:http://127.0.0.1:3000/operations/metrics","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "loopback host with a non-/api/ path is a self-fetch"

# ---- Rule 3 stale ISOLATED: every discovered sink is declared ----
# Without the second (correct) entry, deleting stale-detection leaves the
# scenario failing on `inventory-missing` instead. Verified by mutation.
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."},{"file":"src/gone.ts","enclosing":"gone","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "stale entry alongside a complete inventory fails (stale isolated)"

# ---- Pass B: fetch embedded in a server-rendered template is discovered ----
# A plain CallExpression walk cannot see these — to the TS parser they are just
# string content. Eight live sinks depend on this pass; without a scenario,
# deleting Pass B entirely broke no test. Verified by mutation.
root="$(make_root)"
cat >"$root/src/page.ts" <<'TS'
export function renderPage(): string {
  return `<script>
    async function load() {
      const r = await fetch('/api/health');
      return r.json();
    }
  </script>`;
}
TS
expect_exit 1 "$root" "template-embedded fetch is discovered (undeclared -> fails)"

# ---- Pass B legitimate pass: browser-embedded is a valid classification ----
root="$(make_root)"
cat >"$root/src/page.ts" <<'TS'
export function renderPage(): string {
  return `<script>
    async function load() {
      const r = await fetch('/api/health');
      return r.json();
    }
  </script>`;
}
TS
printf '{"sinks":[{"file":"src/page.ts","enclosing":"renderPage","callee":"embedded:fetch","argFingerprint":"Emb:'"'"'/api/health'"'"'","ordinal":0,"classification":"browser-embedded","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "classified browser-embedded template fetch passes"

# ---- Pass B: a retired prefix is dead from the browser too ----
root="$(make_root)"
cat >"$root/src/page.ts" <<'TS'
export function renderPage(): string {
  return `<script>fetch('/api/sync-orchestrator/tiers');</script>`;
}
TS
printf '{"sinks":[{"file":"src/page.ts","enclosing":"renderPage","callee":"embedded:fetch","argFingerprint":"Emb:'"'"'/api/sync-orchestrator/tiers'"'"'","ordinal":0,"classification":"browser-embedded","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 1 "$root" "embedded fetch to a retired route fails even when classified"

# ---- Pass B: a commented-out fetch is not a sink ----
root="$(make_root)"
cat >"$root/src/page.ts" <<'TS'
export function renderPage(): string {
  return `<script>
    // await fetch('/api/sync-central/tiers');
    const base = 'https://cdn.example.com/lib.js';
  </script>`;
}
TS
expect_exit 0 "$root" "commented-out embedded fetch is not a sink"

# ---- external-provider-wrapper requires a written justification ----
# The rule name is asserted, not just the exit code: an unjustified entry is
# also a plain classification, so `expect_exit 1` alone could pass on some
# unrelated inventory violation.
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider-wrapper"}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing-justification "wrapper classification without a justification fails"

# ---- EVERY classification requires a written justification, not just the
#      wrapper ----
# The gate's header claims there is no classifying past it. That is only true
# if a classification costs a human sentence. While the requirement applied to
# `external-provider-wrapper` alone, a real credential-less loopback could be
# declared `external-provider` and pass with no rationale anyone had to write.
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider"}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing-justification "external-provider without a justification fails"

# ---- ...and the same for the third classification ----
# browser-embedded is asserted, never proven: the gate cannot tell that a
# template string is really executed by a browser.
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"browser-embedded"}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing-justification "browser-embedded without a justification fails"

# ---- Negative control: a whitespace-only justification is not a justification ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"   "}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" inventory-missing-justification "whitespace-only justification fails"

# ---- Fail-closed: a missing inventory file is exit 2, not a clean scan ----
# Doubly enforced: the existsSync guard AND readFileSync throwing inside the
# same try/catch both exit 2. Deleting either alone still yields exit 2, so this
# scenario cannot isolate one — that redundancy is deliberate.
root="$(make_root)"
rm "$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 2 "$root" "missing inventory file exits 2"

# ---- Fail-closed: an unparseable inventory is exit 2 ----
root="$(make_root)"
printf 'not json at all\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 2 "$root" "unparseable inventory exits 2"

# ---- Fail-closed: an unreadable src file is exit 2, not exit 1 ----
# An unguarded readFileSync throws, node exits 1, and exit 1 is this gate's
# "violations found" code — an infrastructure failure would be indistinguishable
# from a real violation. Both the code and the message are asserted.
root="$(make_root)"
printf 'export const x = 1;\n' >"$root/src/locked.ts"
if make_unreadable "$root/src/locked.ts"; then
  expect_exit_rule 2 "$root" "FAIL: cannot read" "unreadable src file exits 2 (fail-closed)"
else
  echo "  SKIP: unreadable src file (cannot revoke read permission on this platform; set ALLOW_SKIP=1 to tolerate)"
  SKIP=$((SKIP + 1))
fi
restore_readable "$root/src/locked.ts"

# ---- Fail-closed: an unreadable public file is exit 2, not exit 1 ----
# The public walk has its own readFileSync; without this the src scenario alone
# would let the public guard be deleted with no test going red.
root="$(make_root)"
printf '<script></script>\n' >"$root/public/locked.html"
if make_unreadable "$root/public/locked.html"; then
  expect_exit_rule 2 "$root" "FAIL: cannot read" "unreadable public file exits 2 (fail-closed)"
else
  echo "  SKIP: unreadable public file (cannot revoke read permission on this platform; set ALLOW_SKIP=1 to tolerate)"
  SKIP=$((SKIP + 1))
fi
restore_readable "$root/public/locked.html"

# ---- Rule 3: legitimate pass ----
root="$(make_root)"
printf 'const get = (p) => fetch(p);\n' >"$root/src/dynamic.ts"
printf '{"sinks":[{"file":"src/dynamic.ts","enclosing":"get","callee":"fetch","argFingerprint":"Id:p","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "dynamic external-provider sink passes"

# ---- Rule 2 negative control: a real external provider is not a self-fetch ----
root="$(make_root)"
cat >"$root/src/provider.ts" <<'TS'
const baseUrl = 'https://api.openai.com/v1';
await fetch(`${baseUrl}/models`);
TS
printf '{"sinks":[{"file":"src/provider.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Tpl:${baseUrl}|/models","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "OpenAI provider passes"

# ---- Rule 2 negative control: /api/ under an EXTERNAL host is not a self-fetch ----
root="$(make_root)"
cat >"$root/src/business-central.ts" <<'TS'
const baseURL = 'https://business-central.example';
await fetch(`${baseURL}/api/v2.0/$metadata`);
TS
printf '{"sinks":[{"file":"src/business-central.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Tpl:${baseURL}|/api/v2.0/$metadata","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "Business Central metadata passes"

# ---- Rule 2 negative control: an absolute external literal is not a self-fetch ----
# Guards the broadened root-relative/loopback predicates from over-reaching: an
# absolute https:// URL on a third-party host must stay a clean pass.
root="$(make_root)"
printf "await fetch('https://api.openai.com/v1/chat/completions');\n" >"$root/src/provider.ts"
printf '{"sinks":[{"file":"src/provider.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:https://api.openai.com/v1/chat/completions","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "absolute external provider literal passes"

# ---- Rule 2 negative control: a host that merely STARTS with a loopback
#      spelling is external ----
# LOOPBACK_HOST_RE must anchor at the host boundary. Matching a bare prefix
# makes `localhostevil.com` — a perfectly ordinary external host someone could
# register — read as loopback. Before the predicate was broadened, a
# `rest.startsWith('/api/')` condition masked this incidentally; it does not
# any more, so the boundary has to be asserted directly.
root="$(make_root)"
printf "await fetch('http://localhostevil.com/data');\n" >"$root/src/ext.ts"
printf '{"sinks":[{"file":"src/ext.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:http://localhostevil.com/data","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "external host merely prefixed by 'localhost' is not a self-fetch"

# ---- Rule 2 negative control: the same boundary bug via a dotted IP prefix ----
# A distinct mechanism from the one above: here the loopback spelling is a
# literal IP and the attacker-controlled part is a DNS suffix.
root="$(make_root)"
printf "await fetch('http://127.0.0.1.evil.com/data');\n" >"$root/src/ext.ts"
printf '{"sinks":[{"file":"src/ext.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:http://127.0.0.1.evil.com/data","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "external host merely prefixed by '127.0.0.1' is not a self-fetch"

# ---- Rule 2: a bare loopback host with NO path is still a self-fetch ----
# Pins the end-of-string arm of the host-boundary lookahead. Without it, adding
# the boundary to fix the two scenarios above would silently stop flagging a
# loopback URL that has no path at all.
root="$(make_root)"
printf "await fetch('http://localhost:3000');\n" >"$root/src/ops.ts"
printf '{"sinks":[{"file":"src/ops.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str:http://localhost:3000","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "loopback-self-fetch: " "bare loopback host with no path is a self-fetch"

# ---- Rule 2: protocol-relative //host/path is flagged, with an HONEST reason ----
# It stays a violation — Node's fetch cannot resolve an originless `//host` URL
# without a base, so flagging fails closed. But it is not root-relative and does
# not resolve to this app, so it must not be reported as though it were. The
# message text is asserted because the exit code alone cannot tell the two
# branches apart.
root="$(make_root)"
printf "await fetch('//cdn.example.com/lib.js');\n" >"$root/src/protorel.ts"
printf '{"sinks":[{"file":"src/protorel.ts","enclosing":"<module>","callee":"fetch","argFingerprint":"Str://cdn.example.com/lib.js","ordinal":0,"classification":"external-provider","justification":"Synthetic scenario fixture: the classification is asserted by this test, not proven by the gate."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit_rule 1 "$root" "protocol-relative" "protocol-relative URL is flagged as protocol-relative, not root-relative"

# ---- Public rule: inline fetch in a shipped page ----
root="$(make_root)"
printf '<script>fetch("/api/sync-orchestrator/tiers")</script>\n' >"$root/public/admin-templates.html"
expect_exit 1 "$root" "public inline fetch fails"

# ---- Public rule: non-fetch client is still an executable string literal ----
root="$(make_root)"
printf '<script>const x = new XMLHttpRequest(); x.open("GET", "/api/automation-libraries/libraries")</script>\n' >"$root/public/admin-templates.html"
expect_exit 1 "$root" "public non-fetch client fails"

# ---- Public rule negative control: prose is not executable ----
# Must use a still-RETIRED prefix (/api/sync-orchestrator, not the now-unbanned
# /api/sync-central) or this scenario is unfalsifiable: an unbanned prefix
# would exit 0 here even if the prose/script scoping (SCRIPT_BLOCK_RE +
# QUOTED_LITERAL_RE) were deleted outright, so the assertion would prove
# nothing about the rule it names.
root="$(make_root)"
printf '<p>POST /api/sync-orchestrator/subscriptions/SUB-123/cancel</p>\n' >"$root/public/admin-templates.html"
expect_exit 0 "$root" "public prose passes"

# ---- Fail-closed: a required page that vanished is exit 2, not 0 or 1 ----
root="$(make_root)"
rm "$root/public/admin-templates.html"
expect_exit 2 "$root" "missing required page exits 2"

# ---- Alias discovery is generic (no class names hardcoded in the gate) ----
root="$(make_root)"
cat >"$root/src/alias.ts" <<'TS'
type Options = { fetchImpl?: typeof fetch };
class Client {
    private readonly fetchImpl: typeof fetch;
    constructor(options: Options) {
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    call(url: string) {
        return this.fetchImpl(url);
    }
}
TS
printf '{"sinks":[{"file":"src/alias.ts","enclosing":"Client.call","callee":"this.fetchImpl","argFingerprint":"Id:url","ordinal":0,"classification":"external-provider-wrapper","justification":"The caller supplies a provider URL validated by outbound governance."}]}\n' >"$root/scripts/no-loopback-self-fetch.inventory.json"
expect_exit 0 "$root" "generic typeof-fetch alias passes"

printf '%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"

# A SKIP is a FAILURE by default. The two fail-closed scenarios below are the
# only coverage of the "unreadable file exits 2, not 1" guards, and they skip
# themselves when the platform cannot revoke read permission. Gating solely on
# $FAIL meant that if the CI runner ever changed such that make_unreadable
# stopped working — a container image running as root, say — both scenarios
# would evaporate behind a green build and nobody would be told.
#
# CI runs this suite on a non-root ubuntu-latest with no `container:` key
# (.github/workflows/ci-minimal.yml), where `chmod 000` is effective, so strict
# is the correct default there. Set ALLOW_SKIP=1 to tolerate skips on a local
# box that genuinely cannot revoke read permission.
[ "$FAIL" -eq 0 ] && { [ "${ALLOW_SKIP:-0}" = 1 ] || [ "$SKIP" -eq 0 ]; }
