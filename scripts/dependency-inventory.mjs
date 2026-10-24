#!/usr/bin/env node
/**
 * Read-only evidence collector for recurring dependency maintenance.
 * It never installs packages, mutates GitHub, closes PRs, or evaluates mergeability.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_LIMIT = 25 * 1024 * 1024;
const NPM_PATHS = ['package.json', 'package-lock.json'];
const SAFE_SHA = /^[0-9a-f]{7,64}$/i;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseArgs(argv) {
  const options = { format: 'json', prs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--format') {
      const format = argv[++index];
      if (format !== 'json' && format !== 'markdown') throw new Error('--format must be json or markdown');
      options.format = format;
    } else if (argument === '--pr') {
      const number = Number(argv[++index]);
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error('--pr must be a positive integer');
      options.prs.push(number);
    } else {
      throw new Error(`unknown argument '${argument}'`);
    }
  }
  return options;
}

function redactResolvedUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, '//').replace(/[?#].*$/, '');
  }
}

function packageValue(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return JSON.parse(JSON.stringify(entry, (key, value) => key === 'resolved' ? redactResolvedUrl(value) : value));
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];

function directDependencies(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
  const entries = {};
  for (const section of DEPENDENCY_SECTIONS) {
    const values = manifest[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [name, value] of Object.entries(values)) entries[`${section}:${name}`] = value;
  }
  return entries;
}

function lifecycleScripts(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object');
  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  return Object.fromEntries(Object.entries(scripts).filter(([name, value]) => /^(?:preinstall|install|postinstall|preprepare|prepare|postprepare|prepublish|prepublishOnly|prepack|postpack|preversion|version|postversion)$/.test(name) && typeof value === 'string'));
}

function lockPackages(lockfile) {
  if (!lockfile || typeof lockfile !== 'object' || Array.isArray(lockfile) || !lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
    throw new Error('unsupported lockfile: expected npm lockfile packages object');
  }
  return lockfile.packages;
}

export function compareNpm(mergeBase, proposed, authority) {
  const baseDirect = directDependencies(mergeBase.manifest);
  const proposedDirect = directDependencies(proposed.manifest);
  const authorityDirect = directDependencies(authority.manifest);
  const baseLock = lockPackages(mergeBase.lock);
  const proposedLock = lockPackages(proposed.lock);
  const authorityLock = lockPackages(authority.lock);
  const baseScripts = lifecycleScripts(mergeBase.manifest);
  const proposedScripts = lifecycleScripts(proposed.manifest);
  const authorityScripts = lifecycleScripts(authority.manifest);
  const names = new Set([...Object.keys(baseDirect), ...Object.keys(proposedDirect), ...Object.keys(authorityDirect)]);
  const paths = new Set([...Object.keys(baseLock), ...Object.keys(proposedLock), ...Object.keys(authorityLock)]);
  const changedPaths = [...paths].filter((path) => !equalValue(packageValue(baseLock[path]), packageValue(proposedLock[path]))).map((path) => path || 'package-lock.json#root');
  const directChanged = [...names].filter((name) => !equalValue(baseDirect[name], proposedDirect[name]));
  const pathsForDirect = directChanged.map((name) => `package.json#${name}`);
  const lifecycleScriptsChanged = !equalValue(baseScripts, proposedScripts);
  const allPaths = [...new Set([...changedPaths, ...pathsForDirect, ...(lifecycleScriptsChanged ? ['package.json#lifecycle-scripts'] : [])])].sort();
  const packages = allPaths.map((path) => {
    if (path === 'package.json#lifecycle-scripts') {
      return {
        path,
        kind: 'manifest',
        mergeBase: baseScripts,
        proposed: proposedScripts,
        authority: authorityScripts,
        authorityMatchesProposed: equalValue(proposedScripts, authorityScripts),
      };
    }
    if (path.startsWith('package.json#')) {
      const directKey = path.slice('package.json#'.length);
      return {
        path,
        kind: 'direct',
        mergeBase: baseDirect[directKey] ?? null,
        proposed: proposedDirect[directKey] ?? null,
        authority: authorityDirect[directKey] ?? null,
        authorityMatchesProposed: equalValue(proposedDirect[directKey], authorityDirect[directKey]),
      };
    }
    const lockPath = path === 'package-lock.json#root' ? '' : path;
    const kind = 'transitive';
    const entry = {
      path,
      kind,
      mergeBase: packageValue(baseLock[lockPath]),
      proposed: packageValue(proposedLock[lockPath]),
      authority: packageValue(authorityLock[lockPath]),
      authorityMatchesProposed: equalValue(packageValue(proposedLock[lockPath]), packageValue(authorityLock[lockPath])),
    };
    return entry;
  });
  const status = packages.length === 0 ? 'no_npm_changes' : packages.every((entry) => entry.authorityMatchesProposed) ? 'already_represented' : 'different';
  return { status, approved: false, packages };
}

function resultError(label) {
  return { source: label, message: `${label} was unavailable or returned invalid data` };
}

function inventoryError(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'origin repository differs from GitHub CLI repository') {
    return { source: 'repository', code: 'repository_identity_mismatch', message };
  }
  return resultError('inventory source');
}

function asArray(value) {
  if (Array.isArray(value)) return value.flat();
  return [];
}

function safeSha(value) {
  if (typeof value !== 'string' || !SAFE_SHA.test(value)) throw new Error('invalid immutable SHA from source');
  return value;
}

function safeRepository(value) {
  if (typeof value !== 'string' || !SAFE_REPOSITORY.test(value)) throw new Error('invalid repository identity from source');
  return value;
}

function authoritySummary(authority) {
  if (!authority || typeof authority !== 'object') return authority ?? null;
  return {
    status: authority.status ?? 'unknown',
    sourceRef: authority.sourceRef ?? null,
    handoffRelative: authority.handoffRelative ?? null,
    head: authority.head ?? authority.branchState?.head ?? null,
  };
}

async function jsonCommand(run, command, args, label) {
  const result = await run(command, args);
  if (result?.status !== 0 || typeof result?.stdout !== 'string') throw new Error(label);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(label);
  }
}

async function textCommand(run, command, args, label) {
  const result = await run(command, args);
  if (result?.status !== 0 || typeof result?.stdout !== 'string') throw new Error(label);
  return result.stdout;
}

function originRepository(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return match?.[1].replace(/\.git$/i, '') ?? null;
}

function authorityBranch(authority) {
  const sourceRef = authority?.sourceRef;
  if (typeof sourceRef !== 'string') return null;
  return sourceRef.split('/').at(-1) ?? null;
}

function isContentsEnvelope(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && 'content' in value && 'encoding' in value;
}

export function parseNpmSource(manifestText, lockText, source) {
  try {
    const manifest = JSON.parse(manifestText);
    const lock = JSON.parse(lockText);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || isContentsEnvelope(manifest) || isContentsEnvelope(lock)) throw new Error('invalid');
    lockPackages(lock);
    return { manifest, lock, source };
  } catch {
    throw new Error(`invalid npm source ${source}`);
  }
}

async function rawFile(run, repository, path, sha) {
  safeSha(sha);
  return textCommand(run, 'gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repository}/contents/${path}?ref=${sha}`], `contents ${path}`);
}

async function npmSource(run, repository, sha, source, cache = new Map()) {
  const cacheKey = `${repository}:${sha}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, source };
  const [manifestText, lockText] = await Promise.all(NPM_PATHS.map((path) => rawFile(run, repository, path, sha)));
  const value = parseNpmSource(manifestText, lockText, source);
  cache.set(cacheKey, { manifest: value.manifest, lock: value.lock });
  return value;
}

async function authorityNpmSource(run, sha) {
  safeSha(sha);
  const [manifestText, lockText] = await Promise.all(NPM_PATHS.map((path) => textCommand(run, 'git', ['show', `${sha}:${path}`], `authority ${path}`)));
  try {
    return { manifest: JSON.parse(manifestText), lock: JSON.parse(lockText), source: 'authority' };
  } catch {
    throw new Error('invalid authority npm source');
  }
}

function selectedPullRequest(item) {
  return item?.user?.login === 'dependabot[bot]' && item?.user?.type === 'Bot'
    || Array.isArray(item?.labels) && item.labels.some((label) => (typeof label === 'string' ? label : label?.name) === 'dependencies');
}

async function collectLivePr(run, repository, authority, item, npmCache) {
  const number = Number(item.number);
  const detail = await jsonCommand(run, 'gh', ['api', `repos/${repository}/pulls/${number}`], `PR ${number}`);
  const baseTip = safeSha(detail.base?.sha);
  const head = safeSha(detail.head?.sha);
  const baseBranch = typeof detail.base?.ref === 'string' ? detail.base.ref : null;
  const expectedBranch = authorityBranch(authority);
  const baseBranchMatchesAuthority = expectedBranch !== null && baseBranch !== null && baseBranch === expectedBranch;
  const record = {
    number,
    url: typeof detail.html_url === 'string' ? detail.html_url : null,
    author: detail.user?.login ?? null,
    labels: (detail.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean),
    baseBranch,
    baseTip,
    head,
    mergeBase: null,
    baseBranchMatchesAuthority,
    status: detail.state ?? 'unknown',
    changedPaths: [],
    npm: { status: 'manual_analysis', packages: [] },
  };
  if (detail.state !== 'open') {
    record.snapshotStatus = 'not_open';
    return record;
  }
  try {
    const mergeBase = await jsonCommand(run, 'gh', ['api', `repos/${repository}/compare/${baseTip}...${head}`], `PR ${number} merge base`);
    const mergeBaseSha = safeSha(mergeBase.merge_base_commit?.sha);
    record.mergeBase = mergeBaseSha;
    const files = asArray(await jsonCommand(run, 'gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls/${number}/files?per_page=100`], `PR ${number} files`));
    record.changedPaths = files.map((file) => file.filename).filter((path) => typeof path === 'string');
    const npmFiles = files.filter((file) => NPM_PATHS.includes(file?.filename));
    const manifestLifecycleChange = npmFiles.some((file) => file.status === 'added' || file.status === 'removed');
    if (manifestLifecycleChange) {
      record.npm = {
        status: 'manual_analysis',
        packages: npmFiles.filter((file) => file.status === 'added' || file.status === 'removed').map((file) => ({ path: file.filename, kind: 'manifest', change: file.status })),
      };
    } else if (npmFiles.length > 0) {
      const [base, proposed] = await Promise.all([
        npmSource(run, repository, mergeBaseSha, 'mergeBase', npmCache),
        npmSource(run, repository, head, 'proposed', npmCache),
      ]);
      record.npm = compareNpm(base, proposed, authority);
    }
    const finalDetail = await jsonCommand(run, 'gh', ['api', `repos/${repository}/pulls/${number}`], `PR ${number} final state`);
    record.snapshotStatus = finalDetail.state !== detail.state
      || finalDetail.base?.ref !== detail.base?.ref
      || finalDetail.base?.sha !== detail.base?.sha
      || finalDetail.head?.sha !== detail.head?.sha ? 'moved' : 'stable';
  } catch {
    record.snapshotStatus = 'incomplete';
  }
  return record;
}

export async function collectInventory(dependencies, options = {}) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const inventory = {
    schemaVersion: 1,
    generatedAt: now(),
    status: 'complete',
    exitCode: 0,
    repository: options.repository ?? null,
    authority: authoritySummary(options.authority),
    errors: [],
    prs: options.prs ?? [],
    alerts: options.alerts ?? { status: 'not_collected' },
  };
  if (inventory.authority?.status !== 'verified') {
    inventory.status = 'partial';
    inventory.exitCode = 1;
    inventory.errors.push({ source: 'authority', message: 'inventory requires verified authority' });
    return inventory;
  }
  try {
    safeSha(inventory.authority.head ?? inventory.authority.branchState?.head);
  } catch {
    inventory.status = 'partial';
    inventory.exitCode = 1;
    inventory.errors.push({ source: 'authority', message: 'inventory requires an immutable verified authority SHA' });
    return inventory;
  }
  if (options.prs || options.alerts || options.repository) {
    if (inventory.alerts.status === 'unavailable') {
      inventory.status = 'partial';
      inventory.exitCode = 2;
    }
    return inventory;
  }
  const { run } = dependencies;
  try {
    const repository = safeRepository((await textCommand(run, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 'repository identity')).trim());
    const remote = originRepository(await textCommand(run, 'git', ['remote', 'get-url', 'origin'], 'origin repository'));
    if (remote !== repository) throw new Error('origin repository differs from GitHub CLI repository');
    inventory.repository = repository;
    const authoritySha = safeSha(inventory.authority.head ?? inventory.authority.branchState?.head);
    const authority = { ...await authorityNpmSource(run, authoritySha), sourceRef: inventory.authority.sourceRef };
    const listed = asArray(await jsonCommand(run, 'gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls?state=open&per_page=100`], 'open pull requests'));
    const wanted = options.prNumbers?.length
      ? options.prNumbers.map((number) => listed.find((item) => Number(item.number) === number) ?? { number })
      : listed.filter(selectedPullRequest);
    inventory.prs = [];
    const npmCache = new Map();
    for (const item of wanted) {
      try {
        const pr = await collectLivePr(run, repository, authority, item, npmCache);
        inventory.prs.push(pr);
        if (pr.snapshotStatus === 'moved') {
          inventory.status = 'partial';
          inventory.exitCode = 2;
          inventory.errors.push({ source: `PR ${pr.number}`, message: 'PR state moved while collecting inventory' });
        }
        if (pr.snapshotStatus === 'not_open') {
          inventory.status = 'partial';
          inventory.exitCode = 2;
          inventory.errors.push({ source: `PR ${pr.number}`, message: 'requested PR is not open' });
        }
        if (pr.snapshotStatus === 'incomplete') {
          inventory.status = 'partial';
          inventory.exitCode = 2;
          inventory.errors.push(resultError(`PR ${pr.number}`));
        }
      } catch {
        inventory.status = 'partial';
        inventory.exitCode = 2;
        inventory.errors.push(resultError(`PR ${Number(item.number)}`));
        inventory.prs.push({ number: Number(item.number), status: 'unavailable', npm: { status: 'manual_analysis', packages: [] } });
      }
    }
    try {
      const alerts = asArray(await jsonCommand(run, 'gh', ['api', '--paginate', '--slurp', `repos/${repository}/dependabot/alerts?state=open&per_page=100`], 'Dependabot alerts'));
      inventory.alerts = { status: 'available', scope: 'default_branch_advisory_evidence', items: alerts.map((alert) => ({ url: alert.html_url ?? null, severity: alert.security_advisory?.severity ?? null, package: alert.dependency?.package?.name ?? null, ecosystem: alert.dependency?.package?.ecosystem ?? null, manifestPath: alert.dependency?.manifest_path ?? null })) };
    } catch {
      inventory.alerts = { status: 'unavailable', error: 'Dependabot alerts were unavailable' };
      inventory.status = 'partial';
      inventory.exitCode = 2;
    }
    const rereadAuthority = dependencies.resolveAuthority ?? (() => resolveAuthority(run));
    const finalAuthority = await rereadAuthority();
    const initialAuthoritySha = safeSha(inventory.authority.head ?? inventory.authority.branchState?.head);
    const finalAuthoritySha = finalAuthority?.status === 'verified'
      ? safeSha(finalAuthority.head ?? finalAuthority.branchState?.head)
      : null;
    if (finalAuthoritySha !== initialAuthoritySha) {
      inventory.status = 'partial';
      inventory.exitCode = 2;
      inventory.errors.push({ source: 'authority', message: 'authority moved while collecting inventory' });
    }
  } catch (error) {
    inventory.status = 'partial';
    inventory.exitCode = 2;
    inventory.errors.push(inventoryError(error));
  }
  return inventory;
}

function markdown(value) {
  return String(value ?? 'unknown').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[|\r\n]/g, ' ');
}

export function renderMarkdown(inventory) {
  const lines = [
    '# Dependency inventory',
    '',
    `Generated: ${markdown(inventory.generatedAt)}`,
    `Status: ${markdown(inventory.status)}`,
    `Authority: ${markdown(inventory.authority?.sourceRef)} at ${markdown(inventory.authority?.head ?? inventory.authority?.branchState?.head)}`,
    '',
    '## Pull requests',
    '',
    '| PR | Base | NPM evidence | Notes |',
    '| --- | --- | --- | --- |',
  ];
  for (const pr of inventory.prs) {
    const note = pr.baseBranchMatchesAuthority === false ? 'base branch differs from authority' : '';
    lines.push(`| #${markdown(pr.number)} | ${markdown(pr.baseBranch)} | ${markdown(pr.npm?.status)} | ${note} |`);
  }
  if (inventory.prs.length === 0) lines.push('| none | — | — | — |');
  lines.push('', `Alerts: ${markdown(inventory.alerts?.status)}`);
  if (inventory.errors.length) lines.push('', '## Errors', '', ...inventory.errors.map((error) => `- ${markdown(error.source)}: ${markdown(error.message)}`));
  return `${lines.join('\n')}\n`;
}

export function runLocalCommand(command, args, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? OUTPUT_LIMIT;
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false, timeout, maxBuffer });
  if (result.error || result.stdout?.length > maxBuffer || result.stderr?.length > maxBuffer) return { status: 1, stdout: '', stderr: '' };
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function resolveAuthority(run) {
  const result = await run('node', ['scripts/resolve-shared-handoff.mjs']);
  if (result.status !== 0 || typeof result.stdout !== 'string') return { status: 'degraded' };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: 'degraded' };
  }
}

export async function main(argv = process.argv.slice(2), dependencies = { run: runLocalCommand, now: () => new Date().toISOString() }) {
  const options = parseArgs(argv);
  const readAuthority = dependencies.resolveAuthority ?? (() => resolveAuthority(dependencies.run));
  const authority = await readAuthority();
  const inventory = await collectInventory({ ...dependencies, resolveAuthority: readAuthority }, { authority, prNumbers: options.prs });
  const output = options.format === 'markdown' ? renderMarkdown(inventory) : `${JSON.stringify(inventory, null, 2)}\n`;
  return { output, exitCode: inventory.exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ output, exitCode }) => {
    process.stdout.write(output);
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`dependency-inventory: ${error instanceof Error ? error.message : 'invalid invocation'}\n`);
    process.exitCode = 1;
  });
}
