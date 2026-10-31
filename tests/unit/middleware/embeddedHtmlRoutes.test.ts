// tests/unit/middleware/embeddedHtmlRoutes.test.ts
import {
  CSP_ROUTED_EMBEDDED_HTML_BASENAMES,
  isEmbeddedHtmlRoutePath,
} from '../../../src/middleware/embeddedHtmlRoutes';

describe('embeddedHtmlRoutes', () => {
  it('lists exactly the five CSP-routed embedded pages', () => {
    expect([...CSP_ROUTED_EMBEDDED_HTML_BASENAMES].sort()).toEqual([
      'approvals.html',
      'lineage.html',
      'reconciliation.html',
      'session-expired.html',
      'sync-error-triage.html',
    ]);
  });

  it.each([
    '/embedded/reconciliation.html',
    '/embedded/approvals.html',
    '/embedded/lineage.html',
    '/embedded/sync-error-triage.html',
    '/embedded/session-expired.html',
  ])('matches CSP-routed page %s', (p) => {
    expect(isEmbeddedHtmlRoutePath(p)).toBe(true);
  });

  it.each([
    '/embedded/host-reference.html',
    '/embedded/reconciliation.js',
    '/embedded/foo/reconciliation.html',
    '/embedded/',
    '/other.html',
    '/reconciliation.html',
  ])('does not match non-routed path %s', (p) => {
    expect(isEmbeddedHtmlRoutePath(p)).toBe(false);
  });
});
