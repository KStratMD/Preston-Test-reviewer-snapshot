#!/usr/bin/env node
/**
 * Shrink-only gate on legacy `FieldMapping` / `TransformationRule` declarations
 * (tranche 2, Workstream A, Task A4).
 *
 * The canonical contract is `src/domain/mapping/MappingContract.ts`, which
 * re-exports the runtime pair from `src/types/index.ts`. Other modules declared
 * their own `FieldMapping` / `TransformationRule` before the contract existed;
 * they are baselined here and may only retire. A NEW declaration anywhere else
 * under `src/` fails the gate.
 *
 * The baseline is per DECLARATION, `path#Name`, with `#2`, `#3` … for repeated
 * declarations of one name in one file (Codex on PR #1253: a per-file baseline
 * let a listed file gain a second legacy name unnoticed, and a per-name set let
 * it gain a merged second declaration of the same name).
 *
 * Detection is on the TypeScript AST, not a regex (Codex Z-05): a regex misses
 * `export { Foo as FieldMapping }` and `export\n  interface FieldMapping`. A
 * declaration counts when, at the module's top level, there is:
 *   - an exported `interface`, `type` alias, `class`, `enum`, or `import X = Ns.Y`
 *     alias with one of the names, or
 *   - an `export { ... }` / `export type { ... }` whose EXPORTED alias is one of
 *     those names (`element.name`, never `element.propertyName`), or
 *   - an `export * from './relative'` whose target module (resolved, followed
 *     recursively with a cycle guard) declares one of those names — a barrel
 *     exposes the legacy name without ever spelling it (Codex round 3).
 * Excluded (Codex AB-02): `src/types/index.ts` (the runtime type) and the
 * canonical module itself, which re-exports both names on purpose.
 *
 * Exit codes: 0 clean; 1 drift (new declaration, or a baseline entry that has
 * retired and must be removed); 2 environment error (missing src/, --init
 * when a baseline exists, missing baseline without --init).
 *
 *   --root <dir>   repository root (default: the script's parent directory)
 *   --init         write the baseline ONCE (refuses if it already exists)
 *   --write        shrink the baseline: keep only entries still detected
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const NAMES = new Set(['FieldMapping', 'TransformationRule']);
const EXCLUDED = new Set(['src/types/index.ts', 'src/domain/mapping/MappingContract.ts']);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const ROOT = argValue('--root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BASELINE = path.join(ROOT, '.mapping-contract-declarations-baseline');
const INIT = process.argv.includes('--init');
const WRITE = process.argv.includes('--write');

if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
  console.error(`[mapping-contract] missing src/ under ${ROOT}`);
  process.exit(2);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    // .d.ts files are compiled too (Codex round 7): an ambient `export interface FieldMapping` counts.
    // ... and .mts/.cts (with their .d.mts/.d.cts) compile under src/**/* too (Codex round 13).
    return /\.(ts|tsx|mts|cts)$/.test(e.name) ? [p] : [];
  });
}

function hasExportModifier(node) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}
/** Every identifier a binding name introduces — through object/array destructuring too (Codex round 19). */
function bindingIdentifiers(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (ts.isBindingElement(el)) bindingIdentifiers(el.name, out);
  }
  return out;
}

/** Resolve a relative module specifier to a .ts/.tsx file, or null. */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // packages are not in scope
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.(js|mjs|cjs)$/, ''));
  for (const cand of [base + '.ts', base + '.tsx', base + '.mts', base + '.cts', base + '.d.ts', base + '.d.mts', base + '.d.cts', path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.mts'), path.join(base, 'index.cts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/**
 * The legacy names this module declares or re-exports at top level, one entry
 * per DECLARATION (Codex on PR #1253: interface declaration merging lets a file
 * declare the same name twice; a set would collapse that), sorted. A star
 * export contributes the names its target exposes (Codex round 3).
 */
/**
 * The NAMESPACE exports of a module: exported name -> the file that namespace
 * is a whole-module binding of. `export * as X from './m'`, and `export { X [as
 * Y] }` of `import * as X` / `import X = require`, and `export { X as Y } from
 * './m'` where X is a namespace export of m (Codex round 15: a barrel of a
 * barrel, `export { legacy as default } from './b1'`).
 */
// Maps only ever GROW, and the whole computation is iterated to a fixpoint, so
// a cycle between barrels (a -> b -> a) and a namespace carried through
// `export * from` (Codex round 16) both resolve: a cycle hit returns the map
// so far, and the next pass fills what the earlier one could not see.
const nsMemo = new Map();
const nsSettled = new Set();
function namespaceExportsOf(file) {
  if (nsSettled.has(file)) return nsMemo.get(file);
  // Maps only ever grow, so the walk terminates; an alias chain that winds
  // around a barrel cycle needs one walk per hop (Codex round 17: a fixed
  // ceiling froze a fourteen-hop chain). Bound only by total growth.
  for (let pass = 0; pass < 100000; pass++) {
    const grew = { value: false };
    collectNamespaceExports(file, new Set(), grew, new Set());
    if (!grew.value) break;
  }
  nsSettled.add(file);
  return nsMemo.get(file) ?? new Map();
}
// First wins: two star exports naming one namespace differently must not flip
// the entry every pass (Codex round 18 — the walk never settled). TypeScript
// treats such a conflict as ambiguous; keeping the first seen fails closed.
function mergeInto(out, key, value, grew) {
  if (!value || out.has(key)) return;
  out.set(key, value); grew.value = true;
}
/** The names a module exports EXPLICITLY (they shadow a same-named name arriving via `export *`). */
function explicitExportNames(sf) {
  const explicit = new Set();
  for (const st of sf.statements) {
    if (hasExportModifier(st)) {
      // `export default function f` / `export default class X` export the binding
      // 'default', not the local name (Codex round 19).
      if (hasDefaultModifier(st)) explicit.add('default');
      else if (st.name && ts.isIdentifier(st.name)) explicit.add(st.name.text);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) for (const n of bindingIdentifiers(d.name)) explicit.add(n);
    }
    if (ts.isExportAssignment(st)) explicit.add('default');
    if (!ts.isExportDeclaration(st) || !st.exportClause) continue;
    if (ts.isNamespaceExport(st.exportClause)) explicit.add(st.exportClause.name.text);
    if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) explicit.add(el.name.text);
  }
  return explicit;
}
function collectNamespaceExports(file, visiting, grew, done) {
  if (!nsMemo.has(file)) nsMemo.set(file, new Map());
  const out = nsMemo.get(file);
  if (visiting.has(file) || done.has(file) || nsSettled.has(file)) return out;
  visiting.add(file);
  const sub = (target) => (target ? collectNamespaceExports(target, visiting, grew, done) : new Map());
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings = new Map();
  for (const st of sf.statements) {
    if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) bindings.set(st.name.text, resolveRelative(file, st.moduleReference.expression.text));
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isStringLiteral(st.moduleSpecifier)) {
      const nb = st.importClause.namedBindings;
      if (ts.isNamespaceImport(nb)) bindings.set(nb.name.text, resolveRelative(file, st.moduleSpecifier.text));
      if (ts.isNamedImports(nb)) {
        const ns = sub(resolveRelative(file, st.moduleSpecifier.text));
        for (const el of nb.elements) { const from = (el.propertyName ?? el.name).text; if (ns.has(from)) bindings.set(el.name.text, ns.get(from)); }
      }
    }
  }
  // Explicit exports first, in a set: TypeScript gives an explicit export
  // precedence over a same-named name arriving through `export *` (Codex
  // round 17 — a later star export used to overwrite it).
  const explicit = explicitExportNames(sf);
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st)) continue;
    if (st.exportClause && ts.isNamespaceExport(st.exportClause) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      mergeInto(out, st.exportClause.name.text, resolveRelative(file, st.moduleSpecifier.text), grew);
    }
    // `export * from './m'` carries every namespace export of m onward — except names this module exports explicitly.
    if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      for (const [k, v] of sub(resolveRelative(file, st.moduleSpecifier.text))) if (!explicit.has(k)) mergeInto(out, k, v, grew);
    }
    if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolveRelative(file, st.moduleSpecifier.text) : null;
      const ns = target ? sub(target) : null;
      for (const el of st.exportClause.elements) {
        const from = (el.propertyName ?? el.name).text;
        if (ns && ns.has(from)) mergeInto(out, el.name.text, ns.get(from), grew);
        if (!target && bindings.has(from)) mergeInto(out, el.name.text, bindings.get(from), grew);
      }
    }
  }
  visiting.delete(file);
  done.add(file);
  return out;
}

function legacyNamesDeclared(file, visiting = new Map()) {
  const names = legacyEntries(file, visiting).map((e) => e.name);
  // Repeats get an occurrence suffix: FieldMapping, FieldMapping#2, ...
  const seen = new Map();
  return names.sort().map((n) => { const k = (seen.get(n) ?? 0) + 1; seen.set(n, k); return k === 1 ? n : `${n}#${k}`; });
}
/**
 * Every reachable legacy declaration this module exposes, as { name, via }:
 * `via` is the exported binding it is reachable through — the name itself, a
 * namespace/alias, or 'default' (`export =` / `export default`). `export *`
 * carries an entry onward only if this module does not export `via` itself
 * (TypeScript's explicit-export precedence; Codex round 18) and never carries
 * a default.
 */
// `visiting` is the current PATH (cycle guard) as a file -> depth map, not every
// file ever seen: a module reached under two aliases is walked for each (Codex
// round 19). A finished subtree is memoized unless a cycle cut inside it
// pointed at an ancestor still on the path — then it is incomplete and is
// recomputed next time (Codex round 20: releasing the path without a memo
// re-walked a 12-layer diamond 16,000 times).
const entriesMemo = new Map();
const cutDepths = [];
function legacyEntries(file, visiting = new Map()) {
  if (entriesMemo.has(file)) return entriesMemo.get(file);
  if (visiting.has(file)) { cutDepths.push(visiting.get(file)); return []; }
  const depth = visiting.size;
  visiting.set(file, depth);
  try {
    const entries = legacyEntriesOf(file, visiting);
    const complete = cutDepths.every((d) => d >= depth);
    for (let i = cutDepths.length - 1; i >= 0; i--) if (cutDepths[i] >= depth) cutDepths.splice(i, 1);
    if (complete) entriesMemo.set(file, entries);
    return entries;
  } finally {
    visiting.delete(file);
  }
}
function legacyEntriesOf(file, visiting) {
  const text = fs.readFileSync(file, 'utf8');
  // Cheap pre-filter, the AST decides. A `\u` escape can spell either name without
  // matching it (Codex round 5: `\u0046ieldMapping`), so any escape defeats the filter.
  // A wholesale barrel never mentions the names (Codex round 13): let those through too.
  // `export\n*`, `export  *` and `export /* gap */ *` are all star exports (Codex
  // round 23): the filter keys on the keyword, never on its spacing.
  if (!/FieldMapping|TransformationRule|\bexport\b|\bimport\b|= require\(|\\u/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const entries = [];
  // An OWN declaration is one entry per declaration (interface merging keeps
  // both); a RE-EXPOSED one is one entry per (name, binding) — reaching one
  // declaration through two barrels of a diamond is one exposure.
  // Every entry carries the IDENTITY of the declaration it stands for (the
  // declaring file plus an ordinal), so a diamond that reaches one declaration
  // twice is one exposure while two different declarations arriving under one
  // binding stay two (Codex round 21: a name-keyed dedupe collapsed them and
  // retiring either source left the barrel's baseline unchanged).
  const exposed = new Set();
  let ordinal = 0;
  const push = (name, via, id = null) => {
    const identity = id ?? `${file}#${ordinal++}`;
    if (id) { const k = identity + '\u0000' + via; if (exposed.has(k)) return; exposed.add(k); }
    entries.push({ name, via, id: identity });
  };
  const isCanonical = (abs) => EXCLUDED.has(path.relative(ROOT, abs).replace(/\\/g, '/'));
  // A wholesale re-exposure of the CANONICAL module contributes nothing — its
  // types are the contract, not legacy (Codex round 24: `export * as FieldMapping
  // from '../domain/mapping/MappingContract'` inflated one binding into three).
  const pushAll = (target, via) => { if (isCanonical(target)) return; for (const e of legacyEntries(target, visiting)) push(e.name, via ?? e.via, e.id); };
  // Ambient modules (`declare module "x" { ... }`) and namespaces carry their
  // own top level (Codex round 8): walk their bodies with the same rules.
  const statements = [];
  // Each statement carries whether it is REACHABLE from outside the file: it is
  // exported from its scope (by keyword, or implicitly) AND every enclosing
  // namespace is reachable too. Verified against the compiler API (Codex
  // rounds 9–11): TypeScript exports every member of an AMBIENT context
  // without the keyword — a .d.ts file, a script file's top level, `declare
  // module "x"`, `declare global`, `declare namespace`, and any namespace
  // nested inside one of those — even when a sibling carries an explicit
  // `export`. Only a non-ambient `namespace` in a .ts file scopes its members.
  const isDts = /\.d\.(ts|mts|cts)$/.test(file);
  const hasDeclareModifier = (node) =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  const isGlobalAugmentation = (md) => (md.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || (ts.isIdentifier(md.name) && md.name.text === 'global');
  // `export = X` and `export default X` expose the local declaration X (Codex
  // round 12): the declaration itself counts, and a namespace so assigned is
  // reachable, so its exported members count too.
  // Top-level bindings of a whole module: `import m = require('./x')` and `import * as m from './x'`.
  const moduleBindings = new Map();
  for (const st of sf.statements) {
    // `import { legacy } from './b1'` where b1 namespace-exports a module: the local name is a whole-module binding too.
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = resolveRelative(file, st.moduleSpecifier.text);
      const ns = target ? namespaceExportsOf(target) : new Map();
      for (const el of st.importClause.namedBindings.elements) {
        const from = (el.propertyName ?? el.name).text;
        if (ns.has(from)) moduleBindings.set(el.name.text, path.relative(path.dirname(file), ns.get(from)).replace(/\\/g, '/').replace(/\.(d\.)?[mc]?tsx?$/, '').replace(/^(?!\.)/, './'));
      }
    }
    if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) moduleBindings.set(st.name.text, st.moduleReference.expression.text);
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamespaceImport(st.importClause.namedBindings) && ts.isStringLiteral(st.moduleSpecifier)) moduleBindings.set(st.importClause.namedBindings.name.text, st.moduleSpecifier.text);
  }
  const exportAssigned = new Set(
    sf.statements.filter((st) => ts.isExportAssignment(st) && ts.isIdentifier(st.expression)).map((st) => st.expression.text),
  );
  const collect = (list, ctx) => {
    for (const st of list) {
      const assigned = ctx.top && ((ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) || (st.name && ts.isIdentifier(st.name))) && exportAssigned.has(st.name.text);
      const exported = ctx.implicit || hasExportModifier(st) || assigned;
      const reachable = ctx.reachable && exported;
      statements.push([st, reachable, ctx.top]);
      if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) {
        const ambient = ctx.ambient || hasDeclareModifier(st) || ts.isStringLiteral(st.name) || isGlobalAugmentation(st);
        // An ambient external module or a global augmentation is reachable on
        // its own terms (import "x" / the global scope), whatever the file exports.
        const nsReachable = reachable || ts.isStringLiteral(st.name) || isGlobalAugmentation(st);
        collect(st.body.statements, { implicit: ambient, ambient, reachable: nsReachable, top: false });
      }
    }
  };
  // A file with no import/export is a SCRIPT: its top-level declarations are
  // globals TypeScript consumes everywhere, without any `export` (Codex round 10).
  // A .d.ts WITH import/export is a module: its top-level locals are private
  // like any module's (Codex round 12), though namespaces inside it stay ambient.
  const script = !ts.isExternalModule(sf);
  collect(sf.statements, { implicit: script, ambient: isDts, reachable: true, top: true });
  const explicitHere = explicitExportNames(sf);
  // Declarations made at THIS module's top level (Codex round 21: a private
  // nested namespace's interface must not make an imported canonical binding
  // look local; an `import X = Ns.Y` alias is a local declaration too).
  const ownDeclared = new Set(
    statements.filter(([st, , top]) => top && st.name && ts.isIdentifier(st.name)
      && (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)
        || (ts.isModuleDeclaration(st) && !isGlobalAugmentation(st))
        || (ts.isImportEqualsDeclaration(st) && !ts.isExternalModuleReference(st.moduleReference))))
      .map(([st]) => st.name.text),
  );
  for (const [stmt, reachable] of statements) {
    // `export import FieldMapping = Legacy.FieldMapping` is an exported alias too (Codex round 4).
    // ... and an enum (Codex round 6): it declares a type named FieldMapping too.
    // ... and a namespace (Codex round 23): `export namespace FieldMapping { … }` declares the name too.
    const isNamedDecl = ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt) || ts.isEnumDeclaration(stmt)
      || (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name) && !isGlobalAugmentation(stmt));
    if (isNamedDecl && stmt.name && NAMES.has(stmt.name.text) && reachable) {
      const defaultOnly = hasDefaultModifier(stmt) || (exportAssigned.has(stmt.name.text) && !hasExportModifier(stmt));
      push(stmt.name.text, defaultOnly ? 'default' : stmt.name.text);
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause) && !stmt.moduleSpecifier) {
      for (const el of stmt.exportClause.elements) {
        // `export { Foo as FieldMapping }` exposes FieldMapping: judge the exported name.
        const local = (el.propertyName ?? el.name).text;
        // `export { Foo as FieldMapping }` exposes FieldMapping under that name;
        // `export { FieldMapping as default }` / `as Other` exposes the local
        // declaration under the alias (Codex round 20) — it counts either way.
        if (NAMES.has(el.name.text)) push(el.name.text, el.name.text);
        else if (NAMES.has(local) && ownDeclared.has(local)) push(local, el.name.text);
        // `export { legacy }` / `export { legacy as lg }` of a whole-module binding is a
        // wholesale barrel too (Codex round 14).
        if (moduleBindings.has(local)) {
          const target = resolveRelative(file, moduleBindings.get(local));
          if (target) pushAll(target, el.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveRelative(file, stmt.moduleSpecifier.text);
      const ns = target ? namespaceExportsOf(target) : new Map();
      for (const el of stmt.exportClause.elements) {
        const from = (el.propertyName ?? el.name).text;
        // A named re-export FROM a module stands for the entries the source exposes
        // under that name, with the source's own identities — so `export
        // { FieldMapping } from './a'` beside `export * from './a'` is one
        // declaration, not two. `export { FieldMapping as default } from './legacy'`
        // re-exposes it under the alias (Codex round 20) — unless the source is the
        // canonical module, whose types are the contract, not legacy.
        // A named re-export of a CANONICAL type — same name or aliased — is not a legacy
        // declaration (Codex round 25 closed the last inconsistency: `export { FieldMapping }
        // from '../types'` used to count while every other canonical route passed).
        if (NAMES.has(from) && target && !isCanonical(target)) {
          for (const e of legacyEntries(target, visiting)) if (e.via === from) push(e.name, el.name.text, e.id);
        } else if (NAMES.has(el.name.text) && !NAMES.has(from)) {
          // `export { X as FieldMapping } from './a'` renames a NON-legacy symbol to a
          // legacy NAME (Codex round 22 — the round-21 follow-through dropped it):
          // the source symbol's identity is the module plus its name. A watched
          // source name from the canonical module fell through here (round 25).
          push(el.name.text, el.name.text, target ? `${target}#${from}` : null);
        }
        // `export { legacy as default } from './b1'` where b1 namespace-exports a legacy
        // module: a barrel of a barrel (Codex round 15).
        if (ns.has(from)) pushAll(ns.get(from), el.name.text);
      }
    }
    // `export default legacy.FieldMapping` / `export = legacy.FieldMapping`: a member picked
    // off a whole-module binding IS the declaration (Codex round 14).
    if (ts.isExportAssignment(stmt) && ts.isPropertyAccessExpression(stmt.expression) && ts.isIdentifier(stmt.expression.expression)
      && moduleBindings.has(stmt.expression.expression.text) && NAMES.has(stmt.expression.name.text)) {
      push(stmt.expression.name.text, 'default');
    }
    // A barrel that re-exposes a legacy module WHOLESALE counts (Codex rounds 3
    // and 13): `export * from './x'`, `export * as ns from './x'`, and
    // `export = mod` / `export default mod` where mod is bound by
    // `import mod = require('./x')` or `import * as mod from './x'`.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamespaceExport(stmt.exportClause) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveRelative(file, stmt.moduleSpecifier.text);
      if (target) pushAll(target, stmt.exportClause.name.text);
      // The namespace binding itself may carry a watched name (Codex round 23):
      // `export * as FieldMapping from './plain'` exposes FieldMapping.
      if (NAMES.has(stmt.exportClause.name.text)) push(stmt.exportClause.name.text, stmt.exportClause.name.text);
    }
    if (ts.isExportDeclaration(stmt) && !stmt.exportClause && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      // `export * from './x'`: an entry travels only under a binding this module does
      // not export itself, and a default never travels (Codex round 18).
      const target = resolveRelative(file, stmt.moduleSpecifier.text);
      if (target && !isCanonical(target)) for (const e of legacyEntries(target, visiting)) if (e.via !== 'default' && !explicitHere.has(e.via)) push(e.name, e.via, e.id);
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression) && moduleBindings.has(stmt.expression.text)) {
      const target = resolveRelative(file, moduleBindings.get(stmt.expression.text));
      if (target) pushAll(target, 'default');
    }
  }
  return entries;
}

const found = walk(SRC)
  .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
  .filter((rel) => !EXCLUDED.has(rel))
  .flatMap((rel) => legacyNamesDeclared(path.join(ROOT, rel)).map((name) => `${rel}#${name}`))
  .sort();

if (INIT) {
  if (fs.existsSync(BASELINE)) {
    console.error('[mapping-contract] baseline exists; use --write to shrink');
    process.exit(2);
  }
  fs.writeFileSync(BASELINE, found.join('\n') + (found.length ? '\n' : ''));
  console.log(`[mapping-contract] baseline initialised (${found.length} declarations)`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('[mapping-contract] no baseline; run with --init once');
  process.exit(2);
}
const baseline = fs.readFileSync(BASELINE, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

if (WRITE) {
  const kept = baseline.filter((b) => found.includes(b));
  fs.writeFileSync(BASELINE, kept.join('\n') + (kept.length ? '\n' : ''));
  console.log(`[mapping-contract] baseline rewritten (${kept.length}; ${baseline.length - kept.length} retired)`);
  process.exit(0);
}

const problems = [];
for (const f of found) if (!baseline.includes(f)) problems.push(`new legacy declaration (use src/domain/mapping/MappingContract): ${f}`);
for (const b of baseline) if (!found.includes(b)) problems.push(`baseline entry retired, remove it (--write): ${b}`);
if (problems.length) {
  console.error(`[mapping-contract] FAIL (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[mapping-contract] OK (${found.length} legacy declarations baselined)`);
