import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/Logger';

const EDITOR_SENTINEL = 'ai-field-mapping-editor.html';
let cachedPublicDir: string | null = null;

const uniqPaths = (paths: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
};

const safeExists = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
};

const getFileStats = (filePath: string): { size: number; mtimeMs: number } => {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
};

export function resolvePublicDir(): string {
  if (cachedPublicDir) return cachedPublicDir;

  const configured = process.env.PUBLIC_DIR?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (safeExists(resolved)) {
      cachedPublicDir = resolved;
      return resolved;
    }
    logger.warn('[public] PUBLIC_DIR set but not found', { publicDir: resolved });
  }

  const cwd = process.cwd();
  const candidates = uniqPaths([
    path.join(cwd, 'public'),
    path.resolve(cwd, '..', 'public'),
    path.resolve(cwd, '..', '..', 'public'),
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(__dirname, '..', '..', '..', 'public'),
  ]);

  const existing = candidates.filter(safeExists);
  const withEditor = existing.filter(dir => safeExists(path.join(dir, EDITOR_SENTINEL)));

  if (withEditor.length > 0) {
    const ranked = withEditor
      .map(dir => {
        const stats = getFileStats(path.join(dir, EDITOR_SENTINEL));
        return { dir, stats };
      })
      .sort((a, b) => {
        if (b.stats.mtimeMs !== a.stats.mtimeMs) return b.stats.mtimeMs - a.stats.mtimeMs;
        return b.stats.size - a.stats.size;
      });
    cachedPublicDir = ranked[0].dir;
    if (withEditor.length > 1) {
      logger.warn('[public] Multiple public dirs contain editor file; using selected', {
        selected: cachedPublicDir,
        candidates: withEditor,
      });
    }
    return cachedPublicDir;
  }

  if (existing.length > 0) {
    cachedPublicDir = existing[0];
    if (existing.length > 1) {
      logger.warn('[public] Multiple public dirs found; using first', {
        selected: cachedPublicDir,
        candidates: existing,
      });
    }
    return cachedPublicDir;
  }

  cachedPublicDir = path.join(cwd, 'public');
  logger.warn('[public] No public dir found; defaulting to cwd/public', { publicDir: cachedPublicDir });
  return cachedPublicDir;
}
