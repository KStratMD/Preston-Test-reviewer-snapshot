import { SuiteCentralOutboundPolicy, type DnsAnswer } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralOutboundPolicy';
import { SuiteCentralDestinationRejectedError } from '../../../../src/services/suitecentral/controlPlane/errors';

const PUBLIC_ANSWERS: DnsAnswer[] = [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

function makePolicy(opts: {
  allowed?: boolean;
  resolve?: () => Promise<readonly DnsAnswer[]>;
} = {}) {
  const findActiveAllowedHost = jest.fn(async () =>
    opts.allowed === false ? undefined : ({ id: 'h1', hostname: 'api.suitecentral.example', allowedPorts: [443], status: 'active' } as never),
  );
  const resolveAll = jest.fn(opts.resolve ?? (async () => PUBLIC_ANSWERS));
  const policy = new SuiteCentralOutboundPolicy({ findActiveAllowedHost } as never, resolveAll);
  return { policy, findActiveAllowedHost, resolveAll };
}

async function expectReject(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SuiteCentralDestinationRejectedError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('SuiteCentralOutboundPolicy', () => {
  describe('happy path', () => {
    it('validates a webhook target and returns the pinned destination', async () => {
      const { policy } = makePolicy();
      await expect(
        policy.validateWebhookTarget('https://api.suitecentral.example/v1/hooks/receive'),
      ).resolves.toMatchObject({
        canonicalUrl: 'https://api.suitecentral.example/v1/hooks/receive',
        hostname: 'api.suitecentral.example',
        port: 443,
        addresses: PUBLIC_ANSWERS,
      });
    });

    it('validates a base URL and canonicalizes it', async () => {
      const { policy } = makePolicy();
      const dest = await policy.validateBaseUrl('https://api.suitecentral.example/');
      expect(dest.canonicalUrl).toBe('https://api.suitecentral.example');
      expect(dest.hostname).toBe('api.suitecentral.example');
      expect(Object.isFrozen(dest)).toBe(true);
    });
  });

  describe('URL-shape rejections', () => {
    it('rejects http', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateWebhookTarget('http://api.suitecentral.example/h'), 'non_https');
    });
    it('rejects userinfo', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateWebhookTarget('https://user:pass@api.suitecentral.example/h'), 'userinfo_forbidden');
    });
    it('rejects a query string', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h?x=1'), 'query_forbidden');
    });
    it('rejects a fragment', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h#frag'), 'fragment_forbidden');
    });
    it('rejects a non-443 port', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example:8443/h'), 'non_https_port');
    });
    it('rejects a base URL that carries a path', async () => {
      const { policy } = makePolicy();
      await expectReject(policy.validateBaseUrl('https://api.suitecentral.example/v1'), 'base_path_forbidden');
    });
    it('stores a webhook target as its URL-normalized concrete path (new URL resolves dot-segments)', async () => {
      const { policy } = makePolicy();
      const dest = await policy.validateWebhookTarget('https://api.suitecentral.example/v1/../../admin');
      // new URL() resolves `..` at parse time; the concrete path is stored and
      // sent verbatim, so there is no traversal artifact left to reject here.
      expect(dest.canonicalUrl).toBe('https://api.suitecentral.example/admin');
    });
  });

  describe('allowlist and DNS rejections', () => {
    it('rejects a host absent from the active allowlist', async () => {
      const { policy } = makePolicy({ allowed: false });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'host_not_allowed');
    });
    it('rejects when DNS returns no answers', async () => {
      const { policy } = makePolicy({ resolve: async () => [] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'dns_empty');
    });
    it('rejects when DNS resolution fails', async () => {
      const { policy } = makePolicy({ resolve: async () => { throw new Error('ENOTFOUND'); } });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'dns_failure');
    });
    it('rejects when any answer is a private address (DNS rebinding)', async () => {
      const { policy } = makePolicy({ resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'non_public_address');
    });
    it('rejects when an answer is a link-local metadata address', async () => {
      const { policy } = makePolicy({ resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'non_public_address');
    });
    it('rejects a NAT64-embedded metadata address (64:ff9b:1::/48 -> 169.254.169.254)', async () => {
      const { policy } = makePolicy({ resolve: async () => [{ address: '64:ff9b:1:a9fe:a9:fe00::', family: 6 }] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'non_public_address');
    });
    it('rejects a DNS answer with an invalid address family (fail closed)', async () => {
      const { policy } = makePolicy({ resolve: async () => [{ address: '93.184.216.34', family: 7 as unknown as 4 }] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'malformed_dns_answer');
    });
    it('rejects a DNS answer whose family disagrees with its address', async () => {
      const { policy } = makePolicy({ resolve: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 4 }] });
      await expectReject(policy.validateWebhookTarget('https://api.suitecentral.example/h'), 'malformed_dns_answer');
    });
  });

  it('does not resolve DNS or hit the allowlist when the URL shape is already invalid', async () => {
    const { policy, findActiveAllowedHost, resolveAll } = makePolicy();
    await expectReject(policy.validateWebhookTarget('http://api.suitecentral.example/h'), 'non_https');
    expect(findActiveAllowedHost).not.toHaveBeenCalled();
    expect(resolveAll).not.toHaveBeenCalled();
  });
});
