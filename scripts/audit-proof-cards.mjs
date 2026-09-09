#!/usr/bin/env node
// @ts-check
//
// audit-proof-cards.mjs (Phase 4)
//
// Companion to scripts/audit-status-claims.mjs. Where the status-claims
// audit verifies each connector has well-formed source-level tags
// (`productionStatus`, `statusEvidence`, optional `proofCard`), this script
// goes further and verifies the **content** of each proof card:
//
//   1. Every connector with a `static readonly proofCard = '...'` field has
//      a Markdown file at that path.
//   2. Every production connector has a `proofCard` field (this is also
//      enforced by audit-status-claims, but we re-check here so this script
//      stands alone in CI).
//   3. Each card has the required sections: a level-1 heading
//      (`# Proof Card: ...`), a `**Status:**` line, a `**Last verified:**`
//      line, and the standard section headings (`## Claim`, `## Source`,
//      `## Tests`, `## Live vs Fixture`, `## Known Gaps`,
//      `## Verification`).
//   4. The card's declared `Status:` value matches the connector's
//      source-level `productionStatus` (only enforced for connector-tagged
//      cards; service-level cards have no connector counterpart).
//   5. Every `.md` file in `docs/review/proof-cards/` (except `_template.md`)
//      passes the section/heading checks — covers service-level cards
//      (ai-providers, dlp-service, etc.) that no connector references.
//
// This script intentionally does NOT cross-check `metrics.json` — that's
// audit-status-claims' job. The two scripts are complementary; both run in
// CI so a failure in either one fails the build.
//
// Usage:
//   node scripts/audit-proof-cards.mjs           # against this repo
//   node scripts/audit-proof-cards.mjs --root <dir>   # for tests

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractStaticString,
  listConnectorFiles,
  readConnectorSourceFile,
} from './lib/connector-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROOF_CARD_DIR = 'docs/review/proof-cards/';

const REQUIRED_SECTIONS = [
  '## Claim',
  '## Source',
  '## Tests',
  '## Live vs Fixture',
  '## Known Gaps',
  '## Verification',
];

import { CONNECTOR_STATUSES, isProductionTier } from './lib/connectorStatuses.mjs';
const VALID_STATUSES = [...CONNECTOR_STATUSES];

/**
 * Claim classes: what KIND of assertion a card makes, and therefore what
 * strength of evidence `Status: production` requires of it.
 */
const CLASSES = {
  connector_interoperability: { minRung: 4, artifact: true },
  customer_outcome: { minRung: 5, artifact: true },
  service_behavior: { minRung: 2, artifact: false, recipe: true },
  deployment_operation: { minRung: 1, artifact: true },
};

const EVIDENCE_LABELS = {
  1: 'official contract',
  2: 'contract fixtures and simulation',
  3: 'development or local commerce system',
  4: 'ERP sandbox',
  5: 'customer read-only',
  6: 'approved reversible write',
};

const BASELINE_FILE = '.proof-card-threshold-baseline';

/**
 * Strip an inline shell comment before matching a recipe (Codex finding AC-05).
 *
 * Dropping only whole-line comments is not enough: `echo done # npm run x`
 * would still satisfy the npm-script pattern, so a recipe that is merely
 * MENTIONED in a comment would count as executed -- the exact claim this check
 * exists to refute.
 *
 * Only a `#` at line start or preceded by whitespace begins a comment, so a URL
 * fragment (`http://host/p#frag`) survives. A `#` inside quotes and preceded by
 * a space is over-stripped; that direction is safe, because the consequence is
 * a recipe going UNrecognised and the gate blocking, never a false pass.
 */
function stripInlineComment(line) {
  return line.replace(/(^|\s)#.*$/, '$1');
}

function commandTokens(cmd) {
  return String(cmd)
    .split(String.fromCharCode(10))
    .map((l) => stripInlineComment(l).trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/\s+|&&|\|\||;|\|/))
    .filter(Boolean);
}

/**
 * Build the recipe-execution context once per root.
 *
 * A `Verification recipe:` is only meaningful if the named thing is actually
 * RUN somewhere. Naming a script nothing executes is precisely the kind of
 * unfalsifiable claim these cards exist to prevent, so the recipe is resolved
 * against the workflow's executed commands and the reviewer mirror's manifest.
 *
 * `js-yaml` parses the workflow rather than the text being grepped: YAML
 * parsing drops the file's own `#` comments, and `stripInlineComment` then
 * removes shell comments inside a `run: |` block (Codex finding AC-05).
 */
/**
 * Per-run state for the claim checks. Set at the top of main() so both card
 * loops (connector-referenced and standalone) share one context and one
 * threshold ledger.
 */
let recipeCtx = null;
/** @type {Set<string>} */
let baselineSet = new Set();
/** @type {Map<string, boolean>} */
const thresholdState = new Map();

function baselinePath(root) {
  return path.join(root, BASELINE_FILE);
}

function isGitTrackedButMissing(root, relFile) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relFile], { cwd: root, stdio: 'ignore' });
    return !fs.existsSync(path.join(root, relFile));
  } catch {
    return false; // not a git repo, or not tracked: nothing to protect
  }
}

// Shared tail for --init / --write: the file is written either way, but the
// exit code tells the truth about what is still wrong.
function reportLiveErrors(errors, liveViolations) {
  const all = [
    ...errors,
    ...liveViolations.map((v) => `${v}: threshold violation not covered by ${BASELINE_FILE} (a baseline may only shrink)`),
  ];
  if (all.length === 0) return 0;
  console.error('audit-proof-cards: FAIL (baseline written, but errors remain)');
  for (const e of all) console.error(`  - ${e}`);
  return 1;
}

function readBaseline(root) {
  const p = baselinePath(root);
  if (!fs.existsSync(p)) return new Set();
  return new Set(
    fs
      .readFileSync(p, 'utf8')
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Run the claim checks for one card and record whether it violates its class
 * threshold. Hard errors always fail; threshold errors are suppressed only for
 * a card already named in the shrink-only baseline.
 */
function applyClaimChecks(cardRel, body, errors) {
  const result = validateCardClaims(cardRel, body, recipeCtx);
  errors.push(...result.errors);
  if (result.thresholdErrors.length > 0 && !baselineSet.has(cardRel)) {
    errors.push(...result.thresholdErrors);
  }
  thresholdState.set(cardRel, result.thresholdErrors.length > 0);
}

/**
 * Handle --init / --write and the ratchet-down check.
 * Returns an exit code to use immediately, or null to carry on.
 */
function handleBaseline(root, options, errors) {
  const violating = [...thresholdState]
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();
  const p = baselinePath(root);

  if (options.init) {
    if (fs.existsSync(p)) {
      console.error(`${BASELINE_FILE} already exists; use --write to shrink it`);
      return 2;
    }
    if (isGitTrackedButMissing(root, BASELINE_FILE)) {
      // F3 (Codex, D4): delete-then---init re-seeded the ratchet with today's
      // violations and the default audit went green. A tracked baseline is
      // restored, never re-seeded.
      console.error(`${BASELINE_FILE} is tracked by git but missing from the worktree; restore it (git checkout -- ${BASELINE_FILE}) instead of re-seeding`);
      return 2;
    }
    fs.writeFileSync(p, violating.join(String.fromCharCode(10)) + String.fromCharCode(10));
    console.log(`${BASELINE_FILE} initialised (${violating.length})`);
    return reportLiveErrors(errors, []);
  }

  if (options.write) {
    const kept = [...baselineSet].filter((b) => violating.includes(b)).sort();
    fs.writeFileSync(
      p,
      kept.join(String.fromCharCode(10)) + (kept.length ? String.fromCharCode(10) : ''),
    );
    console.log(`${BASELINE_FILE} rewritten (${kept.length})`);
    // F3 (Codex, D4): a write run must not end green while a violation the
    // baseline does not cover is live -- that is exactly what `--write` used to do.
    const live = violating.filter((v) => !baselineSet.has(v));
    return reportLiveErrors(errors, live);
  }

  // Shrink-only: a baselined card that now meets its threshold must be removed
  // deliberately, or the baseline silently overstates the remaining debt.
  for (const b of baselineSet) {
    if (!violating.includes(b)) {
      errors.push(`${b}: baselined but now meets its class threshold; run --write`);
    }
  }
  return null;
}

// F2 (Codex, D4): the production_ready claim sentence is only a claim when it
// is an affirmative bullet in the Known Gaps section itself. Section-bound it
// (up to the next H2), skip fenced blocks, reject strikethrough, and require the
// template's exact bullet so "It is not true that ..." cannot satisfy it.
const NO_LIVE_EVIDENCE_BULLET_TEXT = '- No live-credential evidence is on record';
const NO_LIVE_EVIDENCE_BULLET = /^- No live-credential evidence is on record\b/;
function knownGapsStatesNoLiveEvidence(body) {
  let inSection = false;
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      inSection = /^## Known Gaps\s*$/.test(line);
      inFence = false;
      continue;
    }
    if (!inSection) continue;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (NO_LIVE_EVIDENCE_BULLET.test(line) && !line.includes('~~')) return true;
  }
  return false;
}

function isLiteralFalse(cond) {
  if (cond === false) return true;
  if (typeof cond !== 'string') return false;
  const t = cond.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').trim().toLowerCase();
  return t === 'false' || t === "'false'" || t === '"false"';
}

function buildRecipeContext(root) {
  const pkgPath = path.join(root, 'package.json');
  const pkgScripts = fs.existsSync(pkgPath)
    ? Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {})
    : [];

  const workflowPath = path.join(root, '.github/workflows/ci-minimal.yml');
  let runLines = [];
  let runTokens = new Set();
  if (fs.existsSync(workflowPath)) {
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) ?? {};
    // A step whose `if` is a literal false never executes, so its `run` must
    // not prove anything (Codex finding). Arbitrary expressions are NOT
    // evaluated: a step gated on a real condition still counts, which is the
    // conservative direction here (it can only ever make a recipe look
    // executed when it might be, never hide one that is).
    const runs = Object.values(workflow.jobs ?? {}).flatMap((j) =>
      (j.steps ?? [])
        .filter((st) => !isLiteralFalse(st.if))
        .map((st) => String(st.run ?? '')),
    );
    runLines = runs.flatMap((r) =>
      r
        .split(String.fromCharCode(10))
        .map((l) => stripInlineComment(l).trim())
        .filter(Boolean),
    );
    runTokens = new Set(runs.flatMap((r) => commandTokens(r)));
  }

  const manifestPath = path.join(root, 'scripts/reviewer-mirror.test-manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};
  const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const auditRecipes = asList(manifest.auditRecipes);
  const additionalProbes = asList(manifest.additionalProbes);
  const auditTokens = new Set(auditRecipes.flatMap((c) => commandTokens(c)));

  // NB: the replacement is built with an escaped $& via a character code.
  // A literal "$&" in a replacement string means "the matched text", which is how an
  // earlier splice silently rewrote this line into nonsense.
  const escapeRe = (r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return {
    root,
    pkgScripts,
    /**
     * An npm script counts only when an uncommented command actually invokes
     * `npm run <name>` as a whole token; a path recipe counts only as an exact
     * token or an exact manifest entry, never as a substring (so
     * `a.test.ts` is not satisfied by `a.test.ts.bak`).
     */
    isExecuted(recipe) {
      if (pkgScripts.includes(recipe)) {
        const re = new RegExp(`(^|\\s)npm run ${escapeRe(recipe)}(\\s|$)`);
        return (
          runLines.some((l) => re.test(l)) ||
          auditRecipes.some((c) => re.test(stripInlineComment(String(c))))
        );
      }
      return runTokens.has(recipe) || additionalProbes.includes(recipe) || auditTokens.has(recipe);
    },
  };
}

/**
 * Claim-class, evidence-level and recipe checks.
 *
 * Returns hard `errors` (always fatal) separately from `thresholdErrors` (the
 * class-vs-status thresholds, which a card may be baselined against). Recipe
 * problems are deliberately hard errors whatever the card's status: a recipe
 * that names nothing executable is broken evidence, not a legacy gap.
 */
function validateCardClaims(cardRel, body, ctx) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const thresholdErrors = [];
  const statusValue = extractCardStatus(body);

  const claimClass = (body.match(/^\s*\*\*Claim class:\*\*\s*([a-z_]+)\s*$/m) || [])[1];
  const levelMatch = body.match(/^\s*\*\*Evidence level:\*\*\s*rung\s+([1-6])\s+—\s+(.+?)\s*$/m);
  const level = levelMatch ? { rung: Number(levelMatch[1]), label: levelMatch[2] } : null;
  const artifactMatch = body.match(
    /^\s*\*\*Evidence artifact:\*\*\s*(\S+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/m,
  );
  const artifact = artifactMatch ? { path: artifactMatch[1], date: artifactMatch[2] } : null;
  const recipe = (body.match(/^\s*\*\*Verification recipe:\*\*\s*(\S+)\s*$/m) || [])[1];

  if (!claimClass || !CLASSES[claimClass]) {
    errors.push(
      `${cardRel}: missing or unknown "**Claim class:**" (expected one of ${Object.keys(CLASSES).join('|')})`,
    );
  }
  if (!level) {
    errors.push(`${cardRel}: missing "**Evidence level:** rung N — <label>"`);
  } else if (EVIDENCE_LABELS[level.rung] !== level.label) {
    errors.push(
      `${cardRel}: label for rung ${level.rung} must be "${EVIDENCE_LABELS[level.rung]}", got "${level.label}"`,
    );
  }

  // production_ready (D4, option B): the production TIER without live evidence.
  // Its bar is rung >= 2 AND an explicit Known Gaps statement that no live
  // evidence is on record -- the sentence IS the claim, so its absence is a
  // threshold violation, not a style nit. It is deliberately not the
  // `production` rule (rung >= 4 + artifact) and deliberately not exempt.
  if (claimClass === 'connector_interoperability' && level && statusValue === 'production_ready') {
    if (level.rung < 2) {
      thresholdErrors.push(`${cardRel}: Status production_ready requires rung >= 2 (has ${level.rung})`);
    }
    if (!knownGapsStatesNoLiveEvidence(body)) {
      thresholdErrors.push(
        `${cardRel}: Status production_ready requires Known Gaps to state "no live evidence on record" ` +
          `as the template bullet "${NO_LIVE_EVIDENCE_BULLET_TEXT}" (inside the section, outside code fences, not struck through)`,
      );
    }
  }

  if (claimClass && CLASSES[claimClass] && level && statusValue === 'production') {
    const rule = CLASSES[claimClass];
    if (level.rung < rule.minRung) {
      thresholdErrors.push(
        `${cardRel}: Status production for ${claimClass} requires rung >= ${rule.minRung} (has ${level.rung})`,
      );
    }
    if (rule.artifact && !artifact) {
      thresholdErrors.push(
        `${cardRel}: ${claimClass} production requires an "**Evidence artifact:** <path> — YYYY-MM-DD" line`,
      );
    }
  }

  // An artifact that does not exist is a hard error regardless of status: a
  // dangling evidence pointer is worse than no pointer, because it reads as
  // proof that was checked.
  if (artifact && !fs.existsSync(path.join(ctx.root, artifact.path))) {
    errors.push(`${cardRel}: evidence artifact ${artifact.path} does not exist`);
  }

  if (claimClass === 'service_behavior') {
    if (!recipe) {
      errors.push(
        `${cardRel}: service_behavior requires "**Verification recipe:** <npm script | test path>"`,
      );
    } else if (!ctx.pkgScripts.includes(recipe) && !fs.existsSync(path.join(ctx.root, recipe))) {
      errors.push(`${cardRel}: verification recipe ${recipe} is neither an npm script nor an existing path`);
    } else if (!ctx.isExecuted(recipe)) {
      errors.push(
        `${cardRel}: verification recipe ${recipe} is not run by any ci-minimal.yml step or the reviewer-mirror test manifest`,
      );
    }
  }

  return { errors, thresholdErrors };
}

function parseArgs(argv) {
  const options = { root: REPO_ROOT, init: false, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      // Registered here deliberately: the default branch throws on unknown
      // arguments, so reading these with process.argv.includes() alone would
      // make `--init` crash before it ever ran.
      case '--init':
        options.init = true;
        break;
      case '--write':
        options.write = true;
        break;
      case '--help':
        console.log('Usage: node scripts/audit-proof-cards.mjs [--root <dir>] [--init | --write]');
        console.log('  --init   seed .proof-card-threshold-baseline once from the current threshold violations (refuses if it exists)');
        console.log('  --write  shrink the baseline to cards that still violate; never adds');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function scanConnectors(root) {
  const items = [];
  for (const file of listConnectorFiles(root)) {
    const relPath = rel(root, file);
    const sourceFile = readConnectorSourceFile(file, relPath);
    items.push({
      file: relPath,
      productionStatus: extractStaticString(sourceFile, 'productionStatus'),
      proofCard: extractStaticString(sourceFile, 'proofCard'),
    });
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
}

/**
 * Extract the `**Status:**` value from a proof card body. Returns the trimmed
 * tail of the line (everything after `**Status:**` up to end-of-line) or
 * null if the line is absent. Captures the *full* tail (not just the first
 * token) so the caller can distinguish three cases:
 *   1. "no Status line at all"           — match is null
 *   2. "Status line present, valid enum" — match in VALID_STATUSES
 *   3. "Status line present, invalid"    — typo ("prodution"), or template
 *      placeholder line `**Status:** production | beta | demo_only | stub`
 *      where the tail is the whole pipe-delimited string. Anchoring to
 *      end-of-line is what blocks the template from matching `production`
 *      via a leading-token shortcut (Copilot review on PR #693).
 * @param {string} body
 * @returns {string | null}
 */
function extractCardStatus(body) {
  const match = body.match(/^\s*\*\*Status:\*\*\s*(.*?)\s*$/m);
  if (!match) return null;
  const tail = match[1];
  return tail === '' ? null : tail;
}

/**
 * Validate the structural sections of a proof card body.
 * Used both by connector-tagged audit and by directory-walk audit.
 * Returns an array of error strings (empty when the card is valid).
 */
function validateCardStructure(cardRel, body) {
  /** @type {string[]} */
  const errors = [];

  if (!/^#\s+Proof Card:\s+\S+/m.test(body)) {
    errors.push(
      `${cardRel}: missing level-1 heading (expected "# Proof Card: <name>")`,
    );
  }
  // Two-step Status check: presence of the line first, then enum membership.
  // Splitting the checks gives a precise error for typos like
  // "**Status:** prodution" — which the previous `[a-z_]+` regex matched
  // happily, weakening the CI gate for service-level cards that have no
  // connector cross-check (Codex review on PR #693).
  const statusValue = extractCardStatus(body);
  if (statusValue === null) {
    errors.push(
      `${cardRel}: missing "**Status:**" line (expected one of ${VALID_STATUSES.join('|')})`,
    );
  } else if (!VALID_STATUSES.includes(statusValue)) {
    errors.push(
      `${cardRel}: "**Status:** ${statusValue}" is not one of ${VALID_STATUSES.join('|')}`,
    );
  }
  if (!/^\s*\*\*Last verified:\*\*\s+\S/m.test(body)) {
    errors.push(`${cardRel}: missing "**Last verified:**" line`);
  }

  // Required sections (each appears at least once). Allow trailing
  // descriptive text on the heading line — e.g. "## Verification (60-second
  // AI-reviewer recipe)" — but require the section name to be the first
  // word(s) of the heading. The boundary `(\s|$)` prevents `## Source` from
  // also matching `## SourceMaps`.
  for (const section of REQUIRED_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(\\s|$)`, 'm');
    if (!re.test(body)) {
      errors.push(`${cardRel}: missing required section "${section}"`);
    }
  }

  return errors;
}

function auditConnectorCard(root, item) {
  /** @type {string[]} */
  const errors = [];
  const cardRel = item.proofCard;

  // Path-shape gate. audit-status-claims also enforces these rules, but the
  // two scripts are documented as standing alone in CI — re-checking here
  // means audit-proof-cards on its own catches a malformed proofCard
  // string (Copilot review on PR #693). Mirror the audit-status-claims
  // rules: must live under PROOF_CARD_DIR, must end with .md, must be a
  // single file directly under the dir (no subpaths, no `..` traversal),
  // and must not point at the authoring template.
  if (!cardRel.startsWith(PROOF_CARD_DIR)) {
    errors.push(
      `${item.file}: proofCard '${cardRel}' must live under ${PROOF_CARD_DIR}`,
    );
    return errors;
  }
  if (!cardRel.endsWith('.md')) {
    errors.push(
      `${item.file}: proofCard '${cardRel}' must end with .md (Markdown proof-card file)`,
    );
    return errors;
  }
  const remainder = cardRel.slice(PROOF_CARD_DIR.length);
  if (
    remainder === '' ||
    remainder.includes('/') ||
    remainder.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    errors.push(
      `${item.file}: proofCard '${cardRel}' must be a single .md file directly under ${PROOF_CARD_DIR}`,
    );
    return errors;
  }
  if (remainder === '_template.md') {
    errors.push(
      `${item.file}: proofCard cannot point at '_template.md' — that is the authoring template, not a real card`,
    );
    return errors;
  }

  const cardAbs = path.resolve(root, cardRel);
  if (!fs.existsSync(cardAbs)) {
    errors.push(`${item.file}: proofCard file missing at ${cardRel}`);
    return errors;
  }

  const body = fs.readFileSync(cardAbs, 'utf8');
  errors.push(...validateCardStructure(cardRel, body));
    applyClaimChecks(cardRel, body, errors);

  // Status field on card must match the source-level productionStatus.
  // Only run the mismatch check if the card's Status value is *valid* — an
  // invalid value (e.g. typo `prodution`) is already reported by
  // validateCardStructure, and emitting a second mismatch error for the
  // same root cause is noise.
  if (item.productionStatus) {
    const cardStatus = extractCardStatus(body);
    if (
      cardStatus &&
      VALID_STATUSES.includes(cardStatus) &&
      cardStatus !== item.productionStatus
    ) {
      errors.push(
        `${cardRel}: declares Status: ${cardStatus} but source-level productionStatus is '${item.productionStatus}' on ${item.file}`,
      );
    }
  }

  return errors;
}

/**
 * List every `.md` file under <root>/docs/review/proof-cards/, excluding
 * `_template.md` (which is the authoring template — its placeholder values
 * intentionally do not satisfy the structure checks).
 */
function listAllCards(root) {
  const dir = path.join(root, PROOF_CARD_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== '_template.md')
    .map((f) => path.join(dir, f))
    .sort();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root;
  recipeCtx = buildRecipeContext(root);
  baselineSet = readBaseline(root);
  thresholdState.clear();
  const items = scanConnectors(root);
  /** @type {string[]} */
  const errors = [];

  // Production connectors MUST have a proofCard field (audit-status-claims
  // also enforces this; re-checking here so this script stands alone).
  for (const item of items) {
    if (isProductionTier(item.productionStatus) && !item.proofCard) {
      errors.push(
        `${item.file}: productionStatus='${item.productionStatus}' (production tier) requires a static proofCard pointing at ${PROOF_CARD_DIR}<name>.md`,
      );
    }
  }

  // Audit every card that's referenced from a connector (verifies
  // existence + structure + Status-vs-productionStatus match).
  const tagged = new Set();
  let connectorCardCount = 0;
  for (const item of items) {
    if (!item.proofCard) continue;
    connectorCardCount += 1;
    tagged.add(path.resolve(root, item.proofCard));
    errors.push(...auditConnectorCard(root, item));
  }

  // Also audit every card on disk that no connector references — service-
  // level cards (ai-providers, dlp-service, mcp-aggregator, etc.) plus
  // anything else under docs/review/proof-cards/. Catches malformed
  // standalone cards. Excludes _template.md (the authoring template
  // intentionally fails the structure checks; its placeholder Status line
  // does not pick a single value).
  let serviceCardCount = 0;
  for (const cardAbs of listAllCards(root)) {
    if (tagged.has(cardAbs)) continue;
    serviceCardCount += 1;
    const cardRel = rel(root, cardAbs);
    const body = fs.readFileSync(cardAbs, 'utf8');
    errors.push(...validateCardStructure(cardRel, body));
    applyClaimChecks(cardRel, body, errors);
  }

  // --init / --write short-circuit here; otherwise this adds the
  // ratchet-down errors for baselined cards that now pass.
  const baselineExit = handleBaseline(root, options, errors);
  if (baselineExit !== null) process.exit(baselineExit);

  if (errors.length > 0) {
    console.error('audit-proof-cards: FAIL');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `audit-proof-cards: OK (${connectorCardCount} connector-tagged + ${serviceCardCount} service-level cards verified)`,
  );
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
