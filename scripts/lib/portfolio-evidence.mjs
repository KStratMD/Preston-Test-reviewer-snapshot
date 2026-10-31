// @ts-check
// Shared parser for Squire product cards under
// `docs/review/squire-product-cards/<slug>.md`. Imported by
// scripts/build-portfolio-evidence-manifest.mjs (writes the JSON) and
// scripts/audit-portfolio-evidence.mjs (drift gate). The two MUST share
// extraction logic so a parser bug surfaces in both at once instead of
// allowing the audit to greenwash a stale manifest.

import fs from 'node:fs';
import path from 'node:path';

export const CARDS_DIR = 'docs/review/squire-product-cards/';
export const MANIFEST_PATH = 'public/portfolio-evidence.json';

// Excluded from the card walk. README.md is the directory index, not a card;
// any future authoring template would live here too (mirrors the
// `_template.md` exclusion in audit-proof-cards).
const NON_CARD_FILES = new Set(['README.md', '_template.md']);

// Reviewer-mirror render base. The mirror is republished on every push to
// `main` per CLAUDE.md > "Reviewer Mirror — Public Snapshot". Cards under
// `docs/review/**` are allowlisted there, so the `blob/main` URL renders the
// markdown for an outside reviewer without private-repo access. Hard-coded
// `main` matches the reviewer-mirror branch convention and is intentional —
// the snapshot is always force-pushed to that branch, never tagged.
export const REVIEWER_MIRROR_BASE_URL =
  'https://github.com/KStratMD/Preston-Test-reviewer-snapshot/blob/main/';

/**
 * @typedef {object} LastReviewed
 * @property {string} date  ISO date (YYYY-MM-DD)
 * @property {string} sha   short git sha (no backticks)
 */

/**
 * @typedef {object} ParsedCard
 * @property {string} slug              filename without .md
 * @property {string} productName       text after "# Squire Product Card:"
 * @property {string} owner             text after "**Owner:**"
 * @property {string} status            text after "**Squire-side status:**"
 *                                       (acceptance criterion #3 anchor)
 * @property {LastReviewed} lastReviewed parsed `YYYY-MM-DD · git sha \`xxx\``
 * @property {string} whatItDoesToday   first paragraph after the H2
 * @property {string} recommendedPath   text after "**Recommended path today:**"
 *                                       (acceptance criterion #4 anchor)
 * @property {string} sourcePath        repo-relative POSIX path to the card
 * @property {string} reviewerMirrorUrl deep link for acceptance criterion #6
 */

/**
 * List card files under `<root>/docs/review/squire-product-cards/`.
 * Returns absolute paths. Skips README.md (directory index) and any
 * `_template.md` (consistent with audit-proof-cards).
 * @param {string} root
 * @returns {string[]}
 */
export function listCardFiles(root) {
  const dir = path.join(root, CARDS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !NON_CARD_FILES.has(f))
    .map((f) => path.join(dir, f))
    .sort();
}

/**
 * Extract the trimmed tail of a `**Label:**` line. Anchored to end-of-line
 * so an inline tail with bold/em formatting is captured verbatim
 * (e.g. `**Recommended path today:** **Enhance** — pilot ...`).
 *
 * @param {string} body
 * @param {string} label  e.g. "Owner", "Squire-side status"
 * @returns {string | null}  null when the line is absent or empty
 */
function extractLabel(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*\\*\\*${escaped}:\\*\\*\\s*(.*?)\\s*$`, 'm');
  const match = body.match(re);
  if (!match) return null;
  const tail = match[1].trim();
  return tail === '' ? null : tail;
}

/**
 * Parse the "Last reviewed" line — full canonical form (single backticks
 * around the sha for clean JSDoc rendering):
 *   **Last reviewed:** 2026-05-06 · git sha `1e6cb686`
 * The separator `·` (U+00B7) is the canonical delimiter used across every
 * card. Returns null when either the line is absent OR the format does
 * not match.
 *
 * @param {string} body
 * @returns {LastReviewed | null}
 */
function extractLastReviewed(body) {
  const raw = extractLabel(body, 'Last reviewed');
  if (raw === null) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s*·\s*git sha\s*`([0-9a-f]{7,40})`\s*$/);
  if (!m) return null;
  return { date: m[1], sha: m[2] };
}

/**
 * Extract the H1 product name from `# Squire Product Card: <Name>`.
 * Captures everything after the colon, trimmed.
 * @param {string} body
 * @returns {string | null}
 */
function extractProductName(body) {
  const m = body.match(/^#\s+Squire Product Card:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * @typedef {{ kind: 'ok', value: string } | { kind: 'missing' } | { kind: 'multiparagraph' }} WhatItDoesResult
 */

/**
 * Extract content under `## What it does today`. The schema (see
 * `docs/review/squire-product-cards/README.md` authoring rules) requires a
 * SINGLE paragraph here — Reuben-style executive readers browse, so the
 * authoring rule is "density beats length". Returns:
 *   - {kind:'ok', value} — exactly one paragraph found
 *   - {kind:'missing'}   — section absent or empty
 *   - {kind:'multiparagraph'} — two+ paragraphs (audit must reject; silently
 *     concatenating would hide content from the manifest, silently dropping
 *     the rest would hide it from the static surface — both are user-visible
 *     fact loss. Fail loud instead, per PR 22 review STRONG-CONSIDER #3.)
 *
 * @param {string} body
 * @returns {WhatItDoesResult}
 */
function extractWhatItDoesToday(body) {
  // Capture the whole region from the heading to the next `##` (or EOF).
  const region = body.match(/##\s+What it does today\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  if (!region) return { kind: 'missing' };
  // Split on blank lines into paragraphs; trim and drop empties so trailing
  // whitespace at the section boundary doesn't count as a paragraph.
  const paragraphs = region[1]
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((s) => s.trim()).filter(Boolean).join(' '))
    .filter((p) => p !== '');
  if (paragraphs.length === 0) return { kind: 'missing' };
  if (paragraphs.length > 1) return { kind: 'multiparagraph' };
  return { kind: 'ok', value: paragraphs[0] };
}

/**
 * Parse a single card file. Returns the structured record OR throws with a
 * precise per-field error so the audit script can surface it.
 *
 * @param {string} root      repo root (for sourcePath calculation)
 * @param {string} absPath   absolute path to the card .md
 * @returns {ParsedCard}
 */
export function parseCard(root, absPath) {
  const body = fs.readFileSync(absPath, 'utf8');
  const slug = path.basename(absPath, '.md');
  const sourcePath = path.relative(root, absPath).split(path.sep).join('/');

  /** @type {string[]} */
  const missing = [];
  const productName = extractProductName(body);
  if (!productName) missing.push('# Squire Product Card: <Name>');
  const owner = extractLabel(body, 'Owner');
  if (!owner) missing.push('**Owner:**');
  const status = extractLabel(body, 'Squire-side status');
  if (!status) missing.push('**Squire-side status:**');
  const lastReviewed = extractLastReviewed(body);
  if (!lastReviewed) missing.push('**Last reviewed:** YYYY-MM-DD · git sha `xxxxxxx`');
  const whatItDoesResult = extractWhatItDoesToday(body);
  /** @type {string | null} */
  let whatItDoesToday = null;
  if (whatItDoesResult.kind === 'missing') {
    missing.push('## What it does today');
  } else if (whatItDoesResult.kind === 'multiparagraph') {
    // Throw immediately so the error message identifies the file. Falling
    // through to the `missing` aggregation would label this as "missing",
    // which is misleading.
    throw new Error(
      `${sourcePath}: "## What it does today" must be a single paragraph (see authoring rules in docs/review/squire-product-cards/README.md)`,
    );
  } else {
    whatItDoesToday = whatItDoesResult.value;
  }
  const recommendedPath = extractLabel(body, 'Recommended path today');
  if (!recommendedPath) missing.push('**Recommended path today:**');

  if (missing.length > 0) {
    throw new Error(
      `${sourcePath}: missing required field(s): ${missing.join(', ')}`,
    );
  }

  return {
    slug,
    // Non-null assertions below are safe — the `missing` check above bails
    // before this return when any field is null.
    productName: /** @type {string} */ (productName),
    owner: /** @type {string} */ (owner),
    status: /** @type {string} */ (status),
    lastReviewed: /** @type {LastReviewed} */ (lastReviewed),
    whatItDoesToday: /** @type {string} */ (whatItDoesToday),
    recommendedPath: /** @type {string} */ (recommendedPath),
    sourcePath,
    reviewerMirrorUrl: `${REVIEWER_MIRROR_BASE_URL}${sourcePath}`,
  };
}

/**
 * Parse every card under <root>/docs/review/squire-product-cards/ and
 * return the canonical manifest object. Sort by slug for deterministic
 * output (so the drift-gate diff is stable across filesystems).
 *
 * @param {string} root
 * @returns {{generatedFrom: string, cardCount: number, cards: ParsedCard[]}}
 */
export function buildManifest(root) {
  const cards = listCardFiles(root).map((f) => parseCard(root, f));
  cards.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    generatedFrom: CARDS_DIR,
    cardCount: cards.length,
    cards,
  };
}
