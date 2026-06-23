/**
 * Regression test for the AI-accuracy-benchmark `--matrix` mode and the
 * schema_version 3 artifact shape (M1 Phase B, task 2.4; v3 = A/C
 * follow-ups: --include-provider opt-in cells + Wilson 95% CIs).
 *
 * Spawns the real runner in --dry-run (deterministic oracle, $0, no API
 * calls) and asserts:
 *
 *   1. MATRIX — `--matrix --dry-run` exits 0 and emits a schema_version 3
 *      artifact with 4 distinct (provider, pair) cells, every cell at
 *      oracle-perfect accuracy, top-level headline fields mirroring the
 *      canonical cell (openai x sfdc-to-ns-customers), and
 *      total_estimated_cost_usd === 0. The markdown carries the
 *      provider x pair matrix table.
 *
 *   2. WILSON CI — every run (and the headline mirror) carries
 *      accuracy_top1_ci95 with the exact Wilson values for the
 *      oracle-perfect fixtures (n=61 -> [0.9408, 1], n=11 -> [0.7412, 1]),
 *      pinning the interval math against silent formula drift.
 *
 *   3. INCLUDE-PROVIDER — `--include-provider openrouter --include-provider
 *      lmstudio` widens the matrix to 8 distinct cells; the canonical
 *      headline still mirrors openai x sfdc-to-ns-customers; the lmstudio
 *      dry-run cells keep the literal 'auto' model sentinel (no server
 *      contact on a $0 rehearsal) and the openrouter cells carry the pinned
 *      :free default model.
 *
 *   4. SINGLE-RUN — a plain `--dry-run` also emits schema_version 3 with a
 *      one-element runs[] mirroring the headline (uniform v3 shape across
 *      modes).
 *
 *   5. FLAG GUARDS — `--matrix` combined with an explicit cell flag
 *      (--provider) is rejected; `--include-provider` without `--matrix`,
 *      with a base-matrix provider, or with an unknown provider is
 *      rejected; a non-:free OpenRouter model override is rejected (the
 *      $0 invariant). All with a nonzero exit.
 *
 * All artifacts go to a per-run temp dir (never docs/review/**) and are
 * cleaned up afterwards.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/run-ai-accuracy-benchmark.mjs');

const CANONICAL_PROVIDER = 'openai';
const CANONICAL_PAIR = 'sfdc-to-ns-customers';

interface Ci95 {
  low: number;
  high: number;
}

interface RunEntry {
  pair: string;
  fixture: string;
  target_system: string;
  provider: string;
  model: string;
  run_mode: string;
  fixture_cases: number;
  fixture_mappings: number;
  accuracy_top1: number;
  accuracy_top1_ci95: Ci95 | null;
  hallucination_count: number;
  manual_edit_rate: number;
  estimated_cost_usd: number;
  duration_ms: number;
}

interface SummaryV3 {
  schema_version: number;
  run_mode: string;
  provider: string;
  model: string;
  fixture: string;
  target_system: string;
  fixture_cases: number;
  fixture_mappings: number;
  accuracy_top1: number;
  accuracy_top1_ci95: Ci95 | null;
  hallucination_count: number;
  manual_edit_rate: number;
  estimated_cost_usd: number;
  max_cost_usd: number;
  duration_ms: number;
  generated_at: string;
  total_estimated_cost_usd: number;
  runs: RunEntry[];
}

// Exact Wilson 95% intervals (z = 1.96, 4 dp) for the oracle-perfect
// fixtures: successes = n. Pinned numerically so a silent formula change
// in the runner fails here.
const WILSON_PERFECT_CI_BY_N: Record<number, Ci95> = {
  61: { low: 0.9408, high: 1 }, // sfdc-to-ns-customers
  11: { low: 0.7412, high: 1 }, // sfdc-to-bc-customers
};

jest.setTimeout(120_000); // node spawns on /mnt/c can be slow

describe('run-ai-accuracy-benchmark --matrix (schema_version 3)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-matrix-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runBenchmark(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('node', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('matrix dry-run emits 4 distinct oracle-perfect cells with canonical headline mirror', () => {
    const jsonOut = path.join(tmpDir, 'matrix.json');
    const mdOut = path.join(tmpDir, 'matrix.md');
    const { status, stderr } = runBenchmark([
      '--dry-run', '--matrix', '--json-out', jsonOut, '--md-out', mdOut,
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const summary: SummaryV3 = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    expect(summary.schema_version).toBe(3);
    expect(summary.runs).toHaveLength(4);

    // Every cell is oracle-perfect in dry-run, with the exact Wilson CI
    // for its fixture size.
    for (const run of summary.runs) {
      expect(run.accuracy_top1).toBe(1);
      expect(run.accuracy_top1_ci95).toEqual(WILSON_PERFECT_CI_BY_N[run.fixture_mappings]);
      expect(run.hallucination_count).toBe(0);
      expect(run.run_mode).toBe('dry-run');
      expect(run.estimated_cost_usd).toBe(0);
    }

    // 4 DISTINCT (provider, pair) cells covering the full cross-product.
    const cellIds = summary.runs.map((r) => `${r.provider}::${r.pair}`);
    expect(new Set(cellIds).size).toBe(4);
    expect(cellIds.sort()).toEqual([
      'anthropic::sfdc-to-bc-customers',
      'anthropic::sfdc-to-ns-customers',
      'openai::sfdc-to-bc-customers',
      'openai::sfdc-to-ns-customers',
    ]);

    // Headline mirrors the canonical cell.
    const canonical = summary.runs.find(
      (r) => r.provider === CANONICAL_PROVIDER && r.pair === CANONICAL_PAIR,
    );
    expect(canonical).toBeDefined();
    expect(typeof summary.accuracy_top1).toBe('number');
    expect(summary.accuracy_top1).toBe(canonical!.accuracy_top1);
    expect(summary.accuracy_top1_ci95).toEqual(canonical!.accuracy_top1_ci95);
    expect(summary.provider).toBe('openai');
    expect(summary.model).toBe(canonical!.model);
    expect(summary.fixture).toBe(canonical!.fixture);
    expect(summary.fixture_mappings).toBe(canonical!.fixture_mappings);
    expect(summary.target_system).toBe('netsuite');

    // Dry-run total cost is $0 across all cells.
    expect(summary.total_estimated_cost_usd).toBe(0);

    // Markdown carries the provider x pair matrix table (incl. CI column).
    const md = fs.readFileSync(mdOut, 'utf8');
    expect(md).toContain(
      '| Provider | Model | Pair | Mappings | Top-1 accuracy | 95% CI (Wilson) | Hallucinations | Cost (USD) |',
    );
    expect(md).toContain('[94.1%, 100.0%]'); // n=61 oracle-perfect Wilson CI rendered
  });

  it('--include-provider widens the matrix to 8 cells without moving the canonical headline', () => {
    const jsonOut = path.join(tmpDir, 'matrix8.json');
    const mdOut = path.join(tmpDir, 'matrix8.md');
    const { status, stderr } = runBenchmark([
      '--dry-run', '--matrix',
      '--include-provider', 'openrouter',
      '--include-provider', 'lmstudio',
      '--json-out', jsonOut, '--md-out', mdOut,
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const summary: SummaryV3 = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    expect(summary.schema_version).toBe(3);
    expect(summary.runs).toHaveLength(8);

    const cellIds = summary.runs.map((r) => `${r.provider}::${r.pair}`);
    expect(new Set(cellIds).size).toBe(8);
    expect(cellIds.sort()).toEqual([
      'anthropic::sfdc-to-bc-customers',
      'anthropic::sfdc-to-ns-customers',
      'lmstudio::sfdc-to-bc-customers',
      'lmstudio::sfdc-to-ns-customers',
      'openai::sfdc-to-bc-customers',
      'openai::sfdc-to-ns-customers',
      'openrouter::sfdc-to-bc-customers',
      'openrouter::sfdc-to-ns-customers',
    ]);

    // Dry-run never contacts the LM Studio server: the model stays the
    // literal 'auto' sentinel. OpenRouter cells carry the pinned :free
    // default ($0 invariant).
    for (const run of summary.runs.filter((r) => r.provider === 'lmstudio')) {
      expect(run.model).toBe('auto');
      expect(run.estimated_cost_usd).toBe(0);
    }
    for (const run of summary.runs.filter((r) => r.provider === 'openrouter')) {
      expect(run.model.endsWith(':free')).toBe(true);
      expect(run.estimated_cost_usd).toBe(0);
    }

    // Opt-in cells never move the canonical headline.
    expect(summary.provider).toBe(CANONICAL_PROVIDER);
    expect(summary.fixture).toContain(CANONICAL_PAIR);
    expect(summary.total_estimated_cost_usd).toBe(0);
  });

  it('single-run dry-run emits schema_version 3 with a one-element runs[]', () => {
    const jsonOut = path.join(tmpDir, 'single.json');
    const mdOut = path.join(tmpDir, 'single.md');
    const { status, stderr } = runBenchmark([
      '--dry-run', '--json-out', jsonOut, '--md-out', mdOut,
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const summary: SummaryV3 = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    expect(summary.schema_version).toBe(3);
    expect(summary.runs).toHaveLength(1);

    // The single run mirrors the headline exactly.
    const [run] = summary.runs;
    expect(run.pair).toBe(CANONICAL_PAIR);
    expect(run.provider).toBe(summary.provider);
    expect(run.model).toBe(summary.model);
    expect(run.fixture).toBe(summary.fixture);
    expect(run.accuracy_top1).toBe(summary.accuracy_top1);
    expect(run.accuracy_top1_ci95).toEqual(summary.accuracy_top1_ci95);
    expect(run.fixture_mappings).toBe(summary.fixture_mappings);
    expect(summary.total_estimated_cost_usd).toBe(0);
  });

  it('rejects --matrix combined with an explicit cell flag', () => {
    const { status, stderr } = runBenchmark(['--dry-run', '--matrix', '--provider', 'anthropic']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--matrix is incompatible with --provider/--model/--fixture');
  });

  it('rejects --include-provider without --matrix', () => {
    const { status, stderr } = runBenchmark(['--dry-run', '--include-provider', 'lmstudio']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--include-provider requires --matrix');
  });

  it('rejects --include-provider with a base-matrix or unknown provider', () => {
    const base = runBenchmark(['--dry-run', '--matrix', '--include-provider', 'openai']);
    expect(base.status).not.toBe(0);
    expect(base.stderr).toContain('always part of the base matrix');

    const unknown = runBenchmark(['--dry-run', '--matrix', '--include-provider', 'bogus']);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain('Unknown provider "bogus"');
  });

  it('rejects a non-:free OpenRouter model override (the $0 invariant)', () => {
    const { status, stderr } = runBenchmark([
      '--dry-run', '--provider', 'openrouter', '--model', 'meta-llama/llama-3.3-70b-instruct',
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('not a ":free" variant');
  });
});
