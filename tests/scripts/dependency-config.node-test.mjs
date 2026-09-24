import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const configPath = new URL('../../.github/dependabot.yml', import.meta.url);
const routineUpdates = ['minor', 'patch'];

const loadConfig = async () => yaml.load(await readFile(configPath, 'utf8'));
const updateByEcosystem = (config, ecosystem) => config.updates.find((update) => update['package-ecosystem'] === ecosystem);
const group = (update, name) => update.groups[name];

test('Dependabot targets all configured ecosystems at Working-Branch without changing schedules or ignores', async () => {
  const config = await loadConfig();
  const expectedSchedules = {
    npm: { interval: 'weekly', day: 'monday', time: '06:00' },
    docker: { interval: 'weekly', day: 'tuesday', time: '06:00' },
    'github-actions': { interval: 'weekly', day: 'wednesday', time: '06:00' },
  };

  for (const [ecosystem, schedule] of Object.entries(expectedSchedules)) {
    const update = updateByEcosystem(config, ecosystem);
    assert.equal(update['target-branch'], 'Working-Branch', `${ecosystem} target branch`);
    assert.deepEqual(update.schedule, schedule, `${ecosystem} schedule`);
  }
  assert.deepEqual(updateByEcosystem(config, 'npm').ignore.map((entry) => entry['dependency-name']), ['typescript', 'node', '@types/node', 'p-limit']);
});

test('routine dependency groups coordinate Jest and OTel minor or patch updates without grouping majors', async () => {
  const config = await loadConfig();
  const npm = updateByEcosystem(config, 'npm');
  const jest = group(npm, 'jest');
  const otel = group(npm, 'otel-coordinated');

  assert.ok(jest.patterns.includes('@jest/*'));
  assert.deepEqual(jest['update-types'], routineUpdates);
  assert.deepEqual(otel.patterns, ['@opentelemetry/*']);
  assert.deepEqual(otel['update-types'], routineUpdates);
  for (const value of Object.values(npm.groups)) {
    assert.ok(!value['update-types'] || !value['update-types'].some((type) => type === 'major' || type === 'version-update:semver-major'));
  }
});

test('Playwright runner packages update together so they stay on the e2e image version', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  const playwright = group(npm, 'playwright');

  // #1325 bumped bare `playwright` alone; both packages must share one group.
  assert.ok(playwright, 'playwright group exists');
  assert.ok(playwright.patterns.includes('playwright'));
  assert.ok(playwright.patterns.includes('@playwright/*'));
  assert.deepEqual(playwright['update-types'], routineUpdates);
});

test('the runbook keeps grouped OTel changes subject to separate 0.x risk assessment', async () => {
  const runbook = await readFile(new URL('../../docs/operations/DEPENDENCY-MAINTENANCE.md', import.meta.url), 'utf8');
  assert.match(runbook, /0\.x minor/i);
  assert.match(runbook, /grouping.*not.*risk classification/i);
  assert.match(runbook, /automatic approval/i);
});
