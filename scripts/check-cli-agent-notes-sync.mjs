#!/usr/bin/env node
// Verifies AGENTS.md Part 1 stays in sync with docs/CODEX-WORKING-NOTES.md.
// docs/CODEX-WORKING-NOTES.md is canonical (per AGENTS.md legend).
// Exits 1 with a unified diff if the two bodies diverge.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(repoRoot, 'docs/CODEX-WORKING-NOTES.md');
const agentsPath = resolve(repoRoot, 'AGENTS.md');

const PART1_HEADER = '# Part 1 — CLI Agent Working Notes';
const PART2_HEADER = '# Part 2 — AI Agents System Documentation';

const norm = (s) => s.replace(/\r\n/g, '\n');

function bodyAfterFirstH1(text) {
  const lines = text.split('\n');
  if (!lines[0]?.startsWith('# ')) {
    throw new Error('Expected text to start with an H1 line, got: ' + JSON.stringify(lines[0]));
  }
  let i = 1;
  while (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n').replace(/\s+$/, '');
}

const doc = norm(readFileSync(docPath, 'utf8'));
const agents = norm(readFileSync(agentsPath, 'utf8'));

const docBody = bodyAfterFirstH1(doc);

const part1Start = agents.indexOf(PART1_HEADER);
if (part1Start === -1) {
  console.error(`AGENTS.md is missing "${PART1_HEADER}" header`);
  process.exit(1);
}
const part2Start = agents.indexOf(PART2_HEADER, part1Start);
if (part2Start === -1) {
  console.error(`AGENTS.md is missing "${PART2_HEADER}" header after Part 1`);
  process.exit(1);
}

const part1End = agents.lastIndexOf('\n---\n', part2Start);
if (part1End === -1 || part1End < part1Start) {
  console.error(`AGENTS.md is missing "---" separator before "${PART2_HEADER}"`);
  process.exit(1);
}
const agentsBody = bodyAfterFirstH1(agents.slice(part1Start, part1End));

if (docBody === agentsBody) {
  console.log('OK: AGENTS.md Part 1 matches docs/CODEX-WORKING-NOTES.md');
  process.exit(0);
}

const diffDir = mkdtempSync(join(tmpdir(), 'codex-notes-sync-'));
const tmp1 = join(diffDir, 'canonical.txt');
const tmp2 = join(diffDir, 'agents.txt');
writeFileSync(tmp1, docBody);
writeFileSync(tmp2, agentsBody);

console.error('FAIL: AGENTS.md Part 1 has drifted from docs/CODEX-WORKING-NOTES.md (canonical).');
console.error('');
try {
  const diff = spawnSync('git', ['diff', '--no-index', '--', tmp1, tmp2], {
    encoding: 'utf8',
  });
  process.stderr.write(diff.stdout);
  process.stderr.write(diff.stderr);
  if (!diff.stdout && !diff.stderr) {
    console.error(`No diff output produced. Compare ${tmp1} and ${tmp2} manually.`);
  }
} catch (error) {
  console.error(`Unable to produce diff output: ${error instanceof Error ? error.message : String(error)}`);
}
console.error('');
console.error('To fix: replace AGENTS.md Part 1 body with docs/CODEX-WORKING-NOTES.md body (skip the H1).');
process.exit(1);
