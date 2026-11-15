#!/usr/bin/env node
// @ts-check
//
// check-strategic-claims.mjs (PR 16 — A-Grade Plan strategic claim cleanup)
//
// Walks a set of product-positioning markdown files and fails CI on any
// numerical claim that lacks a classification tag or allowlist match.
//
// Classification tag format (HTML comment, on the same line as the
// number it classifies — line-level scope, so one tag covers every
// number on that line):
//
//   <!-- claim:evidence -->          — sourced from metrics.json or a
//                                      CI-emitted artifact
//   <!-- claim:benchmark -->         — from a run of the (post-PR-8-OptA)
//                                      accuracy harness
//   <!-- claim:pilot-result -->      — measured during a real pilot
//                                      (post-PR 15)
//   <!-- claim:labeled-projection -->— explicit "projected", "target",
//                                      or "estimated"
//
// Allowlist (`scripts/strategic-claims.allowlist.json`):
//   - `patterns`: array of {regex, reason}. Each regex MUST be anchored
//     (^...$) — it is matched against the EXACT numeric token, not the
//     surrounding text. Use for year stamps (`^20[12]\d$`), version
//     numbers (`^v?\d+\.\d+(\.\d+)?$`), HTTP status placeholders
//     (`^[2-5]xx$`), etc.
//   - `literals`: array of {value, reason}. Exact-string match against
//     the token. Use for one-off cases where a pattern would over-match.
//
// Skipped regions (numbers inside these never count as claims):
//   - Fenced code blocks (between ``` or ~~~ lines).
//   - Inline code spans (between matching backticks within a line).
//   - URLs (http://..., https://..., <protocol://...>).
//   - HTML comments (between <!-- and -->), EXCEPT classification tags.
//
// Usage:
//   node scripts/check-strategic-claims.mjs                      # walk default SCAN_TARGETS
//   node scripts/check-strategic-claims.mjs --root <dir>         # for tests
//   node scripts/check-strategic-claims.mjs --targets a.md,b.md  # override target list
//   node scripts/check-strategic-claims.mjs --allowlist <path>   # override allowlist path
//
// Exit codes: 0 clean, 1 violations, 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Default scan targets — the product-positioning surfaces the wedge
// claim-cleanup polices. Relative to --root.
//
// Initial scope (PR 16): CLAUDE.md and the new docs/strategic/
// competitive-positioning.md. README.md and docs/01_VISION_DOCUMENT.md
// are deferred to a follow-up sweep PR — the gate is live and tested
// here, and the follow-up just adds files to this array + tags the
// existing claims (mechanical work, no new design).
//
// M1 Phase A update: README.md lines 54 + 67 had their "95%+ accuracy"
// prose replaced with `<!-- METRIC:ai_accuracy.latest_pct -->` templates
// + `<!-- claim:benchmark -->` classification, which means those two
// lines are now ready when the README-sweep PR admits the whole file.
// The wholesale admission is deferred (8 other unclassified numbers
// would surface — out of scope for Phase A).
const DEFAULT_SCAN_TARGETS = [
  'CLAUDE.md',
  'docs/strategic/competitive-positioning.md',
];

const CLAIM_TAG_RE = /<!--\s*claim:(evidence|benchmark|pilot-result|labeled-projection)\s*-->/;
// Numeric tokens we treat as CLAIMS — the high-value drift surfaces the plan
// cares about. Three disjoint patterns; ordering matters because they're
// applied as a single alternation:
//   (A) Percentages — `95%`, `99.5%`, `95-99%` (each side of the range).
//   (B) Currency — `$0.02`, `$50`, `$1,000`. Match captures the full unit.
//   (C) Comma-grouped counts — `10,124`, `462,000`. Bare integers WITHOUT
//       commas (ordinals, section refs, port numbers, PR/issue refs) are
//       intentionally NOT flagged; if the author writes a comma-grouped
//       count they're making a real numeric claim.
// Ranges like "20-50 hrs" or counts like "5 production" are NOT auto-
// flagged by the regex — if the author wants those classified they can
// add an inline `<!-- claim:* -->` voluntarily (the gate doesn't punish
// over-classification). The gate's role is to catch the high-value
// claim-shapes that have historically drifted (the unqualified "95-99%"
// pattern). Adding more granular catches is a future tightening.
const NUMERIC_TOKEN_RE = /(?:\b\d+(?:\.\d+)?%|\$\d+(?:[.,]\d+)*|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/g;

/**
 * @typedef {{ root: string, targets: string[] | null, allowlist: string }} ParsedArgs
 * @typedef {{ patterns: Array<{ regex: RegExp, reason: string }>, literals: Set<string> }} Allowlist
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {{ root: string, targets: string[] | null, allowlist: string | null }} */
  const args = { root: REPO_ROOT, targets: null, allowlist: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--root') {
      args.root = argv[++i];
    } else if (a === '--targets') {
      args.targets = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--allowlist') {
      args.allowlist = argv[++i];
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
    i++;
  }
  const resolvedAllowlist = args.allowlist ?? path.join(args.root, 'scripts/strategic-claims.allowlist.json');
  return { root: args.root, targets: args.targets, allowlist: resolvedAllowlist };
}

/**
 * @param {string} filePath
 * @returns {Allowlist}
 */
function loadAllowlist(filePath) {
  if (!fs.existsSync(filePath)) {
    return { patterns: [], literals: new Set() };
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const patterns = (raw.patterns || []).map((/** @type {{regex: string, reason?: string}} */ p) => ({
    regex: new RegExp(p.regex),
    reason: p.reason || '',
  }));
  const literals = new Set((raw.literals || []).map((/** @type {{value: string}} */ l) => l.value));
  return { patterns, literals };
}

/**
 * @param {string} token
 * @param {Allowlist} allow
 */
function tokenIsAllowlisted(token, allow) {
  if (allow.literals.has(token)) return true;
  for (const p of allow.patterns) {
    if (p.regex.test(token)) return true;
  }
  return false;
}

// Strip URLs, inline code spans, and HTML comments from a line. The claim
// tag, even though it's an HTML comment, is preserved so the line-scope
// check below can still find it. Code blocks (fenced ``` / ~~~) are
// handled at the line level by the caller.
function maskNonClaimRegions(line) {
  let out = line;
  // URLs — bare or in angle brackets.
  const urlRe = /<?(?:https?|ftp):\/\/[^\s<>)]+>?/g;
  out = out.replace(urlRe, (m) => '\0'.repeat(m.length));
  // Inline code spans — single backticks (greedy match within one line).
  const codeRe = /`[^`]*`/g;
  out = out.replace(codeRe, (m) => '\0'.repeat(m.length));
  // HTML comments — but NOT the claim tag itself. We mask the comment
  // bytes only if it's not a claim tag (so the claim tag's whitespace
  // and inner text — including any digits that might be inside `claim:*`
  // — are preserved, but no claim tag contains digits anyway).
  const commentRe = /<!--[\s\S]*?-->/g;
  out = out.replace(commentRe, (m) => (CLAIM_TAG_RE.test(m) ? m : '\0'.repeat(m.length)));
  return out;
}

function checkFile(absPath, displayPath, allow) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const violations = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Track fenced code blocks (``` or ~~~). Opening and closing markers
    // appear on their own (after optional indent).
    const fenceOpen = /^\s*(```|~~~)/.exec(raw);
    if (fenceOpen) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceOpen[1];
      } else if (raw.trim().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    // Apply per-line masking to skip URLs/inline code/HTML-comments-that-
    // aren't-claim-tags.
    const masked = maskNonClaimRegions(raw);
    const tagPresent = CLAIM_TAG_RE.test(raw);

    // Reset regex state (g flag) and walk every numeric token on the line.
    NUMERIC_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = NUMERIC_TOKEN_RE.exec(masked)) !== null) {
      const token = m[0];
      // A token whose match is entirely inside masked NUL bytes was
      // wiped out by maskNonClaimRegions — but regex execution against
      // \0 returns no match, so we don't reach here.
      if (tagPresent) continue;
      if (tokenIsAllowlisted(token, allow)) continue;
      violations.push({
        file: displayPath,
        line: i + 1,
        col: m.index + 1,
        token,
      });
    }
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = args.targets || DEFAULT_SCAN_TARGETS;
  const allow = loadAllowlist(args.allowlist);

  let allViolations = [];
  let scannedFiles = 0;
  for (const rel of targets) {
    const abs = path.join(args.root, rel);
    if (!fs.existsSync(abs)) {
      // Missing files are not a violation — they may be in-progress per
      // the plan's incremental rollout. (A future tightening could require
      // SCAN_TARGETS exist; today we soft-skip.)
      continue;
    }
    scannedFiles++;
    const violations = checkFile(abs, rel, allow);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`[strategic-claims] ${allViolations.length} unclassified numerical claim(s):`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}:${v.col}  "${v.token}"  (add inline classification tag or allowlist entry)`);
    }
    console.error('');
    console.error('Each unclassified number must be tagged on the same line with one of:');
    console.error('  <!-- claim:evidence -->          (sourced from metrics.json / CI artifact)');
    console.error('  <!-- claim:benchmark -->         (post-PR-8-OptA accuracy harness)');
    console.error('  <!-- claim:pilot-result -->      (measured during real pilot)');
    console.error('  <!-- claim:labeled-projection -->(explicit projection / target / estimate)');
    console.error('');
    console.error(`Or extend the allowlist at ${path.relative(args.root, args.allowlist)}.`);
    process.exit(1);
  }

  console.log(`[strategic-claims] OK — ${scannedFiles} file(s) scanned, all numerical claims classified.`);
  process.exit(0);
}

main();
