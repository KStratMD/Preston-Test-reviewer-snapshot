#!/usr/bin/env node
// @ts-check
//
// check-any-budget.mjs
//
// Counts six patterns of `any` usage in TypeScript source and fails CI if any
// counter exceeds the budget in .any-budget. The regex patterns are an
// intentional APPROXIMATION — they miss nested/multiline generics (e.g.
// Record<string, Record<string, any>>) and don't parse the TS AST. Treat the
// counts as a directional tripwire, not a precise audit.
//
// Scope: files matched by tsconfig.json's effective include/exclude. This
// keeps the ratchet aligned with what `npm run typecheck` actually checks
// (e.g. src/__tests__/**/* is excluded from typecheck, so it's excluded
// here too).
//
// Usage:
//   node scripts/check-any-budget.mjs          # fails on counter > budget
//   node scripts/check-any-budget.mjs --write  # writes current counts into .any-budget
//
// Lowering a counter in .any-budget is allowed at any time (fewer anys is
// better). Raising a counter requires reviewer sign-off with a note in the
// PR body explaining why the escape hatch was needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUDGET_FILE = path.join(REPO_ROOT, '.any-budget');
const TSCONFIG = path.join(REPO_ROOT, 'tsconfig.json');

/** @typedef {{ as_any: number; colon_any: number; any_array: number; record_any: number; generic_any: number; ts_expect_error: number }} Budget */

/** @type {Record<keyof Budget, RegExp>} */
const PATTERNS = {
  // `as any` casts: x as any, x as any[], x as any as SomeType
  as_any: /\bas\s+any\b/g,
  // `: any` type annotations in parameters, return types, variable decls.
  // Tight: colon, optional whitespace, literal `any`, word boundary.
  colon_any: /:\s*any\b/g,
  // `any[]` array type (literal bracket form).
  any_array: /\bany\[\]/g,
  // Record<K, any> — single level. Misses Record<K, Record<K, any>> etc.
  record_any: /Record<[^<>,]+,\s*any>/g,
  // Generic arg `any` — Promise<any>, Map<string, any>, Result<any, Err>,
  // makeRequest<any>. Matches `any` in first- or later-argument positions
  // (after `<` or `,`). Single-level only: the outer `record_any` counter
  // catches Record<K, ...> shapes; nested forms like
  // `Record<K, Record<K, any>>` are approximated as before. The `colon_any`
  // and `any_array` patterns above overlap slightly; the counts are
  // independent tripwires per pattern, not a deduplicated total.
  generic_any: /(?:<|,)\s*any[>,]/g,
  // Counts `ts-expect-error` directives (prefixed with @ in source).
  // Baseline expected to be 0. The pattern below uses a concatenated string
  // to avoid the literal directive appearing as a comment in this file.
  ts_expect_error: new RegExp('@' + 'ts-expect-error', 'g'),
};

/** @returns {string[]} absolute paths to .ts files in the typecheck scope */
function getSourceFiles() {
  const configJson = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (configJson.error) {
    console.error('[any-budget] Could not read tsconfig.json:', configJson.error.messageText);
    process.exit(2);
  }
  const parsed = ts.parseJsonConfigFileContent(configJson.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length) {
    console.error('[any-budget] tsconfig parse errors:', parsed.errors.map(e => e.messageText).join(', '));
    process.exit(2);
  }
  return parsed.fileNames.filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.d.ts'));
}

/**
 * Blank out string-literal contents (string, template, regex) and the full
 * span of line and block comments, including their delimiters. Replacements
 * are same-length whitespace so offsets and line numbers are preserved.
 * `@ts-expect-error` directives live INSIDE comments
 * by definition, so that counter runs on raw source before stripping; every
 * other counter runs on the stripped text so a log message like
 * `logger.info('Promise<any> detected')` or a prose comment mentioning
 * `as any` doesn't trip the ratchet.
 *
 * Implementation: walks the parsed TS AST. The scanner-only approach we used
 * before would mis-tokenize the closing `}` of `${...}` substitutions in
 * template literals as opening a new template, then whitewash everything
 * past that point — silently hiding `as any` / `: any` sites in any file
 * that contained a template literal. The AST handles substitution boundaries
 * correctly via TemplateExpression.templateSpans.
 *
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  const sourceFile = ts.createSourceFile('__tmp__.ts', src, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS);
  /** @type {string[]} */
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];

  /** @param {number} start @param {number} end */
  const blank = (start, end) => {
    for (let i = start; i < end; i++) {
      if (i >= 0 && i < src.length) {
        out[i] = /\s/.test(src[i]) ? src[i] : ' ';
      }
    }
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
        blank(node.getStart(sourceFile), node.getEnd());
        return;
      case ts.SyntaxKind.TemplateExpression: {
        // Blank the head + each middle/tail; recurse into substitution expressions.
        const tplExpr = /** @type {ts.TemplateExpression} */ (node);
        blank(tplExpr.head.getStart(sourceFile), tplExpr.head.getEnd());
        for (const span of tplExpr.templateSpans) {
          visit(span.expression);
          blank(span.literal.getStart(sourceFile), span.literal.getEnd());
        }
        return;
      }
      case ts.SyntaxKind.TaggedTemplateExpression: {
        const tagged = /** @type {ts.TaggedTemplateExpression} */ (node);
        visit(tagged.tag);
        visit(tagged.template);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Comments are not nodes — walk them via the scanner. Since string-likes
  // are now blanked, the scanner can't get confused by template substitutions
  // (their contents read as whitespace).
  const stripped = out.join('');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, stripped);
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      blank(scanner.getTokenStart(), scanner.getTokenEnd());
    }
    token = scanner.scan();
  }

  return out.join('');
}

/** @returns {Budget} */
function countAllPatterns() {
  const files = getSourceFiles();
  /** @type {Budget} */
  const counts = { as_any: 0, colon_any: 0, any_array: 0, record_any: 0, generic_any: 0, ts_expect_error: 0 };
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    for (const name of /** @type {(keyof Budget)[]} */ (Object.keys(counts))) {
      // ts_expect_error only exists inside comments; count on raw. Everything
      // else counts on stripped so comments and string literals don't trip it.
      const source = name === 'ts_expect_error' ? raw : stripped;
      const matches = source.match(PATTERNS[name]);
      counts[name] += matches ? matches.length : 0;
    }
  }
  return counts;
}

/** @returns {Budget} */
function readBudget() {
  if (!fs.existsSync(BUDGET_FILE)) {
    console.error(`[any-budget] Missing ${BUDGET_FILE}.`);
    console.error('[any-budget] Bootstrap: node scripts/check-any-budget.mjs --write');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
}

/**
 * @param {string} name
 * @param {number} current
 * @param {number} budget
 */
function formatCounter(name, current, budget) {
  const delta = current - budget;
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '';
  return `  ${name.padEnd(18)} current=${String(current).padStart(5)} budget=${String(budget).padStart(5)} (${sign}${delta})`;
}

function main() {
  const write = process.argv.includes('--write');
  const counts = countAllPatterns();

  if (write) {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(counts, null, 2) + '\n');
    console.log(`[any-budget] Wrote baselines to ${path.relative(REPO_ROOT, BUDGET_FILE)}:`);
    for (const name of Object.keys(counts)) {
      console.log(`  ${name.padEnd(18)} ${counts[name]}`);
    }
    return;
  }

  const budget = readBudget();
  console.log('[any-budget] Counting any-patterns in typecheck scope...');
  let failed = false;
  /** @type {string[]} */
  const overBudget = [];
  for (const name of Object.keys(counts)) {
    console.log(formatCounter(name, counts[name], budget[name] ?? 0));
    if (counts[name] > (budget[name] ?? 0)) {
      overBudget.push(name);
      failed = true;
    }
  }

  if (failed) {
    console.error('');
    console.error(`[any-budget] FAIL: counter(s) exceeded budget: ${overBudget.join(', ')}`);
    console.error('[any-budget] Options:');
    console.error('  1. Remove the new `any` usage (preferred). Use `unknown` + narrowing.');
    console.error('  2. Only with reviewer sign-off: raise the budget in .any-budget and');
    console.error('     document the reason in the PR body.');
    process.exit(1);
  }

  console.log('');
  console.log('[any-budget] OK: all counters within budget.');
}

main();
