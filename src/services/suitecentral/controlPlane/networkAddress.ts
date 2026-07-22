import ipaddr from 'ipaddr.js';

/**
 * Total classification of a literal IP address for SSRF / DNS-rebinding
 * defense. Only globally-routable unicast addresses classify as `public`;
 * every private, loopback, link-local, carrier-grade-NAT, multicast, reserved,
 * unspecified, unique-local, documentation, etc. range — and any unparseable
 * input — is non-public and must be rejected as an outbound destination.
 *
 * Uses ipaddr.js (one audited parser) rather than regexes, and collapses
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to its IPv4 form so `::ffff:127.0.0.1`
 * is classified as loopback rather than sneaking through as IPv6 unicast.
 *
 * ipaddr.js's range table is not exhaustive — several IANA special-purpose
 * prefixes are reported as `unicast`. The most dangerous is the NAT64 local-use
 * prefix `64:ff9b:1::/48` (RFC 8215), which embeds an arbitrary IPv4 address
 * (e.g. `169.254.169.254`) that a NAT64 gateway will translate — a metadata
 * SSRF that would otherwise pass as public. `SPECIAL_USE_CIDRS_V4` /
 * `SPECIAL_USE_CIDRS_V6` denylist those gaps and they classify as `specialUse`
 * (non-public).
 */
export type NetworkAddressClassification =
  | 'public'
  | 'invalid'
  | 'specialUse'
  // IPv4 ranges
  | 'unspecified'
  | 'broadcast'
  | 'multicast'
  | 'linkLocal'
  | 'loopback'
  | 'carrierGradeNat'
  | 'private'
  | 'reserved'
  // IPv6 ranges
  | 'uniqueLocal'
  | 'ipv4Mapped'
  | 'rfc6145'
  | 'rfc6052'
  | '6to4'
  | 'teredo';

/**
 * IANA special-purpose prefixes that ipaddr.js@1.9.1 reports as `unicast` but
 * that must never be reachable outbound. Verified empirically against the
 * bundled ipaddr.js; each entry is only consulted when ipaddr's own range is
 * `unicast`, so redundant entries are harmless.
 */
const SPECIAL_USE_CIDRS_V4: readonly [ipaddr.IPv4, number][] = [
  ipaddr.parseCIDR('198.18.0.0/15') as [ipaddr.IPv4, number], // RFC 2544 benchmarking
  ipaddr.parseCIDR('192.31.196.0/24') as [ipaddr.IPv4, number], // RFC 7535 AS112-v4
  ipaddr.parseCIDR('192.52.193.0/24') as [ipaddr.IPv4, number], // RFC 7450 AMT
  ipaddr.parseCIDR('192.175.48.0/24') as [ipaddr.IPv4, number], // RFC 7534 AS112 direct delegation
];
const SPECIAL_USE_CIDRS_V6: readonly [ipaddr.IPv6, number][] = [
  ipaddr.parseCIDR('64:ff9b:1::/48') as [ipaddr.IPv6, number], // RFC 8215 NAT64 local-use (embeds IPv4 -> metadata SSRF)
  ipaddr.parseCIDR('100::/64') as [ipaddr.IPv6, number], // RFC 6666 discard-only
  // Whole IANA IETF-protocol-assignment block: Teredo, PCP/TURN anycast,
  // benchmarking (2001:2::/48), ORCHIDv1/v2 (2001:10::/28, 2001:20::/28),
  // Drone Remote ID (2001:30::/28), and unassigned space (2001:100::/…) all
  // live here and are not valid outbound destinations. This subsumes the
  // individual ORCHID/benchmarking prefixes and does NOT cover real global
  // unicast (e.g. 2001:4860::/32) which sits outside 2001::/23.
  ipaddr.parseCIDR('2001::/23') as [ipaddr.IPv6, number], // RFC 2928 IETF protocol assignments
  ipaddr.parseCIDR('2620:4f:8000::/48') as [ipaddr.IPv6, number], // RFC 7534 AS112-v6
  ipaddr.parseCIDR('3fff::/20') as [ipaddr.IPv6, number], // RFC 9637 documentation
];

// The only globally-routable IPv6 unicast block IANA has allocated. ipaddr.js
// reports `unicast` as a catch-all (not proof of global routability), so an
// IPv6 address outside 2000::/3 — deprecated site-local `fec0::/10`, SRv6 SID
// space `5f00::/16`, NAT64 local-use, discard-only, etc. — must NOT be treated
// as public even when ipaddr calls it unicast.
const GLOBAL_UNICAST_V6: [ipaddr.IPv6, number] = ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number];

function isSpecialUse(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (addr.kind() === 'ipv4') {
    const v4 = addr as ipaddr.IPv4;
    return SPECIAL_USE_CIDRS_V4.some((cidr) => v4.match(cidr));
  }
  const v6 = addr as ipaddr.IPv6;
  // Positive gate: an IPv6 address must live in global unicast space to be
  // eligible for `public`. Then subtract the in-block special-use prefixes.
  if (!v6.match(GLOBAL_UNICAST_V6)) {
    return true;
  }
  return SPECIAL_USE_CIDRS_V6.some((cidr) => v6.match(cidr));
}

export function classifyNetworkAddress(address: string): NetworkAddressClassification {
  if (!ipaddr.isValid(address)) {
    return 'invalid';
  }
  let addr: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(address);
  // Collapse IPv4-mapped IPv6 to IPv4 so it is classified by its real value.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }
  const range = addr.range();
  if (range !== 'unicast') {
    // Conservative by design: a few globally-reachable special-purpose anycast
    // addresses (e.g. IPv4 PCP/TURN 192.0.0.9/192.0.0.10 inside ipaddr's broad
    // `reserved` 192.0.0.0/24) are rejected here. That is intentional — those
    // are infrastructure anycast addresses, never a legitimate SuiteCentral
    // destination host, and over-rejecting is fail-safe for SSRF defense.
    return range as NetworkAddressClassification;
  }
  // ipaddr says unicast — apply the special-use denylist for the gaps it misses.
  return isSpecialUse(addr) ? 'specialUse' : 'public';
}

export function isPublicNetworkAddress(address: string): boolean {
  return classifyNetworkAddress(address) === 'public';
}

/**
 * The syntactic IP family of a literal address — 4 for an IPv4 literal, 6 for an
 * IPv6 literal (including IPv4-mapped forms like `::ffff:1.2.3.4`), or null if
 * unparseable. Used to fail-close on a DNS answer whose `family` field disagrees
 * with its address string.
 */
export function networkAddressFamily(address: string): 4 | 6 | null {
  if (!ipaddr.isValid(address)) {
    return null;
  }
  return ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6;
}
