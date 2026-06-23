/**
 * Regression test for the executive mini-pack link validator
 * (`scripts/package-squire-exec-v2-mini.ts`).
 *
 * Context: the validator (`validateMiniHtmlLinks` + its pure helpers
 * `normalizeMiniLink` / `isAllowedServerOnlyLink` / `resolveMiniLinkCandidates`)
 * runs ONLY inside `hosted-deploy`, never in PR CI. That blind spot is exactly
 * why the PR #904 wiki regen broke `main` undetected and needed hotfix #905.
 * Codex flagged (non-blocking, PR #905) that these classification functions had
 * no dedicated regression test. This pins their behaviour so the allowlist /
 * resolution logic can't silently drift.
 *
 * These are pure functions over in-memory strings/maps — the test reads no
 * files, so it is reviewer-mirror-safe and runs in plain PR CI.
 */
import {
  normalizeMiniLink,
  isAllowedServerOnlyLink,
  resolveMiniLinkCandidates,
  validateMiniHtmlLinks,
} from '../../../scripts/package-squire-exec-v2-mini';

describe('mini-pack link validator', () => {
  describe('normalizeMiniLink', () => {
    it('returns null for non-local / non-resolvable links', () => {
      const from = 'squire-v2-media-demo/index.html';
      expect(normalizeMiniLink(from, '')).toBeNull();
      expect(normalizeMiniLink(from, '   ')).toBeNull();
      expect(normalizeMiniLink(from, '#section')).toBeNull();
      expect(normalizeMiniLink(from, 'https://example.com/x')).toBeNull();
      expect(normalizeMiniLink(from, '//cdn.example.com/x')).toBeNull();
      expect(normalizeMiniLink(from, 'mailto:foo@bar.com')).toBeNull();
      expect(normalizeMiniLink(from, 'tel:+15551234567')).toBeNull();
      expect(normalizeMiniLink(from, 'javascript:void(0)')).toBeNull();
      expect(normalizeMiniLink(from, 'data:text/plain,hi')).toBeNull();
      // Unexpanded template literals are not resolvable targets.
      expect(normalizeMiniLink(from, 'pages/${slug}.html')).toBeNull();
    });

    it('resolves relative links against the source page directory', () => {
      expect(normalizeMiniLink('a/b/page.html', 'sibling.html')).toBe('a/b/sibling.html');
      expect(normalizeMiniLink('a/b/page.html', '../up.html')).toBe('a/up.html');
    });

    it('treats a leading slash as repo-root-relative (strips the slash)', () => {
      expect(normalizeMiniLink('a/b/page.html', '/api/help/ask')).toBe('api/help/ask');
    });

    it('maps a trailing-slash directory link to its index.html', () => {
      expect(normalizeMiniLink('a/page.html', 'sub/')).toBe('a/sub/index.html');
    });

    it('strips hash and query suffixes before resolving', () => {
      expect(normalizeMiniLink('a/page.html', 'target.html?v=1#frag')).toBe('a/target.html');
    });
  });

  describe('isAllowedServerOnlyLink', () => {
    it('allows the server-only prefixes that legitimately ship without a packaged target', () => {
      expect(isAllowedServerOnlyLink('api/help/ask')).toBe(true);
      expect(isAllowedServerOnlyLink('wiki/downloads/suitecentral-offline-package.zip')).toBe(true);
      expect(isAllowedServerOnlyLink('wiki/tags/portfolio.html')).toBe(true);
      expect(isAllowedServerOnlyLink('code-architecture-dashboard.html')).toBe(true);
      expect(isAllowedServerOnlyLink('suitecentral-deployment-options-dashboard.html')).toBe(true);
    });

    it('does NOT exempt genuine in-pack targets or unrelated tag pages', () => {
      expect(isAllowedServerOnlyLink('src/foo.ts')).toBe(false);
      expect(isAllowedServerOnlyLink('wiki/tags/other.html')).toBe(false);
      expect(isAllowedServerOnlyLink('squire-v2-media-demo/index.html')).toBe(false);
    });
  });

  describe('resolveMiniLinkCandidates', () => {
    it('returns the target verbatim when it already has an extension', () => {
      expect(resolveMiniLinkCandidates('a/b.html')).toEqual(['a/b.html']);
    });

    it('expands an extensionless target to .html and index.html candidates', () => {
      expect(resolveMiniLinkCandidates('a/b')).toEqual(['a/b', 'a/b.html', 'a/b/index.html']);
    });
  });

  describe('validateMiniHtmlLinks', () => {
    const validate = (html: string, packaged: string[], from = 'page.html') => {
      const htmlByPath = new Map([[from, html]]);
      const packagedPaths = new Set(packaged);
      return () => validateMiniHtmlLinks(htmlByPath, packagedPaths, new Set([from]));
    };

    it('passes when every link resolves to a packaged target', () => {
      expect(validate('<a href="other.html">x</a>', ['page.html', 'other.html'])).not.toThrow();
    });

    it('resolves an extensionless link via the .html candidate', () => {
      expect(validate('<a href="other">x</a>', ['page.html', 'other.html'])).not.toThrow();
    });

    it('passes a server-only link (api/) even when no target is packaged', () => {
      expect(validate('<a href="/api/help/ask">x</a>', ['page.html'])).not.toThrow();
    });

    it('passes the allowlisted wiki/tags/portfolio page when it is not packaged', () => {
      expect(validate('<a href="/wiki/tags/portfolio.html">x</a>', ['page.html'])).not.toThrow();
    });

    it('throws naming a non-served target that is neither packaged nor allowlisted', () => {
      const run = validate('<a href="/src/foo.ts">x</a>', ['page.html']);
      expect(run).toThrow(/Mini-pack link validation failed/);
      expect(run).toThrow(/src\/foo\.ts/);
    });

    it('only validates pages in the pagesToValidate set', () => {
      const htmlByPath = new Map([
        ['included.html', '<a href="missing.html">x</a>'],
        ['excluded.html', '<a href="also-missing.html">x</a>'],
      ]);
      const packagedPaths = new Set(['included.html', 'excluded.html']);
      // Only "excluded.html" is left out of pagesToValidate, so its broken
      // link must NOT be reported; "included.html"'s broken link must.
      expect(() =>
        validateMiniHtmlLinks(htmlByPath, packagedPaths, new Set(['included.html'])),
      ).toThrow(/missing\.html/);
      expect(() =>
        validateMiniHtmlLinks(htmlByPath, packagedPaths, new Set(['included.html'])),
      ).not.toThrow(/also-missing\.html/);
    });

    it('reports every broken link across multiple source pages', () => {
      const htmlByPath = new Map([
        ['one.html', '<a href="gone-a.html">a</a>'],
        ['two.html', '<a href="gone-b.html">b</a>'],
      ]);
      const run = () =>
        validateMiniHtmlLinks(htmlByPath, new Set(['one.html', 'two.html']), new Set(['one.html', 'two.html']));
      expect(run).toThrow(/2 missing target\(s\)/);
      expect(run).toThrow(/gone-a\.html/);
      expect(run).toThrow(/gone-b\.html/);
    });
  });
});
