import { classifyNetworkAddress, isPublicNetworkAddress } from '../../../../src/services/suitecentral/controlPlane/networkAddress';

describe('classifyNetworkAddress', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    // TEST-NET / documentation / 6to4-relay / benchmarking — ipaddr flags these
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1',
    // NAT64 well-known prefix (ipaddr: rfc6052)
    '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::',
  ])('rejects non-public address %s', (address) => {
    expect(classifyNetworkAddress(address)).not.toBe('public');
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  // Special-use prefixes that ipaddr.js reports as `unicast` but that must not
  // be reachable — the denylist gap ipaddr misses. The NAT64 local-use case is
  // the SSRF vector: 64:ff9b:1::/48 embeds 169.254.169.254 (a9fe:a9fe).
  it.each([
    ['198.18.0.1', 'IPv4 benchmarking RFC2544'],
    ['64:ff9b:1:a9fe:a9:fe00::', 'NAT64 RFC8215 local-use -> metadata'],
    ['100::1', 'IPv6 discard-only RFC6666'],
    ['2001:20::1', 'ORCHIDv2 RFC7343'],
    ['2001:10::1', 'ORCHIDv1 RFC4843 (deprecated)'],
    ['2001:2::1', 'IPv6 benchmarking RFC5180'],
    ['3fff::1', 'IPv6 documentation RFC9637'],
    // Outside global unicast 2000::/3 — ipaddr calls these `unicast`, but they
    // are not globally routable and must not pass.
    ['fec0::1', 'deprecated site-local RFC3879'],
    ['5f00::1', 'SRv6 SID space RFC9602'],
    ['192.31.196.1', 'AS112-v4 RFC7535'],
    ['192.52.193.1', 'AMT RFC7450'],
    ['192.175.48.1', 'AS112 direct delegation RFC7534'],
    ['2620:4f:8000::1', 'AS112-v6 RFC7534'],
  ])('classifies special-use %s (%s) as non-public', (address) => {
    expect(classifyNetworkAddress(address)).toBe('specialUse');
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it('accepts a globally-routable IPv6 unicast address inside 2000::/3', () => {
    expect(classifyNetworkAddress('2001:4860:4860::8888')).toBe('public');
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(classifyNetworkAddress(address)).toBe('public');
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );

  it('classifies IPv4-mapped IPv6 by its underlying IPv4 value', () => {
    expect(classifyNetworkAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyNetworkAddress('::ffff:8.8.8.8')).toBe('public');
    expect(classifyNetworkAddress('::ffff:169.254.169.254')).toBe('linkLocal');
  });

  it('returns invalid for unparseable input', () => {
    for (const bad of ['', 'not-an-ip', '999.999.999.999', 'http://8.8.8.8', '8.8.8.8:443']) {
      expect(classifyNetworkAddress(bad)).toBe('invalid');
      expect(isPublicNetworkAddress(bad)).toBe(false);
    }
  });
});
