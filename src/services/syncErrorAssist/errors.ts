/**
 * SyncErrorAssistTimeoutError is thrown by withTimeout() when an awaited
 * Promise exceeds the budget. classify() instanceof-checks this class
 * to map timeouts to failed_retryable (until attempts >= 3).
 */
export class SyncErrorAssistTimeoutError extends Error {
  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`${operation} exceeded ${timeoutMs}ms`);
    this.name = 'SyncErrorAssistTimeoutError';
    Object.setPrototypeOf(this, SyncErrorAssistTimeoutError.prototype);
  }
}

/**
 * Race a promise against a timeout. Throws SyncErrorAssistTimeoutError if
 * the promise doesn't settle in `timeoutMs`. The inner promise is left to
 * settle on its own (we don't AbortController-cancel the underlying op
 * because not every caller passes an AbortSignal). Use cases:
 *  - AI provider chat() calls (5 min budget)
 *  - NetSuite ns.create() calls (5 min budget)
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SyncErrorAssistTimeoutError(operation, timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
