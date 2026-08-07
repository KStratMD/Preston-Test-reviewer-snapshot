// Real timers: the connector's rate limiter uses setTimeout only when it runs
// out of tokens, which these low-volume tests never trigger.
jest.useRealTimers();

import { SuiteCentralConnectorProd } from '../../../../src/connectors/SuiteCentralConnectorProd';
import type {
  PinnedHttpsClient,
  PinnedRequestOptions,
  PinnedResponse,
} from '../../../../src/services/suitecentral/controlPlane/PinnedHttpsTransport';
import type { Logger } from '../../../../src/utils/Logger';
import type { AuthConfig, DataRecord } from '../../../../src/types';

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

interface MockPinnedClient extends PinnedHttpsClient {
  request: jest.Mock<Promise<PinnedResponse>, [PinnedRequestOptions]>;
}

function makeClient(): MockPinnedClient {
  return { request: jest.fn() } as MockPinnedClient;
}

function resp(status: number, data: unknown, headers: Record<string, unknown> = {}): PinnedResponse {
  return { status, data, headers };
}

const authConfig: AuthConfig = {
  type: 'oauth2',
  credentials: {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    baseUrl: 'https://api.suitecentral.example',
    apiVersion: 'v1',
    environment: 'production',
  },
};

function tokenResponse(token = 'tok-123'): PinnedResponse {
  return resp(200, { access_token: token, expires_in: 300 });
}

afterEach(() => jest.clearAllMocks());

describe('SuiteCentralConnectorProd — pinned transport', () => {
  it('routes the OAuth token exchange through the injected pinned client with a RELATIVE path', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce(tokenResponse('tok-abc'));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const ok = await connector.authenticate();

    expect(ok).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(1);
    const call = client.request.mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/oauth/token');
    expect(call.data).toMatchObject({ grant_type: 'client_credentials', client_id: 'client-abc' });
    // No bearer token yet, so the OAuth request must NOT carry Authorization.
    expect(call.headers?.Authorization).toBeUndefined();
  });

  it('injects a per-request bearer token on authenticated API calls', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse('tok-123')) // authenticate()
      .mockResolvedValueOnce(resp(200, { customerId: 'c1' })); // read()

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const record = await connector.read('customers', 'c1');

    expect(record?.id).toBe('c1');
    const readCall = client.request.mock.calls[1][0];
    expect(readCall.method).toBe('GET');
    expect(readCall.path).toBe('/api/v1/customers/c1');
    expect(readCall.headers?.Authorization).toBe('Bearer tok-123');
  });

  it('sends create() through the pinned client at the entity endpoint', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(201, { customerId: 'c9' }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const input = {
      fields: { customerId: 'c9', companyName: 'Acme', status: 'active' },
    } as unknown as DataRecord;
    const created = await connector.create('customers', input);

    expect(created.id).toBe('c9');
    const createCall = client.request.mock.calls[1][0];
    expect(createCall.method).toBe('POST');
    expect(createCall.path).toBe('/api/v1/customers');
    expect(createCall.headers?.Authorization).toBe('Bearer tok-123');
  });

  it('translates a non-2xx status into an axios-shaped error so read() returns null on 404', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(404, { error: 'not found' }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    expect(await connector.read('customers', 'missing')).toBeNull();
  });

  it('delete() returns false on a 404 from the pinned client', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(404, {}));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    expect(await connector.delete('customers', 'missing')).toBe(false);
  });

  it('testConnection() reads status/headers directly and does NOT throw on a healthy 200', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(200, {}, { 'x-response-time': '42' }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const status = await connector.testConnection();
    expect(status.isConnected).toBe(true);
    expect(status.latency).toBe(42);
    const healthCall = client.request.mock.calls[1][0];
    expect(healthCall.path).toBe('/api/v1/health');
  });

  it('testConnection() reports not-connected on a non-2xx status without throwing', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(503, {}));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const status = await connector.testConnection();
    expect(status.isConnected).toBe(false);
  });

  it('list() encodes query params onto the relative path', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(resp(200, { items: [{ customerId: 'c1' }, { customerId: 'c2' }] }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    const rows = await connector.list('customers', { limit: 25, offset: 5 });

    expect(rows).toHaveLength(2);
    const listCall = client.request.mock.calls[1][0];
    expect(listCall.path).toContain('/api/v1/customers?');
    expect(listCall.path).toContain('limit=25');
    expect(listCall.path).toContain('offset=5');
  });

  it('fails closed when constructed WITHOUT a pinned client (inert DI instance)', async () => {
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger);
    await connector.initialize(authConfig);

    await expect(connector.authenticate()).rejects.toThrow(/transport_not_configured/);
  });

  it('fails fast on an unexpected environment value instead of coercing to sandbox', async () => {
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, makeClient());
    const bad = { ...authConfig, credentials: { ...authConfig.credentials, environment: 'staging' } };
    await expect(connector.initialize(bad)).rejects.toThrow(/Invalid SuiteCentral environment/);
  });

  it('defaults environment to sandbox only when the field is unset', async () => {
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, makeClient());
    const creds = { ...authConfig.credentials };
    delete (creds as { environment?: unknown }).environment;
    await expect(connector.initialize({ ...authConfig, credentials: creds })).resolves.toBeUndefined();
  });
});

describe('SuiteCentralConnectorProd — one-shot initialization (Finding 1)', () => {
  it('rejects a SECOND initialize() so a sealed connector cannot be rebound to another tenant', async () => {
    const client = makeClient();
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);

    await connector.initialize(authConfig);

    const otherTenant: AuthConfig = {
      type: 'oauth2',
      credentials: {
        clientId: 'attacker-client',
        clientSecret: 'attacker-secret',
        baseUrl: 'https://api.suitecentral.example',
        environment: 'production',
      },
    };
    await expect(connector.initialize(otherTenant)).rejects.toThrow(/already_initialized/);
  });

  it('allows a retry after a FAILED first initialize (seal only on success)', async () => {
    const client = makeClient();
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);

    // Wrong auth type → initialize throws before sealing.
    await expect(
      connector.initialize({ type: 'apikey', credentials: {} } as unknown as AuthConfig),
    ).rejects.toThrow(/requires OAuth2/);

    // A subsequent valid initialize must still succeed.
    await expect(connector.initialize(authConfig)).resolves.toBeUndefined();
  });
});

describe('SuiteCentralConnectorProd — fail-closed OAuth token validation (Finding 2)', () => {
  it('throws when the token response has no access_token and does NOT authenticate', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce(resp(200, { expires_in: 300 }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    await expect(connector.authenticate()).rejects.toThrow(/Authentication failed/);
    // No token was set: a follow-up auth-required call fails closed.
    await expect(connector.read('customers', 'c1')).rejects.toThrow();
  });

  it('throws when access_token is an empty string', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce(resp(200, { access_token: '', expires_in: 300 }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    await expect(connector.authenticate()).rejects.toThrow(/Authentication failed/);
  });

  it('throws when expires_in is missing', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce(resp(200, { access_token: 'tok-1' }));

    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    await expect(connector.authenticate()).rejects.toThrow(/Authentication failed/);
  });

  it('throws when expires_in is non-positive or non-finite', async () => {
    const connector1 = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, (() => {
      const c = makeClient();
      c.request.mockResolvedValueOnce(resp(200, { access_token: 'tok-1', expires_in: 0 }));
      return c;
    })());
    await connector1.initialize(authConfig);
    await expect(connector1.authenticate()).rejects.toThrow(/Authentication failed/);

    const connector2 = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, (() => {
      const c = makeClient();
      c.request.mockResolvedValueOnce(resp(200, { access_token: 'tok-1', expires_in: Number.POSITIVE_INFINITY }));
      return c;
    })());
    await connector2.initialize(authConfig);
    await expect(connector2.authenticate()).rejects.toThrow(/Authentication failed/);
  });

  it('throws when a finite expires_in overflows to an invalid/non-future expiry', async () => {
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, (() => {
      const c = makeClient();
      // Number.MAX_VALUE is finite and positive but Date.now() + it*1000 = Infinity → Invalid Date.
      c.request.mockResolvedValueOnce(resp(200, { access_token: 'tok-1', expires_in: Number.MAX_VALUE }));
      return c;
    })());
    await connector.initialize(authConfig);
    await expect(connector.authenticate()).rejects.toThrow(/Authentication failed/);
  });

  it.each([
    ['missing', {}],
    ['empty string', { id: '' }],
    ['NaN', { id: Number.NaN }],
    ['Infinity', { id: Number.POSITIVE_INFINITY }],
    ['object', { id: {} }],
  ])('setupWebhook fails closed when the response id is %s', async (_label, data) => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce(tokenResponse()) // authenticate()
      .mockResolvedValueOnce(resp(200, data)); // webhook POST
    const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
    await connector.initialize(authConfig);

    await expect(connector.setupWebhook('https://hooks.example/x', ['e'])).rejects.toThrow(/webhook response/);
  });

  it('reauthenticates when the token has expired', async () => {
    jest.useFakeTimers();
    try {
      const client = makeClient();
      client.request
        .mockResolvedValueOnce(resp(200, { access_token: 'tok-1', expires_in: 300 })) // initial auth
        .mockResolvedValueOnce(resp(200, { customerId: 'c1' }))                        // read #1
        .mockResolvedValueOnce(resp(200, { access_token: 'tok-2', expires_in: 300 })) // reauth
        .mockResolvedValueOnce(resp(200, { customerId: 'c1' }));                       // read #2

      const connector = new SuiteCentralConnectorProd('suitecentral-prod', logger, undefined, client);
      await connector.initialize(authConfig);

      await connector.read('customers', 'c1'); // auth + read with tok-1
      expect(client.request.mock.calls[1][0].headers?.Authorization).toBe('Bearer tok-1');

      jest.advanceTimersByTime(301_000); // move past the token expiry

      await connector.read('customers', 'c1'); // must reauthenticate first
      expect(client.request.mock.calls[2][0].path).toBe('/oauth/token');
      expect(client.request.mock.calls[3][0].headers?.Authorization).toBe('Bearer tok-2');
    } finally {
      jest.useRealTimers();
    }
  });
});
