#!/usr/bin/env node
// @ts-check
//
// check-core-type-safety.mjs
//
// Counts `any` / `as any` / `@ts-ignore` / `@ts-expect-error` usage in the
// CORE GOVERNANCE FILE SET — the load-bearing safety surface the project
// makes production claims about — and fails CI unless the total exactly
// equals the budget in .core-type-safety-budget. This is a STRICT ratchet:
// total > budget fails (a new escape hatch landed) AND total < budget fails
// (an escape hatch was removed — re-stamp the lower budget in the same PR).
// Do not "simplify" this to `<=`; the below-budget failure is intentional.
//
// Counting technique (be honest about it): this is AST-ASSISTED REGEX
// counting, the same approach as scripts/check-any-budget.mjs — NOT a true
// AST semantic classifier. It blanks comment and string/template spans via
// the TypeScript scanner/parser (so a `// as any` comment or a "contains any"
// log string does not trip the counter), then regex-matches the escape-hatch
// patterns on the stripped text. @ts-ignore / @ts-expect-error live inside
// comments by definition, so those two are matched on the RAW source.
//
// Why a SEPARATE gate from check-any-budget.mjs:
//   .any-budget caps the REPO-WIDE `as any` count (currently ~531) so the
//   global total can't grow. But that budget can't distinguish a benign
//   `as any` in a demo connector from one in the DLP scanner or the
//   guarded-write chokepoint. This gate scopes a MUCH tighter budget to just
//   the files that enforce safety, so the project can prove "near-zero where
//   it matters" — not merely "the global total isn't rising." A cold reviewer
//   reading "510 anys" can be pointed here: the safety surface holds zero
//   any/suppression escape hatches, enforced.
//
// Note: this gate counts `any` and suppression DIRECTIVES, not all type
// assertions. A narrowed `as Record<string, unknown>` or `as DataRecord` is
// a typed assertion, not an escape hatch, and is intentionally NOT counted.
// The claim it backs is precise: "zero any/suppression escape hatches in the
// core safety set," not "zero type assertions."
//
// Scope rule (categorical, to keep the set honest — see TYPE-SAFETY.md):
// the core set is the governance/safety SERVICE layer + MIDDLEWARE gates +
// src/governance/sourceOfTruth + the governance-completing FlowExecutor slice.
// It EXCLUDES (a) all src/routes/** (the HTTP edge, where `req.query as X`
// casts are expected Express-typing friction) and (b) IO adapters (connectors,
// AI providers) where `any` around unstructured third-party payloads is
// expected. The set is derived from the repo's authoritative core surface
// (jest.core.config.cjs:collectCoverageFrom) + the WorkflowCentral custody
// audit (scripts/audit-workflow-central-payload-custody.mjs), restricted to
// the decision/custody/gate subset. Each entry is a deliberate, reviewable
// inclusion — not a glob over all of src/.
//
// Usage:
//   node scripts/check-core-type-safety.mjs           # exits 0 only when total == budget (strict ratchet)
//   node scripts/check-core-type-safety.mjs --write    # writes current total into the budget file
//   node scripts/check-core-type-safety.mjs --list     # prints per-file nonzero counts and exits 0
//
// Ratchet philosophy (mirrors .strict-null-budget and .any-budget):
//   Lowering the budget is always allowed (fewer is better) and SHOULD be
//   done in the same PR that removes a cast. Raising it requires reviewer
//   sign-off with a PR-body note explaining why a core-surface `any` was
//   unavoidable. The intent is to hold this at 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUDGET_FILE = path.join(REPO_ROOT, '.core-type-safety-budget');

// ---------------------------------------------------------------------------
// The core governance surface. Each entry is a path relative to the repo root;
// a directory entry includes every non-test .ts file beneath it. Keep this
// list curated and explicit — it is the definition of "what we make
// production safety claims about." See the scope-rule note above before adding.
// ---------------------------------------------------------------------------
const CORE_PATHS = [
  // Source-of-truth ownership chokepoint (guardedWrite + manifest + resolver)
  'src/governance/sourceOfTruth',
  // DLP + secret management
  'src/services/security',
  // Approval queue, ownership-resume, write-descriptor encryption, identity
  'src/services/governance',
  // Tenant lifecycle + kill switch
  'src/services/tenants',
  // Durable workflow engine + reference-based payload custody (directory)
  'src/services/workflowCentral',
  // WorkflowCentral service entry point (services root — named by the custody audit)
  'src/services/WorkflowCentralService.ts',
  // Durable finance approve-to-apply loop
  'src/services/financeCentral',
  // AI-assisted sync-error operator loop
  'src/services/syncErrorAssist',
  // Record-level lineage
  'src/services/lineage',
  // Reconciliation center + cadence handlers
  'src/services/reconciliationCenter',
  // Cost transparency (measured vs estimated)
  'src/services/cost',
  // MCP aggregator — the DLP auto-redact egress path on every tool result
  'src/services/mcp/MCPAggregatorService.ts',
  // Encrypted / secret-bearing tenant configuration reads
  'src/database/repositories/TenantConfigurationRepository.ts',
  // The inbound AI governance decision point specifically
  'src/services/ai/orchestrator/GovernanceService.ts',
  // Governance-completing flow execution slice (collectCoverageFrom: "the governance-completing slice")
  'src/flows/templates/FlowExecutor.ts',
  // Request-path gates: access control + tenant status + readiness + webhook verification
  'src/middleware/rbac.ts',
  'src/middleware/tenantStatusGate.ts',
  'src/middleware/workflowCentralReady.ts',
  'src/middleware/syncErrorAssistWebhook.ts',
];

/**
 * Recursively collect non-test .ts files under a repo-relative path.
 * FAIL-CLOSED: a missing core path is a hard error (exit 2), never a silent
 * skip — a renamed/deleted governance file must break CI loudly rather than
 * quietly shrink the gate's coverage.
 */
function collect(relPath, acc) {
  const full = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: core path not found: ${relPath}`);
    console.error('A governance file in CORE_PATHS was renamed, moved, or deleted.');
    console.error('Update CORE_PATHS in scripts/check-core-type-safety.mjs to match, then re-stamp.');
    process.exit(2);
  }
  const st = fs.statSync(full);
  if (st.isFile()) {
    if (full.endsWith('.ts') && !full.endsWith('.d.ts') && !full.endsWith('.test.ts')) acc.push(full);
    return;
  }
  for (const entry of fs.readdirSync(full)) collect(path.join(relPath, entry), acc);
}

/**
 * Blank string-literal and comment spans (same-length whitespace so offsets
 * are preserved) using the TS AST, so a prose comment or log string that
 * mentions `as any` doesn't trip the counter. @ts-ignore / @ts-expect-error
 * live inside comments by definition, so those are counted on RAW source
 * before stripping; every other pattern is counted on the stripped text.
 */
function stripCommentsAndStrings(src) {
  const sf = ts.createSourceFile('__core_ts__.ts', src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out = src.split('');
  const blank = (start, end) => {
    for (let i = start; i < end; i++) {
      if (i >= 0 && i < src.length) out[i] = /\s/.test(src[i]) ? src[i] : ' ';
    }
  };
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
        blank(node.getStart(sf), node.getEnd());
        return;
      case ts.SyntaxKind.TemplateExpression: {
        const tpl = /** @type {ts.TemplateExpression} */ (node);
        blank(tpl.head.getStart(sf), tpl.head.getEnd());
        for (const span of tpl.templateSpans) {
          visit(span.expression);
          blank(span.literal.getStart(sf), span.literal.getEnd());
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Strip line + block comments via the scanner.
  let result = out.join('');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, result);
  const chars = result.split('');
  scanner.setText(result);
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      const s = scanner.getTokenStart ? scanner.getTokenStart() : scanner.getTokenPos();
      const e = scanner.getTextPos();
      for (let i = s; i < e; i++) if (!/\s/.test(chars[i])) chars[i] = ' ';
    }
    tok = scanner.scan();
  }
  return chars.join('');
}

const PATTERNS = {
  as_any: /\bas\s+any\b/g,
  colon_any: /:\s*any\b/g,
  any_array: /\bany\[\]/g,
  generic_any: /(?:<|,)\s*any[>,]/g,
};
// Comment-resident directives — counted on raw source.
const TS_EXPECT_ERROR = new RegExp('@' + 'ts-expect-error', 'g');
const TS_IGNORE = new RegExp('@' + 'ts-ignore', 'g');

function countFile(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const directives =
    (raw.match(TS_EXPECT_ERROR) || []).length + (raw.match(TS_IGNORE) || []).length;
  const stripped = stripCommentsAndStrings(raw);
  let n = directives;
  for (const k of Object.keys(PATTERNS)) {
    n += (stripped.match(PATTERNS[k]) || []).length;
  }
  return n;
}

// --- main ------------------------------------------------------------------
const files = [];
for (const p of CORE_PATHS) collect(p, files);

let total = 0;
const perFile = {};
for (const f of files) {
  const n = countFile(f);
  if (n > 0) perFile[path.relative(REPO_ROOT, f)] = n;
  total += n;
}

const mode = process.argv[2];

if (mode === '--list') {
  console.log(`[core-type-safety] ${files.length} core files scanned; total = ${total}`);
  for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${f}`);
  }
  process.exit(0);
}

if (mode === '--write') {
  fs.writeFileSync(BUDGET_FILE, String(total) + '\n', 'utf8');
  console.log(`[core-type-safety] wrote budget = ${total} (${files.length} core files)`);
  process.exit(0);
}

if (!fs.existsSync(BUDGET_FILE)) {
  console.error(`FAIL: missing ${BUDGET_FILE} — run: node scripts/check-core-type-safety.mjs --write`);
  process.exit(2);
}
const budgetText = fs.readFileSync(BUDGET_FILE, 'utf8').trim();
if (!/^\d+$/.test(budgetText)) {
  console.error(`FAIL: ${BUDGET_FILE} must contain only ASCII digits, got "${budgetText}"`);
  process.exit(2);
}
const budget = parseInt(budgetText, 10);

if (total > budget) {
  console.error(`[core-type-safety] FAIL: core any/ignore count ${total} exceeds budget ${budget}.`);
  console.error('A new `any` / `as any` / @ts-ignore landed in the core governance surface.');
  console.error('Fix it, or (with reviewer sign-off) raise the budget. Offending files:');
  for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(3)}  ${f}`);
  }
  process.exit(1);
}

if (total < budget) {
  console.error(`[core-type-safety] FAIL: count ${total} is BELOW budget ${budget}.`);
  console.error('Good — a core `any` was removed. Re-stamp the lower budget in this same PR:');
  console.error('  node scripts/check-core-type-safety.mjs --write');
  process.exit(1);
}

console.log(`[core-type-safety] OK: ${total} core any/ignore == budget ${budget} (${files.length} core files scanned).`);
process.exit(0);
