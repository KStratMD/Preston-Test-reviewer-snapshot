// A6 — client-IP key resolution for the global limiter.
//
// Why this exists rather than Express `trust proxy`:
//
// `trust proxy` derives identity from X-Forwarded-For. Railway documents
// X-Real-IP as the client-address header and does not document a stable XFF
// hop count, so any hop number here would be a guess. Guessing high lets a
// client forge XFF and mint unlimited buckets; guessing low collapses every
// client into the proxy's socket address and turns an IP-keyed limiter into a
// single global bucket. Both failures are silent.
//
// So in hosted mode we read a VALIDATED X-Real-IP and ignore client XFF
// entirely.
//
// The /64 aggregation is not cosmetic. express-rate-limit is pinned at 7.5.1,
// which does not export `ipKeyGenerator` (that lands in 8.x — see the note in
// MiddlewareSetup.ts). Without masking, every address in an ordinary IPv6 /64
// allocation is its own bucket, and the limiter is defeated by address
// rotation without forging a single header.

import { describe, it, expect } from '@jest/globals';
import { normalizeClientIpKey, resolveClientIpKey, type ClientIpRequest } from '../../../src/middleware/setup/hostedClientIp';

describe('normalizeClientIpKey', () => {
  it('returns IPv4 unchanged', () => {
    expect(normalizeClientIpKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('converts an IPv4-mapped IPv6 address to plain IPv4', () => {
    // ::ffff:203.0.113.7 and 203.0.113.7 are the same client and must not get
    // two buckets.
    expect(normalizeClientIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIpKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('aggregates a native IPv6 address to its /64', () => {
    const key = normalizeClientIpKey('2001:db8:1234:5678:9abc:def0:1234:5678');
    expect(key).toBe('2001:db8:1234:5678::/64');
  });

  it('gives two addresses in the SAME /64 the same key', () => {
    const a = normalizeClientIpKey('2001:db8:1234:5678:aaaa:aaaa:aaaa:aaaa');
    const b = normalizeClientIpKey('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
  });

  it('gives two addresses in DIFFERENT /64s different keys', () => {
    const a = normalizeClientIpKey('2001:db8:1234:5678::1');
    const b = normalizeClientIpKey('2001:db8:1234:9999::1');
    expect(a).not.toBe(b);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeClientIpKey('  203.0.113.7  ')).toBe('203.0.113.7');
  });

  it('returns null for malformed, empty or absent input', () => {
    for (const bad of [undefined, '', '   ', 'not-an-ip', '999.999.999.999', '203.0.113.7, 198.51.100.9', '<script>']) {
      expect(normalizeClientIpKey(bad as string | undefined)).toBeNull();
    }
  });

  it('returns null for a comma-joined header rather than silently taking the first entry', () => {
    // X-Real-IP is single-valued. A comma means something upstream is not what
    // we think it is; failing closed to the socket fallback is safer than
    // parsing an attacker-influenced list.
    expect(normalizeClientIpKey('203.0.113.7,198.51.100.9')).toBeNull();
  });
});

describe('resolveClientIpKey — hosted', () => {
  const mkReq = (headers: Record<string, string>, socketIp?: string) => ({
    get: (name: string) => headers[name.toLowerCase()],
    ip: socketIp,
    socket: { remoteAddress: socketIp },
  }) satisfies ClientIpRequest;

  it('uses a valid X-Real-IP', () => {
    expect(resolveClientIpKey(mkReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1'), { hosted: true }))
      .toBe('203.0.113.7');
  });

  it('IGNORES X-Forwarded-For entirely — it cannot mint a bucket', () => {
    const withXff = resolveClientIpKey(
      mkReq({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' }, '10.0.0.1'),
      { hosted: true },
    );
    const withoutXff = resolveClientIpKey(mkReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1'), { hosted: true });
    expect(withXff).toBe(withoutXff);
    expect(withXff).toBe('203.0.113.7');
  });

  it('falls back to the socket address when X-Real-IP is missing', () => {
    expect(resolveClientIpKey(mkReq({}, '10.0.0.1'), { hosted: true })).toBe('10.0.0.1');
  });

  it('falls back to the socket address when X-Real-IP is malformed', () => {
    expect(resolveClientIpKey(mkReq({ 'x-real-ip': 'garbage' }, '10.0.0.1'), { hosted: true }))
      .toBe('10.0.0.1');
  });

  it('falls back to a single stable key when neither header nor socket is usable', () => {
    // A stable constant, NOT a random or per-request value: an unkeyable
    // request must share one conservative bucket rather than getting a free
    // one of its own.
    const a = resolveClientIpKey(mkReq({ 'x-real-ip': 'garbage' }, undefined), { hosted: true });
    const b = resolveClientIpKey(mkReq({}, undefined), { hosted: true });
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });

  it('normalizes the socket fallback too, so an IPv6 socket is /64-aggregated', () => {
    expect(resolveClientIpKey(mkReq({}, '2001:db8:1:2:3:4:5:6'), { hosted: true }))
      .toBe('2001:db8:1:2::/64');
  });
});

describe('resolveClientIpKey — non-hosted keeps ordinary Express identity', () => {
  const mkReq = (headers: Record<string, string>, socketIp?: string) => ({
    get: (name: string) => headers[name.toLowerCase()],
    ip: socketIp,
    socket: { remoteAddress: socketIp },
  }) satisfies ClientIpRequest;

  it('uses req.ip and does NOT consult X-Real-IP', () => {
    const key = resolveClientIpKey(
      mkReq({ 'x-real-ip': '203.0.113.7' }, '10.0.0.1'),
      { hosted: false },
    );
    expect(key).toBe('10.0.0.1');
  });

  it('still normalizes IPv6 so the rotation bypass is closed in every mode', () => {
    expect(resolveClientIpKey(mkReq({}, '2001:db8:1:2:3:4:5:6'), { hosted: false }))
      .toBe('2001:db8:1:2::/64');
  });
});
