#!/usr/bin/env node
// scripts/check-terminology.mjs — customer-scope vocabulary gate (tranche-1 D5).
//
// The current proposal artifacts are written for a horizontal, non-regulated
// customer scope. This gate fails CI when regulated-medical vocabulary reaches
// prose in that scope. Exit 0 clean, 1 at least one hit, 2 environment or
// usage error. `--root <dir>` points at another checkout (the harness uses it);
// `--list` prints the in-scope files, one per line, and exits 0.
//
// Scope (Markdown only, `.md`):
//   - Markdown under docs/superpowers/specs/ and docs/superpowers/plans/ whose
//     file name starts with `2026-09-02-` (the current proposal artifacts)
//   - every .md under docs/blueprint/ (created by tranche-2 Workstream B)
//   - any docs/**/*.md whose YAML front matter, opening on the first line of
//     the file, carries `terminology-policy: customer-scope` (LF, CRLF, a BOM,
//     trailing whitespace on the `---` delimiters, and a quoted value are all
//     accepted; the key anywhere else in the file opts nothing in)
//
// What is prose: everything except fenced code (``` or ~~~ opener of three or
// more, an info string without a backtick for backtick fences, closed only by a
// run of the same character at least as long, or end of file), inline code
// spans (a run of N backticks closed by the next run of exactly N, on the same
// line), and HTML comments (single- or multi-line). Code spans and comments are
// resolved left to right, whichever opens first, as CommonMark does, so a
// comment opener inside a code span is code and a backtick inside a comment is
// comment; a backslash escapes only in prose. An inline comment opener that never
// closes before its paragraph ends (a blank line, heading, fence, list item, block
// quote, thematic break or HTML block) is literal text; a comment opening at the
// start of a line is an HTML block that runs to the line containing its close; for
// an inline comment a `-->` preceded by `-`, or `--` inside the text, does not
// close (conservative), while a block ends on any line containing `-->`. A line may
// be exempted only by an explicit marker WITH a reason, as
// a real HTML comment on that line: `<!-- terminology-allow: <reason> -->`.
// A marker without a reason is itself a finding; a marker shown inside inline
// code is code, not an exemption.
//
// Matching is on normalised text: NFKC (fullwidth letters fold to ASCII),
// zero-width and soft-hyphen characters removed, and Markdown emphasis
// markers (`*`, `_`) removed, so `pa**tient**` and `p<zero-width>atient` are
// hits. This targets honest drafting; it is not a defence against deliberate
// evasion beyond those normalisations, and the gate documentation says so.
//
// Deliberately NOT banned: `EHR` (means "Effective Hourly Rate" in docs/strategic)
// and `payer`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHRASES = [
  { re: /patient-facing/i, label: 'patient-facing' },
  { re: /\bpatients?\b(?!-facing)/i, label: 'patient(s)' }, // `patient-facing` is reported once, by the entry above
  { re: /\bHIPAA\b/, label: 'HIPAA' },
  { re: /\bPHI\b/, label: 'PHI' },
  { re: /\bclinical\b/i, label: 'clinical' },
  { re: /\bhealthcare\b/i, label: 'healthcare' },
];
const FIXED = [
  { dir: 'docs/superpowers/specs', prefix: '2026-09-02-' },
  { dir: 'docs/superpowers/plans', prefix: '2026-09-02-' },
  { dir: 'docs/blueprint', prefix: '' },
];
const ALLOW_WITH_REASON = /^<!--\s*terminology-allow:\s*[^\s>][^>]*-->$/;
const ALLOW_ANY = /^<!--\s*terminology-allow\b[^>]*-->$/;
const INVISIBLE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g; // zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen

function usage(msg) {
  console.error(`[terminology] ${msg}`);
  console.error('usage: node scripts/check-terminology.mjs [--root <dir>] [--list]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let rootArg = null;
let list = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--root') {
    rootArg = argv[i + 1];
    if (!rootArg || rootArg.startsWith('--')) usage('--root requires a directory');
    i += 1;
  } else if (a === '--list') {
    list = true;
  } else {
    usage(`unknown argument: ${a}`);
  }
}
const ROOT = rootArg ? path.resolve(rootArg) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(ROOT, 'docs');
if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
  console.error(`[terminology] environment error: missing docs/ under ${ROOT}`);
  process.exit(2);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile() && name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Front matter must open on the first line of the file (after an optional BOM)
// and close on a later delimiter line; only that block can opt a file in.
const DELIM = /^---[ \t]*$/;
const OPT_IN = /^terminology-policy:[ \t]*(?:"customer-scope"|'customer-scope'|customer-scope)(?:[ \t]+#.*)?[ \t]*$/; // an inline YAML comment after the value is allowed
function optedIn(text) {
  const lines = text.replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (!DELIM.test(lines[0] ?? '')) return false;
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIM.test(lines[i])) return false;
    if (OPT_IN.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j += 1) if (DELIM.test(lines[j])) return true;
      return false; // never closed: not front matter
    }
  }
  return false;
}

function inScope() {
  const files = new Set();
  for (const { dir, prefix } of FIXED) {
    for (const f of walk(path.join(ROOT, dir))) if (path.basename(f).startsWith(prefix)) files.add(f);
  }
  for (const f of walk(docsDir)) {
    if (files.has(f)) continue;
    if (optedIn(fs.readFileSync(f, 'utf8'))) files.add(f);
  }
  return [...files].sort();
}

// Backslash escapes, code spans and HTML comments resolve left to right, whichever
// comes first, as CommonMark does. A backslash escapes the ASCII punctuation
// character after it only in prose: inside a code span or a comment a backslash
// is literal, so `\`` inside a span does not delay its close and `\-->` inside a
// comment still closes it. An escaped character becomes a private-use placeholder
// that is not a word character, except an escaped underscore, which stays an
// underscore so that `x\_patient` remains the single identifier the renderer shows.
const ESCAPABLE = /[!-/:-@[-`{-~]/;
// For an INLINE comment two rules apply, the conservative reading across CommonMark
// versions: a `-->` whose preceding character is `-` does not close (the empty forms
// `<!-->` and `<!--->` are handled by the caller), and the text before the close may
// not contain `--` (invalid under CommonMark 0.30 and rendered visibly by markdown-it
// and micromark). A block-level comment is exempt from both and ends on any line
// containing `-->`, the HTML-block end condition in every version.
function closeIndex(line, from, inline = true) {
  if (!inline) return line.indexOf('-->', from); // an HTML block ends on any line containing `-->`, `--->` included
  for (let end = line.indexOf('-->', from); end !== -1; end = line.indexOf('-->', end + 1)) {
    if (end !== 0 && line[end - 1] === '-') continue;
    if (line.slice(from, end).includes('--')) return -1; // `--` inside the text: no valid close on this line
    return end;
  }
  return -1;
}
// Lines that end a paragraph in CommonMark, so an inline comment cannot continue past them.
const INTERRUPTS = [
  /^[ \t]*$/, // blank
  /^ {0,3}#{1,6}([ \t]|$)/, // ATX heading
  /^ {0,3}(`{3,}|~{3,})/, // fence
  /^ {0,3}>/, // block quote
  /^ {0,3}([-+*]|\d{1,9}[.)])([ \t]|$)/, // list item
  /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/, // thematic break
  /^ {0,3}(=+|-+)[ \t]*$/, // setext heading underline (turns the paragraph into a heading)
  /^ {0,3}<[!?/A-Za-z]/, // HTML block start of any kind (comment, declaration, tag); conservative for type 7, which does not interrupt
];
const interruptsParagraph = (line) => INTERRUPTS.some((re) => re.test(line));

function nextEscape(line, from) {
  for (let k = line.indexOf('\\', from); k !== -1; k = line.indexOf('\\', k + 1)) {
    if (k + 1 < line.length && ESCAPABLE.test(line[k + 1])) return k;
  }
  return -1;
}

// Returns the prose text of one line, the complete comments met outside code,
// and the index of a comment opener that did not close on this line (-1 if
// none). `state.comment` carries an open comment across lines: 'inline' (opened
// mid-line; prose resumes after its close) or 'block' (opened at the start of a
// line: an HTML block that runs to the line containing its close; text after the
// close on that line is emitted raw, so it is visible and scanned). `literalOpeners`
// lists opener indexes the caller has
// decided are literal text — an inline opener with no valid close before its
// paragraph ends (see INTERRUPTS), which CommonMark renders as visible text.
function stripInline(line, state, literalOpeners = []) {
  let out = '';
  const comments = [];
  let i = 0;
  if (state.comment) {
    const end = closeIndex(line, 0, state.comment === 'inline');
    if (end === -1) return { text: '', comments, openedAt: -1 };
    state.comment = null; // text after the close is visible for both kinds: an HTML block emits its closing line raw
    i = end + 3;
  }
  while (i < line.length) {
    const bt = line.indexOf('`', i);
    const cm = line.indexOf('<!--', i);
    const es = nextEscape(line, i);
    const candidates = [bt, cm, es].filter((x) => x !== -1);
    if (candidates.length === 0) { out += line.slice(i); break; }
    const at = Math.min(...candidates);
    if (at === es) {
      out += line.slice(i, es) + (line[es + 1] === '_' ? '_' : '\uE000');
      i = es + 2;
      continue;
    }
    if (at === bt) {
      let j = bt;
      while (j < line.length && line[j] === '`') j += 1;
      const n = j - bt;
      let k = j;
      let closed = -1;
      while (k < line.length) { // the next run of EXACTLY n backticks closes the span; backslashes inside are literal
        const c = line.indexOf('`', k);
        if (c === -1) break;
        let m = c;
        while (m < line.length && line[m] === '`') m += 1;
        if (m - c === n) { closed = m; break; }
        k = m;
      }
      if (closed === -1) { out += line.slice(i, j); i = j; continue; } // literal backticks, keep scanning
      out += line.slice(i, bt);
      i = closed;
      continue;
    }
    if (literalOpeners.includes(cm)) { out += line.slice(i, cm) + '\uE000'; i = cm + 1; continue; } // a literal '<'; the rest is prose
    out += line.slice(i, cm);
    const empty = /^<!---?>/.exec(line.slice(cm)); // `<!-->` and `<!--->` are the empty comments CommonMark names
    const blockLevel = /^ {0,3}$/.test(line.slice(0, cm)); // a line-start opener is an HTML block: the `--` rule is inline-only
    const end = empty ? cm + empty[0].length - 3 : closeIndex(line, cm + 4, !blockLevel);
    if (end === -1) return { text: out, comments, openedAt: cm };
    comments.push(line.slice(cm, end + 3));
    i = end + 3;
  }
  return { text: out, comments, openedAt: -1 };
}

function normalise(text) {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/[*_]/g, '');
}

function scan(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const hits = [];
  let fence = null; // { ch, len } while inside a fenced block
  const state = { comment: null };
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  lines.forEach((line, idx) => {
    const excerpt = line.trim().slice(0, 100);
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      return;
    }
    if (!state.comment) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line); // spaces only: a tab-indented line is an indented code block, scanned as prose
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = { ch: open[1][0], len: open[1].length }; return; }
    }
    const literal = [];
    let res;
    for (;;) {
      res = stripInline(line, state, literal);
      if (res.openedAt === -1) break;
      if (/^ {0,3}$/.test(line.slice(0, res.openedAt))) { state.comment = 'block'; break; } // HTML block: to the line containing -->, blank lines included
      let closes = false;
      if (!line.slice(res.openedAt + 4).includes('--')) { // `--` in the opener line's text: no valid inline comment at all
        for (let j = idx + 1; j < lines.length; j += 1) { // an inline comment may continue only within its paragraph
          if (interruptsParagraph(lines[j])) break;
          if (closeIndex(lines[j], 0) !== -1) { closes = true; break; }
          if (lines[j].includes('--')) break; // `--` on a continuation line without a valid close: invalid
        }
      }
      if (closes) { state.comment = 'inline'; break; }
      literal.push(res.openedAt); // never closes: the renderer shows it as text, so scan it as prose
    }
    const { text, comments } = res;
    if (comments.some((c) => ALLOW_WITH_REASON.test(c))) return;
    if (comments.some((c) => ALLOW_ANY.test(c))) {
      hits.push(`${rel}:${idx + 1}: allow marker without a reason: ${excerpt}`);
      return;
    }
    const prose = normalise(text);
    for (const { re, label } of PHRASES) {
      if (re.test(prose)) hits.push(`${rel}:${idx + 1}: ${label}: ${excerpt}`);
    }
  });
  return hits;
}

const files = inScope();
if (list) {
  for (const f of files) console.log(path.relative(ROOT, f).split(path.sep).join('/'));
  process.exit(0);
}
const hits = files.flatMap(scan);
if (hits.length > 0) {
  console.error(`[terminology] FAIL (${hits.length}):`);
  for (const h of hits) console.error(`  - ${h}`);
  console.error('[terminology] fenced code, inline code and HTML comments are ignored; exempt a line only with `<!-- terminology-allow: <reason> -->` on that line');
  process.exit(1);
}
console.log(`[terminology] OK (${files.length} files in scope)`);
