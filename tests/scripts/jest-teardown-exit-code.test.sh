#!/usr/bin/env bash
# Verify jest.teardown.js does NOT call process.exit (any code, any path).
#
# Background: PR #682 broke 6 unit suites; PRs #683-#711 all merged with
# CI silently passing because jest's failing exit code wasn't surfacing
# through the GitHub Actions step. Codex's initial diagnosis pointed at
# `jest.teardown.js`'s old `setTimeout(() => process.exit(0), 500)` as
# the masking culprit. Empirical investigation on PR #713 showed that
# block was actually harmless — `forceExit: true` in jest.base.config.cjs
# wins the race and exits with jest's correct code before the 500ms timer
# fires. The real CI silent-failure protection is the test-summary.json
# verification guard wired into ci-minimal.yml's "Run tests with coverage"
# step.
#
# This regression test still has value: any future teardown that DOES
# call `process.exit(<anything>)` would race `forceExit: true` and could
# reintroduce subtle exit-code masking under environment-specific timing.
# So we lock in the contract "globalTeardown does not call process.exit".
#
# Strategy: load jest.teardown.js, intercept process.exit, invoke
# teardown(), wait long enough for any setTimeout-based exit to fire
# (≥500ms). PASS if no process.exit call was captured.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/probe.cjs" <<EOF
// Mock process.exit BEFORE loading the teardown module so a future
// teardown that captures \\\`process.exit\\\` at module-load time
// (e.g. \\\`const exit = process.exit;\\\` then \\\`exit(0)\\\` later)
// still gets the intercepted version. Restore the original if require
// throws so we don't strand process.exit pointing at a closure over
// a torn-down container. (Copilot review on PR #713.)
const exitCalls = [];
const origExit = process.exit;
process.exit = (code) => { exitCalls.push(code); };

let teardown;
try {
  teardown = require('$ROOT_DIR/jest.teardown.js');
} catch (err) {
  process.exit = origExit;
  throw err;
}

// Wrap in Promise.resolve so this also works if a future teardown
// returns synchronously (Jest globalTeardown is allowed to be sync).
// Without the wrap, teardown().then(...) would crash with
// "TypeError: teardown(...).then is not a function" before we ever
// got to inspect process.exit. (Copilot review on PR #713.)
Promise.resolve().then(() => teardown()).then(() => {
  // Wait > 500ms (the historical setTimeout duration) so any deferred
  // process.exit call has time to fire before we check.
  setTimeout(() => {
    process.exit = origExit;
    if (exitCalls.length > 0) {
      console.error(\`FAIL: teardown called process.exit(\${exitCalls[0]}) — globalTeardown must not exit; let \\\`forceExit: true\\\` + jest's natural exit run.\`);
      process.exit(2);
    }
    console.log('PASS: teardown did not call process.exit (jest controls exit code).');
    process.exit(0);
  }, 1000);
}).catch((err) => {
  process.exit = origExit;
  console.error('FAIL: teardown rejected:', err);
  process.exit(2);
});
EOF

# Let `set -e` propagate the probe's actual exit code (1 = node crash,
# 2 = teardown called process.exit, 0 = pass). Wrapping with
# `if ! node ...; then exit 1; fi` would flatten 2 → 1, hiding the
# distinction. (Copilot review on PR #713.)
node "$TMPDIR/probe.cjs"
