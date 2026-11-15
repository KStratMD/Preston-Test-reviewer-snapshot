/** Pure HTTP failure classification and bounded delay policy (Workstream C). */
export type FailureClass = {
  kind: 'retryable' | 'terminal' | 'reauth';
  status?: number;
  retryAfterMs?: number;
  rejectedBeforeProcessing: boolean;
};

export const MAX_RETRY_AFTER_MS = 60_000;
export const TERMINAL_STATUSES: ReadonlySet<number> = new Set([
  400, 402, 403, 404, 405, 406, 409, 410, 411, 412, 413, 414, 415, 416,
  417, 418, 422, 423, 424, 426, 428, 431, 451,
]);
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value: unknown, now: Date): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{1,6}$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  if (!IMF_FIXDATE.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now.getTime(), 0), MAX_RETRY_AFTER_MS);
}

export function classifyHttpFailure(error: unknown, now: Date = new Date()): FailureClass {
  const candidate = error as { response?: { status?: unknown; headers?: Record<string, unknown> }; request?: unknown } | null;
  const status = typeof candidate?.response?.status === 'number' ? candidate.response.status : undefined;
  if (status === undefined) {
    const hasRequest = Boolean(candidate && typeof candidate === 'object' && 'request' in candidate && !candidate.response);
    return { kind: hasRequest ? 'retryable' : 'terminal', rejectedBeforeProcessing: false };
  }
  if (status === 401) return { kind: 'reauth', status, rejectedBeforeProcessing: false };
  if (TERMINAL_STATUSES.has(status)) return { kind: 'terminal', status, rejectedBeforeProcessing: false };
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) {
    const headers = candidate?.response?.headers;
    const retryAfterMs = parseRetryAfter(headers?.['retry-after'] ?? headers?.['Retry-After'], now);
    return {
      kind: 'retryable', status, rejectedBeforeProcessing: status === 408 || status === 425,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  return { kind: 'terminal', status, rejectedBeforeProcessing: false };
}

export function computeBackoffMs(
  attempt: number,
  options: { baseMs: number; maxMs: number; jitterMs: number; random?: () => number },
): number {
  const random = options.random ?? Math.random;
  const raw = options.baseMs * Math.pow(2, Math.max(0, attempt - 1)) + random() * options.jitterMs;
  return Math.min(Math.round(raw), options.maxMs);
}
