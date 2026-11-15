#!/usr/bin/env node
/**
 * PR 12 drift gate — FlowExecutor must keep calling the lineage recorder
 * for source-read, transform, governance-decision, and target-write events.
 *
 * The lineage chain is opt-in by design (`ctx.lineageRecorder?.startChain`
 * is undefined for callers that haven't wired the recorder), so a silent
 * removal of any of the six call sites would let governed-flow lineage
 * rot without any test failure. This gate fails CI on that drift.
 *
 * Exit codes:
 *   0 — all checks pass in src/flows/templates/FlowExecutor.ts
 *       (6 required: hashLineagePayload import + startChain + sourceRead +
 *       transform + governanceDecision + targetWrite calls; 4 required
 *       protected `?.catch` forms — one per event-type call site; 1 negative
 *       check that there is no bare `.catch(swallowLineageErr` form)
 *   1 — at least one check fails (drift)
 *   2 — target file not found (sanity failure — run from repo root)
 *
 * PR 12 R1 (Copilot a/b/c): added the `?.catch` form enforcement on lineage
 * instrumentation calls. Without the second optional-chain, the no-lineage
 * path crashes with TypeError when `lineage` is undefined because
 * `undefined.catch` is not a function.
 *
 * PR 12 R4 (Copilot): strengthened the `?.catch` enforcement from "at least
 * one match" to "all three event-type sites" (transform / governanceDecision
 * / targetWrite), and loosened the hashLineagePayload import regex to allow
 * additional type-only imports from LineageRecorder.ts.
 *
 * PR 12 follow-up: added `sourceRead` as the fourth event-type site so the
 * gate covers all four LineageChainHandle methods. The call site is wrapped
 * in `if (ctx.sourceRecord)` — the regex matches the call regardless of the
 * surrounding `if`-block.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve(process.cwd(), 'src/flows/templates/FlowExecutor.ts');

if (!existsSync(TARGET)) {
  console.error(`[check-lineage-instrumentation] target not found: ${TARGET}`);
  process.exit(2);
}

const src = readFileSync(TARGET, 'utf8');

const REQUIRED = [
  {
    // PR 12 R4 — relaxed to allow additional symbols from the same module
    // (e.g. type-only LineageRecorder/LineageChainHandle), as long as the
    // imports list contains hashLineagePayload.
    name: 'hashLineagePayload import',
    regex: /import\s*\{[^}]*\bhashLineagePayload\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/services\/lineage\/LineageRecorder['"]/,
  },
  { name: 'startChain call', regex: /lineageRecorder\?\.startChain\(/ },
  { name: 'sourceRead call', regex: /lineage\?\.sourceRead\(/ },
  { name: 'transform call', regex: /lineage\?\.transform\(/ },
  { name: 'governanceDecision call', regex: /lineage\?\.governanceDecision\(/ },
  { name: 'targetWrite call', regex: /lineage\?\.targetWrite\(/ },
];

const missing = REQUIRED.filter((r) => !r.regex.test(src));

// PR 12 R1 + R4 — every `lineage?.X(...)` followed by a swallow catch must use
// the optional-chain `?.catch` form so the no-lineage path doesn't crash with
// TypeError. R4 strengthening: require ALL THREE event-type catches present
// (transform/governanceDecision/targetWrite) AND zero bare `.catch` forms.
// Allow one level of nested parens in the argument list (covers
// `lineage?.transform({ payloadHash: hashLineagePayload(record) })`) and
// multi-line argument blocks (governanceDecision / targetWrite span
// several lines). Non-greedy `\)` matching to keep failure mode clear.
const PROTECTED_CATCH = (method) =>
  new RegExp(String.raw`lineage\?\.${method}\((?:[^()]|\([^()]*\))*\)\?\.catch\(swallowLineageErr`);
const REQUIRED_PROTECTED_CATCHES = [
  { name: 'sourceRead ?.catch', regex: PROTECTED_CATCH('sourceRead') },
  { name: 'transform ?.catch', regex: PROTECTED_CATCH('transform') },
  { name: 'governanceDecision ?.catch', regex: PROTECTED_CATCH('governanceDecision') },
  { name: 'targetWrite ?.catch', regex: PROTECTED_CATCH('targetWrite') },
];
const missingProtected = REQUIRED_PROTECTED_CATCHES.filter((r) => !r.regex.test(src));

// Negative check (PR 12 R1) — no bare `.catch(swallowLineageErr` (i.e. lacking
// the protective optional-chain). One match = drift.
const BARE_CATCH = /\)\.catch\(swallowLineageErr/;
const hasBareCatch = BARE_CATCH.test(src);

if (missing.length > 0 || missingProtected.length > 0 || hasBareCatch) {
  console.error('[check-lineage-instrumentation] FAIL');
  for (const m of missing) console.error(`  - missing: ${m.name}`);
  for (const m of missingProtected) console.error(`  - missing protected ?.catch: ${m.name}`);
  if (hasBareCatch) {
    console.error('  - bare `.catch(swallowLineageErr` found; use `?.catch(...)` so the no-lineage path is safe');
  }
  process.exit(1);
}

console.log(`[check-lineage-instrumentation] OK — ${REQUIRED.length} required + ${REQUIRED_PROTECTED_CATCHES.length} protected catches + bare-catch negative check all passed.`);
process.exit(0);
