import { Router, type Request, type Response, type NextFunction } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as promClient from 'prom-client';
import { timingSafeCompare } from '../utils/securityHelpers';

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

/**
 * Scrape auth: tenant IDs and per-tenant AI cost appear as metric labels
 * (SyncErrorAssistMetrics), so the registry must not be world-readable in
 * production. When METRICS_SCRAPE_TOKEN is set, require it as a Bearer token
 * (Prometheus scrape_config supports `authorization: credentials`). When
 * unset: open in dev/test/HOSTED_DEMO, 403 in production (fail closed).
 */
// Mirrors env.ts's parseBooleanEnvFlag string semantics (1/true/yes/on,
// trimmed, case-insensitive) so hosted-demo detection can't diverge between
// the schema parse and this middleware.
function isTruthyEnvFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function metricsScrapeAuth(req: Request, res: Response, next: NextFunction): void {
  // The JWT bypass is scoped to the top-level /metrics mount ONLY: that
  // mount wraps this router in REQUIRED authMiddleware (ENABLE_METRICS=true,
  // RouteSetup), so req.user there means an ops caller on the deliberate
  // JWT-authed surface. On /api/metrics the global /api
  // optionalAuthMiddleware ALSO populates req.user for any valid tenant JWT
  // — a plain tenant credential must NOT bypass the scrape token, or any
  // tenant could read cross-tenant metric labels.
  if (req.user && req.baseUrl === '/metrics') { next(); return; }
  // Trim once and compare timing-safe (same posture as the API-key check in
  // middleware/security.ts) so incidental env-var whitespace can't lock out
  // legitimate scrapes and equality checks don't leak timing.
  const token = (process.env.METRICS_SCRAPE_TOKEN ?? '').trim();
  if (token.length > 0) {
    // RFC 7235: the auth scheme is case-insensitive; tolerate incidental
    // whitespace around the credentials.
    const header = req.headers.authorization ?? '';
    const match = /^\s*Bearer\s+(.*?)\s*$/i.exec(header);
    const provided = match ? match[1] : '';
    if (provided.length > 0 && timingSafeCompare(provided, token)) { next(); return; }
    // Plain text, not JSON — the Prometheus path never returns JSON (see
    // metricsReview.integration.test.ts header contract).
    res.status(403).type('text/plain').send('invalid metrics scrape token');
    return;
  }
  // Same fail-closed posture as src/config/env.ts: only an EXPLICIT
  // development/test NODE_ENV is non-prod; unset or prod-like values
  // ('staging', '') get the 403 when no token is configured.
  const explicitlyNonProd = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const isProdLike = !explicitlyNonProd && !isTruthyEnvFlag(process.env.HOSTED_DEMO);
  if (isProdLike) {
    res.status(403).type('text/plain').send('metrics scraping requires METRICS_SCRAPE_TOKEN in production');
    return;
  }
  next();
}

export const createMetricsRouter = (): Router => {
  const router = Router();

  router.get('/', metricsScrapeAuth, async (_req, res) => {
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
