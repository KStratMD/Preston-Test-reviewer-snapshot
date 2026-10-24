#!/usr/bin/env node
// @ts-check
//
// audit-portfolio-evidence.mjs (PR 22 / Phase 4)
//
// Drift gate for the SuiteCentral portfolio evidence manifest. Re-runs the
// builder in-memory and compares the result against `public/portfolio-evidence.json`.
// Fails CI when:
//   - The committed manifest is missing
//   - The committed manifest is malformed JSON
//   - Any card was added, removed, renamed (different slug), or edited in a
//     way that affects a tracked field WITHOUT a corresponding
//     `npm run build:portfolio-evidence-manifest` re-stamp
//
// Implementation note: comparison is deep-value, not byte-for-byte. The
// committed manifest is JSON.parse'd and each card's fields are diff'd
// against the freshly-built values via JSON.stringify equality per key
// (bidirectional union sweep), plus a top-level key-set sweep. Whitespace-
// only changes to the committed JSON are NOT detected — the builder
// writes deterministic formatting (sorted by slug, 2-space indent,
// trailing newline) so a hand-edited file with cosmetic whitespace would
// silently pass the audit but still fail visual review. The trade-off is
// intentional: byte equality would false-positive on JSON.stringify
// platform variance, and the per-field diff produces actionable messages
// pointing at the specific card.field that drifted.
//
// Usage:
//   node scripts/audit-portfolio-evidence.mjs           # against this repo
//   node scripts/audit-portfolio-evidence.mjs --root <dir>   # for tests

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, MANIFEST_PATH } from './lib/portfolio-evidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--help':
        console.log(
          'Usage: node scripts/audit-portfolio-evidence.mjs [--root <dir>]',
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Compute a per-card diff between committed and freshly-built manifests.
 * Returns an array of human-readable error strings (empty when in sync).
 *
 * The per-card key sweep is BIDIRECTIONAL: it walks the union of committed
 * and fresh keys so a key that exists only on one side surfaces as
 * `field drifted: committed=undefined fresh=...` (or vice versa). Without
 * this, a typo'd partial revert that leaves an extraneous key in
 * `public/portfolio-evidence.json` would silently pass — the same blind
 * spot called out in PR 22 whole-PR code review STRONG-CONSIDER #1.
 *
 * @param {{cards: Array<{slug: string, [k: string]: unknown}>}} committed
 * @param {{cards: Array<{slug: string, [k: string]: unknown}>}} fresh
 * @returns {string[]}
 */
function diffManifests(committed, fresh) {
  /** @type {string[]} */
  const errors = [];
  const committedBySlug = new Map(committed.cards.map((c) => [c.slug, c]));
  const freshBySlug = new Map(fresh.cards.map((c) => [c.slug, c]));

  for (const slug of freshBySlug.keys()) {
    if (!committedBySlug.has(slug)) {
      errors.push(`card added or renamed: '${slug}' is on disk but not in the manifest`);
    }
  }
  for (const slug of committedBySlug.keys()) {
    if (!freshBySlug.has(slug)) {
      errors.push(`card removed or renamed: '${slug}' is in the manifest but no card file matches`);
    }
  }

  for (const [slug, freshCard] of freshBySlug.entries()) {
    const committedCard = committedBySlug.get(slug);
    if (!committedCard) continue;
    const allKeys = new Set([...Object.keys(freshCard), ...Object.keys(committedCard)]);
    for (const key of allKeys) {
      const freshVal = JSON.stringify(/** @type {Record<string, unknown>} */ (freshCard)[key]);
      const committedVal = JSON.stringify(/** @type {Record<string, unknown>} */ (committedCard)[key]);
      if (freshVal !== committedVal) {
        errors.push(`${slug}.${key} drifted: committed=${committedVal} fresh=${freshVal}`);
      }
    }
  }

  return errors;
}

/**
 * Top-level key-set diff. Catches a stale `generatedFrom` or a future
 * extraneous key like `schemaVersion` left over from a partial revert.
 * Symmetric to diffManifests's union sweep — the per-card and per-manifest
 * blind-spot fix has to be applied at both levels.
 *
 * @param {Record<string, unknown>} committed
 * @param {Record<string, unknown>} fresh
 * @returns {string[]}
 */
function diffTopLevel(committed, fresh) {
  /** @type {string[]} */
  const errors = [];
  const allKeys = new Set([...Object.keys(committed), ...Object.keys(fresh)]);
  for (const key of allKeys) {
    // `cards` is checked by diffManifests; skip here to avoid noisy double
    // reporting (the per-card diff produces precise per-field errors).
    if (key === 'cards') continue;
    const freshVal = JSON.stringify(fresh[key]);
    const committedVal = JSON.stringify(committed[key]);
    if (freshVal !== committedVal) {
      errors.push(`top-level '${key}' drifted: committed=${committedVal} fresh=${freshVal}`);
    }
  }
  return errors;
}

/**
 * Validate that a parsed-JSON value has the manifest shape this script
 * relies on: object with `cards` array, every card has a string `slug`.
 * Returns null when shape is correct, or a precise human-readable error
 * string when wrong. Catches the class of bugs where someone hand-edits
 * the JSON to a different valid-JSON shape (array, primitive, missing
 * `cards`, card without `slug`) — without this check, the diff functions
 * throw opaque TypeErrors from inside `.map` / `.set` calls.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function validateManifestShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `expected an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`;
  }
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (!('cards' in obj)) return `missing required top-level field 'cards'`;
  if (!Array.isArray(obj.cards)) {
    // Explicit null branch: typeof null === 'object', so without this the
    // error would say "got object" for a null `cards` value (Copilot R3
    // NIT). Same pattern as the outer value-shape check above.
    const actual = obj.cards === null ? 'null' : typeof obj.cards;
    return `top-level 'cards' must be an array, got ${actual}`;
  }
  // Track slugs to catch a duplicate before it reaches diffManifests
  // (which builds a Map keyed by slug — last-write-wins would silently
  // collapse duplicates and greenwash a hand-edit that pasted a card
  // twice. Copilot R8 finding on PR 22).
  const seenSlugs = new Set();
  for (let i = 0; i < obj.cards.length; i += 1) {
    const card = obj.cards[i];
    if (card === null || typeof card !== 'object' || Array.isArray(card)) {
      return `cards[${i}] must be an object, got ${card === null ? 'null' : Array.isArray(card) ? 'array' : typeof card}`;
    }
    const c = /** @type {Record<string, unknown>} */ (card);
    if (typeof c.slug !== 'string' || c.slug === '') {
      return `cards[${i}] missing required string field 'slug'`;
    }
    if (seenSlugs.has(c.slug)) {
      return `cards[${i}] duplicates slug '${c.slug}' (each slug must appear at most once; the diff is keyed by slug so duplicates would silently collapse)`;
    }
    seenSlugs.add(c.slug);
  }
  return null;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const manifestAbs = path.join(root, MANIFEST_PATH);

  if (!fs.existsSync(manifestAbs)) {
    console.error(
      `audit-portfolio-evidence: FAIL — committed manifest missing at ${MANIFEST_PATH}.\n` +
        `  Run: npm run build:portfolio-evidence-manifest`,
    );
    process.exit(1);
  }

  /** @type {unknown} */
  let rawCommitted;
  try {
    rawCommitted = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  } catch (parseError) {
    console.error(
      `audit-portfolio-evidence: FAIL — committed manifest is not valid JSON: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
    );
    process.exit(1);
  }

  // Shape-validate BEFORE handing to diff functions. Without this, a
  // hand-edit that drops `cards` or replaces the file with a JSON array
  // would surface as `committed.cards.map is not a function` from inside
  // diffManifests — accurate but opaque (Copilot R2 finding on PR 22).
  // Treat any wrong shape as a manifest-schema failure with a precise
  // pointer to the missing/wrong field.
  const shapeError = validateManifestShape(rawCommitted);
  if (shapeError !== null) {
    console.error(
      `audit-portfolio-evidence: FAIL — committed manifest has wrong shape: ${shapeError}\n` +
        `  Run: npm run build:portfolio-evidence-manifest`,
    );
    process.exit(1);
  }
  /** @type {ReturnType<typeof buildManifest>} */
  const committed = /** @type {ReturnType<typeof buildManifest>} */ (rawCommitted);

  /** @type {ReturnType<typeof buildManifest>} */
  let fresh;
  try {
    fresh = buildManifest(root);
  } catch (buildError) {
    console.error(
      `audit-portfolio-evidence: FAIL — could not parse one or more cards:\n  ${
        buildError instanceof Error ? buildError.message : String(buildError)
      }`,
    );
    process.exit(1);
  }

  /** @type {string[]} */
  const errors = [];
  errors.push(...diffTopLevel(committed, fresh));
  errors.push(...diffManifests(committed, fresh));

  if (errors.length > 0) {
    console.error('audit-portfolio-evidence: FAIL');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      '\n  To fix: npm run build:portfolio-evidence-manifest && git add public/portfolio-evidence.json',
    );
    process.exit(1);
  }

  console.log(
    `audit-portfolio-evidence: OK (${fresh.cardCount} cards in sync with ${MANIFEST_PATH})`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
