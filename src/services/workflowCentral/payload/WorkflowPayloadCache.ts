import { injectable, unmanaged } from 'inversify';
import { createHash } from 'node:crypto';
import type { WorkflowExternalRecordReference } from './WorkflowPayload';

/**
 * Short-TTL in-process cache for resolved WorkflowPayload references (Phase 1 T5).
 *
 * Purpose: prevent N+1 ERP calls when an operator render burst hits the same
 * task multiple times within seconds (browser focus, parallel tabs, dashboard
 * refresh). Default TTL is 30s — short enough that operator-visible staleness
 * is bounded; long enough to coalesce burst reads.
 *
 * Scope intentionally NOT cached:
 *   - failed outcomes (no negative caching — let the retry hit the connector)
 *   - cross-tenant lookups (per-tenant key prefix enforces isolation)
 *
 * Out of scope for Phase 1: Redis, distributed coherence. If operator render
 * latency proves unacceptable in production (Open Question Q1), Phase 1's
 * decision point routes to a Redis layer or revisits Phase 2 timing.
 */

export interface CachedResolution {
  readonly fields: Record<string, unknown>;
  readonly resolvedAt: string;
  /**
   * Deterministic fingerprint of the posture this entry was computed under
   * (Copilot R5 — defense against posture drift within the 30s cache TTL).
   * `get()` invalidates on fingerprint mismatch so any change to
   * `allowPII`/`blockOnDetection`/`autoRedact`/`piiTypes` immediately
   * evicts entries computed under the old policy. Optional for backward
   * compatibility with pre-C3.1c entries (treated as legacy → never match).
   */
  readonly postureFingerprint?: string;
}

interface CacheEntry {
  readonly value: CachedResolution;
  readonly expiresAt: number;
}

export interface WorkflowPayloadCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 10_000;

@injectable()
export class WorkflowPayloadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  // @unmanaged() per feedback_inversify_v6_unmanaged_options — Inversify v6
  // tries to resolve plain object-typed constructor params as bindings even
  // when they have default values; the @unmanaged decorator tells the
  // planner to skip injection for this parameter and rely on the call-site
  // default.
  constructor(@unmanaged() options: WorkflowPayloadCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? parseEnvInt('WORKFLOW_PAYLOAD_CACHE_TTL_MS', DEFAULT_TTL_MS);
    this.maxEntries = options.maxEntries ?? parseEnvInt('WORKFLOW_PAYLOAD_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES);
  }

  /**
   * @param expectedPostureFingerprint  When provided, the cached entry is
   *   only returned if its `postureFingerprint` matches. A mismatch evicts
   *   the entry (it was computed under different posture and may surface
   *   PII the current posture no longer permits — Copilot R5). Pass
   *   `undefined` to opt into legacy non-posture-aware behavior (test
   *   fixtures, migration period).
   */
  get(
    tenantId: string,
    ref: WorkflowExternalRecordReference,
    expectedPostureFingerprint?: string,
  ): CachedResolution | undefined {
    const key = this.keyFor(tenantId, ref);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    if (
      expectedPostureFingerprint !== undefined
      && entry.value.postureFingerprint !== expectedPostureFingerprint
    ) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(tenantId: string, ref: WorkflowExternalRecordReference, value: CachedResolution): void {
    const key = this.keyFor(tenantId, ref);
    // FIFO eviction when adding a NEW entry would breach the bound. Re-setting
    // an existing key is a refresh, not a growth event.
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(tenantId: string): number {
    const prefix = `${tenantId}:`;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private keyFor(tenantId: string, ref: WorkflowExternalRecordReference): string {
    const fields = ref.fieldsOfInterest && ref.fieldsOfInterest.length > 0
      ? [...ref.fieldsOfInterest].sort().join(',')
      : '';
    const fieldsHash = createHash('sha256').update(fields).digest('hex').slice(0, 16);
    return `${tenantId}:${ref.system}:${ref.recordType}:${ref.recordId}:${fieldsHash}`;
  }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
