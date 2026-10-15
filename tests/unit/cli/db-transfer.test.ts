import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runCli(args: readonly string[], overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  return spawnSync(npmCommand, ['run', 'db-transfer', '--', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

describe('db-transfer CLI boundary', () => {
  it('documents that target actions need separate approval', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/separately approved target actions/i);
  });

  it('fails closed when the bundle key is missing or malformed', () => {
    const missing = { ...process.env };
    delete missing.MIGRATION_BUNDLE_KEY;
    const missingResult = runCli(['export', '--sqlite', 'missing.sqlite', '--bundle', 'capture.bundle'], missing);
    expect(missingResult.status).not.toBe(0);
    expect(`${missingResult.stdout}\n${missingResult.stderr}`).not.toMatch(/DATABASE_URL|password|secret/i);

    const malformedResult = runCli(
      ['export', '--sqlite', 'missing.sqlite', '--bundle', 'capture.bundle'],
      { MIGRATION_BUNDLE_KEY: 'not-a-valid-key' },
    );
    expect(malformedResult.status).not.toBe(0);
  });

  it('rejects unknown options and non-PostgreSQL target identity requests', () => {
    const unknown = runCli(['not-a-command']);
    expect(unknown.status).not.toBe(0);

    const target = runCli(['target-id'], { DB_TYPE: 'sqlite', DATABASE_URL: 'sqlite://local' });
    expect(target.status).not.toBe(0);
  });
});
