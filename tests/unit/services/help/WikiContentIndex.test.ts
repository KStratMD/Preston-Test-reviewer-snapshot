/**
 * Unit tests for WikiContentIndex.
 *
 * MIRROR SAFETY: these tests MUST NOT read the real `public/wiki/static/*.json`
 * — `public/wiki/**` is excluded from the reviewer mirror, so a test reading it
 * would pass locally and fail inside the published snapshot. Every test points
 * the injectable base directory at an os.tmpdir() fixture instead.
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { WikiContentIndex } from '../../../../src/services/help/WikiContentIndex';

function makeFixtureRoot(opts: {
  contentIndex?: unknown;
  sourceIndex?: unknown;
  writeContent?: boolean;
  writeSource?: boolean;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-index-test-'));
  const staticDir = path.join(root, 'public', 'wiki', 'static');
  mkdirSync(staticDir, { recursive: true });

  if (opts.writeContent !== false) {
    writeFileSync(
      path.join(staticDir, 'contentIndex.json'),
      typeof opts.contentIndex === 'string'
        ? opts.contentIndex
        : JSON.stringify(opts.contentIndex ?? {}),
    );
  }
  if (opts.writeSource !== false) {
    writeFileSync(
      path.join(staticDir, 'source-index.json'),
      typeof opts.sourceIndex === 'string'
        ? opts.sourceIndex
        : JSON.stringify(opts.sourceIndex ?? { total: 0, bySlug: {} }),
    );
  }
  return root;
}

const SAMPLE_CONTENT = {
  'pages/concepts/nl-action-gate': {
    slug: 'pages/concepts/nl-action-gate',
    filePath: 'pages/concepts/nl-action-gate.md',
    title: 'Natural Language Action Gate',
    tags: ['nl-action-gate', 'governance', 'ai-safety'],
    content: 'The SuiteCentral 2.0 component that gates plain-English commands.',
  },
  'pages/concepts/production-proof': {
    slug: 'pages/concepts/production-proof',
    filePath: 'pages/concepts/production-proof.md',
    title: 'Production Proof',
    tags: ['production-proof', 'evidence'],
    content: 'Evidence that the system is production-ready.',
  },
};

describe('WikiContentIndex', () => {
  const created: string[] = [];

  function fixture(opts: Parameters<typeof makeFixtureRoot>[0]): string {
    const root = makeFixtureRoot(opts);
    created.push(root);
    return root;
  }

  afterAll(() => {
    for (const root of created) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('findEntriesByPaths', () => {
    it('resolves manifest-style /wiki/...html paths to bare-slug entries', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      const entries = idx.findEntriesByPaths(['/wiki/pages/concepts/nl-action-gate.html']);
      expect(entries.length).toBe(1);
      expect(entries[0].slug).toBe('pages/concepts/nl-action-gate');
      expect(entries[0].title).toBe('Natural Language Action Gate');
      expect(entries[0].excerpt).toContain('plain-English commands');
    });

    it('resolves bare-slug paths', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      const entries = idx.findEntriesByPaths(['pages/concepts/production-proof']);
      expect(entries.map(e => e.slug)).toEqual(['pages/concepts/production-proof']);
    });

    it('de-duplicates when multiple input forms map to the same slug', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      const entries = idx.findEntriesByPaths([
        '/wiki/pages/concepts/nl-action-gate.html',
        'pages/concepts/nl-action-gate',
      ]);
      expect(entries.length).toBe(1);
    });

    it('returns empty for an empty path list', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      expect(idx.findEntriesByPaths([])).toEqual([]);
    });

    it('returns empty for unmatched paths', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      expect(idx.findEntriesByPaths(['/wiki/pages/concepts/does-not-exist.html'])).toEqual([]);
    });
  });

  describe('findEntriesByTags', () => {
    it('returns entries carrying at least one matching tag', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      const entries = idx.findEntriesByTags(['governance']);
      expect(entries.map(e => e.slug)).toEqual(['pages/concepts/nl-action-gate']);
    });

    it('returns empty for an empty tag list', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: SAMPLE_CONTENT }));
      expect(idx.findEntriesByTags([])).toEqual([]);
    });
  });

  describe('missing / malformed artifacts (non-fatal)', () => {
    it('returns empty when contentIndex.json is absent', () => {
      const idx = new WikiContentIndex(
        fixture({ writeContent: false, writeSource: false }),
      );
      expect(idx.findEntriesByPaths(['pages/concepts/nl-action-gate'])).toEqual([]);
      expect(idx.findEntriesByTags(['governance'])).toEqual([]);
    });

    it('returns empty (never throws) on malformed JSON', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: '{ not valid json' }));
      expect(() => idx.findEntriesByPaths(['pages/concepts/nl-action-gate'])).not.toThrow();
      expect(idx.findEntriesByPaths(['pages/concepts/nl-action-gate'])).toEqual([]);
    });

    it('tolerates an unexpected top-level shape (array) by returning empty', () => {
      const idx = new WikiContentIndex(fixture({ contentIndex: [1, 2, 3] }));
      expect(idx.findEntriesByTags(['governance'])).toEqual([]);
    });

    it('points the base dir at a temp fixture, never the real public/wiki', () => {
      // Guard against accidental cwd fallthrough: a non-existent base dir must
      // simply yield empty, proving we are not reading the real artifacts.
      const idx = new WikiContentIndex(path.join(tmpdir(), 'definitely-absent-wiki-root'));
      expect(idx.findEntriesByPaths(['pages/concepts/nl-action-gate'])).toEqual([]);
    });
  });

  describe('lazy load + caching', () => {
    it('does not read files at construction time', () => {
      // Construct against an absent dir, then verify no throw on first call.
      const idx = new WikiContentIndex(path.join(tmpdir(), 'absent-at-construction'));
      expect(() => idx.findEntriesByTags(['governance'])).not.toThrow();
    });
  });

  describe('source-index slug registration', () => {
    it('registers source slugs not present in the content index', () => {
      const idx = new WikiContentIndex(
        fixture({
          contentIndex: SAMPLE_CONTENT,
          sourceIndex: { total: 1, bySlug: { 'sources/01-executive-summary': 1 } },
        }),
      );
      const entries = idx.findEntriesByPaths(['sources/01-executive-summary']);
      expect(entries.length).toBe(1);
      expect(entries[0].slug).toBe('sources/01-executive-summary');
    });
  });
});
