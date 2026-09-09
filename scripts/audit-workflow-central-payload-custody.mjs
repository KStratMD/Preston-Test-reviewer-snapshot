#!/usr/bin/env node
/**
 * Custodian drift gate for WorkflowCentral payload custody (Phase 1 T14b / ADR-019).
 *
 * Scans src/services/workflowCentral/** + src/services/WorkflowCentralService.ts
 * + src/routes/workflowCentral.ts for direct writes of arbitrary payload into
 * `.data = ` or `.variables = ` outside the LEGACY-COMPAT whitelist.
 *
 * Whitelist marker: `// LEGACY-COMPAT: payload-custody-gate`
 *   - Apply on the line above the write OR on the same line.
 *   - Covers the transitional repository fallback paths that read/write
 *     legacy columns during the Phase 1 rollout window.
 *
 * Exit codes:
 *   0 — clean (no violations OR only whitelisted writes)
 *   1 — violation(s) found (printed with file:line)
 *   2 — script error
 *
 * Wired into ci-minimal.yml AFTER audit-status-claims per the Phase 1 plan.
 * Future PRs that accidentally regress to inline business payload trip the gate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SCAN_TARGETS = [
  'src/services/workflowCentral',
  'src/services/WorkflowCentralService.ts',
  'src/routes/workflowCentral.ts',
];

// Catches:
//   - `task.data = ...`, `row.data = ...`, etc. — explicit assignment
//   - `updates.variables = req.body.variables` — same shape with chained access
// Does NOT catch:
//   - TypeScript type definitions (`data: Record<string, unknown>;` — colon not equals)
//   - Property destructuring / function-call passing (`fn(row.data)`)
//   - JSON.stringify(row.data ?? {}) — reads
//   - Object literals with data/variables keys (those use `:` not `=`)
//
// The gate intentionally narrow-focuses on .data = / .variables = assignment
// because that's the regression vector — a future PR that adds inline
// payload writing of arbitrary data would land via this shape.
const WRITE_PATTERN = /\.(data|variables)\s*=\s*[^=]/;
const WHITELIST_MARKER = '// LEGACY-COMPAT: payload-custody-gate';

function isCodeFile(path) {
  const ext = extname(path);
  return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs';
}

function walk(target) {
  const files = [];
  const abs = join(ROOT, target);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return files;
  }
  if (stat.isFile() && isCodeFile(abs)) {
    files.push(target);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of readdirSync(abs)) {
    files.push(...walk(join(target, entry)));
  }
  return files;
}

function scanFile(relPath) {
  const violations = [];
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!WRITE_PATTERN.test(line)) continue;
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    // Exclude common safe-pattern false positives that match the regex shape
    // but aren't actually arbitrary-payload writes:
    if (/\.dataLayer|\.dataSetId|\.dataIndex|\.dataType|\.dataset/.test(line)) continue;
    if (/\.variables\s*=\s*data\.variables/.test(line)) continue; // workflow-DEFINITION variables array (declarations, not payload)
    const prevLine = i > 0 ? lines[i - 1] : '';
    if (line.includes(WHITELIST_MARKER) || prevLine.includes(WHITELIST_MARKER)) continue;
    violations.push({ relPath, line: i + 1, content: line.trim() });
  }
  return violations;
}

function main() {
  const allFiles = [];
  for (const target of SCAN_TARGETS) {
    allFiles.push(...walk(target));
  }
  // Skip files we know are out of scope (test files inside src, dist artifacts, etc.)
  const codeFiles = allFiles.filter((f) => !f.includes('/__mocks__/') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));

  const violations = [];
  for (const file of codeFiles) {
    violations.push(...scanFile(file));
  }

  if (violations.length === 0) {
    console.log(`audit-workflow-central-payload-custody: OK (${codeFiles.length} files scanned)`);
    process.exit(0);
  }

  console.error('audit-workflow-central-payload-custody: FAIL');
  console.error(`Found ${violations.length} direct payload-custody write(s) without the LEGACY-COMPAT marker.`);
  console.error('Phase 1 (ADR-019) requires writes of business payload to go through the WorkflowPayload tagged union.');
  console.error('If this is a transitional fallback, add the marker ABOVE the line:');
  console.error(`  ${WHITELIST_MARKER}`);
  console.error('');
  for (const v of violations) {
    console.error(`  ${v.relPath}:${v.line} — ${v.content}`);
  }
  process.exit(1);
}

main();
