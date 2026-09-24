/**
 * Every browser script shipped from public/ must parse, and every local
 * <script src> must point at a file that exists.
 *
 * Regression for the removed back-to-dashboard.js: two `const referrer`
 * declarations in one function body made the whole file an early
 * SyntaxError ("Identifier 'referrer' has already been declared"). The file
 * never executed, yet /docs/* pages and three public pages kept including it
 * for a year, logging the error on every load. Nothing in the unit suite
 * parsed public/ scripts, so it went unnoticed.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

const repoRoot = path.resolve(__dirname, '../../..');

function walkFiles(relDir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...walkFiles(rel, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(rel);
    }
  }
  return out;
}

// Every public/**/*<ext> file. Git-tracked files when this is a checkout (so
// untracked local files are ignored); a filesystem walk otherwise, because the
// reviewer mirror runs this test inside a staged snapshot that has no .git.
function gitTracked(ext: '.js' | '.html'): string[] {
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['ls-files', '--', `public/*${ext}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    // not a git repository
  }
  return tracked;
}
const IN_CHECKOUT = gitTracked('.js').length > 0;
function publicFiles(ext: '.js' | '.html'): string[] {
  return (IN_CHECKOUT ? gitTracked(ext) : walkFiles('public', ext)).sort();
}

// Module-only syntax that a classic-script parse rejects; such files are
// re-checked as ES modules instead of being skipped.
const MODULE_SYNTAX = /import statement|import\.meta|Unexpected token 'export'|await is only valid/;

function parseError(relPath: string): string | null {
  const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  try {
    new vm.Script(source, { filename: relPath });
    return null;
  } catch (err) {
    const message = (err as Error).message;
    if (!MODULE_SYNTAX.test(message)) return message;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-script-parse-'));
  try {
    const tmpFile = path.join(tmpDir, 'module.mjs');
    fs.writeFileSync(tmpFile, source);
    const result = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
    return result.status === 0 ? null : result.stderr.trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('public/ browser scripts', () => {
  const scripts = publicFiles('.js');

  it('finds the public scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(10);
  });

  it.each(scripts)('%s parses', (relPath) => {
    expect(parseError(relPath)).toBeNull();
  });

  it('every local <script src> in public pages and the docs renderer resolves to a file', () => {
    // Checkout only: the reviewer-mirror snapshot deliberately ships a subset of
    // public/, so pages there reference scripts it leaves out by design.
    if (!IN_CHECKOUT) return;
    const pages = [
      ...publicFiles('.html').filter((f) => !f.startsWith('public/wiki/')),
      'src/routes/docs.ts',
    ];
    const missing: string[] = [];
    for (const page of pages) {
      const text = fs.readFileSync(path.join(repoRoot, page), 'utf8');
      for (const match of text.matchAll(/<script[^>]*\bsrc=["']([^"'?#]+)/g)) {
        const src = match[1];
        if (/^(https?:)?\/\//.test(src) || src.includes('${')) continue;
        const target = src.startsWith('/')
          ? path.join(repoRoot, 'public', src)
          : path.join(repoRoot, path.dirname(page), src);
        if (!fs.existsSync(target)) missing.push(`${page} -> ${src}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
