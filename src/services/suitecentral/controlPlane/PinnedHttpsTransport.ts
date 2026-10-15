import https from 'https';
import { URL } from 'url';
import { domainToASCII } from 'url';
import type { LookupFunction } from 'net';
import { hasUnsafeHttpPath } from './httpPathSafety';
import type { ValidatedSuiteCentralDestination } from './SuiteCentralOutboundPolicy';

export interface PinnedRequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative path only (resolved against the pinned destination). */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-serializable body; sent as `application/json`. */
  readonly data?: unknown;
}

export interface PinnedResponse {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Record<string, unknown>;
}

/**
 * A single-destination HTTPS client. The ONLY thing a caller can vary is the
 * method, a relative path, headers, and a JSON body — every security-critical
 * knob is fixed internally and cannot be overridden per request.
 */
export interface PinnedHttpsClient {
  request(options: PinnedRequestOptions): Promise<PinnedResponse>;
}

/** Hard cap on a buffered response body (defends a drip/flood from an allowlisted host). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Cap on retained chunks so a fragmented drip can't allocate unbounded Buffers under the byte cap. */
const MAX_RESPONSE_CHUNKS = 10_000;

/** Hop-by-hop / connection-control headers a caller must not set on the pinned transport. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
]);

/**
 * Builds a {@link PinnedHttpsClient} on Node's native `https.request` — NOT
 * axios. This is the second half of DNS-rebinding defense: the request runs
 * through an `https.Agent` whose lookup only ever hands back the addresses the
 * outbound policy validated as public.
 *
 * Native `https.request` is used deliberately. Axios (even a private instance
 * with a forced adapter) is an unbounded surface: `axios.defaults`/global
 * interceptors, adapter selection (`fetch`/`xhr`), `httpVersion`/`http2Options`
 * (bypass the agent via `http2.connect`), `transport`, `socketPath`, and the
 * FormData header policy each let a request escape the validated destination.
 * With `https.request` there is no global state and every option below is set
 * explicitly:
 *   - `agent` with the pinned family-aware lookup (rebind-proof);
 *   - `host`/`servername`/`port` pinned to the validated destination;
 *   - `Host` header pinned (any caller-supplied Host is stripped);
 *   - relative path only (absolute/protocol-relative rejected);
 *   - no redirect following (native `https.request` never auto-follows);
 *   - JSON-only body (no multipart/FormData header-injection path).
 *
 * The client is intended to live for one operation and be discarded.
 */
export class PinnedHttpsTransport {
  create(destination: ValidatedSuiteCentralDestination, timeoutMs: number): PinnedHttpsClient {
    if (destination.addresses.length === 0) {
      // The outbound policy only produces destinations with >=1 public address,
      // but the type cannot express that — fail fast rather than throw a bare
      // TypeError deep in the pinned lookup.
      throw new Error('validated_destination_has_no_addresses');
    }
    const agent = new https.Agent({ keepAlive: false, lookup: this.pinnedLookup(destination) });
    const canonicalPath = new URL(destination.canonicalUrl).pathname;

    return {
      request: (options: PinnedRequestOptions): Promise<PinnedResponse> => {
        const path = options.path ?? '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
          return Promise.reject(new Error('pinned_transport_absolute_url_forbidden'));
        }
        const relative = path === '' ? '' : path.startsWith('/') ? path : `/${path}`;
        // path === '' hits the validated destination path EXACTLY (preserving an
        // intentional trailing slash on a webhook target). A relative path joins
        // onto the base (canonical path minus a trailing slash) for base-URL use.
        const fullPath = relative === ''
          ? canonicalPath
          : `${canonicalPath === '/' ? '' : canonicalPath.replace(/\/$/, '')}${relative}`;
        // Confine to the validated base path: reject `..` segments, backslashes,
        // and percent-encoded dot/slash/backslash/percent that a proxy could
        // normalize (incl. double-encoded) out of the validated prefix
        // (parser-differential traversal). The CONSTRUCTED path is checked.
        if (hasUnsafeHttpPath(fullPath.split('?', 1)[0])) {
          return Promise.reject(new Error('pinned_transport_unsafe_path'));
        }

        // Headers from scratch: drop any caller-supplied Host / hop-by-hop /
        // connection-control header (a shared CDN/reverse proxy routes by Host to
        // an unallowlisted vhost; Upgrade/Connection could switch protocols) and
        // pin Host to the validated hostname.
        const headers: Record<string, string> = { Accept: 'application/json' };
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          if (FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) {
            continue;
          }
          headers[key] = value;
        }
        headers.Host = destination.hostname;

        let body: string | undefined;
        if (options.data !== undefined) {
          body = JSON.stringify(options.data);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = String(Buffer.byteLength(body));
        }

        return this.dispatch(
          {
            protocol: 'https:',
            host: destination.hostname,
            servername: destination.hostname,
            port: destination.port,
            method: options.method,
            path: fullPath,
            headers,
            agent,
            timeout: timeoutMs,
          },
          body,
          timeoutMs,
        );
      },
    };
  }

  private dispatch(requestOptions: https.RequestOptions, body: string | undefined, timeoutMs: number): Promise<PinnedResponse> {
    return new Promise<PinnedResponse>((resolve, reject) => {
      let settled = false;
      let req: ReturnType<typeof https.request> | undefined;
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      // Wall-clock deadline for the WHOLE operation — the socket `timeout` option
      // is only an inactivity timer, so a slow drip could otherwise run forever.
      // `req` may be undefined if construction threw synchronously.
      const deadline = setTimeout(() => {
        finish(() => reject(new Error('pinned_transport_deadline')));
        req?.destroy();
      }, timeoutMs);

      try {
        req = https.request(requestOptions, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES || chunks.length >= MAX_RESPONSE_CHUNKS) {
              req?.destroy();
              res.destroy();
              finish(() => reject(new Error('pinned_transport_response_too_large')));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const contentType = String(res.headers['content-type'] ?? '');
            let data: unknown = raw;
            if (raw && contentType.includes('application/json')) {
              try {
                data = JSON.parse(raw);
              } catch {
                data = raw;
              }
            }
            finish(() => resolve({ status: res.statusCode ?? 0, data, headers: res.headers as Record<string, unknown> }));
          });
          res.on('error', (err) => {
            finish(() => reject(err));
            req?.destroy();
          });
          // If the remote aborts the stream mid-body, `close` fires without a
          // preceding `end`/`error`; settle so the promise can't hang until the
          // deadline. `finish` is idempotent, so the normal end→close order is a
          // no-op here.
          res.on('close', () => finish(() => reject(new Error('pinned_transport_response_incomplete'))));
        });
        // A 101/upgrade response arrives on `upgrade`, not the response callback
        // — destroy the socket and reject so the promise can never hang.
        req.on('upgrade', (_res, socket) => {
          socket.destroy();
          finish(() => reject(new Error('pinned_transport_upgrade_forbidden')));
        });
        req.on('timeout', () => {
          finish(() => reject(new Error('pinned_transport_timeout')));
          req?.destroy();
        });
        req.on('error', (err) => finish(() => reject(err)));
        if (body !== undefined) {
          req.write(body);
        }
        req.end();
      } catch (err) {
        // https.request / write / end can throw synchronously on invalid
        // options (e.g. bad header/path token). Settle, clear the timer so it
        // never fires against an uninitialized request, and destroy the request
        // if it was already constructed (a write()/end() throw) so its socket
        // isn't retained.
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        req?.destroy();
      }
    });
  }

  /** Family-aware DNS lookup pinned to the validated destination addresses. */
  private pinnedLookup(destination: ValidatedSuiteCentralDestination): LookupFunction {
    return (hostname, options, callback): void => {
      // The Node LookupFunction callback types `address` as required; widen it
      // so the error-only and single-address forms are callable.
      const cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
      if (domainToASCII(hostname).toLowerCase() !== destination.hostname) {
        cb(new Error('validated_destination_hostname_mismatch'));
        return;
      }
      // Honor the requested address family (Node's dns.lookup contract): the
      // agent may request { family: 4 } or { family: 6 } in IPv4/IPv6-only
      // environments; family 0/undefined means either.
      const wantFamily = options.family === 4 || options.family === 6 ? options.family : 0;
      const matches = wantFamily === 0
        ? destination.addresses
        : destination.addresses.filter((a) => a.family === wantFamily);
      if (matches.length === 0) {
        cb(new Error('validated_destination_no_address_for_family'));
        return;
      }
      if (options.all === true) {
        cb(null, matches.map((a) => ({ address: a.address, family: a.family })));
      } else {
        const first = matches[0];
        cb(null, first.address, first.family);
      }
    };
  }
}
