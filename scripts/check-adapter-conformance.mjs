#!/usr/bin/env node
/**
 * CI gate: assert that every PR-10b adapter file under src/embedded/adapters/
 * has a matching named test in tests/playwright/embedded/adapter-conformance.spec.ts.
 *
 * Behavior contract (locked by spec round-7 finding #6 + round-8 finding #3 +
 * round-8 finding #6 + round-9 finding #5 + round-10 finding #3):
 *   - Exit 0 if `src/embedded/adapters/` is missing or contains no `*.adapter.ts`.
 *   - Exit 0 if every adapter file has a matching `test('<basename>: ...', ...)`.
 *   - Exit 1 if any adapter file exists without a paired test.
 *   - Exit 1 if `tests/playwright/embedded/adapter-conformance.spec.ts` is missing
 *     (catches the case where PR 10b accidentally deletes the placeholder before
 *     adding real tests).
 *
 * The spec file MUST exist from PR 10a's merge — initially as a placeholder
 * containing a single trivial passing test (NOT `test.skip`, which would
 * conflict with the audit-skipped-tests gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const ADAPTERS_DIR = path.join(repoRoot, 'src/embedded/adapters');
const SPEC_PATH = path.join(repoRoot, 'tests/playwright/embedded/adapter-conformance.spec.ts');

function fail(msg) {
  console.error(`[check-adapter-conformance] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SPEC_PATH)) {
  fail(
    `tests/playwright/embedded/adapter-conformance.spec.ts is missing — ` +
      `PR 10a must keep this fixture in place so the gate is enforceable. ` +
      `Restore it (placeholder is a single passing test, NOT test.skip).`,
  );
}

if (!fs.existsSync(ADAPTERS_DIR)) {
  console.log('[check-adapter-conformance] OK — adapters directory does not exist yet (PR 10b not started)');
  process.exit(0);
}

const adapterFiles = fs
  .readdirSync(ADAPTERS_DIR)
  .filter((name) => name.endsWith('.adapter.ts'));

if (adapterFiles.length === 0) {
  console.log('[check-adapter-conformance] OK — no adapters present yet');
  process.exit(0);
}

const specSrc = fs.readFileSync(SPEC_PATH, 'utf8');
const missing = [];
for (const file of adapterFiles) {
  const basename = file.replace(/\.adapter\.ts$/, '');
  // Look for a `test('<basename>:` or `test("<basename>:` line in the spec.
  const re = new RegExp(`test\\((['"\`])${basename}:`);
  if (!re.test(specSrc)) {
    missing.push(file);
  }
}

if (missing.length > 0) {
  fail(
    `Adapter file(s) without a matching test in adapter-conformance.spec.ts:\n` +
      missing.map((f) => `  - src/embedded/adapters/${f}`).join('\n') +
      `\nAdd a \`test('<basename>: <scenario>', ...)\` for each.`,
  );
}

console.log(`[check-adapter-conformance] OK — ${adapterFiles.length} adapter(s) verified`);
