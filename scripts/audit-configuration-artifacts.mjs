#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.worktrees',
  '.codegraph',
  '.superpowers',
  'build',
  'coverage',
  'coverage-core',
  'dist',
  'logs',
  'node_modules',
  'playwright-report',
  'test-results',
  'uploads',
]);

const CREDENTIAL_KEYS = new Set([
  'apikey',
  'accountid',
  'accesstoken',
  'clientid',
  'refreshtoken',
  'clientsecret',
  'consumerkey',
  'consumersecret',
  'tokenid',
  'tokensecret',
  'username',
  'password',
  'passphrase',
  'privatekey',
  'secret',
  'token',
]);

const CURRENT_AUTHENTICATION_KEYS = new Set([
  'sourceAuthentication',
  'targetAuthentication',
]);

const DEFAULT_SCAN_PATHS = [
  'config/integrations',
  'integrations',
  'examples/configs',
  'src/examples',
  'test-config',
  'data',
];

function normalizeKey(key) {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertWithinRoot(root, candidate) {
  if (!isWithinRoot(root, candidate)) {
    throw new Error(`Refusing to scan outside explicit root: ${candidate}`);
  }
}

function isPlaceholder(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;

  const candidate = value.trim();
  if (candidate === '') return true;
  if (/^<[^>]+>$/.test(candidate)) return true;
  if (/^\$\{[^}]+\}$/.test(candidate)) return true;
  if (/^\{\{[^}]+\}\}$/.test(candidate)) return true;
  if (/^[*xX]+$/.test(candidate)) return true;
  if (/@example\.(?:com|org|net)$/i.test(candidate)) return true;
  if (/^(?:demo|test|sample|example|dummy|fake|mock|placeholder)[^@]*@/i.test(candidate)) return true;

  const normalized = candidate.toLowerCase();
  if (/(?:^|[-_.\s])(?:demo|test|sample|example|dummy|fake|mock|placeholder)(?:$|[-_.\s])/.test(normalized)) {
    return true;
  }
  if (/^(?:change[-_\s]?me|replace[-_\s]?me|redacted|masked|not[-_\s]?set|none|null)$/.test(normalized)) {
    return true;
  }
  return /^your[-_\s].*(?:key|secret|password|token|credential)$/.test(normalized);
}

function safeRecordId(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
  const value = document.id;
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function findingCategory(keyPath) {
  const segments = keyPath.replace(/\[\d+\]/g, '').split('.');
  if (segments.includes('authentication')) return 'legacy-authentication';
  if (segments.some((segment) => CURRENT_AUTHENTICATION_KEYS.has(segment))) {
    return 'current-authentication';
  }
  return 'credential-shaped-key';
}

function collectCredentialFindings(value, context, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectCredentialFindings(entry, {
        ...context,
        keyPath: `${context.keyPath}[${index}]`,
      }, findings);
    });
    return;
  }

  if (value && typeof value === 'object') {
    const recordId = safeRecordId(value) ?? context.recordId;
    for (const [key, child] of Object.entries(value)) {
      const keyPath = context.keyPath ? `${context.keyPath}.${key}` : key;
      const normalizedKey = normalizeKey(key);
      collectCredentialFindings(child, {
        ...context,
        recordId,
        keyPath,
        credentialKey: CREDENTIAL_KEYS.has(normalizedKey),
      }, findings);
    }
    return;
  }

  if (!context.credentialKey || isPlaceholder(value)) return;
  findings.push({
    file: context.file,
    ...(context.recordId ? { recordId: context.recordId } : {}),
    category: findingCategory(context.keyPath),
    keyPath: context.keyPath,
  });
}

function scanJsonFile(root, filePath, findings) {
  const relativeFile = path.relative(root, filePath).split(path.sep).join('/');
  let document;
  try {
    document = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    findings.push({
      file: relativeFile,
      category: 'unreadable-json',
      keyPath: '$',
    });
    return;
  }

  collectCredentialFindings(document, {
    file: relativeFile,
    recordId: safeRecordId(document),
    keyPath: '',
    credentialKey: false,
  }, findings);
}

function isJsonPath(candidate) {
  return path.extname(candidate).toLowerCase() === '.json';
}

function walkDirectory(root, directory, findings, visited) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    walk(root, path.join(directory, entry.name), findings, visited);
  }
}

function walk(root, target, findings, visited = new Set()) {
  assertWithinRoot(root, target);
  const stat = lstatSync(target);

  if (stat.isSymbolicLink()) {
    const resolved = realpathSync(target);
    assertWithinRoot(root, resolved);

    // Scanning used to STOP here: a link was proved to stay inside the root and
    // then skipped entirely, so credential-bearing JSON reachable only through
    // it never reached scanJsonFile. Scan paths are narrow (`config/integrations`,
    // `src/examples`, `data`, ...), so a link inside one of them pointing at a
    // file in an unscanned directory was invisible to this gate — a bypass of a
    // blocking check, not merely a coverage gap. Links are followed now.
    //
    // `visited` holds RESOLVED real paths, which both bounds link cycles and
    // stops one file being reported twice when two links reach it.
    if (visited.has(resolved)) return;
    visited.add(resolved);

    const resolvedStat = statSync(resolved);
    if (resolvedStat.isDirectory()) {
      walkDirectory(root, resolved, findings, visited);
      return;
    }

    // Either name qualifying is deliberate: `latest.json -> credentials.txt` is
    // still a credential-bearing JSON artifact, and so is the reverse.
    if (resolvedStat.isFile() && (isJsonPath(target) || isJsonPath(resolved))) {
      scanJsonFile(root, resolved, findings);
    }
    return;
  }

  if (stat.isDirectory()) {
    walkDirectory(root, target, findings, visited);
    return;
  }

  if (stat.isFile() && isJsonPath(target)) {
    scanJsonFile(root, target, findings);
  }
}

export function auditConfigurationArtifacts(options = {}) {
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new Error('Configuration artifact audit requires an explicit root');
  }

  const root = realpathSync(path.resolve(options.root));
  const usesDefaultScanPaths = options.scanPaths === undefined;
  const scanPaths = options.scanPaths ?? DEFAULT_SCAN_PATHS;
  if (!Array.isArray(scanPaths) || scanPaths.length === 0) {
    throw new Error('Configuration artifact audit requires at least one scan path');
  }

  const findings = [];
  for (const requestedPath of scanPaths) {
    if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
      throw new Error('Configuration artifact audit scan paths must be non-empty strings');
    }
    const target = path.resolve(root, requestedPath);
    assertWithinRoot(root, target);
    if (usesDefaultScanPaths && !existsSync(target)) continue;
    const resolvedTarget = realpathSync(target);
    assertWithinRoot(root, resolvedTarget);
    walk(root, resolvedTarget, findings);
  }

  return findings.sort((left, right) => (
    left.file.localeCompare(right.file) || left.keyPath.localeCompare(right.keyPath)
  ));
}

function parseCliArguments(argv) {
  let root;
  const scanPaths = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = argv[index + 1];
      index += 1;
    } else if (argument === '--path') {
      scanPaths.push(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { root, ...(scanPaths.length > 0 ? { scanPaths } : {}) };
}

function main() {
  try {
    const findings = auditConfigurationArtifacts(parseCliArguments(process.argv.slice(2)));
    if (findings.length === 0) {
      console.log('audit-configuration-artifacts: OK (no credential-bearing JSON artifacts found)');
      return;
    }

    console.error(`audit-configuration-artifacts: FAIL (${findings.length} finding(s))`);
    for (const finding of findings) {
      const record = finding.recordId ? ` [record ${finding.recordId}]` : '';
      console.error(`  ${finding.file}${record} | ${finding.category} | ${finding.keyPath}`);
    }
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown audit failure';
    console.error(`audit-configuration-artifacts: ERROR: ${message}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main();
}
