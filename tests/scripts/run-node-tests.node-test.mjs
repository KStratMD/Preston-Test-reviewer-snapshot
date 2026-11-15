import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../../scripts/run-node-tests.mjs', import.meta.url));

// Drop NODE_TEST_CONTEXT so the nested node --test behaves as a top-level run.
const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
const run = (args, cwd) => spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: 'utf8' });

const withFixture = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-node-tests-'));
  const marker = join(dir, 'ran.marker');
  writeFileSync(
    join(dir, 'present.node-test.mjs'),
    `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('present', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });\n`,
  );
  try {
    fn({ dir, marker });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('exits 0 and runs a present test file', () => {
  withFixture(({ dir, marker }) => {
    const result = run(['present.node-test.mjs'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(marker), 'present test ran');
  });
});

test('exits 1 naming the missing path and runs nothing when any file is missing', () => {
  withFixture(({ dir, marker }) => {
    const result = run(['present.node-test.mjs', 'gone.node-test.mjs'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gone\.node-test\.mjs/);
    assert.ok(!existsSync(marker), 'present test must not run when a sibling is missing');
  });
});

test('exits 1 when given no files', () => {
  withFixture(({ dir }) => {
    const result = run([], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no test files/);
  });
});
