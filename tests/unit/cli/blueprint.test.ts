import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fixture = path.join(root, 'tests/fixtures/blueprints/shopify-netsuite-order-to-cash.v1.json');
const run = (...args: string[]) => spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', '--project', path.join(root, 'tsconfig.dev.json'), path.join(root, 'src/cli/blueprint.ts'), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', GITHUB_TOKEN: '' }, timeout: 30_000,
});
it('validates a local fixture as non-executable JSON', () => {
  const result = run('validate', fixture); expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout); expect(parsed.ok).toBe(true); expect(parsed.executable).toBe(false);
  expect(parsed.reasons).toContain('attestations not verified against GitHub');
});
it('exports exactly five artifacts locally without attestations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-cli-'));
  try {
    expect(run('export', fixture, '--out', dir).status).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(5);
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'blueprint.export.json'), 'utf8'));
    expect(envelope.validation.executable).toBe(false); expect(envelope.attestations).toEqual([]); expect(envelope.source).toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it.each([['validate', 'missing.json'], ['verify-and-validate', '--pull', '1', '--head', 'abc'], ['approve'], ['validate', fixture, '--allow-stale']])('rejects usage %j', (...args) => {
  expect(run(...args).status).toBe(2);
});
it('renders the questionnaire to stdout', () => { const result = run('questionnaire'); expect(result.status).toBe(0); expect(result.stdout).toContain('# Blueprint discovery questionnaire'); });
