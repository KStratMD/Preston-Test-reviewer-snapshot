import { classifyHttpFailure, computeBackoffMs, MAX_RETRY_AFTER_MS, parseRetryAfter, TERMINAL_STATUSES } from '../../../../src/core/http/RetryPolicy';

const now = new Date('2026-09-02T00:00:00Z');
const response = (status: number, headers: Record<string, unknown> = {}) => ({ response: { status, headers } });

describe('HTTP failure policy', () => {
  it.each([408, 425, 429, 500, 502, 503, 504, 599])('classifies %i as retryable', status => {
    expect(classifyHttpFailure(response(status), now)).toEqual({ kind: 'retryable', status, rejectedBeforeProcessing: status === 408 || status === 425 });
  });

  it('keeps terminal client statuses and unknown failures terminal', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(classifyHttpFailure(response(status), now)).toEqual({ kind: 'terminal', status, rejectedBeforeProcessing: false });
    }
    expect(TERMINAL_STATUSES.has(404)).toBe(true);
    for (const error of [null, undefined, 'failure', new Error('setup'), {}, response(200), response(600)]) {
      expect(classifyHttpFailure(error, now).kind).toBe('terminal');
    }
  });

  it('routes 401 to reauthentication without proof of non-processing', () => {
    expect(classifyHttpFailure(response(401), now)).toEqual({ kind: 'reauth', status: 401, rejectedBeforeProcessing: false });
  });

  it('treats a request without a response as ambiguous and retryable', () => {
    expect(classifyHttpFailure({ request: {} }, now)).toEqual({ kind: 'retryable', rejectedBeforeProcessing: false });
    expect(classifyHttpFailure({ request: {}, response: {} }, now).kind).toBe('terminal');
  });

  it.each(['retry-after', 'Retry-After'])('reads %s on a retryable response', header => {
    expect(classifyHttpFailure(response(429, { [header]: '2' }), now)).toEqual({ kind: 'retryable', status: 429, rejectedBeforeProcessing: false, retryAfterMs: 2000 });
    expect(classifyHttpFailure(response(429, { [header]: 'soon' }), now)).not.toHaveProperty('retryAfterMs');
  });
});

describe('strict Retry-After parsing', () => {
  it.each([['0', 0], [' 2 ', 2000], ['000003', 3000], ['999999', MAX_RETRY_AFTER_MS], ['Wed, 02 Sep 2026 00:00:05 GMT', 5000], ['Tue, 01 Sep 2026 00:00:00 GMT', 0], ['Thu, 03 Sep 2026 00:00:00 GMT', MAX_RETRY_AFTER_MS]])('parses %s', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  it.each([undefined, null, 2, {}, '', '-5', '1e3', '+2', '1.5', '1000000', 'soon', 'Wed, 02 Sep 2026 00:00:05', '2026-09-02T00:00:05Z', 'Wed, 32 Sep 2026 00:00:05 GMT'])('rejects malformed value %p', value => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe('bounded exponential backoff', () => {
  it('adds jitter and clamps the final delay', () => {
    const options = { baseMs: 1000, maxMs: 10000, jitterMs: 1000, random: () => 0.5 };
    expect(computeBackoffMs(1, options)).toBe(1500);
    expect(computeBackoffMs(2, options)).toBe(2500);
    expect(computeBackoffMs(9, options)).toBe(10000);
    expect(computeBackoffMs(0, options)).toBe(1500);
  });
});
