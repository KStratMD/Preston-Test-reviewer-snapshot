/**
 * Wiki Content Index
 *
 * Lazily reads the Quartz-built wiki indexes shipped under
 * `public/wiki/static/` and exposes lookups by path and by tag. Used to enrich
 * architecture-node retrieval with hosted-wiki excerpts.
 *
 * Local dev (and the reviewer mirror, which does NOT ship `public/wiki/**`)
 * must work without the artifacts present, so every read failure degrades to
 * an empty result — never a throw, never per-call log spam (the miss is cached
 * exactly like a successful parse).
 */

import path from 'path';
import { readFileSync } from 'fs';
import { logger } from '../../utils/Logger';

/**
 * A normalized wiki entry surfaced to callers. `excerpt` is a bounded slice of
 * the indexed page content suitable for prompt injection.
 */
export interface WikiContentEntry {
  slug: string;
  title: string;
  filePath: string;
  tags: string[];
  excerpt: string;
}

const CONTENT_INDEX_REL = path.join('public', 'wiki', 'static', 'contentIndex.json');
const SOURCE_INDEX_REL = path.join('public', 'wiki', 'static', 'source-index.json');
const EXCERPT_MAX_CHARS = 600;

/**
 * Narrow an unknown JSON value to a string, defaulting to ''.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Narrow an unknown JSON value to a string array, dropping non-strings.
 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Normalize a wiki path/slug for matching. The architecture manifest carries
 * wiki references like `/wiki/pages/concepts/nl-action-gate.html`, while the
 * contentIndex keys/slugs are bare like `pages/concepts/nl-action-gate`.
 * Strips a leading `/wiki/` or `/`, a trailing `.html`/`.md` extension, and
 * surrounding slashes so both forms collapse to the same key.
 */
function normalizeWikiKey(raw: string): string {
  let key = raw.trim();
  if (key.startsWith('/wiki/')) {
    key = key.slice('/wiki/'.length);
  } else if (key.startsWith('wiki/')) {
    key = key.slice('wiki/'.length);
  }
  key = key.replace(/^\/+/, '').replace(/\/+$/, '');
  key = key.replace(/\.(html|md)$/i, '');
  return key;
}

export class WikiContentIndex {
  private readonly baseDir: string;
  /** Parsed entries keyed by normalized slug; null until first load attempt. */
  private entriesBySlug: Map<string, WikiContentEntry> | null = null;
  /** True once a load has been attempted (success OR failure) — caches misses. */
  private loaded = false;

  /**
   * @param baseDir Repo root containing `public/wiki/static/`. Injectable so
   *   tests can point it at a temp-dir fixture (the real `public/wiki/**` is
   *   NOT shipped to the reviewer mirror, so tests must never read it).
   */
  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  /**
   * Find entries whose normalized slug matches one of the supplied paths.
   * Accepts either manifest-style (`/wiki/pages/.../x.html`) or bare-slug paths.
   */
  findEntriesByPaths(paths: readonly string[]): WikiContentEntry[] {
    if (paths.length === 0) {
      return [];
    }
    const index = this.ensureLoaded();
    if (index.size === 0) {
      return [];
    }

    const results: WikiContentEntry[] = [];
    const seen = new Set<string>();
    for (const rawPath of paths) {
      const entry = index.get(normalizeWikiKey(rawPath));
      if (entry && !seen.has(entry.slug)) {
        seen.add(entry.slug);
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Find entries carrying at least one of the supplied tags.
   */
  findEntriesByTags(tags: readonly string[]): WikiContentEntry[] {
    if (tags.length === 0) {
      return [];
    }
    const index = this.ensureLoaded();
    if (index.size === 0) {
      return [];
    }

    const wanted = new Set(tags);
    const results: WikiContentEntry[] = [];
    for (const entry of index.values()) {
      if (entry.tags.some(tag => wanted.has(tag))) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Lazily load + parse the content index on first use, caching the result
   * (including an empty result on any failure) so subsequent calls are cheap
   * and quiet.
   */
  private ensureLoaded(): Map<string, WikiContentEntry> {
    if (this.loaded && this.entriesBySlug) {
      return this.entriesBySlug;
    }

    const index = new Map<string, WikiContentEntry>();
    const contentIndexPath = path.join(this.baseDir, CONTENT_INDEX_REL);

    try {
      const raw = readFileSync(contentIndexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
          }
          const record = value as Record<string, unknown>;
          const slug = normalizeWikiKey(asString(record['slug']) || key);
          if (!slug) {
            continue;
          }
          const content = asString(record['content']);
          index.set(slug, {
            slug,
            title: asString(record['title']),
            filePath: asString(record['filePath']),
            tags: asStringArray(record['tags']),
            excerpt: content.slice(0, EXCERPT_MAX_CHARS),
          });
        }
      } else {
        logger.warn('Wiki content index has unexpected shape; treating as empty', {
          contentIndexPath,
        });
      }
      this.registerSourceIndexSlugs(index);
    } catch (error) {
      // Missing/unreadable artifacts are expected in local dev and the reviewer
      // mirror. Log once at debug level and cache the empty result.
      logger.debug('Wiki content index unavailable; architecture wiki enrichment disabled', {
        contentIndexPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.entriesBySlug = index;
    this.loaded = true;
    return index;
  }

  /**
   * Register slugs from the `source-index.json` ordinal map that the content
   * index didn't already cover. The source index carries no content or tags
   * (it is a slug → ordinal lookup), so these entries exist only so a
   * path lookup against a known source slug resolves rather than missing.
   * Best-effort: any read/parse failure is swallowed (the content index has
   * already loaded by this point).
   */
  private registerSourceIndexSlugs(index: Map<string, WikiContentEntry>): void {
    const sourceIndexPath = path.join(this.baseDir, SOURCE_INDEX_REL);
    try {
      const raw = readFileSync(sourceIndexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      const bySlug = (parsed as Record<string, unknown>)['bySlug'];
      if (!bySlug || typeof bySlug !== 'object' || Array.isArray(bySlug)) {
        return;
      }
      for (const rawSlug of Object.keys(bySlug as Record<string, unknown>)) {
        const slug = normalizeWikiKey(rawSlug);
        if (!slug || index.has(slug)) {
          continue;
        }
        index.set(slug, {
          slug,
          title: slug,
          filePath: '',
          tags: [],
          excerpt: '',
        });
      }
    } catch (error) {
      logger.debug('Wiki source index unavailable; skipping source-slug registration', {
        sourceIndexPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
