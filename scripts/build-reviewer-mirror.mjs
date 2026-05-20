#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULT_ALLOWLIST = 'scripts/reviewer-mirror.allowlist.json';
const HARD_EXCLUDE_PREFIXES = [
  'public/Squire-Executive-Package-v2/',
  'public/wiki/',
  'cookies/',
];
const FORBIDDEN_CONTENT_PATTERNS = [
  { name: 'K-drive path', regex: new RegExp('K:' + '[\\\\/]') },
  { name: 'Windows user path', regex: new RegExp('C:' + '\\\\' + 'Users' + '\\\\') },
  { name: 'cloud-drive path', regex: new RegExp('One' + 'Drive' + '\\\\', 'i') },
  { name: 'cloud-drive URL', regex: new RegExp('(?:one' + 'drive\\.live\\.com|1drv\\.ms)', 'i') },
  { name: 'storage_state file reference', regex: /storage_state\.json/i },
  { name: 'Brain1 deploy key name', regex: new RegExp('BRAIN1_QUARTZ_' + 'DEPLOY_KEY') },
  { name: 'Preston dispatch token name', regex: new RegExp('PRESTON_TEST_' + 'DISPATCH_TOKEN') },
];

// Files that are themselves test fixtures for THIS scanner. They contain
// forbidden patterns intentionally to assert that the scanner rejects them,
// so the scanner must skip its own self-test inputs or it'll flag them and
// refuse to ship the mirror. Tightly scoped — adding to this list requires
// reviewer sign-off, since each entry weakens the scan surface.
const CONTENT_SCAN_EXEMPTIONS = new Set([
  'tests/scripts/reviewer-mirror.test.sh',
]);
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const MAX_TEXT_SCAN_BYTES = 1024 * 1024;

function usage() {
  console.error(`Usage: scripts/build-reviewer-mirror.sh [options]

Options:
  --source <dir>        Source repo directory (default: cwd)
  --staging <dir>      Staging directory (default: tmp dir)
  --allowlist <file>   Allowlist JSON file (default: ${DEFAULT_ALLOWLIST})
  --archive <file>     Also create a tar.gz archive from staged files
  --dry-run            Print staged file tree after copy
  --yes                Skip interactive confirmation for non-dry-run staging
  --skip-secret-scan   Skip gitleaks/trufflehog scan; custom checks still run
  --help               Show this help
`);
}

function parseArgs(argv) {
  const options = {
    source: process.cwd(),
    staging: '',
    allowlist: DEFAULT_ALLOWLIST,
    archive: '',
    dryRun: false,
    yes: false,
    skipSecretScan: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--source':
        options.source = argv[++i];
        break;
      case '--staging':
        options.staging = argv[++i];
        break;
      case '--allowlist':
        options.allowlist = argv[++i];
        break;
      case '--archive':
        options.archive = argv[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--skip-secret-scan':
        options.skipSecretScan = true;
        break;
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function escapeRegexChar(value) {
  return value.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
}

function globToRegex(pattern) {
  const segments = pattern.split('/');
  const converted = segments.map((segment) => {
    if (segment === '**') {
      return '(?:.*)';
    }

    return [...segment].map((char) => {
      if (char === '*') {
        return '[^/]*';
      }
      if (char === '?') {
        return '[^/]';
      }
      return escapeRegexChar(char);
    }).join('');
  });

  return new RegExp(`^${converted.join('/')}$`);
}

function matchesPattern(relativePath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }

  if (!pattern.includes('*') && !pattern.includes('?')) {
    return relativePath === pattern;
  }

  return globToRegex(pattern).test(relativePath);
}

function basenameHasForbiddenShape(relativePath) {
  const base = path.posix.basename(relativePath);
  return (
    base.includes('.env') ||
    base.toLowerCase().includes('storage_state') ||
    base.endsWith('.cookie') ||
    base.endsWith('.session')
  );
}

function isHardExcluded(relativePath) {
  if (HARD_EXCLUDE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return true;
  }

  if (relativePath.startsWith('public/') && /\.(?:zip|tar\.gz|pdf)$/i.test(relativePath)) {
    return true;
  }

  return basenameHasForbiddenShape(relativePath);
}

function readAllowlist(sourceDir, allowlistPath) {
  const resolved = path.resolve(sourceDir, allowlistPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed.include) || parsed.include.length === 0) {
    throw new Error(`Allowlist must define a non-empty include array: ${resolved}`);
  }

  return {
    include: parsed.include,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
  };
}

function walkFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = toPosix(path.relative(rootDir, absolutePath));

      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '.worktrees', '.claude'].includes(entry.name)) {
          continue;
        }
        walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

function selectFiles(sourceDir, allowlist) {
  return walkFiles(sourceDir).filter((relativePath) => {
    if (isHardExcluded(relativePath)) {
      return false;
    }

    const included = allowlist.include.some((pattern) => matchesPattern(relativePath, pattern));
    const excluded = allowlist.exclude.some((pattern) => matchesPattern(relativePath, pattern));
    return included && !excluded;
  });
}

function copyFiles(sourceDir, stagingDir, files) {
  const safeStagingDir = assertSafeStagingDir(sourceDir, stagingDir);
  fs.rmSync(safeStagingDir, { recursive: true, force: true });
  fs.mkdirSync(safeStagingDir, { recursive: true });

  for (const relativePath of files) {
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(safeStagingDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function isSameOrDescendantPath(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeStagingDir(sourceDir, stagingDir) {
  const resolvedStagingDir = path.resolve(stagingDir);
  const filesystemRoot = path.parse(resolvedStagingDir).root;
  const protectedDirs = [sourceDir, process.cwd(), os.homedir()]
    .map((dir) => path.resolve(dir))
    .filter(Boolean);

  if (resolvedStagingDir === filesystemRoot) {
    throw new Error(`Refusing to use dangerous staging directory: ${resolvedStagingDir}`);
  }

  for (const protectedDir of protectedDirs) {
    if (isSameOrDescendantPath(protectedDir, resolvedStagingDir)) {
      throw new Error(`Refusing to use dangerous staging directory: ${resolvedStagingDir}`);
    }
  }

  return resolvedStagingDir;
}

function runCustomContentChecks(stagingDir) {
  const files = walkFiles(stagingDir);
  const violations = [];

  for (const relativePath of files) {
    if (basenameHasForbiddenShape(relativePath)) {
      violations.push(`${relativePath}: forbidden file name`);
      continue;
    }

    if (CONTENT_SCAN_EXEMPTIONS.has(relativePath)) {
      continue;
    }

    if (!shouldScanTextContent(relativePath, path.join(stagingDir, relativePath))) {
      continue;
    }

    const absolutePath = path.join(stagingDir, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');
    for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
      if (pattern.regex.test(content)) {
        violations.push(`${relativePath}: ${pattern.name}`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Forbidden content found in reviewer mirror:\n${violations.map((v) => `  - ${v}`).join('\n')}`);
  }
}

function shouldScanTextContent(relativePath, absolutePath) {
  if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return false;
  }
  return fs.statSync(absolutePath).size <= MAX_TEXT_SCAN_BYTES;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function runSecretScans(sourceDir, stagingDir) {
  const configPath = path.join(sourceDir, '.gitleaks.toml');
  runCommand('gitleaks', [
    'detect',
    '--source',
    stagingDir,
    '--no-git',
    '--config',
    configPath,
    '--no-banner',
    '--redact',
    '--exit-code',
    '1',
  ], sourceDir);
  runCommand('trufflehog', ['filesystem', stagingDir, '--only-verified', '--fail', '--no-update'], sourceDir);
}

function createArchive(stagingDir, archivePath) {
  fs.mkdirSync(path.dirname(path.resolve(archivePath)), { recursive: true });
  runCommand('tar', ['-czf', path.resolve(archivePath), '-C', stagingDir, '.'], stagingDir);
}

async function confirmIfNeeded(options, files) {
  if (options.dryRun || options.yes) {
    return;
  }

  console.log(`About to stage ${files.length} files for reviewer mirror.`);
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question('Continue? Type y to proceed: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    throw new Error('Reviewer mirror build cancelled');
  }
}

function printTree(files) {
  console.log('Reviewer mirror staged files:');
  for (const file of files) {
    console.log(file);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(options.source);
  const stagingDir = path.resolve(options.staging || fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-mirror-')));
  const allowlist = readAllowlist(sourceDir, options.allowlist);
  const files = selectFiles(sourceDir, allowlist);

  if (files.length === 0) {
    throw new Error('Allowlist selected zero files');
  }

  await confirmIfNeeded(options, files);
  copyFiles(sourceDir, stagingDir, files);
  runCustomContentChecks(stagingDir);

  if (!options.skipSecretScan) {
    runSecretScans(sourceDir, stagingDir);
  }

  if (options.archive) {
    createArchive(stagingDir, options.archive);
  }

  printTree(files);
  console.log(`Reviewer mirror staging directory: ${stagingDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
