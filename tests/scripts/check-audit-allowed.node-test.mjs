// Runs scripts/check-audit-allowed.mjs against canned `npm audit --json`
// output by putting a fake `npm` first on PATH, so the gate's real code path
// (spawn, parse, classify, exit code) is exercised without a registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gate = path.join(repoRoot, 'scripts', 'check-audit-allowed.mjs');
const ALLOWED = 'GHSA-xcx6-jx8p-x3h5';
const OTHER = 'GHSA-aaaa-bbbb-cccc';
const advisory = (id) => ({ source: 1, name: 'x', url: `https://github.com/advisories/${id}` });
const allowedLeaf = { '@azure/msal-node': { severity: 'high', via: [advisory(ALLOWED)] } };

function runGate(vulnerabilities) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
  try {
    const json = path.join(dir, 'audit.json');
    fs.writeFileSync(json, typeof vulnerabilities === 'string'
      ? `{"auditReportVersion":2,"vulnerabilities":${vulnerabilities}}`
      : JSON.stringify({ auditReportVersion: 2, vulnerabilities }));
    fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\ncat "${json}"\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'npm.cmd'), `@type "${json}"\r\n@exit /b 1\r\n`);
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    const r = spawnSync(process.execPath, [gate], { cwd: repoRoot, env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const passes = (r) => assert.equal(r.status, 0, r.out);
const fails = (r) => assert.equal(r.status, 1, r.out);

test('passes when the only advisory is allowlisted and a dependent points at it by name', () => {
  const r = runGate({ ...allowedLeaf, '@azure/identity': { severity: 'high', via: ['@azure/msal-node'] } });
  passes(r);
  assert.match(r.out, /OK: 2 vulnerability entries, all allowlisted/);
});

test('passes for a diamond: two dependents sharing one allowlisted leaf', () => {
  passes(runGate({
    ...allowedLeaf,
    mid1: { severity: 'high', via: ['@azure/msal-node'] },
    mid2: { severity: 'high', via: ['@azure/msal-node'] },
    top: { severity: 'high', via: ['mid1', 'mid2'] },
  }));
});

test('fails when a name pointer leads to an advisory that is not allowlisted', () => {
  const r = runGate({ leaf: { severity: 'high', via: [advisory(OTHER)] }, parent: { severity: 'high', via: ['leaf'] } });
  fails(r);
  assert.match(r.out, new RegExp(`parent\\s+${OTHER}`));
});

test('fails closed when a name pointer leads to a missing entry', () => {
  const r = runGate({ parent: { severity: 'high', via: ['not-in-report'] } });
  fails(r);
  assert.match(r.out, /parent\s+\(missing-ghsa-id\)/);
});

test('fails closed on a pointer cycle with no advisory', () => {
  fails(runGate({ a: { severity: 'high', via: ['b'] }, b: { severity: 'high', via: ['a'] } }));
});

test('fails when an entry mixes an allowlisted pointer with its own unlisted advisory', () => {
  const r = runGate({ ...allowedLeaf, mixed: { severity: 'high', via: ['@azure/msal-node', advisory(OTHER)] } });
  fails(r);
  assert.match(r.out, new RegExp(`mixed\\s+${OTHER}`));
});

// An allowlisted sibling must never mask a branch the gate cannot resolve.
for (const [label, branch] of [
  ['a missing package name', 'not-in-report'],
  ['a null advisory', null],
  ['an advisory with no URL', { source: 2, name: 'y' }],
  ['an advisory URL that is not an exact GitHub advisory URL', { source: 3, url: `https://example.com/advisories/${ALLOWED}` }],
  ['an inherited prototype name', '__proto__'],
  ['an inherited prototype name (constructor)', 'constructor'],
]) {
  test(`fails closed for an allowlisted advisory alongside ${label}`, () => {
    const r = runGate({ pkg: { severity: 'high', via: [advisory(ALLOWED), branch] } });
    fails(r);
    assert.match(r.out, /pkg\s+\(missing-ghsa-id\)/);
  });
}

test('fails closed on a self-reference alongside an allowlisted advisory', () => {
  fails(runGate({ pkg: { severity: 'high', via: [advisory(ALLOWED), 'pkg'] } }));
});

test('fails closed on a cycle that contains an allowlisted advisory', () => {
  fails(runGate({
    a: { severity: 'high', via: [advisory(ALLOWED), 'b'] },
    b: { severity: 'high', via: ['a'] },
  }));
});

test('fails closed on a pointer to an entry with an empty via', () => {
  const r = runGate({
    ...allowedLeaf,
    empty: { severity: 'high', via: [] },
    parent: { severity: 'high', via: ['@azure/msal-node', 'empty'] },
  });
  fails(r);
  assert.match(r.out, /parent\s+\(missing-ghsa-id\)/);
});

test('treats a JSON-parsed own "__proto__" key as data, not as a pass', () => {
  const r = runGate(`{"__proto__":{"severity":"high","via":[{"url":"https://github.com/advisories/${OTHER}"}]},"pkg":{"severity":"high","via":["__proto__"]}}`);
  fails(r);
  assert.match(r.out, new RegExp(`pkg\\s+${OTHER}`));
});

test('still fails on a direct advisory outside the allowlist', () => {
  fails(runGate({ pkg: { severity: 'high', via: [advisory(OTHER)] } }));
});

test('passes with no vulnerabilities', () => {
  const r = runGate({});
  passes(r);
  assert.match(r.out, /OK: 0 vulnerability entries/);
});
