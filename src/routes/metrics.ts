import { Router } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as promClient from 'prom-client';

/**
 * Prometheus metrics endpoint for Squire/SuiteCentral integrations.
 *
 * Exposes the following counters:
 * - `squire_suitecentral_sync_runs_total`: number of sync attempts
 * - `squire_suitecentral_sync_errors_total`: number of failed sync attempts
 */
export const syncRunsCounter = new promClient.Counter({
  name: 'squire_suitecentral_sync_runs_total',
  help: 'Total number of Squire/SuiteCentral sync runs',
});

export const syncErrorsCounter = new promClient.Counter({
  name: 'squire_suitecentral_sync_errors_total',
  help: 'Total number of errors during Squire/SuiteCentral sync runs',
});

// Expose default metrics as well - only initialize once globally, and allow disabling in tests
declare global {
  var __promDefaultMetricsInitialized: boolean | undefined;
  var __promDefaultMetricsStopper: (() => void) | undefined;
}

if (!global.__promDefaultMetricsInitialized) {
  if (process.env.PROM_DISABLE_DEFAULT_METRICS !== '1') {
    const stop = (promClient as any).collectDefaultMetrics?.();
    // prom-client v15 returns a stopper function; store it for cleanup
    if (typeof stop === 'function') {
      global.__promDefaultMetricsStopper = stop as () => void;
    }
  }
  global.__promDefaultMetricsInitialized = true;
}

// ---------------------------------------------------------------------------
// /review JSON sub-route — Phase 7 reviewer-evidence payload.
// Separate handler from the Prometheus text route at /. Reads metrics.json
// from disk, augments with proof-card index + build sha, caches the file-I/O
// portion for 60s.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const METRICS_JSON_PATH = path.join(REPO_ROOT, 'metrics.json');
const PROOF_CARDS_DIR = path.join(REPO_ROOT, 'docs/review/proof-cards');
const REVIEW_CACHE_TTL_MS = 60_000;

type ProofCardEntry = {
  component: string;
  card_path: string;
  status: string;
};

type CachedParts = {
  metrics: unknown;
  metrics_error: string | null;
  proof_cards: ProofCardEntry[];
  loaded_at: string;
};

let reviewCache: { parts: CachedParts; expiresAt: number } | null = null;
// In-flight load promise to coalesce concurrent refreshes. Without this, a
// burst of requests arriving after cache expiry each triggers their own disk
// read + proof-card scan; with it, only one refresh runs per TTL boundary.
let inflightLoad: Promise<CachedParts> | null = null;

function pickGitSha(metrics: unknown): string | null {
  if (metrics && typeof metrics === 'object' && 'git_sha' in metrics) {
    const value = (metrics as { git_sha: unknown }).git_sha;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

async function buildProofCardIndex(): Promise<ProofCardEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROOF_CARDS_DIR);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith('.md') && f !== '_template.md').sort();
  const cards: ProofCardEntry[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(PROOF_CARDS_DIR, file), 'utf-8');
    } catch {
      continue;
    }
    const headingMatch = /^# Proof Card:\s*(.+?)\s*$/m.exec(content);
    const statusMatch = /^\*\*Status:\*\*\s*([a-z_]+)/m.exec(content);
    cards.push({
      component: headingMatch ? headingMatch[1] : file.replace(/\.md$/, ''),
      card_path: `docs/review/proof-cards/${file}`,
      status: statusMatch ? statusMatch[1] : 'unknown',
    });
  }
  return cards;
}

async function loadReviewParts(): Promise<CachedParts> {
  let metrics: unknown = null;
  let metrics_error: string | null = null;
  try {
    const raw = await fs.readFile(METRICS_JSON_PATH, 'utf-8');
    metrics = JSON.parse(raw);
  } catch (err) {
    metrics_error = err instanceof Error ? err.message : String(err);
  }
  const proof_cards = await buildProofCardIndex();
  return {
    metrics,
    metrics_error,
    proof_cards,
    loaded_at: new Date().toISOString(),
  };
}

async function getCachedReviewParts(): Promise<CachedParts> {
  const now = Date.now();
  if (reviewCache && reviewCache.expiresAt > now) {
    return reviewCache.parts;
  }
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      const parts = await loadReviewParts();
      reviewCache = { parts, expiresAt: Date.now() + REVIEW_CACHE_TTL_MS };
      return parts;
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

// Test hook: allow integration tests to clear cache + in-flight state between
// cases. Exported (not private) because the unit and integration test files
// import it by name; the `__` prefix and `ForTests` suffix mark this as a
// test-only API contract.
export function __resetMetricsReviewCacheForTests(): void {
  reviewCache = null;
  inflightLoad = null;
}

export const createMetricsRouter = (): Router => {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });

  router.get('/review', async (_req, res) => {
    const parts = await getCachedReviewParts();
    const envSha = process.env.BUILD_SHA?.trim();
    const build_sha = (envSha && envSha.length > 0) ? envSha
      : (pickGitSha(parts.metrics) ?? 'unknown');
    const payload = {
      schema_version: 1 as const,
      served_at: new Date().toISOString(),
      payload_loaded_at: parts.loaded_at,
      build_sha,
      metrics: parts.metrics,
      metrics_error: parts.metrics_error,
      proof_cards: parts.proof_cards,
      dlp_patterns_endpoint: '/api/compliance/dlp-patterns',
      link_to_evidence: 'EVALUATION.md',
    };
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(payload, null, 2));
  });

  return router;
};
