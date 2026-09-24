import { AxiosError, type AxiosAdapter } from 'axios';
import { inspect } from 'node:util';
import type { AuthCredentials, AuthService as AuthServiceType } from '../../../src/services/AuthService';
import { BusinessCentralConnector } from '../../../src/connectors/BusinessCentralConnector';
import { DynamicsConnector } from '../../../src/connectors/DynamicsConnector';
import { SalesforceConnector } from '../../../src/connectors/SalesforceConnector';
import type { AuthConfig } from '../../../src/types';
import type { Logger } from '../../../src/utils/Logger';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

const { AuthService } = jest.requireActual<typeof import('../../../src/services/AuthService')>('../../../src/services/AuthService');
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
class BC extends BusinessCentralConnector {
  get authenticated(): boolean { return this.isAuthenticated; }
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  business(): Promise<unknown> { return this.makeRequest({ method: 'GET', url: '/business' }); }
}
class Dynamics extends DynamicsConnector {
  get authenticated(): boolean { return this.isAuthenticated; }
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  business(): Promise<unknown> { return this.makeRequest({ method: 'GET', url: '/business' }); }
}
class Salesforce extends SalesforceConnector {
  get authenticated(): boolean { return this.isAuthenticated; }
  setAdapter(adapter: AxiosAdapter): void { this.httpClient.defaults.adapter = adapter; }
  business(): Promise<unknown> { return this.makeRequest({ method: 'GET', url: '/business' }); }
}
type Fixture = BC | Dynamics | Salesforce;
const cases: Array<[string, (service: AuthServiceType) => Fixture]> = [
  ['Business Central', service => new BC('bc', logger, service, createMockOutboundGovernanceService())],
  ['Dynamics', service => new Dynamics('d', logger, service)],
  ['Salesforce', service => new Salesforce('sf', logger, service, createMockOutboundGovernanceService())],
];
const config = (secret: string, tenant: string): AuthConfig => ({
  type: 'oauth2', credentials: {
    clientId: 'shared-client', clientSecret: secret, tenantId: tenant,
    companyId: 'company', resourceUrl: `https://${tenant}.example.invalid`,
    loginUrl: `https://${tenant}.example.invalid`, instanceUrl: `https://${tenant}.example.invalid`,
    username: 'user', password: 'password',
  },
});
const tokenResponse = (token: string): Response => new Response(JSON.stringify({
  access_token: token, expires_in: 3600, token_type: 'Bearer',
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const previous = { NODE_ENV: process.env.NODE_ENV, DEMO_MODE: process.env.DEMO_MODE, FORCE_DISABLE_DEMO_MODE: process.env.FORCE_DISABLE_DEMO_MODE, JWT_SECRET: process.env.JWT_SECRET };
let service: AuthServiceType;
let fetchSpy: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false'; process.env.FORCE_DISABLE_DEMO_MODE = 'true';
  process.env.JWT_SECRET = 'tH8+fR2!mK7@pW9#zC4%uN6^bJ3&xV5*qL0(iS8)oD2_eG7-rA9=vY4[hU6]nP1+k5';
  service = new AuthService(logger);
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  service?.cleanup(); fetchSpy?.mockRestore();
  for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

it.each(cases)('%s exchanges replacement credentials despite a same-client cached token', async (_name, create) => {
  const requests: Array<{ url: string; secret: string | null }> = [];
  fetchSpy.mockImplementation(async (url, init) => {
    const secret = new URLSearchParams(String(init?.body)).get('client_secret');
    requests.push({ url: String(url), secret });
    return tokenResponse(String(secret));
  });
  const c = create(service); const headers: string[] = [];
  c.setAdapter(async request => {
    headers.push(String(request.headers.get('Authorization')));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  await c.initialize(config('old-secret', 'old-tenant')); await c.business();
  await c.initialize(config('new-secret', 'new-tenant')); await c.business();
  expect(requests.map(request => request.secret)).toEqual(['old-secret', 'new-secret']);
  expect(requests[1].url).not.toBe(requests[0].url);
  expect(headers).toEqual(['Bearer old-secret', 'Bearer new-secret']);
});

describe.each([200, 401])('second business response %s', secondStatus => {
  it.each(cases)('%s obtains a fresh token for one 401 replay and stops after the second 401', async (_name, create) => {
    fetchSpy.mockResolvedValueOnce(tokenResponse('first')).mockResolvedValueOnce(tokenResponse('second'));
    const c = create(service); const headers: string[] = [];
    c.setAdapter(async request => {
      headers.push(String(request.headers.get('Authorization')));
      const status = headers.length === 1 ? 401 : secondStatus;
      const response = { status, statusText: 'fixture', headers: {}, config: request, data: {} };
      if (status === 401) throw new AxiosError('Unauthorized', 'ERR_BAD_RESPONSE', request, undefined, response);
      return response;
    });
    await c.initialize(config('secret', 'tenant'));
    if (secondStatus === 401) await expect(c.business()).rejects.toThrow(); else await c.business();
    expect(headers).toEqual(['Bearer first', 'Bearer second']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

it.each(cases)('%s does not share another instance\'s pending exchange with different credentials', async (_name, create) => {
  let enterFirst!: () => void; let releaseFirst!: () => void;
  const entered = new Promise<void>(resolve => { enterFirst = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  fetchSpy.mockImplementation(async (_url, init) => {
    const secret = new URLSearchParams(String(init?.body)).get('client_secret');
    if (secret === 'first-secret') { enterFirst(); await release; }
    return tokenResponse(String(secret));
  });
  const first = create(service); const second = create(service); const headers: string[] = [];
  for (const c of [first, second]) c.setAdapter(async request => {
    headers.push(String(request.headers.get('Authorization')));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  await first.initialize(config('first-secret', 'first-tenant')); await second.initialize(config('second-secret', 'second-tenant'));
  const pendingFirst = first.authenticate(); await entered;
  const pendingSecond = second.authenticate(); await Promise.resolve(); releaseFirst();
  await Promise.all([pendingFirst, pendingSecond]);
  await first.business(); await second.business();
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(headers).toEqual(['Bearer first-secret', 'Bearer second-secret']);
});

it.each(cases)('%s refuses a failed replacement exchange without exposing token-service secrets', async (_name, create) => {
  const canary = 'credential-response-canary';
  fetchSpy.mockResolvedValueOnce(tokenResponse('old-token')).mockResolvedValue(new Response(JSON.stringify({ error_description: canary }), { status: 401 }));
  const c = create(service); let businessCalls = 0;
  c.setAdapter(async request => {
    businessCalls++;
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  await c.initialize(config('old-secret', 'old-tenant')); await c.business();
  await c.initialize(config('bad-secret', 'new-tenant'));
  const result: { failed: boolean; error?: unknown } = await c.business().then(() => ({ failed: false }), (error: unknown) => ({ failed: true, error }));
  expect(result.failed).toBe(true); expect(c.authenticated).toBe(false); expect(businessCalls).toBe(1);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(inspect([result.error, ...['debug', 'info', 'warn', 'error'].map(level => (logger[level as keyof Logger] as jest.Mock).mock.calls)], { depth: 20 })).not.toContain(canary);
});

const serviceCredentials = (secret: string): AuthCredentials => ({ type: 'oauth2', credentials: {
  client_id: 'shared-client', client_secret: secret, token_url: 'https://identity.invalid/token',
} });

it('fresh exchanges do not read or overwrite the legacy cached API', async () => {
  fetchSpy.mockImplementation(async (_url, init) => tokenResponse(String(new URLSearchParams(String(init?.body)).get('client_secret'))));
  expect((await service.authenticateOAuth2(serviceCredentials('old'))).accessToken).toBe('old');
  expect((await service.authenticateOAuth2(serviceCredentials('new'), { cache: 'bypass' })).accessToken).toBe('new');
  expect((await service.authenticateOAuth2(serviceCredentials('old'))).accessToken).toBe('old');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('fresh exchanges neither join nor overwrite an already-pending legacy exchange', async () => {
  let enterFirst!: () => void; let releaseFirst!: () => void;
  const entered = new Promise<void>(resolve => { enterFirst = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  fetchSpy.mockImplementation(async (_url, init) => {
    const secret = new URLSearchParams(String(init?.body)).get('client_secret');
    if (secret === 'old') { enterFirst(); await release; }
    return tokenResponse(String(secret));
  });
  const old = service.authenticateOAuth2(serviceCredentials('old')); await entered;
  const current = service.authenticateOAuth2(serviceCredentials('new'), { cache: 'bypass' });
  await Promise.resolve(); releaseFirst();
  expect((await old).accessToken).toBe('old'); expect((await current).accessToken).toBe('new');
  expect((await service.authenticateOAuth2(serviceCredentials('old'))).accessToken).toBe('old');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('fresh explicit demo exchanges preserve simulation without populating the shared cache', async () => {
  process.env.NODE_ENV = 'test';
  const credentials: AuthCredentials = { type: 'oauth2', credentials: { client_id: 'demo-client', client_secret: 'demo-value', token_url: 'https://demo.invalid/token' } };
  expect((await service.authenticateOAuth2(credentials, { cache: 'bypass' })).accessToken).toContain('demo-access-token');
  expect(fetchSpy).not.toHaveBeenCalled(); expect(service.getTokenCacheStats().totalTokens).toBe(0);
});

it.each(['http', 'network'])('fresh exchange failures redact secret material from errors and logs (%s)', async mode => {
  const canary = 'token-server-echo-canary';
  if (mode === 'http') fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error_description: canary }), { status: 401 }));
  else fetchSpy.mockRejectedValue(new Error(canary));
  const error = await service.authenticateOAuth2(serviceCredentials('bad'), { cache: 'bypass' }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(inspect([error, ...['debug', 'info', 'warn', 'error'].map(level => (logger[level as keyof Logger] as jest.Mock).mock.calls)], { depth: 20 })).not.toContain(canary);
});

it.each([
  { access_token: ' ', expires_in: 3600 }, { access_token: 42, expires_in: 3600 },
  { access_token: 'token', expires_in: 'invalid' }, { access_token: 'token', expires_in: -1 },
  { access_token: 'token', expires_in: 1e308 },
  ...[null, 0, false, '', '3600', true].map(expires_in => ({ access_token: 'token', expires_in })),
])('fresh exchanges refuse malformed token information: %j', async payload => {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
  await expect(service.authenticateOAuth2(serviceCredentials('valid'), { cache: 'bypass' })).rejects.toThrow();
  expect(service.getTokenCacheStats().totalTokens).toBe(0);
});

it.each([undefined, 0])('legacy exchanges retain their default expiry behavior (%s)', async expires_in => {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'legacy', expires_in }), { status: 200 }));
  const before = Date.now();
  const result = await service.authenticateOAuth2(serviceCredentials('valid'));
  expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
});

it('fresh exchanges retain the local one-hour reuse deadline when expiry is omitted', async () => {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh' }), { status: 200 }));
  const before = Date.now();
  const result = await service.authenticateOAuth2(serviceCredentials('valid'), { cache: 'bypass' });
  expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
  expect(service.getTokenCacheStats().totalTokens).toBe(0);
});

it('Business Central refreshes metadata configuration after company discovery', async () => {
  const connector = new BC('bc', logger, service, createMockOutboundGovernanceService());
  fetchSpy.mockResolvedValue(tokenResponse('token'));
  connector.setAdapter(async request => ({ status: 200, statusText: 'OK', headers: {}, config: request, data: { value: [{ id: 'discovered-company' }] } }));
  const initial = config('secret', 'tenant');
  delete initial.credentials.companyId;
  await connector.initialize(initial);
  await connector.authenticate();
  expect(await connector.getFieldCatalog('customers')).not.toBeNull();
  expect(logger.debug).toHaveBeenCalledWith('Fetching BC metadata from API', expect.objectContaining({ metadataURL: expect.stringContaining('/companies(discovered-company)/$metadata') }));
  // This production-mode metadata path currently falls back to fixtures.
  expect(logger.warn).toHaveBeenCalledWith('Live BC metadata fetch not yet implemented, falling back to fixture');
});
