#!/usr/bin/env bash
# Regression harness for scripts/check-mapping-contract-declarations.mjs.
#
# Every scenario asserts an EXIT CODE. The contract: outside src/types/index.ts
# and the canonical module, an exported FieldMapping/TransformationRule
# declaration (interface, type alias, or re-export ALIAS) must be baselined;
# the baseline may only shrink; --init is one-shot; missing src/ is an
# environment error.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-mapping-contract-declarations.mjs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAILURES=0

run_gate() { node "$SCRIPT" --root "$1" "${@:2}" >"$TMP_DIR/out.txt" 2>&1; echo $?; }
expect_exit() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then echo "PASS: $label (exit $got)"; else
    echo "FAIL: $label — expected exit $want, got $got"; sed 's/^/      /' "$TMP_DIR/out.txt" | tail -4; FAILURES=$((FAILURES + 1)); fi
}
fresh_root() { # $1 name -> prints root path with an empty src/ and a canonical module
  local r="$TMP_DIR/$1"; mkdir -p "$r/src/types" "$r/src/domain/mapping" "$r/src/other"
  printf 'export interface FieldMapping { a: string }\nexport interface TransformationRule { id: string }\n' > "$r/src/types/index.ts"
  printf "export type { FieldMapping, TransformationRule } from '../../types';\n" > "$r/src/domain/mapping/MappingContract.ts"
  echo "$r"
}

# ---- 1. real repo passes -------------------------------------------------------
if node "$SCRIPT" >"$TMP_DIR/real.out" 2>&1; then echo "PASS: real repo (exit 0)"; else
  echo "FAIL: real repo should pass"; sed 's/^/      /' "$TMP_DIR/real.out"; FAILURES=$((FAILURES + 1)); fi

# ---- 2. fresh root: --init writes an EMPTY baseline (only the excluded files declare) --
R=$(fresh_root a)
expect_exit "init on a clean root" 0 "$(run_gate "$R" --init)"
[ -f "$R/.mapping-contract-declarations-baseline" ] || { echo "FAIL: --init did not create the baseline"; FAILURES=$((FAILURES + 1)); }
[ ! -s "$R/.mapping-contract-declarations-baseline" ] || { echo "FAIL: excluded files must not be baselined"; FAILURES=$((FAILURES + 1)); }
expect_exit "clean root passes after init" 0 "$(run_gate "$R")"

# ---- 3. --init refuses when the baseline exists ----------------------------------
expect_exit "init refuses when baseline exists" 2 "$(run_gate "$R" --init)"

# ---- 4. a new exported interface in src/other -> 1 -----------------------------------
printf 'export interface FieldMapping { legacy: true }\n' > "$R/src/other/x.ts"
expect_exit "new exported interface blocks" 1 "$(run_gate "$R")"
grep -q 'new legacy declaration.*src/other/x.ts' "$TMP_DIR/out.txt" || { echo "FAIL: message did not name the file"; FAILURES=$((FAILURES + 1)); }

# ---- 5. the multi-line form the old regex missed: export\n  interface ---------------
printf 'export\n  interface FieldMapping { legacy: true }\n' > "$R/src/other/x.ts"
expect_exit "export on its own line blocks (Z-05)" 1 "$(run_gate "$R")"

# ---- 6. re-export ALIAS `export { Foo as FieldMapping }` -> 1 (Z-05) -----------------
printf 'interface Foo { a: string }\nexport { Foo as FieldMapping };\n' > "$R/src/other/x.ts"
expect_exit "re-export alias blocks (Z-05)" 1 "$(run_gate "$R")"

# ---- 7. re-export whose LOCAL name matches but exported alias does not -> 0 ------------
printf "import type { FieldMapping } from '../types';\nexport type { FieldMapping as RouteMapping };\n" > "$R/src/other/x.ts"
expect_exit "alias away from the name passes" 0 "$(run_gate "$R")"

# ---- 8. exported type alias -> 1 (what the regex missed in ConfigurationSchema.ts) -----
printf 'export type TransformationRule = { id: string };\n' > "$R/src/other/x.ts"
expect_exit "exported type alias blocks (AB-02)" 1 "$(run_gate "$R")"

# ---- 9. the same re-export line inside the canonical module -> 0 -----------------------
rm "$R/src/other/x.ts"
printf "export type { FieldMapping } from '../../types';\n" > "$R/src/domain/mapping/MappingContract.ts"
expect_exit "canonical module is excluded" 0 "$(run_gate "$R")"
# ... and the identical line in src/other re-exports the CANONICAL type, which is not legacy
# (Codex round 25 — until then this scenario pinned the opposite, inconsistent with every
# other canonical route).
printf "export type { FieldMapping } from '../types';\n" > "$R/src/other/x.ts"
expect_exit "a re-export of the canonical type outside the canonical module passes" 0 "$(run_gate "$R")"
printf "export type { FieldMapping } from '../domain/mapping/MappingContract';\n" > "$R/src/other/x.ts"
expect_exit "...from the contract module too" 0 "$(run_gate "$R")"
rm "$R/src/other/x.ts"

# ---- 10. NON-exported interface -> 0; a comment containing the words -> 0 ----------------
printf 'interface FieldMapping { local: true }\nexport {};\n' > "$R/src/other/x.ts"
expect_exit "non-exported interface in a MODULE passes" 0 "$(run_gate "$R")"
printf '// export interface FieldMapping is documented elsewhere\n/* export type TransformationRule = never */\nexport const x = 1;\n' > "$R/src/other/x.ts"
expect_exit "comment mentioning the names passes" 0 "$(run_gate "$R")"
rm "$R/src/other/x.ts"

# ---- 11. --write shrinks and never adds -------------------------------------------------
R2=$(fresh_root b)
printf 'export interface FieldMapping { legacy: true }\n' > "$R2/src/other/legacy.ts"
expect_exit "init with one legacy file" 0 "$(run_gate "$R2" --init)"
grep -q '^src/other/legacy.ts#FieldMapping$' "$R2/.mapping-contract-declarations-baseline" || { echo "FAIL: baseline entry must be path#Name"; FAILURES=$((FAILURES + 1)); }
rm "$R2/src/other/legacy.ts"
expect_exit "retired entry blocks until removed" 1 "$(run_gate "$R2")"
grep -q 'baseline entry retired' "$TMP_DIR/out.txt" || { echo "FAIL: retired message missing"; FAILURES=$((FAILURES + 1)); }
expect_exit "--write shrinks" 0 "$(run_gate "$R2" --write)"
[ ! -s "$R2/.mapping-contract-declarations-baseline" ] || { echo "FAIL: --write did not remove the retired entry"; FAILURES=$((FAILURES + 1)); }
printf 'export interface FieldMapping { legacy: true }\n' > "$R2/src/other/new.ts"
expect_exit "--write with a NEW declaration still exits 0 but must not add it" 0 "$(run_gate "$R2" --write)"
grep -q 'src/other/new.ts' "$R2/.mapping-contract-declarations-baseline" && { echo "FAIL: --write added a new entry"; FAILURES=$((FAILURES + 1)); }
expect_exit "new declaration still blocks after --write" 1 "$(run_gate "$R2")"

# ---- 11b. a BASELINED file gains a SECOND legacy name -> 1 (Codex on PR #1253: a
#          per-file baseline let this through). Entries are path#Name.
R4=$(fresh_root d)
printf 'export interface FieldMapping { legacy: true }\n' > "$R4/src/other/both.ts"
expect_exit "init with one name in one file" 0 "$(run_gate "$R4" --init)"
grep -q '^src/other/both.ts#FieldMapping$' "$R4/.mapping-contract-declarations-baseline" || { echo "FAIL: per-declaration entry missing"; FAILURES=$((FAILURES + 1)); }
printf 'export interface FieldMapping { legacy: true }\nexport interface TransformationRule { kind: string }\n' > "$R4/src/other/both.ts"
expect_exit "baselined file gaining a second legacy name blocks" 1 "$(run_gate "$R4")"
grep -q 'src/other/both.ts#TransformationRule' "$TMP_DIR/out.txt" || { echo "FAIL: message did not name the new declaration"; FAILURES=$((FAILURES + 1)); }

# ---- 11d. declaration MERGING: a baselined file adds a second `export interface`
#          of the SAME name -> 1 (Codex round 2 on PR #1253) ---------------------------
R6=$(fresh_root f)
printf 'export interface FieldMapping { a: string }\n' > "$R6/src/other/merge.ts"
expect_exit "init with one declaration" 0 "$(run_gate "$R6" --init)"
printf 'export interface FieldMapping { a: string }\nexport interface FieldMapping { b: string }\n' > "$R6/src/other/merge.ts"
expect_exit "merged second declaration of the same name blocks" 1 "$(run_gate "$R6")"
grep -q 'src/other/merge.ts#FieldMapping#2' "$TMP_DIR/out.txt" || { echo "FAIL: message did not name the second declaration"; FAILURES=$((FAILURES + 1)); }
# ---- 11c. an exported CLASS with the name -> 1 (Codex on PR #1253) ---------------
R5=$(fresh_root e)
expect_exit "init clean root e" 0 "$(run_gate "$R5" --init)"
printf 'export class FieldMapping { sourceField!: string }\n' > "$R5/src/other/cls.ts"
expect_exit "exported class blocks" 1 "$(run_gate "$R5")"
printf 'class FieldMapping { sourceField!: string }\nexport const x = 1;\n' > "$R5/src/other/cls.ts"
expect_exit "non-exported class passes" 0 "$(run_gate "$R5")"

# ---- 11e. a BARREL `export * from` a module that declares a legacy name -> 1 (Codex round 3)
R7=$(fresh_root g)
mkdir -p "$R7/src/legacy"
printf 'export interface FieldMapping { a: string }\n' > "$R7/src/legacy/shape.ts"
expect_exit "init with the legacy module" 0 "$(run_gate "$R7" --init)"
printf "export * from '../legacy/shape';\n" > "$R7/src/other/barrel.ts"
expect_exit "star-export barrel over a legacy module blocks" 1 "$(run_gate "$R7")"
grep -q 'src/other/barrel.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: message did not name the barrel"; FAILURES=$((FAILURES + 1)); }
printf "export * as legacy from '../legacy/shape';\n" > "$R7/src/other/barrel.ts"
expect_exit "namespace star export blocks too (wholesale re-exposure, Codex round 13)" 1 "$(run_gate "$R7")"
printf "export * from '../other/barrel';\n" > "$R7/src/other/cycle.ts"; printf "export * from './cycle';\nexport * from '../legacy/shape';\n" > "$R7/src/other/barrel.ts"
expect_exit "cyclic barrels terminate and block" 1 "$(run_gate "$R7")"
rm "$R7/src/other/barrel.ts" "$R7/src/other/cycle.ts"
# ---- 11f. `export import FieldMapping = Legacy.FieldMapping` -> 1 (Codex round 4) ---------
R8=$(fresh_root h)
expect_exit "init clean root h" 0 "$(run_gate "$R8" --init)"
printf 'declare namespace Legacy { interface FieldMapping { a: string } }\nexport import FieldMapping = Legacy.FieldMapping;\n' > "$R8/src/other/eq.ts"
expect_exit "exported import-equals alias blocks" 1 "$(run_gate "$R8")"
printf 'declare namespace Legacy { interface FieldMapping { a: string } }\nimport FieldMapping = Legacy.FieldMapping;\nexport const x = 1;\n' > "$R8/src/other/eq.ts"
expect_exit "non-exported import-equals passes" 0 "$(run_gate "$R8")"

# ---- 11g. a Unicode-escaped identifier spells the name without matching it (Codex round 5)
R9=$(fresh_root i)
expect_exit "init clean root i" 0 "$(run_gate "$R9" --init)"
printf 'export interface \\u0046ieldMapping { x: string }\n' > "$R9/src/other/esc.ts"
expect_exit "unicode-escaped declaration blocks" 1 "$(run_gate "$R9")"
grep -q 'src/other/esc.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: escaped declaration not named"; FAILURES=$((FAILURES + 1)); }

# ---- 11h. `export enum FieldMapping` declares a type too -> 1 (Codex round 6) ------------
R10=$(fresh_root j)
expect_exit "init clean root j" 0 "$(run_gate "$R10" --init)"
printf 'export enum FieldMapping { A = 1 }\n' > "$R10/src/other/en.ts"
expect_exit "exported enum blocks" 1 "$(run_gate "$R10")"
printf 'enum FieldMapping { A = 1 }\nexport const x = FieldMapping.A;\n' > "$R10/src/other/en.ts"
expect_exit "non-exported enum passes" 0 "$(run_gate "$R10")"
# ---- 11i. a .d.ts declaration file counts too (Codex round 7) ------------------------------
R11=$(fresh_root k)
expect_exit "init clean root k" 0 "$(run_gate "$R11" --init)"
printf 'export interface FieldMapping { x: string }\n' > "$R11/src/other/legacy.d.ts"
expect_exit "exported declaration in a .d.ts blocks" 1 "$(run_gate "$R11")"
grep -q 'src/other/legacy.d.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: .d.ts declaration not named"; FAILURES=$((FAILURES + 1)); }
rm "$R11/src/other/legacy.d.ts"
# Codex round 13: TypeScript compiles .mts/.cts (and .d.mts/.d.cts) under src/**/* too.
for ext in mts cts d.mts d.cts; do
  printf 'export interface FieldMapping { x: string }\n' > "$R11/src/other/legacy.$ext"
  expect_exit "exported declaration in a .$ext blocks" 1 "$(run_gate "$R11")"
  grep -q "src/other/legacy.$ext#FieldMapping" "$TMP_DIR/out.txt" || { echo "FAIL: .$ext declaration not named"; FAILURES=$((FAILURES + 1)); }
  rm "$R11/src/other/legacy.$ext"
done
# Codex round 13: a barrel that re-exposes a legacy module WHOLESALE counts like `export *`
# does — `export = mod`, `export default mod`, `export * as ns`. (A baselined source
# declaration plus a fresh barrel is drift: the barrel is what the gate names.)
R15=$(fresh_root o)
printf 'export interface FieldMapping { x: string }\n' > "$R15/src/other/legacy.ts"
expect_exit "init a root holding a baselined legacy declaration" 0 "$(run_gate "$R15" --init)"
expect_exit "baselined declaration alone passes" 0 "$(run_gate "$R15")"
printf "import legacy = require('./legacy');\nexport = legacy;\n" > "$R15/src/other/barrel.ts"
expect_exit "export = of a required legacy module blocks (wholesale re-exposure)" 1 "$(run_gate "$R15")"
grep -q 'src/other/barrel.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: export = barrel not named"; FAILURES=$((FAILURES + 1)); }
printf "import * as legacy from './legacy';\nexport default legacy;\n" > "$R15/src/other/barrel.ts"
expect_exit "export default of a namespace-imported legacy module blocks" 1 "$(run_gate "$R15")"
printf "export * as ns from './legacy';\n" > "$R15/src/other/barrel.ts"
expect_exit "export * as ns from a legacy module blocks" 1 "$(run_gate "$R15")"
printf "import * as legacy from './legacy';\nexport const x = legacy;\n" > "$R15/src/other/barrel.ts"
expect_exit "a VALUE binding of the namespace passes (types are not reachable through a const)" 0 "$(run_gate "$R15")"
# Codex round 14: the other spellings of a wholesale barrel, and a member picked off one.
printf "import * as legacy from './legacy';\nexport { legacy };\n" > "$R15/src/other/barrel.ts"
expect_exit "export { legacy } of a namespace-imported legacy module blocks" 1 "$(run_gate "$R15")"
printf "import * as legacy from './legacy';\nexport { legacy as lg };\n" > "$R15/src/other/barrel.ts"
expect_exit "export { legacy as lg } blocks too" 1 "$(run_gate "$R15")"
printf "import legacy = require('./legacy');\nexport { legacy };\n" > "$R15/src/other/barrel.ts"
expect_exit "export { legacy } of a required legacy module blocks" 1 "$(run_gate "$R15")"
printf "import * as legacy from './legacy';\nexport default legacy.FieldMapping;\n" > "$R15/src/other/barrel.ts"
expect_exit "export default legacy.FieldMapping blocks (the member is the declaration)" 1 "$(run_gate "$R15")"
grep -q 'src/other/barrel.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: member re-export not named"; FAILURES=$((FAILURES + 1)); }
printf "import * as legacy from './legacy';\nexport = legacy.FieldMapping;\n" > "$R15/src/other/barrel.ts"
expect_exit "export = legacy.FieldMapping blocks" 1 "$(run_gate "$R15")"
printf "import * as legacy from './legacy';\nexport default legacy.Other;\n" > "$R15/src/other/barrel.ts"
expect_exit "export default legacy.Other passes (control)" 0 "$(run_gate "$R15")"
rm "$R15/src/other/barrel.ts"
# A baselined declaration living in pkg/index.mts, then a fresh directory barrel over it.
R16=$(fresh_root p)
mkdir -p "$R16/src/other/pkg"
printf 'export interface TransformationRule { legacy: true }\n' > "$R16/src/other/pkg/index.mts"
expect_exit "init a root whose baselined declaration lives in index.mts" 0 "$(run_gate "$R16" --init)"
printf "export * from './pkg';\n" > "$R16/src/other/barrel.ts"
expect_exit "a directory barrel resolved through index.mts blocks" 1 "$(run_gate "$R16")"
grep -q 'src/other/barrel.ts#TransformationRule' "$TMP_DIR/out.txt" || { echo "FAIL: index.mts barrel not named"; FAILURES=$((FAILURES + 1)); }
rm "$R16/src/other/barrel.ts"
# Codex round 15: `export { legacy as default } from './b1'` where b1 has `export * as legacy from './legacy'`.
R17=$(fresh_root q)
printf 'export interface FieldMapping { x: string }\n' > "$R17/src/other/legacy.ts"
printf "export * as legacy from './legacy';\nexport const other = 1;\n" > "$R17/src/other/b1.ts"
expect_exit "init a root with a baselined declaration and a baselined namespace barrel over it" 0 "$(run_gate "$R17" --init)"
printf "export { legacy as default } from './b1';\n" > "$R17/src/other/b2.ts"
expect_exit "a named re-export of a namespace export blocks (barrel of a barrel)" 1 "$(run_gate "$R17")"
grep -q 'src/other/b2.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: barrel-of-a-barrel not named"; FAILURES=$((FAILURES + 1)); }
printf "export { legacy } from './b1';\n" > "$R17/src/other/b2.ts"
expect_exit "...under its own name too" 1 "$(run_gate "$R17")"
printf "import { legacy } from './b1';\nexport { legacy as lg };\n" > "$R17/src/other/b2.ts"
expect_exit "...and through a local import of the namespace export" 1 "$(run_gate "$R17")"
printf "export { other } from './b1';\n" > "$R17/src/other/b2.ts"
expect_exit "a named re-export of a non-namespace member passes (control)" 0 "$(run_gate "$R17")"
rm "$R17/src/other/b2.ts"
# Codex round 16: `export * from` carries a namespace export onward, and barrels may form a cycle.
printf "export * from './b1';\n" > "$R17/src/other/b2.ts"
printf "export { legacy } from './b2';\n" > "$R17/src/other/b3.ts"
expect_exit "a namespace export carried through export * then named re-exported blocks" 1 "$(run_gate "$R17")"
grep -q 'src/other/b3.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: export-star chain not named"; FAILURES=$((FAILURES + 1)); }
rm "$R17/src/other/b2.ts" "$R17/src/other/b3.ts"
R18=$(fresh_root r)
printf 'export interface FieldMapping { x: string }\n' > "$R18/src/other/legacy.ts"
printf "export * from './b';\nexport * as legacy from './legacy';\n" > "$R18/src/other/a.ts"
printf "export * from './a';\nexport const fromB = 1;\n" > "$R18/src/other/b.ts"
expect_exit "init a root whose barrels a and b form a cycle" 0 "$(run_gate "$R18" --init)"
printf "export { legacy } from './b';\n" > "$R18/src/other/c.ts"
expect_exit "a namespace export reached around a barrel cycle blocks" 1 "$(run_gate "$R18")"
grep -q 'src/other/c.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: cycle-carried namespace not named"; FAILURES=$((FAILURES + 1)); }
rm "$R18/src/other/c.ts"
# Codex round 17: an EXPLICIT export beats a later `export *` of the same name (TypeScript's
# precedence); the gate had let the star export overwrite it, hiding the legacy target.
R19=$(fresh_root s)
printf 'export interface FieldMapping { x: string }\n' > "$R19/src/other/legacy.ts"
printf 'export const unrelated = 1;\n' > "$R19/src/other/unrelated.ts"
printf "export * as legacy from './unrelated';\n" > "$R19/src/other/other.ts"
printf "export * as legacy from './legacy';\nexport * from './other';\n" > "$R19/src/other/x.ts"
expect_exit "init a root where x explicitly exports legacy and also star-exports a module with its own legacy" 0 "$(run_gate "$R19" --init)"
printf "export { legacy } from './x';\n" > "$R19/src/other/y.ts"
expect_exit "the explicit namespace export wins over the star export: y blocks" 1 "$(run_gate "$R19")"
grep -q 'src/other/y.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: explicit-over-star not named"; FAILURES=$((FAILURES + 1)); }
rm "$R19/src/other/y.ts"
# Codex round 17: an alias chain that winds around a barrel cycle needs one walk per hop;
# a fixed pass ceiling froze it. Ten hops here.
R20=$(fresh_root t)
printf 'export interface FieldMapping { x: string }\n' > "$R20/src/other/legacy.ts"
# Forty hops, alternating files: even aliases live in a, odd in b (a six-pass ceiling let eleven through).
{ printf "export * as l0 from './legacy';\n"; for i in $(seq 1 2 39); do printf "export { l%d as l%d } from './b';\n" "$i" "$((i + 1))"; done; } > "$R20/src/other/a.ts"
{ for i in $(seq 0 2 38); do printf "export { l%d as l%d } from './a';\n" "$i" "$((i + 1))"; done; } > "$R20/src/other/b.ts"
expect_exit "init a root whose barrels alias a namespace forty hops around a cycle" 0 "$(run_gate "$R20" --init)"
printf "export { l40 } from './a';\n" > "$R20/src/other/y.ts"
expect_exit "a namespace aliased forty hops around a cycle still resolves: y blocks" 1 "$(run_gate "$R20")"
grep -q 'src/other/y.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: forty-hop alias chain not named"; FAILURES=$((FAILURES + 1)); }
rm "$R20/src/other/y.ts"
# Codex round 18: a module's OWN explicit export shadows a same-named name arriving via
# `export *`, so the legacy namespace behind it is not reachable through that module;
# and `export *` never carries a DEFAULT export onward.
R21=$(fresh_root u)
printf 'export interface FieldMapping { x: string }\n' > "$R21/src/other/legacy.ts"
printf "export * as legacy from './legacy';\n" > "$R21/src/other/m.ts"
printf "import * as legacy from './legacy';\nexport default legacy;\n" > "$R21/src/other/d.ts"
expect_exit "init a root with a baselined namespace barrel m and a baselined default barrel d" 0 "$(run_gate "$R21" --init)"
printf "export * from './m';\n" > "$R21/src/other/x.ts"
expect_exit "x: export * from m re-exposes legacy (control)" 1 "$(run_gate "$R21")"
printf "export const legacy = 1;\nexport * from './m';\n" > "$R21/src/other/x.ts"
expect_exit "x's own explicit legacy shadows m's namespace: x passes" 0 "$(run_gate "$R21")"
printf "export { legacy } from './x';\n" > "$R21/src/other/y.ts"
expect_exit "...and y re-exporting x's legacy (the const) passes too" 0 "$(run_gate "$R21")"
rm "$R21/src/other/y.ts"
printf "export * from './d';\n" > "$R21/src/other/x.ts"
expect_exit "export * from d does not carry d's DEFAULT onward: x passes" 0 "$(run_gate "$R21")"
rm "$R21/src/other/x.ts"
# Codex round 18: two star exports naming the same namespace differently must not keep the
# walk growing forever — first wins, and the gate finishes.
R22=$(fresh_root v)
printf 'export interface FieldMapping { x: string }\n' > "$R22/src/other/legacy.ts"
printf 'export const unrelated = 1;\n' > "$R22/src/other/unrelated.ts"
printf "export * as legacy from './legacy';\n" > "$R22/src/other/m1.ts"
printf "export * as legacy from './unrelated';\n" > "$R22/src/other/m2.ts"
printf "export * from './m1';\nexport * from './m2';\n" > "$R22/src/other/x.ts"
expect_exit "init a root whose barrel x star-exports two conflicting namespaces" 0 "$(run_gate "$R22" --init)"
printf "export { legacy } from './x';\n" > "$R22/src/other/y.ts"
rc_conf=$(timeout 30 node "$SCRIPT" --root "$R22" >"$TMP_DIR/out.txt" 2>&1; echo $?)
[ "$rc_conf" != "124" ] || { echo "FAIL: conflicting star exports did not terminate"; FAILURES=$((FAILURES + 1)); }
expect_exit "conflicting star exports settle (first wins) and the legacy one blocks" 1 "$rc_conf"
rm "$R22/src/other/y.ts"
# Codex round 19: a default-exported declaration is the binding 'default' (it shadows
# nothing named after it, and it never travels through export *); a module reached under
# two aliases is walked for each; destructured exports are explicit too.
R23=$(fresh_root w)
printf 'export interface FieldMapping { x: string }\n' > "$R23/src/other/legacy.ts"
printf 'export default class FieldMapping { x = 1 }\n' > "$R23/src/other/legacy2.ts"
printf "export * as f from './legacy';\n" > "$R23/src/other/mf.ts"
printf "export * as legacy from './legacy';\n" > "$R23/src/other/m.ts"
printf "export * as a from './legacy';\nexport * as b from './legacy';\n" > "$R23/src/other/twice.ts"
expect_exit "init a root with baselined legacy, a default-only legacy2, and barrels mf, m, twice" 0 "$(run_gate "$R23" --init)"
printf "export default function f() {}\nexport * from './mf';\n" > "$R23/src/other/x.ts"
expect_exit "export default function f does not shadow a star-exported namespace f: x blocks" 1 "$(run_gate "$R23")"
grep -q 'src/other/x.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: default-function case not named"; FAILURES=$((FAILURES + 1)); }
printf "export * from './legacy2';\n" > "$R23/src/other/x.ts"
expect_exit "export * never carries a default-exported class: x passes" 0 "$(run_gate "$R23")"
printf "export const a = 1;\nexport * from './twice';\n" > "$R23/src/other/x.ts"
expect_exit "shadowing alias a still leaves alias b of the same module reachable: x blocks" 1 "$(run_gate "$R23")"
grep -q 'src/other/x.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: second-alias case not named"; FAILURES=$((FAILURES + 1)); }
printf "export const { legacy } = { legacy: 1 };\nexport * from './m';\n" > "$R23/src/other/x.ts"
expect_exit "a destructured explicit export shadows the star-exported namespace: x passes" 0 "$(run_gate "$R23")"
rm "$R23/src/other/x.ts"
# Codex round 20: `export { FieldMapping as default }` exposes the declaration under the alias —
# locally and from a module — and a downstream `export *` still does not carry the default.
R24=$(fresh_root x)
expect_exit "init an empty root x" 0 "$(run_gate "$R24" --init)"
printf 'class FieldMapping { x = 1 }\nexport { FieldMapping as default };\n' > "$R24/src/other/local.ts"
expect_exit "a local declaration exported only as default blocks" 1 "$(run_gate "$R24")"
grep -q 'src/other/local.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: local as-default not named"; FAILURES=$((FAILURES + 1)); }
rm "$R24/src/other/local.ts"
R24=$(fresh_root x2)
printf 'export interface FieldMapping { x: string }\n' > "$R24/src/other/legacy.ts"
expect_exit "init a root with a baselined legacy declaration" 0 "$(run_gate "$R24" --init)"
printf "export { FieldMapping as default } from './legacy';\n" > "$R24/src/other/d.ts"
expect_exit "a module re-exporting the declaration as default blocks" 1 "$(run_gate "$R24")"
grep -q 'src/other/d.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: as-default re-export not named"; FAILURES=$((FAILURES + 1)); }
rm "$R24/src/other/d.ts" "$R24/.mapping-contract-declarations-baseline"
printf "export { FieldMapping as default } from './legacy';\n" > "$R24/src/other/d.ts"
expect_exit "re-init with d baselined" 0 "$(run_gate "$R24" --init)"
printf "export * from './d';\n" > "$R24/src/other/x.ts"
expect_exit "export * from d does not carry the as-default re-export: x passes" 0 "$(run_gate "$R24")"
rm "$R24/src/other/x.ts"
# Codex round 20: a 16-layer two-way diamond (50 files, 65,536 root-to-leaf paths) over ONE declaration must finish fast and
# count the root's exposure ONCE, not once per path.
R25=$(fresh_root y)
printf 'export interface FieldMapping { x: string }\n' > "$R25/src/other/leaf.ts"
printf "export * from './leaf';\n" > "$R25/src/other/l16.ts"
for i in $(seq 15 -1 0); do
  n=$((i + 1))
  printf "export * from './l%da';\nexport * from './l%db';\n" "$n" "$n" > "$R25/src/other/l$i.ts"
  printf "export * from './l%d';\n" "$n" > "$R25/src/other/l${n}a.ts"
  printf "export * from './l%d';\n" "$n" > "$R25/src/other/l${n}b.ts"
done
start_ms=$(date +%s%3N)
rc_dia=$(timeout 60 node "$SCRIPT" --root "$R25" --init >"$TMP_DIR/out.txt" 2>&1; echo $?)
elapsed_ms=$(( $(date +%s%3N) - start_ms ))
expect_exit "a 16-layer diamond initialises" 0 "$rc_dia"
[ "$elapsed_ms" -lt 10000 ] || { echo "FAIL: diamond took ${elapsed_ms} ms"; FAILURES=$((FAILURES + 1)); }
root_count=$(grep -c '^src/other/l0.ts#' "$R25/.mapping-contract-declarations-baseline")
[ "$root_count" = "1" ] || { echo "FAIL: the diamond root was counted $root_count times, not once"; FAILURES=$((FAILURES + 1)); }
echo "PASS: 16-layer diamond in ${elapsed_ms} ms, root counted once"
# Codex round 21: two DIFFERENT declarations arriving under one binding stay two entries (retiring
# either source must move the barrel's baseline); a top-level `import X = Ns.Y` alias is a local
# declaration; a private nested declaration does not make an imported canonical binding local.
R26=$(fresh_root z)
printf 'export interface FieldMapping { a: string }\n' > "$R26/src/other/a.ts"
printf 'export interface FieldMapping { b: string }\n' > "$R26/src/other/b.ts"
printf "export * from './a';\nexport * from './b';\n" > "$R26/src/other/barrel.ts"
expect_exit "init a root whose barrel star-exports two different FieldMapping declarations" 0 "$(run_gate "$R26" --init)"
two=$(grep -c '^src/other/barrel.ts#FieldMapping' "$R26/.mapping-contract-declarations-baseline")
[ "$two" = "2" ] || { echo "FAIL: the barrel exposes two declarations but was baselined with $two"; FAILURES=$((FAILURES + 1)); }
# ...and ONE declaration reached through a named re-export in one barrel and a star export of the
# source in another is one entry for the barrel that merges them (the named re-export must carry
# the source declaration's own identity, not a synthetic one).
printf "export { FieldMapping } from './a';\n" > "$R26/src/other/named.ts"
printf "export * from './named';\nexport * from './a';\n" > "$R26/src/other/merged.ts"
rm "$R26/.mapping-contract-declarations-baseline"
expect_exit "re-init with a barrel merging a named re-export and a star export of one declaration" 0 "$(run_gate "$R26" --init)"
one=$(grep -c '^src/other/merged.ts#FieldMapping' "$R26/.mapping-contract-declarations-baseline")
[ "$one" = "1" ] || { echo "FAIL: one declaration reached two ways was baselined $one times"; FAILURES=$((FAILURES + 1)); }
rm "$R26/src/other/named.ts" "$R26/src/other/merged.ts"
# Codex round 22: renaming a NON-legacy symbol to a legacy name across a module still counts.
printf 'export interface Plain { p: 1 }\n' > "$R26/src/other/plain.ts"
rm "$R26/.mapping-contract-declarations-baseline"
expect_exit "re-init with a plain declaration" 0 "$(run_gate "$R26" --init)"
printf "export { Plain as FieldMapping } from './plain';\n" > "$R26/src/other/rename.ts"
expect_exit "renaming a non-legacy symbol to FieldMapping across a module blocks" 1 "$(run_gate "$R26")"
grep -q 'src/other/rename.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: cross-module rename not named"; FAILURES=$((FAILURES + 1)); }
rm "$R26/src/other/rename.ts" "$R26/src/other/plain.ts"
# Codex round 23 (broad pass): a star export spelled with a newline, double space or a comment is
# still a star export; a namespace named a watched name is a declaration; the binding of
# `export * as FieldMapping` carries the watched name itself.
R28=$(fresh_root aa)
printf 'export interface FieldMapping { x: string }\n' > "$R28/src/other/legacy.ts"
printf 'export const plain = 1;\n' > "$R28/src/other/plain.ts"
expect_exit "init a root with a baselined legacy declaration and a plain module" 0 "$(run_gate "$R28" --init)"
printf "export\n* from './legacy';\n" > "$R28/src/other/barrel.ts"
expect_exit "export<newline>* from legacy blocks" 1 "$(run_gate "$R28")"
printf "export  * from './legacy';\n" > "$R28/src/other/barrel.ts"
expect_exit "export<two spaces>* from legacy blocks" 1 "$(run_gate "$R28")"
printf "export /* gap */ * from './legacy';\n" > "$R28/src/other/barrel.ts"
expect_exit "export /* comment */ * from legacy blocks" 1 "$(run_gate "$R28")"
rm "$R28/src/other/barrel.ts"
printf 'export namespace FieldMapping { export const x = 1 }\n' > "$R28/src/other/ns.ts"
expect_exit "an exported namespace named FieldMapping blocks" 1 "$(run_gate "$R28")"
grep -q 'src/other/ns.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: exported namespace not named"; FAILURES=$((FAILURES + 1)); }
printf 'namespace TransformationRule { export const x = 1 }\n' > "$R28/src/other/ns.ts"
expect_exit "a script-global namespace named TransformationRule blocks" 1 "$(run_gate "$R28")"
printf 'namespace TransformationRule { export const x = 1 }\nexport {};\n' > "$R28/src/other/ns.ts"
expect_exit "a module-local namespace named TransformationRule passes (control)" 0 "$(run_gate "$R28")"
rm "$R28/src/other/ns.ts"
printf "export * as FieldMapping from './plain';\n" > "$R28/src/other/nsx.ts"
expect_exit "export * as FieldMapping binds the watched name: blocks" 1 "$(run_gate "$R28")"
grep -q 'src/other/nsx.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: namespace binding not named"; FAILURES=$((FAILURES + 1)); }
printf "export type * as TransformationRule from './plain';\n" > "$R28/src/other/nsx.ts"
expect_exit "export type * as TransformationRule blocks" 1 "$(run_gate "$R28")"
printf "export * as other from './plain';\n" > "$R28/src/other/nsx.ts"
expect_exit "export * as other of a plain module passes (control)" 0 "$(run_gate "$R28")"
rm "$R28/src/other/nsx.ts"
# Codex round 24: a wholesale re-exposure of the CANONICAL module is not legacy — only the
# binding name of `export * as FieldMapping` counts, and `export * from` it counts nothing.
printf "export * as FieldMapping from '../domain/mapping/MappingContract';\n" > "$R28/src/other/canon.ts"
expect_exit "export * as FieldMapping from the canonical module blocks for the binding only" 1 "$(run_gate "$R28")"
canon_n=$(grep -c 'src/other/canon.ts#' "$TMP_DIR/out.txt")
[ "$canon_n" = "1" ] || { echo "FAIL: the canonical namespace binding was counted $canon_n times, not once"; FAILURES=$((FAILURES + 1)); }
grep -q 'src/other/canon.ts#TransformationRule' "$TMP_DIR/out.txt" && { echo "FAIL: canonical members leaked into the count"; FAILURES=$((FAILURES + 1)); }
printf "export * from '../domain/mapping/MappingContract';\n" > "$R28/src/other/canon.ts"
expect_exit "export * from the canonical module passes (the contract is not legacy)" 0 "$(run_gate "$R28")"
rm "$R28/src/other/canon.ts"
R27=$(fresh_root z2)
printf 'export namespace Legacy { export interface FieldMapping { x: string } }\n' > "$R27/src/other/legacy-ns.ts"
expect_exit "init a root with a baselined namespace-scoped declaration" 0 "$(run_gate "$R27" --init)"
printf "import { Legacy } from './legacy-ns';\nimport FieldMapping = Legacy.FieldMapping;\nexport { FieldMapping as default };\n" > "$R27/src/other/consumer.ts"
expect_exit "a top-level import-equals alias exported as default blocks" 1 "$(run_gate "$R27")"
grep -q 'src/other/consumer.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: import-equals alias not named"; FAILURES=$((FAILURES + 1)); }
printf "import type { FieldMapping } from '../types';\nnamespace Private { interface FieldMapping { p: 1 } }\nexport type { FieldMapping as default };\n" > "$R27/src/other/consumer.ts"
expect_exit "a private nested declaration does not make the imported canonical alias local: passes" 0 "$(run_gate "$R27")"
rm "$R27/src/other/consumer.ts"
# ---- 11j. a declaration nested in an ambient module counts (Codex round 8) -------------
R12=$(fresh_root l)
expect_exit "init clean root l" 0 "$(run_gate "$R12" --init)"
printf 'declare module "legacy" { export interface FieldMapping { x: string } }\n' > "$R12/src/other/ambient.d.ts"
expect_exit "declaration inside an ambient module blocks" 1 "$(run_gate "$R12")"
grep -q 'src/other/ambient.d.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: ambient declaration not named"; FAILURES=$((FAILURES + 1)); }
printf 'declare namespace Legacy { export interface FieldMapping { x: string } }\n' > "$R12/src/other/ambient.d.ts"
expect_exit "declaration inside a namespace blocks" 1 "$(run_gate "$R12")"
rm "$R12/src/other/ambient.d.ts"

# ---- 11k. IMPLICIT exports inside ambient modules and global augmentations (Codex round 9)
R13=$(fresh_root m)
expect_exit "init clean root m" 0 "$(run_gate "$R13" --init)"
printf 'declare module "legacy" { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.d.ts"
expect_exit "unexported interface inside an ambient module blocks (implicitly exported)" 1 "$(run_gate "$R13")"
printf 'declare global { interface FieldMapping { x: string } }\nexport {};\n' > "$R13/src/other/implicit.d.ts"
expect_exit "interface inside declare global blocks" 1 "$(run_gate "$R13")"
# Codex round 11: TypeScript exports every member of an AMBIENT namespace without the
# keyword — `declare namespace`, any namespace in a .d.ts, any namespace nested in an
# ambient module — even when a sibling carries an explicit `export`. Only a non-ambient
# `namespace` in a .ts file scopes its members. (Verified against the compiler API.)
printf 'declare namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.d.ts"
expect_exit "unexported interface inside a declare namespace BLOCKS (ambient members are exported)" 1 "$(run_gate "$R13")"
printf 'namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.d.ts"
expect_exit "unexported interface inside a namespace in a .d.ts BLOCKS (the file is ambient)" 1 "$(run_gate "$R13")"
printf 'declare namespace Legacy { export interface Other { y: 1 } interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.d.ts"
expect_exit "an explicitly exported sibling does not make the rest private in an ambient namespace" 1 "$(run_gate "$R13")"
printf 'declare module "legacy" { namespace N { interface FieldMapping { x: string } } }\n' > "$R13/src/other/implicit.d.ts"
expect_exit "unexported interface inside a namespace nested in an ambient module BLOCKS" 1 "$(run_gate "$R13")"
rm "$R13/src/other/implicit.d.ts"
printf 'declare namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.ts"
expect_exit "declare namespace in a script .ts blocks (global and ambient)" 1 "$(run_gate "$R13")"
printf 'namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.ts"
expect_exit "unexported interface inside a NON-ambient namespace in a .ts passes (the only private case)" 0 "$(run_gate "$R13")"
printf 'namespace Legacy { interface FieldMapping { x: string } }\nexport {};\n' > "$R13/src/other/implicit.ts"
expect_exit "...and inside a module file too" 0 "$(run_gate "$R13")"
printf 'declare namespace Legacy { interface FieldMapping { x: string } }\nexport {};\n' > "$R13/src/other/implicit.ts"
expect_exit "a declare namespace that is itself unexported from a MODULE file passes (unreachable)" 0 "$(run_gate "$R13")"
printf 'export declare namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.ts"
expect_exit "an exported declare namespace from a module file blocks (reachable, ambient)" 1 "$(run_gate "$R13")"
rm "$R13/src/other/implicit.ts"
# Codex round 12: a .d.ts WITH import/export is a module — its top-level locals are private
# (compiler: "Cannot find name"), while an exported namespace inside it is still ambient.
printf 'export {};\ninterface FieldMapping { x: string }\n' > "$R13/src/other/modular.d.ts"
expect_exit "an unexported interface in a MODULE .d.ts passes (module-local)" 0 "$(run_gate "$R13")"
printf 'export namespace N { interface FieldMapping { x: string } }\n' > "$R13/src/other/modular.d.ts"
expect_exit "an unexported member of an EXPORTED namespace in a module .d.ts blocks (ambient by file)" 1 "$(run_gate "$R13")"
printf 'export {};\nnamespace N { interface FieldMapping { x: string } }\n' > "$R13/src/other/modular.d.ts"
expect_exit "an unexported namespace in a module .d.ts passes (unreachable)" 0 "$(run_gate "$R13")"
rm "$R13/src/other/modular.d.ts"
# Codex round 12: `export =` and `export default` expose a local declaration too.
printf 'class FieldMapping { x = 1 }\nexport = FieldMapping;\n' > "$R13/src/other/assign.ts"
expect_exit "export = of a local FieldMapping blocks" 1 "$(run_gate "$R13")"
grep -q 'src/other/assign.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: export = declaration not named"; FAILURES=$((FAILURES + 1)); }
printf 'interface FieldMapping { x: string }\nexport default FieldMapping;\n' > "$R13/src/other/assign.ts"
expect_exit "export default of a local FieldMapping blocks" 1 "$(run_gate "$R13")"
printf 'namespace Legacy { export interface FieldMapping { x: string } }\nexport = Legacy;\n' > "$R13/src/other/assign.ts"
expect_exit "export = of a namespace with an exported FieldMapping blocks (reachable through the assignment)" 1 "$(run_gate "$R13")"
printf 'namespace Legacy { interface FieldMapping { x: string } }\nexport = Legacy;\n' > "$R13/src/other/assign.ts"
expect_exit "export = of a non-ambient namespace with an UNexported member passes" 0 "$(run_gate "$R13")"
printf 'class Other { x = 1 }\nexport = Other;\n' > "$R13/src/other/assign.ts"
expect_exit "export = of an unrelated name passes (control)" 0 "$(run_gate "$R13")"
rm "$R13/src/other/assign.ts"
printf 'declare namespace Legacy { interface FieldMapping { x: string } }\n' > "$R13/src/other/implicit.d.ts"
rm "$R13/src/other/implicit.d.ts"
# ---- 11l. a NON-MODULE file (no import/export) declares GLOBALS (Codex round 10) ---------
R14=$(fresh_root n)
expect_exit "init clean root n" 0 "$(run_gate "$R14" --init)"
printf 'interface FieldMapping { legacy: true }\n' > "$R14/src/other/global.d.ts"
expect_exit "unexported interface in a script .d.ts blocks (global)" 1 "$(run_gate "$R14")"
grep -q 'src/other/global.d.ts#FieldMapping' "$TMP_DIR/out.txt" || { echo "FAIL: global .d.ts declaration not named"; FAILURES=$((FAILURES + 1)); }
rm "$R14/src/other/global.d.ts"
printf 'type TransformationRule = { legacy: true };\n' > "$R14/src/other/global.ts"
expect_exit "unexported type alias in a script .ts blocks (global)" 1 "$(run_gate "$R14")"
printf 'type TransformationRule = { legacy: true };\nexport {};\n' > "$R14/src/other/global.ts"
expect_exit "the same alias in a MODULE file passes (module-scoped, not exported)" 0 "$(run_gate "$R14")"
rm "$R14/src/other/global.ts"
# ---- 12. missing src/ -> 2; missing baseline without --init -> 2 -------------------------
mkdir -p "$TMP_DIR/nosrc"
expect_exit "missing src/ is an environment error" 2 "$(run_gate "$TMP_DIR/nosrc")"
R3=$(fresh_root c)
expect_exit "missing baseline without --init is an environment error" 2 "$(run_gate "$R3")"

echo
if [ "$FAILURES" -eq 0 ]; then echo "check-mapping-contract-declarations.test.sh: all scenarios passed"; exit 0; else
  echo "check-mapping-contract-declarations.test.sh: $FAILURES failure(s)"; exit 1; fi
