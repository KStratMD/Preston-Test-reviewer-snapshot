// PR 3B route-coverage spec test.
//
// Enforces that every route file calling a BaseProvider or BaseConnector
// write surfaces PendingApprovalError via the shared
// `handleApprovalQueueError` helper at the documented catch count.
//
// Drift detection is bidirectional:
//   - REGRESSED: file has FEWER catches than the manifest expects (a route
//     was added without wiring the catch, or a wired catch was removed).
//   - IMPROVED: file has MORE catches than the manifest expects (a new
//     route was wired; bump the manifest).
//
// Maintenance: when adding a new route that calls a BaseProvider /
// BaseConnector write, EITHER add a `handleApprovalQueueError` call in the
// route's catch and bump the file's `expectedCatchCount`, OR add a new
// entry to `tests/spec/pr-3b-route-catches.json` if the file isn't yet
// listed. The companion docstring on the manifest spells out the rules.

import { readFileSync } from 'fs';
import { join } from 'path';

interface ManifestEntry {
  path: string;
  expectedCatchCount: number;
  reach: string;
  notes: string;
}

interface Manifest {
  files: ManifestEntry[];
}

// Anchored at repo root via 3 ../-segments from tests/unit/spec/ (spec → unit
// → tests → repo root).
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'tests', 'spec', 'pr-3b-route-catches.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

// `handleApprovalQueueError` calls are uniquely shaped:
//   if (await handleApprovalQueueError(...
// The import line uses `import { handleApprovalQueueError }` — different
// substring, so the count is unambiguous against the catch-site shape.
const CATCH_RE = /if\s+\(await\s+handleApprovalQueueError\s*\(/g;
const IMPORT_RE = /import\s*\{[^}]*handleApprovalQueueError[^}]*\}/;

describe('PR 3B route-coverage spec test', () => {
  it('manifest is non-empty', () => {
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  describe.each(manifest.files)('$path (expected $expectedCatchCount catches, $reach)', (entry) => {
    const absPath = join(REPO_ROOT, entry.path);
    let source: string;

    beforeAll(() => {
      source = readFileSync(absPath, 'utf8');
    });

    it('imports handleApprovalQueueError', () => {
      expect(source).toMatch(IMPORT_RE);
    });

    it(`has exactly ${entry.expectedCatchCount} catch-site calls (zero drift)`, () => {
      const actual = (source.match(CATCH_RE) ?? []).length;
      expect(actual).toBe(entry.expectedCatchCount);
    });
  });

  it('manifest paths are all unique', () => {
    const seen = new Set<string>();
    for (const entry of manifest.files) {
      expect(seen.has(entry.path)).toBe(false);
      seen.add(entry.path);
    }
  });

  it('expectedCatchCount values are positive integers', () => {
    for (const entry of manifest.files) {
      expect(Number.isInteger(entry.expectedCatchCount)).toBe(true);
      expect(entry.expectedCatchCount).toBeGreaterThan(0);
    }
  });
});
