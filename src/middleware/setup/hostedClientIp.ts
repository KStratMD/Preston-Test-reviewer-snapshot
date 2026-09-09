// A6 — client-IP key resolution for the global rate limiter.
//
// Deliberately NOT Express `trust proxy`.
//
// `trust proxy` derives client identity from X-Forwarded-For. Railway
// documents X-Real-IP as its client-address header and does not document a
// stable XFF hop count, so any hop number configured here would be a guess,
// and both ways of guessing fail silently:
//   - too permissive → a client forges XFF and mints unlimited buckets;
//   - too strict → every client collapses into the proxy's socket address and
//     the IP-keyed limiter becomes one global bucket.
// So in hosted mode we read a validated X-Real-IP and ignore client XFF.
//
// IPv6 /64 aggregation is load-bearing, not tidiness. express-rate-limit is
// pinned at 7.5.1, which does not export `ipKeyGenerator` (that arrives in
// 8.x — see the note in MiddlewareSetup.ts). Keying on a raw IPv6 address
// gives every address in an ordinary /64 allocation its own bucket, so the
// limiter is defeated by address rotation without forging anything. Masking
// to /64 makes the budget per-allocation.
//
// NOTE: the repo has two other client-IP resolvers (advancedSecurity.ts:408,
// enhancedRateLimit.ts:219) which order it socket → XFF → X-Real-IP, i.e.
// they prefer client-supplied XFF over the header Railway sets. They are NOT
// reused here and are recorded as follow-up debt; changing them is out of A6
// scope by explicit decision.

import ipaddr from 'ipaddr.js';

/**
 * Stable key for a request whose address cannot be determined at all.
 *
 * A constant, never a random or per-request value: an unkeyable request must
 * share one conservative bucket rather than being handed a fresh budget.
 */
const UNKNOWN_CLIENT_KEY = 'unknown-client';

/** Number of leading 16-bit groups retained when aggregating IPv6 to /64. */
const IPV6_AGGREGATION_GROUPS = 4;

/** Minimal request shape the resolver needs. Exported so tests can type their
 * fakes precisely instead of casting through `never`. */
export interface ClientIpRequest {
  get(name: string): string | undefined;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/**
 * Parse and canonicalize one address into a rate-limit key.
 *
 * Returns null when the input is absent or not a single valid address, so the
 * caller can fall back deliberately rather than keying on garbage.
 */
export function normalizeClientIpKey(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  // X-Real-IP is single-valued. A comma means the upstream is not shaped the
  // way we believe it is; fail to the socket fallback rather than parsing an
  // attacker-influenced list and picking an element.
  if (value.includes(',')) return null;

  if (!ipaddr.isValid(value)) return null;
  const addr = ipaddr.parse(value);

  if (addr.kind() === 'ipv4') return addr.toString();

  const v6 = addr as ipaddr.IPv6;
  // ::ffff:203.0.113.7 and 203.0.113.7 are the same client; without this they
  // would occupy two buckets.
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().toString();

  const masked = v6.parts.map((part, i) => (i < IPV6_AGGREGATION_GROUPS ? part : 0));
  return `${new ipaddr.IPv6(masked).toString()}/64`;
}

/**
 * The rate-limit key for a request.
 *
 * Hosted: validated X-Real-IP, else the socket address, else a single stable
 * constant. Client-supplied X-Forwarded-For is never consulted.
 *
 * Non-hosted: ordinary Express identity (`req.ip`), unchanged. Normalization
 * still applies, because the IPv6 rotation bypass is worth closing in every
 * mode and it keeps one code path — the SOURCE of the address is what differs
 * between modes, not the canonicalization.
 */
export function resolveClientIpKey(req: ClientIpRequest, options: { hosted: boolean }): string {
  const socketCandidate = req.socket?.remoteAddress ?? req.ip;

  if (options.hosted) {
    const fromHeader = normalizeClientIpKey(req.get('x-real-ip'));
    if (fromHeader !== null) return fromHeader;
    return normalizeClientIpKey(socketCandidate) ?? UNKNOWN_CLIENT_KEY;
  }

  return normalizeClientIpKey(req.ip ?? socketCandidate) ?? UNKNOWN_CLIENT_KEY;
}

/** Bind the resolver to an environment, for use as an express-rate-limit keyGenerator. */
export function createClientIpKeyGenerator(options: { hosted: boolean }): (req: ClientIpRequest) => string {
  return (req) => resolveClientIpKey(req, options);
}
