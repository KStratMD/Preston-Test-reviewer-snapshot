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

test('Dependabot targets all configured ecosystems at Working-Branch on low-frequency schedules', async () => {
  const config = await loadConfig();
  const expectedSchedules = {
    npm: { interval: 'monthly', time: '06:00' },
    docker: { interval: 'quarterly', time: '06:00' },
    'github-actions': { interval: 'quarterly', time: '06:00' },
  };

  for (const [ecosystem, schedule] of Object.entries(expectedSchedules)) {
    const update = updateByEcosystem(config, ecosystem);
    assert.equal(update['target-branch'], 'Working-Branch', `${ecosystem} target branch`);
    assert.deepEqual(update.schedule, schedule, `${ecosystem} schedule`);
    // The limit is per ecosystem entry, not a repository-wide cap.
    assert.equal(update['open-pull-requests-limit'], 3, `${ecosystem} open PR limit`);
    assert.ok(!('assignees' in update), `${ecosystem} has no blanket assignee`);
  }
  assert.deepEqual(updateByEcosystem(config, 'npm').ignore.map((entry) => entry['dependency-name']), ['typescript', 'node', '@types/node', 'p-limit', '*']);
  assert.deepEqual(updateByEcosystem(config, 'npm').cooldown, { 'default-days': 7 });
  const wildcard = updateByEcosystem(config, 'npm').ignore.find((entry) => entry['dependency-name'] === '*');
  assert.deepEqual(wildcard['update-types'], ['version-update:semver-major'], 'wildcard ignore covers majors only');
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

test('lint packages update together, including the typescript-eslint wrapper and @eslint scope', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  const eslint = group(npm, 'eslint');

  // #1380 and #1388 bumped typescript-eslint alone, beside the eslint group PR #1385.
  assert.deepEqual(eslint.patterns, ['eslint*', '@eslint/*', '@typescript-eslint/*', 'typescript-eslint']);
  assert.deepEqual(eslint['update-types'], routineUpdates);
});

test('catch-all groups are patternless dependency-type scoped minor/patch groups', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');

  assert.ok(!group(npm, 'production-minor-patch').patterns, 'catch-all has no include patterns');
  assert.ok(!group(npm, 'development-minor-patch').patterns, 'catch-all has no include patterns');
  assert.equal(group(npm, 'production-minor-patch')['dependency-type'], 'production');
  assert.equal(group(npm, 'development-minor-patch')['dependency-type'], 'development');
  assert.deepEqual(group(npm, 'production-minor-patch')['update-types'], routineUpdates);
  assert.deepEqual(group(npm, 'development-minor-patch')['update-types'], routineUpdates);
});

// Risk-category packages (authentication, credentials and secrets, crypto, rate
// limiting, database, Redis, the HTTP security boundary, outbound authenticated
// clients, build/install hooks, browser-delivered vendored assets, runtime code
// declared as dev, 0.x outside a family) and their type packages must not be
// batched by any group; they still get individual routine PRs. These are the
// known names only: the guard cannot judge a new dependency.
const SENSITIVE = {
  production: [
    'jsonwebtoken', 'bcryptjs', 'express-rate-limit', 'ipaddr.js', 'better-sqlite3', 'pg', 'kysely',
    'ioredis', 'bullmq', 'express', 'helmet', 'cors', 'sanitize-html', 'multer', '@modelcontextprotocol/sdk',
    'axios', 'dotenv', 'cron', 'json-bigint', 'xml2js', 'reflect-metadata', 'swagger-ui-express',
  ],
  // Optional cloud secret SDKs (services/SecretManager.ts). Their Dependabot
  // dependency-type is not documented, so they must stay individual under either.
  optional: ['@aws-sdk/client-secrets-manager', '@azure/identity', '@azure/keyvault-secrets'],
  development: [
    'typescript', 'ts-node', 'tailwindcss', 'ffmpeg-static',
    '@types/jsonwebtoken', '@types/bcryptjs', '@types/better-sqlite3', '@types/pg', '@types/express',
    '@types/cors', '@types/multer', '@types/sanitize-html',
    'chart.js', 'alpinejs', '@fortawesome/fontawesome-free', 'ajv', 'ajv-formats',
    'markdownlint', 'markdownlint-cli', '@types/xml2js', '@types/swagger-ui-express',
  ],
};

// Coordinated-family patterns. Each must be excluded from BOTH catch-alls so a
// family dependency is never captured by a catch-all: the config does not rely on
// how Dependabot ranks overlapping groups.
const FAMILY_PATTERNS = [
  'eslint*', '@eslint/*', '@typescript-eslint/*', 'typescript-eslint',
  'jest*', '@jest/*', '@types/jest', 'ts-jest',
  '*docker*', '@aws-sdk/*', '@azure/*',
  'playwright', '@playwright/*', '@opentelemetry/*',
];
const CATCH_ALLS = ['production-minor-patch', 'development-minor-patch'];

// Representative names per family pattern, including shapes package.json does not declare.
const FAMILY_EXEMPLARS = {
  'eslint*': ['eslint', 'eslint-plugin-security'],
  '@eslint/*': ['@eslint/js'],
  '@typescript-eslint/*': ['@typescript-eslint/parser'],
  'typescript-eslint': ['typescript-eslint'],
  'jest*': ['jest', 'jest-environment-jsdom'],
  '@jest/*': ['@jest/globals'],
  '@types/jest': ['@types/jest'],
  'ts-jest': ['ts-jest'],
  '*docker*': ['dockerode', '@scope/some-docker-client'],
  '@aws-sdk/*': ['@aws-sdk/client-s3'],
  '@azure/*': ['@azure/storage-blob'],
  playwright: ['playwright'],
  '@playwright/*': ['@playwright/test'],
  '@opentelemetry/*': ['@opentelemetry/api', '@opentelemetry/sdk-node'],
};

// Test-only model of Dependabot group ELIGIBILITY, not of its priority rules: `*` is
// the only wildcard and an exclude pattern removes a dependency from that group. The
// config is correct only if at most one group is ever eligible.
const globMatch = (pattern, name) =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name);
const eligibleGroups = (npm, name, dependencyType) =>
  Object.entries(npm.groups).filter(([, value]) =>
    (!value.patterns || value.patterns.some((pattern) => globMatch(pattern, name))) &&
    (!value['dependency-type'] || value['dependency-type'] === dependencyType) &&
    !(value['exclude-patterns'] || []).some((pattern) => globMatch(pattern, name)),
  ).map(([groupName]) => groupName);
const reverseGroups = (npm) => ({ ...npm, groups: Object.fromEntries(Object.entries(npm.groups).reverse()) });

const loadDeclared = async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  return {
    production: { ...manifest.dependencies, ...manifest.optionalDependencies },
    optional: manifest.optionalDependencies,
    development: manifest.devDependencies,
  };
};

// Not just the catch-alls: an earlier family group must not capture these either.
const assertSensitiveStayIndividual = (npm, declared) => {
  for (const [section, names] of Object.entries(SENSITIVE)) {
    for (const name of names) {
      assert.ok(name in declared[section], `${name} is a declared ${section} dependency`);
      // Optional packages are checked under both dependency types: a
      // classification-invariance check, not a claim that they are dev.
      const types = section === 'optional' ? ['production', 'development'] : [section];
      if (section === 'optional') assert.ok(name in declared.production, `${name} is in the production map`);
      for (const dependencyType of types) {
        const eligible = eligibleGroups(npm, name, dependencyType);
        assert.deepEqual(eligible, [], `${name} (${dependencyType}) must get an individual PR, but groups ${eligible} capture it`);
      }
    }
  }
};

test('FAMILY_PATTERNS equals the union of include patterns of all non-catch-all npm groups', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  const union = Object.entries(npm.groups)
    .filter(([name]) => !CATCH_ALLS.includes(name))
    .flatMap(([, value]) => value.patterns || []);
  assert.deepEqual([...new Set(union)].sort(), [...FAMILY_PATTERNS].sort());
});

test('every catch-all exclusion is a tested risk-category name or an intentional coordinated-family pattern', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  const risk = new Set(Object.values(SENSITIVE).flat());
  const families = new Set(FAMILY_PATTERNS);
  for (const name of CATCH_ALLS) {
    const excludes = group(npm, name)['exclude-patterns'] || [];
    for (const pattern of excludes) {
      assert.ok(risk.has(pattern) || families.has(pattern), `${name} excludes ${pattern}, which is neither a tested risk name nor a coordinated-family pattern`);
    }
    for (const pattern of FAMILY_PATTERNS) {
      assert.ok(excludes.includes(pattern), `${name} must exclude family pattern ${pattern}`);
    }
  }
  // The family groups only exclude tested risk names, never family patterns.
  for (const name of ['aws', 'azure']) {
    for (const pattern of group(npm, name)['exclude-patterns'] || []) {
      assert.ok(risk.has(pattern), `${name} excludes ${pattern}, which the sensitivity guard does not cover`);
    }
  }
});

const assertFamilyIsolation = (npm) => {
  for (const [pattern, names] of Object.entries(FAMILY_EXEMPLARS)) {
    for (const name of names) {
      assert.ok(globMatch(pattern, name), `${name} is an exemplar of ${pattern}`);
      for (const dependencyType of ['production', 'development']) {
        const eligible = eligibleGroups(npm, name, dependencyType);
        assert.equal(eligible.length, 1, `${name} (${dependencyType}) must be eligible for exactly one group, got ${eligible}`);
        assert.ok(!CATCH_ALLS.includes(eligible[0]), `${name} (${dependencyType}) must not land in a catch-all`);
      }
    }
  }
};

test('family exemplars are eligible for exactly one family group under both dependency types, in either group order', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  assertFamilyIsolation(npm);
  assertFamilyIsolation(reverseGroups(npm));
  // Family wildcards must not re-admit the optional secret SDKs.
  for (const name of ['@aws-sdk/client-secrets-manager', '@azure/identity', '@azure/keyvault-secrets']) {
    for (const dependencyType of ['production', 'development']) {
      assert.deepEqual(eligibleGroups(npm, name, dependencyType), [], `${name} (${dependencyType})`);
    }
  }
});

test('no declared dependency is eligible for more than one minor/patch group, in either group order', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  const declared = await loadDeclared();
  const sections = [['production', ['production']], ['optional', ['production', 'development']], ['development', ['development']]];
  for (const candidate of [npm, reverseGroups(npm)]) {
    for (const [section, types] of sections) {
      for (const name of Object.keys(declared[section])) {
        for (const dependencyType of types) {
          const eligible = eligibleGroups(candidate, name, dependencyType);
          assert.ok(eligible.length <= 1, `${name} (${dependencyType}) is eligible for ${eligible.length} groups: ${eligible}`);
        }
      }
    }
  }
});

test('removing any family exclusion from a catch-all is detected', async () => {
  const base = updateByEcosystem(await loadConfig(), 'npm');
  assertFamilyIsolation(base);
  for (const catchAll of CATCH_ALLS) {
    for (const pattern of FAMILY_PATTERNS) {
      const npm = structuredClone(base);
      group(npm, catchAll)['exclude-patterns'] = group(npm, catchAll)['exclude-patterns'].filter((entry) => entry !== pattern);
      assert.throws(() => assertFamilyIsolation(npm), /exactly one group|must not land/, `dropping ${pattern} from ${catchAll} must fail`);
    }
  }
});

test('the sensitivity guard rejects a risk-category package captured by an earlier family group', async () => {
  const npm = structuredClone(updateByEcosystem(await loadConfig(), 'npm'));
  // A future, broadened family pattern listed before the catch-alls.
  npm.groups = { 'token-family': { patterns: ['json*'], 'update-types': routineUpdates }, ...npm.groups };
  const declared = await loadDeclared();
  assert.throws(() => assertSensitiveStayIndividual(npm, declared), /jsonwebtoken/);
});

test('catch-all groups leave risk-category packages for individual PRs and still batch ordinary ones', async () => {
  const npm = updateByEcosystem(await loadConfig(), 'npm');
  assertSensitiveStayIndividual(npm, await loadDeclared());

  const expected = {
    lodash: ['production', 'production-minor-patch'],
    compression: ['production', 'production-minor-patch'],
    zod: ['production', 'production-minor-patch'],
    marked: ['production', 'production-minor-patch'],
    inversify: ['production', 'production-minor-patch'],
    prettier: ['development', 'development-minor-patch'],
    nodemon: ['development', 'development-minor-patch'],
    'cross-env': ['development', 'development-minor-patch'],
    supertest: ['development', 'development-minor-patch'],
    'ffprobe-static': ['development', 'development-minor-patch'],
    eslint: ['development', 'eslint'],
    'typescript-eslint': ['development', 'eslint'],
    'ts-jest': ['development', 'jest'],
    '@playwright/test': ['development', 'playwright'],
    '@opentelemetry/sdk-node': ['development', 'otel-coordinated'],
    '@opentelemetry/api': ['production', 'otel-coordinated'],
  };
  const declared = await loadDeclared();
  for (const [name, [dependencyType]] of Object.entries(expected)) {
    assert.ok(name in declared[dependencyType], `${name} is a declared ${dependencyType} dependency`);
  }
  for (const [name, [dependencyType, groupName]] of Object.entries(expected)) {
    assert.deepEqual(eligibleGroups(npm, name, dependencyType), [groupName], `${name} is eligible only for ${groupName}`);
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
