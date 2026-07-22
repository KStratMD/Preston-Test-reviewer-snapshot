import { EventEmitter } from 'events';
import https from 'https';
import type { LookupAddress } from 'dns';
import { PinnedHttpsTransport } from '../../../../src/services/suitecentral/controlPlane/PinnedHttpsTransport';
import type { ValidatedSuiteCentralDestination } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralOutboundPolicy';

const destination: ValidatedSuiteCentralDestination = Object.freeze({
  canonicalUrl: 'https://api.suitecentral.example',
  hostname: 'api.suitecentral.example',
  port: 443,
  addresses: Object.freeze([
    { address: '93.184.216.34', family: 4 as const },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
  ]),
});

type LookupFn = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: Error | null, addresses?: unknown, family?: number) => void,
) => void;

interface Res extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  destroy: jest.Mock;
}

/** Stub https.request and hand back the captured options + req/res emitters. */
function stubHttps() {
  const req = new EventEmitter() as EventEmitter & {
    write: (b: string) => void; end: () => void; destroy: jest.Mock;
  };
  let written = '';
  req.write = (b: string) => { written += b; };
  req.end = () => undefined;
  req.destroy = jest.fn();

  const res = new EventEmitter() as Res;
  res.statusCode = 200;
  res.headers = { 'content-type': 'application/json' };
  res.destroy = jest.fn();

  let options: https.RequestOptions = {};
  let cb: ((res: Res) => void) | undefined;
  jest.spyOn(https, 'request').mockImplementation(((opts: https.RequestOptions, callback: (res: Res) => void) => {
    options = opts;
    cb = callback;
    return req;
  }) as unknown as typeof https.request);

  return {
    req,
    res,
    get options() { return options; },
    get body() { return written; },
    respond: () => cb?.(res),
  };
}

function getLookup(agent: unknown): LookupFn {
  return (agent as { options: { lookup: LookupFn } }).options.lookup;
}

describe('PinnedHttpsTransport', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pins host/port/servername/agent and returns the parsed JSON response', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({ method: 'POST', path: '/customers', data: { a: 1 } });
    stub.respond();
    stub.res.emit('data', Buffer.from('{"ok":true}'));
    stub.res.emit('end');
    const res = await p;

    expect(res).toEqual({ status: 200, data: { ok: true }, headers: { 'content-type': 'application/json' } });
    expect(stub.options.host).toBe('api.suitecentral.example');
    expect(stub.options.servername).toBe('api.suitecentral.example');
    expect(stub.options.port).toBe(443);
    expect(stub.options.method).toBe('POST');
    expect(stub.options.path).toBe('/customers');
    expect(stub.options.timeout).toBe(5000);
    expect(stub.options.agent).toBeDefined();
    const headers = stub.options.headers as Record<string, string>;
    expect(headers.Host).toBe('api.suitecentral.example');
    expect(headers['Content-Length']).toBe(String(Buffer.byteLength('{"a":1}')));
    expect(stub.body).toBe('{"a":1}');
  });

  it('drops caller Host / Content-Length / hop-by-hop headers and pins Host', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({
      method: 'GET',
      path: '/x',
      headers: { host: 'evil.example', 'Content-Length': '999', Connection: 'Upgrade', Upgrade: 'websocket', 'X-Custom': 'keep' },
    });
    stub.respond();
    stub.res.emit('end');
    await p;
    const headers = stub.options.headers as Record<string, string>;
    expect(headers.Host).toBe('api.suitecentral.example');
    expect(headers.host).toBeUndefined();
    expect(headers.Connection).toBeUndefined();
    expect(headers.Upgrade).toBeUndefined();
    expect(headers['X-Custom']).toBe('keep');
  });

  it('resolves the request path against the pinned destination base path', async () => {
    const withBase = Object.freeze({
      ...destination,
      canonicalUrl: 'https://api.suitecentral.example/v1/hooks/receive',
    }) as ValidatedSuiteCentralDestination;
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(withBase, 5000);
    const p = client.request({ method: 'POST', path: '' });
    stub.respond();
    stub.res.emit('end');
    await p;
    expect(stub.options.path).toBe('/v1/hooks/receive');
  });

  it('preserves an intentional trailing slash on a webhook target (path === "")', async () => {
    const withSlash = Object.freeze({
      ...destination,
      canonicalUrl: 'https://api.suitecentral.example/hooks/receive/',
    }) as ValidatedSuiteCentralDestination;
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(withSlash, 5000);
    const p = client.request({ method: 'POST', path: '' });
    stub.respond();
    stub.res.emit('end');
    await p;
    expect(stub.options.path).toBe('/hooks/receive/');
  });

  it('joins a relative path onto a base path without a double slash', async () => {
    const withBase = Object.freeze({
      ...destination,
      canonicalUrl: 'https://api.suitecentral.example/api/',
    }) as ValidatedSuiteCentralDestination;
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(withBase, 5000);
    const p = client.request({ method: 'GET', path: '/customers' });
    stub.respond();
    stub.res.emit('end');
    await p;
    expect(stub.options.path).toBe('/api/customers');
  });

  it('rejects absolute / protocol-relative paths', async () => {
    stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    await expect(client.request({ method: 'GET', path: 'http://169.254.169.254/' })).rejects.toThrow(
      'pinned_transport_absolute_url_forbidden',
    );
    await expect(client.request({ method: 'GET', path: '//evil.example/x' })).rejects.toThrow(
      'pinned_transport_absolute_url_forbidden',
    );
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each([
    '/../admin',
    '/v1/../../secret',
    '/a\\b',
    '/%2e%2e/admin',
    '/a%2fb',
    '/a%5cb',
    '/%252e%252e/admin', // double-encoded traversal
    '/%25%32%65/x', // triple-nested percent
  ])('rejects traversal / encoded-separator path %s', async (path) => {
    stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    await expect(client.request({ method: 'GET', path })).rejects.toThrow('pinned_transport_unsafe_path');
    expect(https.request).not.toHaveBeenCalled();
  });

  it('rejects a malformed percent-encoding in the path', async () => {
    stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    await expect(client.request({ method: 'GET', path: '/%zz' })).rejects.toThrow('pinned_transport_unsafe_path');
  });

  it('settles (does not hang or crash) when https.request throws synchronously', async () => {
    jest.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('boom_invalid_option');
    });
    const client = new PinnedHttpsTransport().create(destination, 5000);
    await expect(client.request({ method: 'GET', path: '/' })).rejects.toThrow('boom_invalid_option');
  });

  it('rejects a response that exceeds the size cap', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({ method: 'GET', path: '/' });
    stub.respond();
    stub.res.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(p).rejects.toThrow('pinned_transport_response_too_large');
    expect(stub.req.destroy).toHaveBeenCalled();
  });

  it('rejects a response fragmented past the chunk cap', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({ method: 'GET', path: '/' });
    stub.respond();
    for (let i = 0; i < 10001; i += 1) {
      stub.res.emit('data', Buffer.from('a'));
    }
    await expect(p).rejects.toThrow('pinned_transport_response_too_large');
  });

  it('rejects when the response stream closes prematurely (mid-body abort)', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({ method: 'GET', path: '/' });
    stub.respond();
    stub.res.emit('data', Buffer.from('{"partial":'));
    stub.res.emit('close'); // no 'end' — remote aborted
    await expect(p).rejects.toThrow('pinned_transport_response_incomplete');
  });

  it('rejects an upgrade (101) response instead of hanging', async () => {
    const stub = stubHttps();
    const client = new PinnedHttpsTransport().create(destination, 5000);
    const p = client.request({ method: 'GET', path: '/' });
    const socket = { destroy: jest.fn() };
    stub.req.emit('upgrade', {}, socket);
    await expect(p).rejects.toThrow('pinned_transport_upgrade_forbidden');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('rejects on the wall-clock deadline', async () => {
    jest.useFakeTimers();
    try {
      const stub = stubHttps();
      const client = new PinnedHttpsTransport().create(destination, 5000);
      const p = client.request({ method: 'GET', path: '/' });
      const assertion = expect(p).rejects.toThrow('pinned_transport_deadline');
      jest.advanceTimersByTime(5000);
      await assertion;
      expect(stub.req.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails fast when the destination has no validated addresses', () => {
    const empty = Object.freeze({
      ...destination,
      addresses: Object.freeze([]),
    }) as ValidatedSuiteCentralDestination;
    expect(() => new PinnedHttpsTransport().create(empty, 5000)).toThrow(
      'validated_destination_has_no_addresses',
    );
  });

  describe('pinned DNS lookup', () => {
    async function captureLookup(dest = destination): Promise<LookupFn> {
      const stub = stubHttps();
      const client = new PinnedHttpsTransport().create(dest, 5000);
      const p = client.request({ method: 'GET', path: '/' });
      stub.respond();
      stub.res.emit('end');
      await p;
      return getLookup(stub.options.agent);
    }

    it('returns the validated addresses for the pinned host (all: true)', async () => {
      const lookup = await captureLookup();
      let seen: LookupAddress[] | undefined;
      lookup('api.suitecentral.example', { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        seen = addresses as LookupAddress[];
      });
      expect(seen).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
    });

    it('honors a requested IPv6 family (all: false)', async () => {
      const lookup = await captureLookup();
      let addr: unknown;
      let fam: number | undefined;
      lookup('api.suitecentral.example', { family: 6 }, (err, address, family) => {
        expect(err).toBeNull();
        addr = address;
        fam = family;
      });
      expect(addr).toBe('2606:2800:220:1:248:1893:25c8:1946');
      expect(fam).toBe(6);
    });

    it('rejects any other hostname', async () => {
      const lookup = await captureLookup();
      let error: Error | null = null;
      lookup('evil.example', { all: true }, (err) => {
        error = err;
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as unknown as Error).message).toBe('validated_destination_hostname_mismatch');
    });

    it('errors when no validated address matches the requested family', async () => {
      const ipv4Only = Object.freeze({
        ...destination,
        addresses: Object.freeze([{ address: '93.184.216.34', family: 4 as const }]),
      }) as ValidatedSuiteCentralDestination;
      const lookup = await captureLookup(ipv4Only);
      let error: Error | null = null;
      lookup('api.suitecentral.example', { all: true, family: 6 }, (err) => {
        error = err;
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as unknown as Error).message).toBe('validated_destination_no_address_for_family');
    });
  });
});
