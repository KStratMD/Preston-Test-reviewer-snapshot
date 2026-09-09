#!/usr/bin/env bash
set -euo pipefail

# Contract: the E2E Smoke job runs in the pinned prebuilt Playwright image and
# never regresses to downloading browsers/OS deps at runtime. Three identical
# CI failures (2026-08-19, runs 32270298316 x2 and 32273718287) burned the
# whole 15-minute job budget inside `npx playwright install --with-deps
# chromium` when azure.archive.ubuntu.com stalled, so the tests never ran.
#
# The workflow is parsed as YAML rather than grepped. An earlier grep-based
# version of this file was reviewed and rejected: unanchored substring matches
# over the raw job text could be satisfied by a YAML *comment* mentioning the
# expected line, so an explanatory comment could have silently propped up a
# check after the executable line it guards was removed. Parsing discards
# comments outright, which retires that entire class of false pass.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

node - <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');

const CI_FILE = '.github/workflows/ci-minimal.yml';
const LOCK_FILE = 'package-lock.json';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(CI_FILE)) fail(`missing CI workflow: ${CI_FILE}`);

let doc;
try {
  doc = yaml.load(fs.readFileSync(CI_FILE, 'utf8'));
} catch (e) {
  fail(`${CI_FILE} is not parseable YAML: ${e.message}`);
}

const job = doc && doc.jobs && doc.jobs['e2e-smoke'];
if (!job) fail(`e2e-smoke job not found in ${CI_FILE}`);

// 1. Pinned prebuilt Playwright container: version tag AND sha256 digest.
//    `container:` accepts either a bare image string or a mapping.
const image = typeof job.container === 'string' ? job.container : job.container && job.container.image;
if (!image) fail('e2e-smoke must declare a container image; browsers must not be installed at runtime');

const PIN = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/;
const pinned = PIN.exec(String(image));
if (!pinned) {
  fail(`e2e-smoke container.image must be a digest-pinned mcr.microsoft.com/playwright:<version>-noble image, got: ${image}`);
}

// 2. The image version must match the installed @playwright/test version, so
//    the browser build cannot silently drift from the test runner.
const imageVersion = pinned[1];
if (!fs.existsSync(LOCK_FILE)) fail(`missing lockfile: ${LOCK_FILE}`);
let lock;
try {
  lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
} catch (e) {
  fail(`${LOCK_FILE} is not parseable JSON: ${e.message}`);
}
const lockEntry = lock.packages && lock.packages['node_modules/@playwright/test'];
if (!lockEntry || !lockEntry.version) fail(`could not read @playwright/test version from ${LOCK_FILE}`);
if (imageVersion !== lockEntry.version) {
  fail(`container image playwright v${imageVersion} does not match @playwright/test ${lockEntry.version} in ${LOCK_FILE}`);
}

// 3. Realistic job budget now that setup is image-based.
if (job['timeout-minutes'] !== 30) {
  fail(`e2e-smoke must have timeout-minutes: 30, got: ${job['timeout-minutes']}`);
}

// 4. The job must point Playwright at the image's preinstalled browser tree.
//    The image sets PLAYWRIGHT_BROWSERS_PATH itself, so this is belt-and-braces
//    rather than the only thing standing between us and a download: with it
//    unset Playwright looks in ~/.cache/ms-playwright and fails "browser not
//    found" rather than silently fetching. Asserted anyway so the contract does
//    not depend on an upstream image ENV this repo does not control.
if (!job.env || job.env.PLAYWRIGHT_BROWSERS_PATH !== '/ms-playwright') {
  fail('e2e-smoke must set PLAYWRIGHT_BROWSERS_PATH: /ms-playwright so the preinstalled browsers are used');
}

const steps = Array.isArray(job.steps) ? job.steps : [];
if (!steps.length) fail('e2e-smoke declares no steps');

// Shell comments inside a `run:` block are still text after YAML parsing, so
// strip them before reasoning about what a step actually executes.
const executable = (run) =>
  String(run || '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

// 5. No runtime browser/OS-dependency download may return to this job.
const installer = steps.find((s) => /playwright\s+install/.test(executable(s.run)));
if (installer) {
  fail(`e2e-smoke must not run 'playwright install' at runtime (step: ${installer.name || 'unnamed'}); browsers ship in the pinned image`);
}

// 6. Cleanup is idempotent: the demo server is stopped only when a PID file
//    was actually written, so a cancelled setup cannot add a second, misleading
//    failure. scripts/stop-demo-detached.js exits 1 when logs/ holds no *.pid.
//
//    This asserts the step's ENTIRE run block against one canonical shape
//    rather than reasoning about the shell inside it. Five review rounds of
//    line predicates were each defeated by a different shell construct: a
//    comment that is not executable, an executable line not governed by the
//    guard, a no-op prefix that turns a command into a mention, a missing token
//    boundary, a boolean that neutralises the condition, and finally a heredoc
//    whose body is data rather than code. Every one of those was a false PASS.
//    A five-line fixed block does not need a shell parser; it needs to be
//    exactly itself. Anything else -- including a benign reformat -- fails, and
//    a deliberate change to this block must update the contract alongside it.
const STOP_STEP_NAME = 'Stop demo server';
const CANONICAL_CLEANUP = [
  'if ls logs/*.pid >/dev/null 2>&1; then',
  '  npm run demo:stop-detached',
  'else',
  '  echo "No demo server PID recorded; nothing to stop."',
  'fi',
];

const stopSteps = steps.filter((s) => s.name === STOP_STEP_NAME);
if (stopSteps.length !== 1) {
  fail(`e2e-smoke must declare exactly one '${STOP_STEP_NAME}' step, found ${stopSteps.length}`);
}
const stopStep = stopSteps[0];
if (stopStep.if !== 'always()') {
  fail(`e2e-smoke '${STOP_STEP_NAME}' must run with if: always()`);
}

const cleanupLines = String(stopStep.run || '').replace(/\n+$/, '').split('\n');
const mismatch = cleanupLines.length !== CANONICAL_CLEANUP.length
  ? cleanupLines.length
  : CANONICAL_CLEANUP.findIndex((line, i) => cleanupLines[i] !== line);
if (mismatch !== -1) {
  fail(
    `e2e-smoke '${STOP_STEP_NAME}' run block must match the canonical guarded form exactly.\n` +
      `  expected:\n${CANONICAL_CLEANUP.map((l) => `    | ${l}`).join('\n')}\n` +
      `  actual:\n${cleanupLines.map((l) => `    | ${l}`).join('\n')}`,
  );
}

//    Shape alone is not enough: the canonical step can be left untouched while a
//    SECOND step stops the server unconditionally, which recreates the very
//    failure the guard exists to prevent. No other step in this job may mention
//    the stop script at all. This one stays a conservative substring check over
//    the whole serialised step: here a mere mention producing a failure is a
//    false FAIL, which is safe, whereas a second real invocation slipping
//    through would be a false PASS, which is not.
const strays = steps
  .filter((s) => s !== stopStep && JSON.stringify(s).includes('demo:stop-detached'))
  .map((s) => s.name || s.uses || '(unnamed step)');
if (strays.length) {
  fail(
    `only the '${STOP_STEP_NAME}' step may reference demo:stop-detached; also found in: ${strays.join(', ')}`,
  );
}

console.log('PASS: e2e-smoke runs in the pinned prebuilt Playwright environment with a 30-minute budget and guarded cleanup');
NODE
