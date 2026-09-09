/**
 * Unit proof for the first-navigation diagnostic helper (issue #1187).
 *
 * The helper exists because a `page.goto` timeout tells you the navigation ran
 * out of budget and nothing about WHICH resource never arrived. Issue #1187's
 * failure moves between the two smoke specs according to which one navigates
 * first, and a 20-second budget has already failed, so widening the budget is
 * not a diagnosis. These tests pin the contract that makes the helper safe to
 * run in CI output: it never emits a raw pathname, query string, credential,
 * or raw failure text, it is bounded, and its entry SELECTION and ORDERING are
 * deterministic. The digest bytes are not - they are salted per navigation on
 * purpose - so cross-run comparisons here normalize them rather than pinning
 * literal values.
 *
 * A browser is deliberately not involved. The helper takes the two structural
 * surfaces it actually uses — a Page that emits `request`/`requestfinished`/
 * `requestfailed`, and a Request that answers `method`/`resourceType`/`url`/
 * `failure` — so every branch here is reachable without Playwright.
 */
import {
  withNavigationDiagnostics,
  NAV_DIAGNOSTICS_MARKER,
  MAX_TRACKED_ENTRIES,
  type NavigationDiagnosticsPage,
  type NavigationDiagnosticsRequest,
} from '../../e2e/helpers/navigationDiagnostics';

type Listener = (request: NavigationDiagnosticsRequest) => void;
type EventName = 'request' | 'requestfinished' | 'requestfailed';

/**
 * Minimal event surface. `listenerCount` is the whole point of the fake: the
 * detach-in-finally requirement is only provable by observing that the counts
 * return to zero, which the real Page will not tell us.
 */
class FakePage implements NavigationDiagnosticsPage {
  private readonly listeners = new Map<EventName, Listener[]>();

  on(event: EventName, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  off(event: EventName, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    const index = existing.indexOf(listener);
    if (index >= 0) existing.splice(index, 1);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: EventName, request: NavigationDiagnosticsRequest): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(request);
  }

  /**
   * Total across all events, or one event's count when named.
   *
   * The event parameter exists because it was MISSING and a test called
   * `listenerCount('requestfinished')` anyway: the argument was silently
   * ignored, the total came back, and the assertion failed for a reason
   * unrelated to what it claimed to check. An ignored argument is worse than a
   * missing method - it reads as a per-event assertion and is not one.
   */
  listenerCount(event?: EventName): number {
    if (event !== undefined) return (this.listeners.get(event) ?? []).length;
    let total = 0;
    for (const listeners of this.listeners.values()) total += listeners.length;
    return total;
  }
}

function makeRequest(options: {
  url: string;
  method?: string;
  resourceType?: string;
  errorText?: string;
}): NavigationDiagnosticsRequest {
  return {
    url: () => options.url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'document',
    failure: () => (options.errorText === undefined ? null : { errorText: options.errorText }),
  };
}

/**
 * The digest is an HMAC under a per-navigation salt, so a test cannot
 * precompute it — which is the point. These read it back out of the rendered
 * block instead, and assert the properties that actually matter: shape,
 * within-run stability, and that no input text survives.
 */
const PATH_DIGEST = /path-hmac:[0-9a-f]{12}/g;

function digestsIn(message: string): string[] {
  return message.match(PATH_DIGEST) ?? [];
}

/**
 * Renders comparable across separate invocations. Two runs cannot be compared
 * byte-for-byte any more - the salt is per navigation by design - so the
 * digests are normalized away and what remains is exactly what these tests are
 * about: which entries appear and in what order.
 */
function withoutDigests(message: string): string {
  return message.replace(PATH_DIGEST, 'path-hmac:<salted>');
}

/**
 * The navigation target for these tests. Requests to this origin classify as
 * `self`, any other parseable origin becomes a salted `external-hmac:` digest,
 * and a URL that cannot be read or parsed becomes the literal `unparseable-url`.
 * Three values, matching the helper's contract - this comment previously named
 * only two and was corrected in review.
 */
const NAV_URL = 'http://127.0.0.1:3000/';

/** Drives the helper to failure and returns the message the call site would see. */
async function failWith(
  page: FakePage,
  during: () => void,
  error: unknown = new Error('page.goto: Timeout 20000ms exceeded'),
): Promise<string> {
  try {
    await withNavigationDiagnostics(page, NAV_URL, async () => {
      during();
      throw error;
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the navigation to reject');
}

describe('withNavigationDiagnostics', () => {
  describe('successful navigation', () => {
    it('returns the navigation result untouched and emits nothing', async () => {
      const page = new FakePage();
      const response = { ok: () => true };
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const result = await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: 'http://127.0.0.1:3000/' }));
          page.emit('requestfinished', makeRequest({ url: 'http://127.0.0.1:3000/' }));
          return response;
        });

        expect(result).toBe(response);
        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('attaches listeners for the navigation and detaches every one after', async () => {
      const page = new FakePage();
      let duringNavigation = -1;

      await withNavigationDiagnostics(page, NAV_URL, async () => {
        duringNavigation = page.listenerCount();
        return 'ok';
      });

      // Both halves matter. Asserting only the zero at the end would be
      // satisfied by a helper that never registered a listener at all - a
      // no-op pass-through would pass that test, which makes it no test.
      expect(duringNavigation).toBeGreaterThan(0);
      expect(page.listenerCount()).toBe(0);
    });
  });

  describe('failed navigation', () => {
    it('preserves the original failure message so call-site classification still works', async () => {
      const page = new FakePage();
      const original = new Error(
        'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/',
      );
      let thrown: unknown;

      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          throw original;
        });
      } catch (err) {
        thrown = err;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      // Both smoke specs classify skips by regex over this message. If the
      // helper replaced or reformatted it, a "server not listening" run would
      // start failing instead of skipping.
      expect(message).toContain('page.goto: net::ERR_CONNECTION_REFUSED');
      expect(/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(message)).toBe(true);
      expect(thrown instanceof Error && thrown.name).toBe('Error');
      expect(message).toContain(NAV_DIAGNOSTICS_MARKER);
    });

    it('attaches listeners for the navigation and detaches every one after', async () => {
      const page = new FakePage();
      let duringNavigation = -1;

      await expect(
        withNavigationDiagnostics(page, NAV_URL, async () => {
          duringNavigation = page.listenerCount();
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(duringNavigation).toBeGreaterThan(0);
      expect(page.listenerCount()).toBe(0);
    });

    it('appends the block once even when the stack cannot be written', async () => {
      // The fallback path used to re-read error.message AFTER the successful
      // message mutation, so an error whose stack rejects assignment got the
      // block twice: message is annotated, the stack write throws, and the
      // catch rebuilds from the already-annotated message. A throwing setter
      // is used rather than writable:false because a non-writable property
      // fails SILENTLY outside strict mode, which would make this pass for the
      // wrong reason.
      const page = new FakePage();
      const original = new Error('page.goto: Timeout 20000ms exceeded');
      Object.defineProperty(original, 'stack', {
        get: () => 'Error: page.goto: Timeout 20000ms exceeded',
        set: () => {
          throw new TypeError('stack is read-only');
        },
        configurable: true,
      });

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: `${NAV_URL}x.js`, resourceType: 'script' }));
          throw original;
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      const header = `${NAV_DIAGNOSTICS_MARKER} pending=`;
      const occurrences = error.message.split(header).length - 1;
      expect(occurrences).toBe(1);
      expect(error.message).toContain('page.goto: Timeout 20000ms exceeded');
      expect(error.name).toBe('Error');
    });

    it('preserves name and stack on the fallback path, not just the message', async () => {
      // The fallback rebuilds the error, so every field it claims to preserve
      // needs asserting. The earlier test checked the message and the DEFAULT
      // name, which a fallback that silently dropped `name` would also pass.
      const page = new FakePage();
      const original = new Error('page.goto: Timeout 20000ms exceeded');
      original.name = 'TimeoutError';
      Object.defineProperty(original, 'stack', {
        get: () => 'TimeoutError: page.goto: Timeout 20000ms exceeded\n    at nav',
        set: () => {
          throw new TypeError('stack is read-only');
        },
        configurable: true,
      });

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          throw original;
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      expect(error.name).toBe('TimeoutError');
      expect(error.stack).toContain('    at nav');
      expect(error.stack).toContain(NAV_DIAGNOSTICS_MARKER);
      expect((error as { cause?: unknown }).cause).toBe(original);
    });

    it('continues detaching after one off() throws', async () => {
      // Guarding each off() independently is only meaningful if the loop keeps
      // going. Guarding the whole loop in a single try would abandon the
      // remaining listeners on the first throw, which leaks exactly what the
      // guard exists to clean up.
      const page = new FakePage();
      const realOff = page.off.bind(page);
      let offCalls = 0;
      page.off = (event: never, listener: never) => {
        offCalls += 1;
        if (offCalls === 1) throw new TypeError('first off is hostile');
        return realOff(event, listener);
      };

      await expect(
        withNavigationDiagnostics(page, NAV_URL, async () => {
          throw new Error('page.goto: Timeout 20000ms exceeded');
        }),
      ).rejects.toThrow('page.goto: Timeout 20000ms exceeded');

      // All three were attempted despite the first throwing, the two that
      // could be removed were, and exactly one leaked - the one whose own
      // off() threw. That single leak is the accepted cost of never letting
      // cleanup mask the navigation error.
      expect(offCalls).toBe(3);
      expect(page.listenerCount('request')).toBe(1);
      expect(page.listenerCount('requestfinished')).toBe(0);
      expect(page.listenerCount('requestfailed')).toBe(0);
      expect(page.listenerCount()).toBe(1);
    });

    it('preserves a synchronous throw from navigate()', async () => {
      // navigate() is invoked inside the try, so a synchronous throw takes the
      // same annotate-and-rethrow path as a rejected promise. Nothing pinned
      // that, and the two paths are easy to diverge.
      const page = new FakePage();
      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, () => {
          page.emit('request', makeRequest({ url: `${NAV_URL}x.js`, resourceType: 'script' }));
          throw new Error('page.goto: synchronous boom');
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      expect(error.message).toContain('page.goto: synchronous boom');
      expect(error.message).toContain(NAV_DIAGNOSTICS_MARKER);
      expect(error.message).toContain('pending=1');
      expect(page.listenerCount('request')).toBe(0);
    });

    it('does not let a throwing page.off replace the navigation error', async () => {
      // The helper's one hard guarantee is that the caller sees the
      // navigation's own error. Detach ran unguarded in `finally`, so a page
      // whose `off()` throws had the CLEANUP error replace the navigation
      // error - the exact substitution this helper exists to prevent.
      const page = new FakePage();
      page.off = () => {
        throw new TypeError('off is hostile');
      };

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: `${NAV_URL}x.js`, resourceType: 'script' }));
          throw new Error('page.goto: Timeout 20000ms exceeded');
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      expect(error.message).toContain('page.goto: Timeout 20000ms exceeded');
      expect(error.message).toContain(NAV_DIAGNOSTICS_MARKER);
      expect(error.message).not.toContain('off is hostile');
    });

    it('surfaces a throwing page.on without leaking listeners', async () => {
      // Registration sat outside the try, so a page whose `on()` throws part
      // way through both leaked the listeners already added and surfaced the
      // registration error instead of the navigation error.
      const page = new FakePage();
      const realOn = page.on.bind(page);
      let calls = 0;
      page.on = (event: never, listener: never) => {
        calls += 1;
        if (calls === 2) throw new TypeError('on is hostile');
        return realOn(event, listener);
      };

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          throw new Error('page.goto: Timeout 20000ms exceeded');
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      // The registration error is what surfaces here - it happens before the
      // navigation runs - but it must NOT be masked and the helper must not
      // hang or leak. What matters is that the caller still sees a real error
      // and cleanup ran.
      expect(error).toBeInstanceOf(Error);
      expect(page.listenerCount('request')).toBe(0);
    });

    it('survives an Error whose message getter throws, keeping the other fields', async () => {
      // The snapshot reads are property accesses on a value this helper did not
      // create. Unguarded, one throwing getter killed annotation before the
      // block was ever attached. Guarded together, one hostile getter would
      // still discard the other two readable fields - so each is independent.
      const page = new FakePage();
      const original = new Error('placeholder');
      original.name = 'HostileError';
      Object.defineProperty(original, 'message', {
        get: () => {
          throw new TypeError('message is hostile');
        },
        configurable: true,
      });

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: `${NAV_URL}x.js`, resourceType: 'script' }));
          throw original;
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      // The diagnosis survives, the hostile getter's own error does not leak,
      // and the readable field (name) is still preserved.
      expect(error.message).toContain(NAV_DIAGNOSTICS_MARKER);
      expect(error.message).toContain('pending=1');
      expect(error.message).not.toContain('message is hostile');
      expect(error.name).toBe('HostileError');
    });

    it('survives a thrown non-Error whose toString throws', async () => {
      // The one annotation path that still had an unguarded String(): a thrown
      // value that refuses coercion would take the annotation down with it,
      // losing the diagnostic block AND the original value.
      const page = new FakePage();
      const hostile = {
        toString(): string {
          throw new Error('coercion exploded');
        },
      };

      let thrown: unknown;
      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: `${NAV_URL}x.js`, resourceType: 'script' }));
          throw hostile;
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      expect(error.message).not.toContain('coercion exploded');
      expect(error.message).toContain(NAV_DIAGNOSTICS_MARKER);
      expect(error.message).toContain('pending=1');
      // The original is never lost, even when it cannot be described.
      expect((error as { cause?: unknown }).cause).toBe(hostile);
    });

    it('attaches the diagnostic block exactly once to both message and stack', async () => {
      // V8 materializes `stack` lazily from the message. Appending to the
      // message first and only then reading the stack produced a stack that
      // already contained the block, so appending again printed it twice in
      // CI output.
      const page = new FakePage();
      const header = `${NAV_DIAGNOSTICS_MARKER} pending=`;
      const occurrences = (haystack: string): number =>
        haystack.split(header).length - 1;
      let thrown: unknown;

      try {
        await withNavigationDiagnostics(page, NAV_URL, async () => {
          page.emit('request', makeRequest({ url: 'http://127.0.0.1:3000/' }));
          throw new Error('page.goto: Timeout 20000ms exceeded');
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as Error;
      expect(occurrences(error.message)).toBe(1);
      expect(typeof error.stack).toBe('string');
      expect(occurrences(error.stack as string)).toBe(1);
    });

    it('keeps requests that never finished visible as pending', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({ url: 'http://127.0.0.1:3000/', resourceType: 'document' }),
        );
      });

      expect(message).toContain(`${NAV_DIAGNOSTICS_MARKER} pending=1`);
      expect(message).toMatch(/pending GET document self path-hmac:[0-9a-f]{12}/);
    });

    it('drops requests that finished and keeps requests that failed', async () => {
      const page = new FakePage();
      const finished = makeRequest({ url: 'http://127.0.0.1:3000/finished.js' });
      const failed = makeRequest({
        url: 'http://127.0.0.1:3000/failed.js',
        resourceType: 'script',
        errorText: 'net::ERR_CONNECTION_RESET',
      });

      const message = await failWith(page, () => {
        page.emit('request', finished);
        page.emit('request', failed);
        page.emit('requestfinished', finished);
        page.emit('requestfailed', failed);
      });

      expect(message).toContain(`${NAV_DIAGNOSTICS_MARKER} pending=0`);
      expect(message).toContain('failed=1');
      expect(message).toMatch(/failed GET script self path-hmac:[0-9a-f]{12} CONNECTION_RESET/);
      // Exactly one entry survived, so exactly one digest is printed: the
      // finished request left no trace.
      expect(digestsIn(message)).toHaveLength(1);
    });

    it('maps browser failure text to an allowlisted class and never quotes it', async () => {
      const cases: Array<[string, string]> = [
        ['net::ERR_CONNECTION_REFUSED', 'CONNECTION_REFUSED'],
        ['net::ERR_CONNECTION_RESET', 'CONNECTION_RESET'],
        ['net::ERR_SOCKET_NOT_CONNECTED', 'CONNECTION_RESET'],
        ['net::ERR_TIMED_OUT', 'TIMED_OUT'],
        ['net::ERR_ABORTED', 'ABORTED'],
        ['net::ERR_CERT_AUTHORITY_INVALID', 'OTHER'],
      ];

      for (const [errorText, expectedClass] of cases) {
        const page = new FakePage();
        const message = await failWith(page, () => {
          const request = makeRequest({ url: 'http://127.0.0.1:3000/a.js', errorText });
          page.emit('request', request);
          page.emit('requestfailed', request);
        });
        expect(message).toContain(expectedClass);
        expect(message).not.toContain(errorText);
      }
    });

    it('survives a failure whose error text refuses to be a string', async () => {
      // Playwright types errorText as a string, so this is defensive rather
      // than reachable today. It is tested because the cost of being wrong is
      // severe and silent: an exception thrown inside the `requestfailed`
      // listener REPLACES the navigation error this helper exists to preserve,
      // and the coercion error would then be what CI prints.
      const hostile = {
        toString(): string {
          throw new Error('coercion exploded');
        },
      };
      const request: NavigationDiagnosticsRequest = {
        url: () => 'http://127.0.0.1:3000/a.js',
        method: () => 'GET',
        resourceType: () => 'script',
        failure: () => ({ errorText: hostile as unknown as string }),
      };

      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit('request', request);
        page.emit('requestfailed', request);
      });

      expect(message).toContain('page.goto: Timeout 20000ms exceeded');
      expect(message).not.toContain('coercion exploded');
      expect(message).toContain('failed=1');
      expect(message).toContain('OTHER');
    });

    it('classifies a request whose failure text is unavailable', async () => {
      const page = new FakePage();
      const request = makeRequest({ url: 'http://127.0.0.1:3000/a.js' });
      const message = await failWith(page, () => {
        page.emit('request', request);
        page.emit('requestfailed', request);
      });
      expect(message).toContain('failed=1');
      expect(message).toContain('OTHER');
    });
  });

  describe('bounded output', () => {
    it('caps pending entries and reports how many were omitted', async () => {
      const page = new FakePage();
      const overflow = 4;
      const message = await failWith(page, () => {
        for (let i = 0; i < MAX_TRACKED_ENTRIES + overflow; i += 1) {
          page.emit(
            'request',
            makeRequest({ url: `http://127.0.0.1:3000/pending-${i}.js`, resourceType: 'script' }),
          );
        }
      });

      expect(message).toContain(
        `${NAV_DIAGNOSTICS_MARKER} pending=${MAX_TRACKED_ENTRIES} (omitted=${overflow})`,
      );
      const pendingLines = message
        .split('\n')
        .filter((line) => line.includes(' pending GET '));
      expect(pendingLines).toHaveLength(MAX_TRACKED_ENTRIES);
    });

    it('caps failed entries and reports how many were omitted', async () => {
      const page = new FakePage();
      const overflow = 3;
      const message = await failWith(page, () => {
        for (let i = 0; i < MAX_TRACKED_ENTRIES + overflow; i += 1) {
          const request = makeRequest({
            url: `http://127.0.0.1:3000/failed-${i}.js`,
            resourceType: 'script',
            errorText: 'net::ERR_CONNECTION_REFUSED',
          });
          page.emit('request', request);
          page.emit('requestfailed', request);
        }
      });

      expect(message).toContain(`failed=${MAX_TRACKED_ENTRIES} (omitted=${overflow})`);
      const failedLines = message.split('\n').filter((line) => line.includes(' failed GET '));
      expect(failedLines).toHaveLength(MAX_TRACKED_ENTRIES);
    });

    it('orders entries deterministically regardless of arrival order', async () => {
      const urls = [
        'http://127.0.0.1:3000/z.js',
        'http://127.0.0.1:3000/a.css',
        'http://127.0.0.1:3000/m.png',
      ];
      const types = ['script', 'stylesheet', 'image'];

      const render = async (order: number[]): Promise<string> => {
        const page = new FakePage();
        return failWith(page, () => {
          for (const index of order) {
            page.emit(
              'request',
              makeRequest({ url: urls[index], resourceType: types[index] }),
            );
          }
        });
      };

      const forward = withoutDigests(await render([0, 1, 2]));
      const reverse = withoutDigests(await render([2, 1, 0]));
      const shuffled = withoutDigests(await render([1, 2, 0]));

      expect(forward).toBe(reverse);
      expect(forward).toBe(shuffled);
    });

    it('selects the same top-K across runs when entries differ only by path', async () => {
      // The gap that let a real bug through, and the reason it was invisible:
      // every other ordering test used entries differing in resourceType or
      // origin, both of which the comparator reaches BEFORE the path. Nothing
      // exercised ordering BY PATH - which is where a salted sort key made the
      // order random per navigation, and so made keepTopK print a different
      // subset each run.
      //
      // Same origin, method and resourceType means the only emitted difference
      // is the digest, and digests are normalized - so the selected SET has to
      // be made observable some other way. failureClass is emitted and sorts
      // AFTER the path, so it reveals which entries survived without
      // influencing which ones do. Correct behaviour: the 25 smallest paths are
      // p-000..p-024, all REFUSED. Under a salted sort key the surviving 25 are
      // a random mix and RESET leaks in.
      const total = 60;
      const render = async (): Promise<string> => {
        const page = new FakePage();
        return failWith(page, () => {
          for (let i = total - 1; i >= 0; i -= 1) {
            const request = makeRequest({
              url: `http://127.0.0.1:3000/p-${String(i).padStart(3, '0')}.js`,
              resourceType: 'script',
              errorText: i < 30 ? 'net::ERR_CONNECTION_REFUSED' : 'net::ERR_CONNECTION_RESET',
            });
            page.emit('request', request);
            page.emit('requestfailed', request);
          }
        });
      };

      for (let run = 0; run < 6; run += 1) {
        const message = await render();
        expect(message).toContain(
          `failed=${MAX_TRACKED_ENTRIES} (omitted=${total - MAX_TRACKED_ENTRIES})`,
        );
        const refused = (message.match(/CONNECTION_REFUSED/g) ?? []).length;
        const reset = (message.match(/CONNECTION_RESET/g) ?? []).length;
        expect(refused).toBe(MAX_TRACKED_ENTRIES);
        expect(reset).toBe(0);
      }
    });

    it('keeps valid entries when malformed ones outnumber the cap, across method and type', async () => {
      // Two defects, one test. First: unparseable entries had EMPTY sort keys,
      // and empty sorts first, so they took the whole top-K. A high sentinel on
      // the origin/path keys was NOT enough either, because the comparator
      // reaches method and resourceType first - thirty malformed GET/script
      // entries still outranked valid POST/xhr ones. Parseability is now the
      // FIRST key, the only arrangement that holds whatever the other fields
      // are. The earlier regression test used matching methods and types, which
      // is exactly why it missed the second defect.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (let i = 0; i < 30; i += 1) {
          const request = makeRequest({
            url: `not a url ${i}`,
            method: 'GET',
            resourceType: 'script',
            errorText: 'net::ERR_CONNECTION_REFUSED',
          });
          page.emit('request', request);
          page.emit('requestfailed', request);
        }
        for (let i = 0; i < 5; i += 1) {
          const request = makeRequest({
            url: `${NAV_URL}keep-${i}.js`,
            method: 'POST',
            resourceType: 'xhr',
            errorText: 'net::ERR_CONNECTION_RESET',
          });
          page.emit('request', request);
          page.emit('requestfailed', request);
        }
      });

      // All five valid entries survive and lead, despite sorting later on both
      // method (POST > GET) and resource type (xhr > script).
      expect((message.match(/failed POST xhr self/g) ?? []).length).toBe(5);
      expect(message).toContain(`failed=${MAX_TRACKED_ENTRIES} (omitted=10)`);
      expect(message.indexOf('POST xhr self')).toBeLessThan(message.indexOf('unparseable-url'));
    });

    it('never publishes a hostname: the navigation origin is self, others are digests', async () => {
      // The earlier contract emitted origins verbatim, justified by "this suite
      // only navigates to a loopback BASE_URL". That justification was wrong:
      // the listener sees every request the page makes, including subresources
      // and API calls to external hosts, so a tenant-bearing hostname could
      // reach a public CI log. What matters diagnostically is "the app under
      // test, or somebody else", and that survives without naming anyone.
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({ url: `${NAV_URL}app.js`, resourceType: 'script' }),
        );
        page.emit(
          'request',
          makeRequest({ url: 'https://tenant-acme.cdn.example/x.js', resourceType: 'script' }),
        );
      });

      expect(message).not.toContain('tenant-acme');
      expect(message).not.toContain('cdn.example');
      expect(message).not.toContain('127.0.0.1');
      expect(message).toContain(' self ');
      expect(message).toMatch(/external-hmac:[0-9a-f]{12}/);
    });

    it('gives distinct third parties distinct origin digests', async () => {
      // Naming nobody must not mean conflating everybody: two different third
      // parties have to remain distinguishable inside one run, or "which host
      // is stalling" becomes unanswerable.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const host of ['https://a.example', 'https://b.example']) {
          page.emit(
            'request',
            makeRequest({ url: `${host}/x.js`, resourceType: 'script' }),
          );
        }
      });

      const origins = message.match(/external-hmac:[0-9a-f]{12}/g) ?? [];
      expect(origins).toHaveLength(2);
      expect(new Set(origins).size).toBe(2);
    });

    it('collapses every opaque origin to ONE shared digest, and says so', async () => {
      // The previous version of this test counted four external digests and
      // passed whether or not they were distinct - vacuous, because the code
      // normalizes every opaque origin to the same literal before hashing.
      // The real contract is the collapse: about:blank, data:, file: and
      // opaque blob: all parse with origin `null` and are indistinguishable by
      // definition, so they SHARE one digest. Asserting the count alone hid
      // that; asserting the distinct-digest count pins it.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const url of [
          'about:blank',
          'data:text/html,<p>x</p>',
          'file:///tmp/x.js',
          'blob:null/0d7e-1',
        ]) {
          page.emit('request', makeRequest({ url, resourceType: 'other' }));
        }
      });

      const digests = message.match(/external-hmac:[0-9a-f]{12}/g) ?? [];
      expect(digests).toHaveLength(4);
      expect(new Set(digests).size).toBe(1);

      // None of them is `self`, none leaks a literal `null`, and none of the
      // raw inputs survives into the output.
      expect(message).not.toContain('about:blank');
      expect(message).not.toContain('/tmp/x.js');
      expect(message).not.toMatch(/ null /);
    });

    it('gives the SAME external origin the same digest every time within a run', async () => {
      // The collapse and distinctness tests together still permit an
      // implementation that mints a fresh digest per OCCURRENCE - one fixed
      // value for opaque origins, a new one each time for identity-bearing
      // ones. That would satisfy both and destroy the property the report
      // depends on: counting how often one third party appears. Repetition is
      // the missing half, so it is asserted directly.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const path of ['a.js', 'b.js', 'c.js']) {
          page.emit(
            'request',
            makeRequest({ url: `https://cdn.example.test/${path}`, resourceType: 'script' }),
          );
        }
        page.emit(
          'request',
          makeRequest({ url: 'https://other.example.test/x.js', resourceType: 'script' }),
        );
      });

      const digests = message.match(/external-hmac:[0-9a-f]{12}/g) ?? [];
      expect(digests).toHaveLength(4);
      // Three from one host plus one from another: two distinct values, and
      // the repeated host must account for exactly three of them.
      expect(new Set(digests).size).toBe(2);
      const counts = new Map<string, number>();
      for (const d of digests) counts.set(d, (counts.get(d) ?? 0) + 1);
      expect([...counts.values()].sort()).toEqual([1, 3]);
    });

    it('distinguishes same-host origins that differ only by scheme or port', async () => {
      // The other origin tests are all satisfiable by a HOSTNAME-only digest,
      // which would collide http://x:8080 with https://x:9090 and report two
      // different servers as one. Origin is scheme+host+port, and the digest
      // must carry all three.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const url of [
          'http://same.example.test:8080/x.js',
          'https://same.example.test:8080/x.js',
          'http://same.example.test:9090/x.js',
        ]) {
          page.emit('request', makeRequest({ url, resourceType: 'script' }));
        }
      });

      const digests = message.match(/external-hmac:[0-9a-f]{12}/g) ?? [];
      expect(digests).toHaveLength(3);
      // Same host three times, but three distinct origins - so three digests.
      expect(new Set(digests).size).toBe(3);
      expect(message).not.toContain('same.example.test');
    });

    it('gives origins that DO have an identity distinct digests', async () => {
      // The counterpart to the collapse above: the distinctness guarantee is
      // real for origins that carry identity, and it is what makes "which host
      // is stalling" answerable without naming anyone. Without this, the
      // collapse test alone would be satisfied by hashing every origin to one
      // value.
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const host of ['a.example.test', 'b.example.test', 'c.example.test']) {
          page.emit(
            'request',
            makeRequest({ url: `https://${host}/x.js`, resourceType: 'script' }),
          );
        }
      });

      const digests = message.match(/external-hmac:[0-9a-f]{12}/g) ?? [];
      expect(digests).toHaveLength(3);
      expect(new Set(digests).size).toBe(3);
      for (const host of ['a.example.test', 'b.example.test', 'c.example.test']) {
        expect(message).not.toContain(host);
      }
    });

    it('classifies a cross-origin resource as external even though the page requested self', async () => {
      // `self` means the origin REQUESTED, not wherever a redirect landed.
      // Pins the contract the helper comment now states explicitly.
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit('request', makeRequest({ url: `${NAV_URL}app.js`, resourceType: 'script' }));
        page.emit(
          'request',
          makeRequest({ url: 'https://cdn.example.test/vendor.js', resourceType: 'script' }),
        );
      });

      expect(message).not.toContain('cdn.example.test');
      // Match the emitted FIELD SEQUENCE rather than a bare " self " substring,
      // which is formatting-dependent and would drift if a field were reordered
      // or a separator changed. No newline literal here on purpose: writing one
      // through this toolchain has silently produced a real line break instead
      // of the escape.
      expect(message.match(/ self path-hmac:[0-9a-f]{12}/g) ?? []).toHaveLength(1);
      expect(message.match(/ external-hmac:[0-9a-f]{12} path-hmac:[0-9a-f]{12}/g) ?? []).toHaveLength(
        1,
      );
    });

    it('never emits the raw origin or pathname it sorts on', async () => {
      // The sort keys hold RAW values. They order entries and must never reach
      // the output, or both digests would be pointless.
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({
            url: 'http://sortleak.test:3000/tenants/SORTKEYSENTINEL/x.js',
            resourceType: 'script',
          }),
        );
      });

      expect(message).not.toContain('SORTKEYSENTINEL');
      expect(message).not.toContain('/tenants/');
      expect(message).not.toContain('sortleak.test');
      expect(message).toMatch(/external-hmac:[0-9a-f]{12}/);
      expect(digestsIn(message)).toHaveLength(1);
    });

    it('breaks ties on the RAW origin, so identical paths from different hosts stay ordered', async () => {
      // Same path, method and type; only the host differs, and hosts are no
      // longer printed. failureClass sorts AFTER origin, so it marks which is
      // which without influencing the order.
      const render = async (reverse: boolean): Promise<string> => {
        const page = new FakePage();
        // failureClass is deliberately ordered AGAINST the host order:
        // alpha->RESET, beta->REFUSED. Sorting by raw origin puts alpha first,
        // so RESET is printed first. Drop sortOrigin from the comparator and
        // the two tie on path, leaving failureClass to decide - which puts
        // REFUSED first and fails this test. With the classes aligned to the
        // hosts the test passed either way, and mutation M8 survived.
        const hosts: Array<[string, string]> = [
          ['https://alpha.example', 'net::ERR_CONNECTION_RESET'],
          ['https://beta.example', 'net::ERR_CONNECTION_REFUSED'],
        ];
        const order = reverse ? [...hosts].reverse() : hosts;
        return failWith(page, () => {
          for (const [host, errorText] of order) {
            const request = makeRequest({
              url: `${host}/same.js`,
              resourceType: 'script',
              errorText,
            });
            page.emit('request', request);
            page.emit('requestfailed', request);
          }
        });
      };

      for (const reverse of [false, true]) {
        const message = await render(reverse);
        expect(message.indexOf('CONNECTION_RESET')).toBeLessThan(
          message.indexOf('CONNECTION_REFUSED'),
        );
        expect(message).not.toContain('alpha');
        expect(message).not.toContain('beta');
      }
    });

    it('prints the K smallest by RAW origin at any volume, not the first to arrive', async () => {
      // Origins are digested, so the printed origin cannot reveal ordering.
      // failureClass is emitted and sorts after origin, marking which hosts
      // were selected without influencing selection. Correct behaviour: the 25
      // lexicographically smallest raw hosts are host-000..host-024, all
      // REFUSED. Emitting in DESCENDING order is what fails a first-arrived
      // implementation.
      const total = 400;
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (let i = total - 1; i >= 0; i -= 1) {
          const request = makeRequest({
            url: `https://host-${String(i).padStart(3, '0')}.test/a.js`,
            resourceType: 'script',
            errorText: i < 25 ? 'net::ERR_CONNECTION_REFUSED' : 'net::ERR_CONNECTION_RESET',
          });
          page.emit('request', request);
          page.emit('requestfailed', request);
        }
      });

      expect(message).toContain(
        `failed=${MAX_TRACKED_ENTRIES} (omitted=${total - MAX_TRACKED_ENTRIES})`,
      );
      expect((message.match(/CONNECTION_REFUSED/g) ?? []).length).toBe(MAX_TRACKED_ENTRIES);
      expect((message.match(/CONNECTION_RESET/g) ?? []).length).toBe(0);
      expect(message).not.toContain('host-');
    });

  });

  describe('secret safety', () => {
    const SENTINEL = 'SUPERSECRET0PAYLOAD';

    it('never emits a query string, fragment, or credentials', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({
            url: `http://alice:${SENTINEL}@127.0.0.1:3000/tenants/${SENTINEL}/x.js?token=${SENTINEL}#${SENTINEL}`,
            resourceType: 'script',
          }),
        );
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain('token=');
      expect(message).not.toContain('alice');
      expect(message).not.toContain('127.0.0.1');
      expect(digestsIn(message)).toHaveLength(1);
    });

    it('digests an allowlist-shaped asset path rather than trusting how it looks', async () => {
      // A path can end in `.js` and still be customer data. The helper has no
      // notion of a "safe-looking" pathname: every pathname is a digest.
      const page = new FakePage();
      const path = `/assets/customer-token-${SENTINEL}.js`;
      void path;
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({ url: `http://127.0.0.1:3000${path}`, resourceType: 'script' }),
        );
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain('customer-token');
      expect(digestsIn(message)).toHaveLength(1);
    });

    it('never emits raw failure text', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        const request = makeRequest({
          url: 'http://127.0.0.1:3000/a.js',
          errorText: `net::ERR_CONNECTION_REFUSED ${SENTINEL}`,
        });
        page.emit('request', request);
        page.emit('requestfailed', request);
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).toContain('CONNECTION_REFUSED');
    });

    it('gives one path one digest within a run, and different paths different ones', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        for (const url of [
          'http://127.0.0.1:3000/same.js',
          'http://127.0.0.1:3000/same.js?cachebust=1',
          'http://127.0.0.1:3000/other.js',
        ]) {
          page.emit('request', makeRequest({ url, resourceType: 'script' }));
        }
      });

      const digests = digestsIn(message);
      // Three requests, but the first two differ only in a query string, which
      // is stripped before hashing - so two distinct pending entries, not three.
      expect(new Set(digests).size).toBe(2);
    });

    it('salts the digest per run, so it cannot be dictionary-tested', async () => {
      // A bare 12-hex SHA-256 prefix is 48 bits over a GUESSABLE input: anyone
      // with a candidate list of tenant ids could hash them and confirm a hit.
      // The salt is fresh per navigation, so the same path renders differently
      // across runs and there is nothing stable to attack.
      const render = async (): Promise<string> => {
        const page = new FakePage();
        return failWith(page, () => {
          page.emit(
            'request',
            makeRequest({ url: 'http://127.0.0.1:3000/tenants/acme/x.js', resourceType: 'script' }),
          );
        });
      };

      const first = digestsIn(await render());
      const second = digestsIn(await render());
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]).not.toBe(second[0]);
    });

    it('marks an unparseable URL instead of echoing it', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit('request', makeRequest({ url: `not a url ${SENTINEL}` }));
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).toContain('unparseable-url');
    });

    it('reduces an unrecognised HTTP method to an allowlisted token', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({ url: 'http://127.0.0.1:3000/a.js', method: `X-${SENTINEL}` }),
        );
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).toContain('pending OTHER');
    });

    it('reduces an unrecognised resource type to an allowlisted token', async () => {
      const page = new FakePage();
      const message = await failWith(page, () => {
        page.emit(
          'request',
          makeRequest({ url: 'http://127.0.0.1:3000/a.js', resourceType: SENTINEL }),
        );
      });

      expect(message).not.toContain(SENTINEL);
      expect(message).toContain('pending GET other');
    });
  });
});
