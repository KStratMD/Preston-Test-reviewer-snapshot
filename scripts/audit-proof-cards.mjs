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

import fs from 'node:fs';
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

const VALID_STATUSES = ['production', 'beta', 'demo_only', 'stub'];

function parseArgs(argv) {
  const options = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--help':
        console.log('Usage: node scripts/audit-proof-cards.mjs [--root <dir>]');
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
  const items = scanConnectors(root);
  /** @type {string[]} */
  const errors = [];

  // Production connectors MUST have a proofCard field (audit-status-claims
  // also enforces this; re-checking here so this script stands alone).
  for (const item of items) {
    if (item.productionStatus === 'production' && !item.proofCard) {
      errors.push(
        `${item.file}: productionStatus='production' requires a static proofCard pointing at ${PROOF_CARD_DIR}<name>.md`,
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
  }

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
