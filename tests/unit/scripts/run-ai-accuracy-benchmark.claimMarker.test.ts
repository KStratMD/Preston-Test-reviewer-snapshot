/**
 * Regression test for the `<!-- claim:benchmark -->` marker (M2, CLAUDE.md
 * Phase 2 slimming migration crosswalk). The durable benchmark-context
 * sentence and its marker are emitted as STATIC content by `buildMarkdown()`
 * in the renderer -- pins that a future renderer edit can't silently drop
 * either half, since the committed `docs/review/ai-accuracy-benchmark.md`
 * only carries what the renderer emits.
 *
 * Spawns the real runner in --dry-run ($0 oracle, no API calls) with
 * explicit --md-out into a temp dir (never docs/review/**) and asserts the
 * marker is on the line immediately following its exact sentence.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');

const DURABLE_SENTENCE =
  '- **Remaining cuts:** no nightly CI smoke (manual invocation only); population-level absolute-% claims still require broader fixtures than these hand-labeled sets (the CI quantifies sampling noise on the fixture, not fixture representativeness).';
const MARKER = '<!-- claim:benchmark -->';

describe('run-ai-accuracy-benchmark claim:benchmark marker', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-claim-marker-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renderer emits the marker immediately after its durable sentence', () => {
    const jsonOut = path.join(tmpDir, 'claim-marker.json');
    const mdOut = path.join(tmpDir, 'claim-marker.md');
    const result = spawnSync(
      'node',
      [SCRIPT, '--dry-run', '--json-out', jsonOut, '--md-out', mdOut],
      { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    expect(result.stderr ?? '').toBe('');
    expect(result.status).toBe(0);

    const md = fs.readFileSync(mdOut, 'utf8');
    const lines = md.split('\n');
    const sentenceIdx = lines.indexOf(DURABLE_SENTENCE);
    expect(sentenceIdx).toBeGreaterThanOrEqual(0);
    expect(lines[sentenceIdx + 1]).toBe(MARKER);

    // No orphan / duplicate markers.
    const markerCount = lines.filter((l) => l === MARKER).length;
    expect(markerCount).toBe(1);
  });

  it('committed docs/review/ai-accuracy-benchmark.md carries the same marker adjacency', () => {
    const committedPath = path.join(REPO_ROOT, 'docs/review/ai-accuracy-benchmark.md');
    const md = fs.readFileSync(committedPath, 'utf8');
    const lines = md.split('\n');
    const sentenceIdx = lines.indexOf(DURABLE_SENTENCE);
    expect(sentenceIdx).toBeGreaterThanOrEqual(0);
    expect(lines[sentenceIdx + 1]).toBe(MARKER);
  });
});
