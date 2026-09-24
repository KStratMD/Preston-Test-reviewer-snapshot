import { domainToASCII } from 'url';
import { classifyNetworkAddress, networkAddressFamily } from './networkAddress';
import { SuiteCentralDestinationRejectedError } from './errors';
import type { SuiteCentralControlPlaneRepository } from './SuiteCentralControlPlaneRepository';

export interface DnsAnswer {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ResolveAll = (hostname: string) => Promise<readonly DnsAnswer[]>;

export interface ValidatedSuiteCentralDestination {
  /**
   * The canonical https URL to connect to. For base URLs this is the origin
   * (`https://host`); for webhook targets it includes the validated path. Named
   * `canonicalUrl` rather than `canonicalBaseUrl` because it is not always a
   * bare origin.
   */
  readonly canonicalUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly DnsAnswer[];
}

/**
 * Validates and canonicalizes SuiteCentral outbound destinations (base URLs and
 * webhook targets) against the platform allowlist with DNS-rebinding-resistant
 * checks. The validation order is FIXED and fail-closed:
 *
 *   1. parse URL; require https:; reject userinfo/query/fragment
 *   2. enforce the method-specific path rule (base: path only `/`; webhook: any
 *      normalized path allowed)
 *   3. canonicalize the hostname (IDNA/domainToASCII, lowercased)
 *   4. normalize/require port 443
 *   5. look up the EXACT active allowlist row
 *   6. resolve DNS via the injected `resolveAll`, which MUST return every A/AAAA
 *      answer for the host (this layer does not control the resolver's options)
 *   7. require ≥1 answer AND that EVERY answer classifies as public
 *   8. freeze and return the validated destination
 *
 * Requiring every resolved address to be public defeats DNS rebinding: an
 * attacker who allowlists a host they control cannot then answer with a
 * loopback/private address. Because every answer is checked, resolver ordering
 * (verbatim vs. not) is irrelevant to the security property.
 */
export class SuiteCentralOutboundPolicy {
  constructor(
    private readonly repository: Pick<SuiteCentralControlPlaneRepository, 'findActiveAllowedHost'>,
    private readonly resolveAll: ResolveAll,
  ) {}

  async validateBaseUrl(rawUrl: string): Promise<ValidatedSuiteCentralDestination> {
    return this.validate(rawUrl, 'base');
  }

  async validateWebhookTarget(rawUrl: string): Promise<ValidatedSuiteCentralDestination> {
    return this.validate(rawUrl, 'webhook');
  }

  private reject(code: string, message: string): never {
    throw new SuiteCentralDestinationRejectedError(code, message);
  }

  private async validate(rawUrl: string, mode: 'base' | 'webhook'): Promise<ValidatedSuiteCentralDestination> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.reject('invalid_url', 'Destination is not a valid URL.');
    }

    if (url.protocol !== 'https:') {
      this.reject('non_https', 'Destination must use https.');
    }
    if (url.username !== '' || url.password !== '') {
      this.reject('userinfo_forbidden', 'Destination must not contain user credentials.');
    }
    if (url.search !== '') {
      this.reject('query_forbidden', 'Destination must not contain a query string.');
    }
    if (url.hash !== '') {
      this.reject('fragment_forbidden', 'Destination must not contain a fragment.');
    }
    if (mode === 'base' && url.pathname !== '/' && url.pathname !== '') {
      this.reject('base_path_forbidden', 'Base URL must not include a path.');
    }
    // Note: `new URL(...)` already resolves dot-segments (including `%2e` forms)
    // in the pathname, so a configured webhook target like `/v1/../../admin` is
    // stored as its concrete resolved path (`/admin`) and sent verbatim by the
    // transport — there is no traversal artifact to reject here. Caller-supplied
    // REQUEST paths (which never pass through `new URL`) are the traversal vector
    // and are guarded by `hasUnsafeHttpPath` inside PinnedHttpsTransport.

    // `new URL(...)` has already IDNA-encoded and lowercased url.hostname, so
    // domainToASCII here is a defensive no-op on the common path; its only live
    // effect is rejecting a hostname that fails IDNA (empty result). The actual
    // homoglyph/rebind guard is the EXACT allowlist match plus the all-public
    // DNS check below — a Unicode host canonicalizes to punycode that will not
    // match an ASCII allowlist row.
    const canonicalHost = domainToASCII(url.hostname).toLowerCase();
    if (canonicalHost === '') {
      this.reject('invalid_hostname', 'Destination hostname is invalid.');
    }

    const port = url.port === '' ? 443 : Number(url.port);
    if (port !== 443) {
      this.reject('non_https_port', 'Destination must use port 443.');
    }

    const allowed = await this.repository.findActiveAllowedHost(canonicalHost, port);
    if (!allowed) {
      this.reject('host_not_allowed', 'Destination host is not on the active allowlist.');
    }

    let answers: readonly DnsAnswer[];
    try {
      answers = await this.resolveAll(canonicalHost);
    } catch {
      this.reject('dns_failure', 'Destination DNS resolution failed.');
    }
    if (answers.length === 0) {
      this.reject('dns_empty', 'Destination DNS resolution returned no records.');
    }
    for (const answer of answers) {
      // Fail closed on a malformed answer from the injected resolver: an
      // unexpected family — or an address string whose real family disagrees
      // with the claimed one — would break the pinned transport's family-aware
      // lookup.
      if (answer.family !== 4 && answer.family !== 6) {
        this.reject('malformed_dns_answer', 'Destination DNS answer has an invalid address family.');
      }
      if (networkAddressFamily(answer.address) !== answer.family) {
        this.reject('malformed_dns_answer', 'Destination DNS answer family does not match its address.');
      }
      if (classifyNetworkAddress(answer.address) !== 'public') {
        this.reject('non_public_address', 'Destination resolves to a non-public address.');
      }
    }

    const pathname = mode === 'webhook' ? url.pathname : '';
    return Object.freeze({
      canonicalUrl: `https://${canonicalHost}${pathname}`,
      hostname: canonicalHost,
      port,
      addresses: Object.freeze(answers.map((a) => Object.freeze({ ...a }))),
    });
  }
}
