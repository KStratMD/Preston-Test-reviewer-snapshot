#!/usr/bin/env node
// @ts-check
//
// check-governance-posture-reads.mjs (C3.1c)
//
// Audit gate: no file outside GovernanceService.ts may directly read
// `governance.*` keys from tenant_configurations. Posture decisions MUST
// route through GovernanceService.getPostureForTenant(tenantId).
//
// Allowlist: GovernanceService.ts itself, tests/, scripts/.
//
// Scope limitation (Copilot R5 — match check-secret-key-encryption.mjs's
// disclosure pattern): this AST walk only flags CallExpressions whose
// second argument is a STRING LITERAL starting with "governance.". It
// does NOT chase indirect cases:
//   - dynamic expressions: `repo.getString(tenantId, somePrefix + "auto_redact")`
//   - const indirection:   `const KEY = "governance.allow_pii"; repo.getString(tenantId, KEY)`
//   - template literals:   `` repo.getString(tenantId, `governance.${name}`) ``
//
// Acceptable because the same surface is enforced by code-review + the
// per-repo convention that `governance.*` literals only appear in
// GovernanceService.ts's `resolvePostureFromRepository`. If future code
// reaches for indirection, augment this walk (resolve identifiers + template
// literals) rather than relaxing the audit. The sibling check-secret-key-
// encryption.mjs carries the same scope limitation by design.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.root ?? defaultRoot);
const srcRoot = path.join(repoRoot, 'src');

const ALLOWLIST_PATH = 'src/services/ai/orchestrator/GovernanceService.ts';
const REPO_METHODS = new Set([
  'getString',
  'getBoolean',
  'getBooleanStrict',
  'getInt',
  'getSecretString',
]);
const VIOLATION_PREFIX = 'governance.';

if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
  console.error(`check-governance-posture-reads: src/ not found at ${srcRoot}`);
  process.exit(2);
}

/** @type {Array<{file: string, line: number, col: number, key: string, method: string}>} */
const findings = [];
const files = walk(srcRoot).filter(isScriptFile);

for (const file of files) {
  const rel = toPosix(path.relative(repoRoot, file));
  if (rel === ALLOWLIST_PATH) continue;
  // Defense-in-depth allowlist guard: `walk(srcRoot)` only ever returns
  // `src/**` files (so `tests/`/`scripts/` paths are structurally already
  // out of scope), but if `srcRoot` is ever broadened to the repo root in
  // a future change, this guard keeps the test scaffolding and the
  // self-referential `scripts/check-governance-posture-reads.mjs` test
  // fixtures out of the violation set. Copilot R4 — preserve as a
  // future-proof guard rather than removing the dead branch.
  if (rel.startsWith('tests/') || rel.startsWith('scripts/')) continue;

  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(file),
  );

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const callee = node.expression;
      let methodName = null;

      if (ts.isPropertyAccessExpression(callee)) {
        methodName = callee.name.escapedText;
      } else if (ts.isElementAccessExpression(callee)) {
        const arg = callee.argumentExpression;
        if (arg && (ts.isStringLiteral(arg) || arg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)) {
          methodName = /** @type {ts.StringLiteralLike} */ (arg).text;
        }
      }

      if (typeof methodName === 'string' && REPO_METHODS.has(methodName)) {
        const keyArg = node.arguments[1];
        const keyLiteral = getStringLiteralText(keyArg);
        if (keyLiteral !== null && keyLiteral.startsWith(VIOLATION_PREFIX)) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            file: rel,
            line: pos.line + 1,
            col: pos.character + 1,
            key: keyLiteral,
            method: methodName,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

if (findings.length > 0) {
  console.error('C3.1c — direct read of governance.* configuration key outside GovernanceService.ts:');
  console.error('');
  for (const v of findings) {
    console.error(`  ${v.file}:${v.line}:${v.col}  called ${v.method} with key="${v.key}"`);
  }
  console.error('');
  console.error('Posture decisions MUST route through GovernanceService.getPostureForTenant(tenantId).');
  process.exit(1);
}

console.log(
  `✓ check-governance-posture-reads: AST-scanned ${files.length} src/ file(s); no direct governance.* reads outside GovernanceService.ts`,
);

// --- helpers ---------------------------------------------------------------

/**
 * Extract the .text of a string-literal-like expression, or null if the
 * argument is dynamic.
 * @param {ts.Node} node
 */
function getStringLiteralText(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return /** @type {ts.StringLiteralLike} */ (node).text;
  }
  return null;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ root?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('Usage: node scripts/check-governance-posture-reads.mjs [--root <repo-root>]');
        process.exit(2);
      }
      out.root = value;
      i++;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    console.error('Usage: node scripts/check-governance-posture-reads.mjs [--root <repo-root>]');
    process.exit(2);
  }
  return out;
}

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** @param {string} file */
function isScriptFile(file) {
  return /\.(?:ts|tsx|mts|cts)$/.test(file) && !/\.d\.ts$/.test(file);
}

/** @param {string} file */
function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}
