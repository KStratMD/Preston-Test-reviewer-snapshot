#!/usr/bin/env node
// @ts-check
//
// Ensures the system identity sentinel is only defined in its canonical home.
// Provider and route code must import SYSTEM_IDENTITY instead of spelling the
// sentinel directly, otherwise audit attribution can silently drift.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.root ?? defaultRoot);
const srcRoot = path.join(repoRoot, 'src');
const SYSTEM_SENTINEL = '__system__';
const ALLOWLIST = new Set([
  'src/services/governance/identityContext.ts',
]);

if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
  console.error(`[system-identity-isolation] Missing src directory under ${displayPath(repoRoot, process.cwd())}`);
  process.exit(2);
}

for (const rel of ALLOWLIST) {
  const fullPath = path.join(repoRoot, rel);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    console.error(`[system-identity-isolation] Allowlisted file missing: ${rel}`);
    process.exit(2);
  }
}

const findings = [];
const files = walk(srcRoot).filter(isScriptFile);

for (const file of files) {
  const rel = toPosix(path.relative(repoRoot, file));
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(file),
  );

  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
      node.text === SYSTEM_SENTINEL &&
      !ALLOWLIST.has(rel)
    ) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push(`${rel}:${pos.line + 1}:${pos.character + 1}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

if (findings.length > 0) {
  console.error('[system-identity-isolation] Hardcoded system identity literal found outside canonical home:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  console.error('Import SYSTEM_IDENTITY from src/services/governance/identityContext.ts instead.');
  process.exit(1);
}

console.log(`[system-identity-isolation] OK (${files.length} source files scanned).`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('Usage: node scripts/check-system-identity-isolation.mjs [--root <repo-root>]');
        process.exit(2);
      }
      out.root = value;
      i++;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    console.error('Usage: node scripts/check-system-identity-isolation.mjs [--root <repo-root>]');
    process.exit(2);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function isScriptFile(file) {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(file);
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function displayPath(target, root) {
  const rel = path.relative(root, target);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel || '.');
  return target;
}
