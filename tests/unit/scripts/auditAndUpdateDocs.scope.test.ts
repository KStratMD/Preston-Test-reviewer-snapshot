import fs from 'fs';
import path from 'path';

describe('audit-and-update-docs file scope', () => {
  const script = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/audit-and-update-docs.ps1'),
    'utf8',
  );

  it('excludes repository-local worktrees and analysis output', () => {
    expect(script).toMatch(/\\\.worktrees/);
    expect(script).toMatch(/\\\.codegraph/);
    expect(script).toContain('docs[/\\\\]plans');
  });

  // Text fenced by vintage markers is a point-in-time snapshot, and these
  // baselines are coupled — the April-2026 page's test count, suite count, and
  // coverage figure were measured together. Re-baselining one number strands
  // the rest and yields a snapshot that never existed. check-baseline-drift.mjs
  // already scope-skips these blocks; the writer has to agree with the checker
  // about what is frozen. (No literal numbers here on purpose: the drift guard
  // scans this file too, and a frozen baseline cited in a comment is
  // indistinguishable from drift to a literal-substring scanner.)
  it('fences vintage-marked history off from the replacement pass', () => {
    expect(script).toContain('vintage:');
    expect(script).toContain('VINTAGE_FROZEN');
  });

  // Restoring after the comparison would leave placeholders in $content, so
  // every vintage-bearing file would compare as changed and take a date bump —
  // the git-blame noise the content-driven gate exists to prevent.
  it('restores vintage blocks before the change comparison', () => {
    const restore = script.indexOf('VINTAGE_FROZEN_$vi');
    const compare = script.indexOf('$contentChangedBySubstantiveReplacements');
    expect(restore).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(compare);
  });

  // A bare "N test suites" rule matches the RIGHT side of "630 / 630 test
  // suites passed" and leaves "630 / 567" — a mixed baseline that reconciles to
  // nothing and that a count sweep cannot see, since both halves look current.
  // Ordering alone does not save it: every rule runs over the whole file, so an
  // unguarded bare rule re-corrupts the ratio that the ratio-rule just fixed. The
  // lookbehind is the fix.
  it('guards the bare suite-count rule against matching a ratio', () => {
    expect(script).toContain('[\\d,]+[ \\t]{1,3}/[ \\t]{1,3}[\\d,]+ test suites');
    // Unbounded line-safe lookbehind: the spaced-ratio rule tolerates up to 3
    // spaces around the slash, but the guard must hold at ANY spacing — a
    // bounded lookbehind leaves a window where the ratio rule no longer
    // matches and the bare rule corrupts the right-hand side again.
    expect(script).toMatch(/\(\?<!\[\\d,\]\[ \\t\]\*\/\[ \\t\]\*\)\\b\\d\{2,4\} test suites/);
  });

  // The drift checker's scope scanner is line-state based: an unclosed opener
  // freezes everything through end-of-file. The writer must agree, or content
  // after an unclosed marker passes the checker while this script rewrites it.
  it('treats an unclosed vintage opener as frozen through end-of-file', () => {
    expect(script).toContain('|.*\\z');
  });

  // The conditional date bump must run while the vintage placeholders are
  // still in $content — restoring first lets a frozen "Last Updated"-style
  // date inside a vintage block get rewritten whenever anything else in the
  // file changed. The comparison uses a restored copy instead.
  it('date-bumps while vintage placeholders are still in place', () => {
    const comparisonCopy = script.indexOf('$restoredForComparison');
    const bump = script.indexOf('Last Updated date bumped');
    const restoreReal = script.lastIndexOf('VINTAGE_FROZEN_$vi');
    expect(comparisonCopy).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(comparisonCopy);
    expect(restoreReal).toBeGreaterThan(bump);
  });

  // Trailing skip-count phrases ("..., N skipped" / "... with N intentionally
  // skipped") carry none of the numbers a count sweep rewrites, so they go
  // stale silently unless synced. The rules anchor on the freshly-written
  // grand numbers so they can only ever touch the skip count that belongs
  // to them.
  it('syncs trailing skip counts anchored on the grand totals', () => {
    expect(script).toContain('[\\d,]+ skipped" = "`${1}$grandSkippedFmt skipped"');
    expect(script).toContain(
      '[\\d,]+ intentionally skipped" = "`${1}$grandSkippedFmt intentionally skipped"',
    );
  });
});
