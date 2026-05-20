#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TOKEN_PATTERN = /<!--\s*METRIC:([a-zA-Z0-9_.-]+)\s*-->([\s\S]*?)<!--\s*\/METRIC\s*-->/g;
const SKIP_DIRS = new Set(['.git', '.worktrees', 'coverage', 'dist', 'node_modules']);

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    metrics: 'metrics.json',
    check: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--metrics':
        options.metrics = argv[++i];
        break;
      case '--check':
        options.check = true;
        break;
      case '--help':
        console.log('Usage: node scripts/sync-metric-tokens.mjs [--root <dir>] [--check] [--metrics metrics.json]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function valueAtPath(source, keyPath) {
  const value = keyPath.split('.').reduce((current, part) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    return current[part];
  }, source);

  if (value === undefined) {
    throw new Error(`Metric token references missing key: ${keyPath}`);
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return String(value);
  }
  return JSON.stringify(value);
}

function listMarkdownFiles(root) {
  /** @type {string[]} */
  const files = [];

  /** @param {string} current */
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(current, entry.name));
      }
    }
  }

  walk(root);
  return files;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate first.`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

  const changed = [];
  const stale = [];

  for (const file of listMarkdownFiles(options.root)) {
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(TOKEN_PATTERN, (_match, keyPath) => {
      const nextValue = valueAtPath(metrics, keyPath.trim());
      return `<!-- METRIC:${keyPath.trim()} -->${nextValue}<!-- /METRIC -->`;
    });

    if (after !== before) {
      if (options.check) {
        stale.push(rel(options.root, file));
      } else {
        fs.writeFileSync(file, after);
        changed.push(rel(options.root, file));
      }
    }
  }

  if (stale.length > 0) {
    console.error(`Metric tokens are stale in ${stale.length} file(s):`);
    for (const file of stale) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  if (options.check) {
    console.log('Metric tokens are current.');
  } else if (changed.length > 0) {
    console.log(`Updated metric tokens in ${changed.length} file(s).`);
  } else {
    console.log('No metric tokens found or all tokens already current.');
  }
}

main();
