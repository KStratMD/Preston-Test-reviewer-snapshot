import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig } from 'axios';
import { getOAuth1AuthorizationHeader } from '../../../src/utils/oauth1Helper';
import { BaseConnector } from '../../../src/core/BaseConnector';
import { AdyenConnector } from '../../../src/connectors/AdyenConnector';
import { PayPalConnector } from '../../../src/connectors/PayPalConnector';
import { StripeConnector } from '../../../src/connectors/StripeConnector';
import { DynamicsConnector } from '../../../src/connectors/DynamicsConnector';
import { SalesforceConnector } from '../../../src/connectors/SalesforceConnector';
import { OracleConnector } from '../../../src/connectors/OracleConnector';
import { SAPConnector } from '../../../src/connectors/SAPConnector';
import { ShopifyConnector } from '../../../src/connectors/ShopifyConnector';
import { ShipStationConnector } from '../../../src/connectors/ShipStationConnector';
import { NetSuiteConnector } from '../../../src/connectors/NetSuiteConnector';
import { SuiteCentralProductionConnector } from '../../../src/connectors/SuiteCentralProductionConnector';
import { BusinessCentralConnector } from '../../../src/connectors/BusinessCentralConnector';
import { MockConnectorBase } from '../../../src/connectors/MockConnectorBase';
import type { Logger } from '../../../src/utils/Logger';
import type { AuthService } from '../../../src/services/AuthService';
import type { AuthConfig } from '../../../src/types';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

class Adyen extends AdyenConnector {
  setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; }
  business(): Promise<unknown> { return this.makeRequest({ method: 'GET', url: '/business' }); }
}
class Shopify extends ShopifyConnector { setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; } }
class ShipStation extends ShipStationConnector { setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; } }
class NetSuite extends NetSuiteConnector {
  setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; }
  dispatch(config: AxiosRequestConfig): Promise<unknown> { return this.makeRequest(config); }
}
class Mock extends MockConnectorBase {
  protected getDefaultBaseUrl(): string { return 'https://mock.invalid'; }
  protected async seedData(): Promise<void> {}
  getSystemInfo = jest.fn();
}
class PayPal extends PayPalConnector {
  get authenticated(): boolean { return this.isAuthenticated; }
  setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; }
  business(): Promise<unknown> { return this.makeRequest({ method: 'GET', url: '/business' }); }
}
class Stripe extends StripeConnector { setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; } }
class Oracle extends OracleConnector { setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; } }
class SAP extends SAPConnector { setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; } }
class SuiteCentralLegacy extends SuiteCentralProductionConnector {
  setAdapter(a: AxiosAdapter): void { this.httpClient.defaults.adapter = a; }
  get authorization(): unknown { return this.httpClient.defaults.headers.common.Authorization; }
}
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
const exchange = jest.fn();
const exchangeOAuth1 = jest.fn();
const service = { authenticateOAuth2: exchange, authenticateOAuth1: exchangeOAuth1 } as unknown as AuthService;
const oauth: AuthConfig = { type: 'oauth2', credentials: { clientId: 'live-client', clientSecret: 'secret', tenantId: 'tenant', username: 'live-user', password: 'password', resourceUrl: 'https://tenant.invalid', loginUrl: 'https://login.invalid' } };
const basic: AuthConfig = { type: 'basic', credentials: { username: 'user', password: 'password', host: 'host.invalid', client: '100' } };
type Fixture = BaseConnector & { setAdapter?: (a: AxiosAdapter) => void };
const cases: Array<[string, () => Fixture, AuthConfig]> = [
  ['Adyen', () => new Adyen('Adyen', 'a', logger), { type: 'api_key', credentials: { apiKey: 'live-key', merchantAccount: 'merchant' } }],
  ['PayPal', () => new PayPal('PayPal', 'p', logger), oauth],
  ['Stripe', () => new Stripe('Stripe', 's', logger), { type: 'api_key', credentials: { apiKey: 'sk_live_key' } }],
  ['Dynamics', () => new DynamicsConnector('d', logger, service), oauth],
  ['Salesforce', () => new SalesforceConnector('sf', logger, service, createMockOutboundGovernanceService()), oauth],
  ['Oracle', () => new Oracle('o', logger, service, createMockOutboundGovernanceService()), basic],
  ['SAP', () => new SAP('sap', logger, service), basic],
];
const previous = { NODE_ENV: process.env.NODE_ENV, DEMO_MODE: process.env.DEMO_MODE, FORCE_DISABLE_DEMO_MODE: process.env.FORCE_DISABLE_DEMO_MODE };
afterEach(() => {
  for (const key of ['NODE_ENV', 'DEMO_MODE', 'FORCE_DISABLE_DEMO_MODE'] as const) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

const invalid: AuthConfig = { type: 'basic', credentials: {} };
it('preserves keyless SuiteCentral demo authentication without reviving rejected configuration', async () => {
  const c = new SuiteCentralLegacy('SuiteCentral', 'demo', logger, service);
  const adapter = jest.fn(); c.setAdapter(adapter);
  await expect(c.authenticate()).rejects.toThrow();
  const demo: AuthConfig = { type: 'api_key', credentials: { productionMode: false } };
  await c.initialize(demo);
  await expect(c.authenticate()).resolves.toBe(true);
  expect((await c.getSystemInfo()).name).toContain('Demo');
  await expect(c.initialize(invalid)).rejects.toThrow('API key authentication');
  await expect(c.authenticate()).rejects.toThrow();
  await expect(c.getSystemInfo()).rejects.toThrow();
  expect(c.authorization).toBeUndefined();
  await c.initialize(demo);
  await expect(c.authenticate()).resolves.toBe(true);
  expect(adapter).not.toHaveBeenCalled();
});

it('rejects a keyless SuiteCentral production probe before dispatch and retains initialization fallback', async () => {
  const c = new SuiteCentralLegacy('SuiteCentral', 'fallback', logger, service);
  const adapter = jest.fn(); c.setAdapter(adapter);
  jest.mocked(logger.warn).mockClear();
  await c.initialize({ type: 'api_key', credentials: { productionMode: true } });
  expect(logger.warn).toHaveBeenCalledWith(
    'SuiteCentral production connection failed, falling back to demo mode',
    { error: expect.objectContaining({ message: expect.stringContaining('SuiteCentral API key is not configured') }) },
  );
  await expect(c.authenticate()).resolves.toBe(true);
  expect((await c.getSystemInfo()).name).toContain('Demo');
  expect(adapter).not.toHaveBeenCalled();
});

const replacementCases: Array<[string, () => Fixture, AuthConfig, AuthConfig]> = [
  ['Shopify', () => new Shopify('shop', logger), { type: 'api_key', credentials: { shopName: 'old-shop', accessToken: 'old-token' } }, invalid],
  ['ShipStation', () => new ShipStation(logger, createMockOutboundGovernanceService()), { type: 'api_key', credentials: { apiKey: 'old-key', apiSecret: 'old-secret' } }, invalid],
  ['Dynamics', () => new DynamicsConnector('d', logger, service), oauth, invalid],
  ['Salesforce', () => new SalesforceConnector('sf', logger, service, createMockOutboundGovernanceService()), oauth, invalid],
  ['Oracle', () => new Oracle('o', logger, service, createMockOutboundGovernanceService()), basic, { type: 'oauth2', credentials: {} }],
  ['SAP', () => new SAP('sap', logger, service), basic, { type: 'oauth2', credentials: {} }],
  ['NetSuite', () => new NetSuiteConnector('ns', logger, service, createMockOutboundGovernanceService()), { type: 'oauth1', credentials: { accountId: 'OLD_ACCOUNT', consumerKey: 'old-consumer', consumerSecret: 'old-secret', tokenId: 'old-token', tokenSecret: 'old-token-secret' } }, invalid],
  ['SuiteCentral legacy demo', () => new SuiteCentralProductionConnector('SuiteCentral', 'sc', logger, service), { type: 'api_key', credentials: { apiKey: 'old-key', productionMode: false } }, invalid],
  ['BusinessCentral', () => new BusinessCentralConnector('bc', logger, service, createMockOutboundGovernanceService()), { ...oauth, credentials: { ...oauth.credentials, companyId: 'company' } }, invalid],
  ['MockConnectorBase', () => new Mock('Mock', 'm', logger, service), { type: 'api_key', credentials: { apiKey: 'old-key' } }, invalid],
];

it.each(replacementCases)('%s refuses authentication after a rejected replacement without using old credentials', async (_name, create, valid, replacement) => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = create(); const requests: string[] = [];
  c.setAdapter?.(async request => {
    requests.push(String(request.headers));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  exchange.mockReset().mockResolvedValue({ accessToken: 'token', expiresAt: new Date(Date.now() + 600_000) });
  exchangeOAuth1.mockReset().mockResolvedValue(valid.credentials);
  await c.initialize(valid); expect(await c.authenticate()).toBe(true);
  await expect(c.initialize(replacement)).rejects.toThrow();
  requests.length = 0; exchange.mockClear(); exchangeOAuth1.mockClear();
  const result = await c.authenticate().catch(() => false);
  expect(result).toBe(false);
  expect(requests).toEqual([]); expect(exchange).not.toHaveBeenCalled(); expect(exchangeOAuth1).not.toHaveBeenCalled();
  await c.initialize(valid); expect(await c.authenticate()).toBe(true);
});

it('Adyen sends the current API key on actual probe and business dispatches after failure and replacement', async () => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = new Adyen('Adyen', 'a', logger); const headers: unknown[] = [];
  c.setAdapter(async request => {
    headers.push(request.headers.get('X-API-Key'));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  await c.initialize({ type: 'api_key', credentials: { apiKey: 'first-key', merchantAccount: 'merchant' } });
  await c.business();
  await c.initialize({ type: 'api_key', credentials: {} });
  expect(await c.authenticate()).toBe(false);
  await c.initialize({ type: 'api_key', credentials: { apiKey: 'second-key', merchantAccount: 'merchant' } });
  await c.business();
  expect(headers).toEqual(['first-key', 'first-key', 'second-key', 'second-key']);
});

it.each([
  ['Adyen', () => new Adyen('Adyen', 'a', logger), { type: 'api_key', credentials: { apiKey: 'live-key', merchantAccount: 'merchant' } }, 'https://checkout-test.adyen.com/v1/me'],
  ['PayPal', () => new PayPal('PayPal', 'p', logger), oauth, 'https://api-m.sandbox.paypal.com/v1/oauth2/token'],
  ['Stripe', () => new Stripe('Stripe', 's', logger), { type: 'api_key', credentials: { apiKey: 'sk_live_key' } }, 'https://api.stripe.com/v1/account'],
] as Array<[string, () => Fixture, AuthConfig, string]>)('%s resolves its probe URL against the configured vendor origin', async (_name, create, config, expected) => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = create(); const urls: string[] = [];
  c.setAdapter?.(async request => {
    urls.push(axios.getUri(request));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: { access_token: 'token', expires_in: 3600 } };
  });
  await c.initialize(config); expect(urls).toEqual([expected]);
});

it('Business Central discards its previous metadata client on rejected replacement', async () => {
  process.env.NODE_ENV = 'test'; process.env.DEMO_MODE = 'true';
  const c = new BusinessCentralConnector('bc', logger, service, createMockOutboundGovernanceService());
  await c.initialize(oauth);
  expect(c.getSupportedEntityTypes().length).toBeGreaterThan(0);
  expect(await c.getFieldCatalog('customers')).not.toBeNull();
  await expect(c.initialize(invalid)).rejects.toThrow();
  expect(c.getSupportedEntityTypes()).toEqual([]);
  expect(await c.getFieldCatalog('customers')).toBeNull();
  await c.initialize(oauth); expect(c.getSupportedEntityTypes().length).toBeGreaterThan(0);
});

it.each([401, 503])('NetSuite signs each physical retry with current tokens and a fresh nonce (status=%s)', async status => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = new NetSuite('ns', logger, service, createMockOutboundGovernanceService());
  c.maxRetries = 2;
  const credentials = { accountId: 'ACCOUNT', consumerKey: 'consumer', consumerSecret: 'secret', tokenId: 'old-token', tokenSecret: 'old-secret' };
  exchangeOAuth1.mockReset().mockResolvedValueOnce(credentials).mockResolvedValue({ ...credentials, tokenId: 'new-token', tokenSecret: 'new-secret' });
  const signatures: string[] = [];
  c.setAdapter(async request => {
    signatures.push(String(request.headers.get('Authorization')));
    const response = { status: 200, statusText: 'OK', headers: {}, config: request, data: { id: '1' } };
    if (signatures.length === 1) throw new AxiosError('retry', 'ERR_BAD_RESPONSE', request, undefined, { ...response, status, headers: { 'retry-after': '0' } });
    return response;
  });
  await c.initialize({ type: 'oauth1', credentials });
  await c.read('customer', '1');
  expect(signatures).toHaveLength(2);
  expect(signatures[0]).toContain('oauth_token="old-token"');
  expect(signatures[1]).toContain(status === 401 ? 'oauth_token="new-token"' : 'oauth_token="old-token"');
  expect(signatures[1].match(/oauth_nonce="([^"]+)"/)?.[1]).not.toBe(signatures[0].match(/oauth_nonce="([^"]+)"/)?.[1]);
});

it('NetSuite signs the final query and preserves body and custom headers on a POST 401 replay', async () => {
  const c = new NetSuite('ns', logger, service, createMockOutboundGovernanceService());
  const credentials = { accountId: 'ACCOUNT', consumerKey: 'consumer', consumerSecret: 'secret', tokenId: 'token', tokenSecret: 'secret' };
  exchangeOAuth1.mockReset().mockResolvedValue(credentials);
  const data = { customer: 'Customer A', quantity: 2 }; let calls = 0;
  c.setAdapter(async request => {
    calls++;
    const header = String(request.headers.get('Authorization'));
    const attrs = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], decodeURIComponent(match[2])]));
    expect(header).toBe(getOAuth1AuthorizationHeader('POST', axios.getUri(request), {
      ...credentials, realm: credentials.accountId, nonce: attrs.oauth_nonce, timestamp: attrs.oauth_timestamp,
    }));
    expect(JSON.parse(request.data as string)).toEqual(data);
    expect(request.headers.get('X-Correlation-ID')).toBe('trace');
    const response = { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
    if (calls === 1) throw new AxiosError('Unauthorized', 'ERR_BAD_RESPONSE', request, undefined, { ...response, status: 401 });
    return response;
  });
  await c.initialize({ type: 'oauth1', credentials });
  await c.dispatch({ method: 'POST', url: '/services/rest/record/v1/customer?name=Customer%20A&limit=2', headers: { 'X-Correlation-ID': 'trace' }, data });
  expect(calls).toBe(2);
});

it('NetSuite signs Axios default GET and base URL when method and URL are omitted', async () => {
  const c = new NetSuite('ns', logger, service, createMockOutboundGovernanceService());
  const credentials = { accountId: 'ACCOUNT', consumerKey: 'consumer', consumerSecret: 'secret', tokenId: 'token', tokenSecret: 'secret' };
  exchangeOAuth1.mockReset().mockResolvedValue(credentials);
  let calls = 0;
  c.setAdapter(async request => {
    calls++;
    const header = String(request.headers.get('Authorization'));
    const attrs = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], decodeURIComponent(match[2])]));
    expect(request.method).toBe('get');
    expect(header).toBe(getOAuth1AuthorizationHeader('GET', axios.getUri(request), {
      ...credentials, realm: credentials.accountId, nonce: attrs.oauth_nonce, timestamp: attrs.oauth_timestamp,
    }));
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
  });
  await c.initialize({ type: 'oauth1', credentials });
  await c.dispatch({});
  expect(calls).toBe(1);
});

it('NetSuite stops after a second 401 and refuses separately supplied query parameters', async () => {
  const c = new NetSuite('ns', logger, service, createMockOutboundGovernanceService());
  const credentials = { accountId: 'ACCOUNT', consumerKey: 'consumer', consumerSecret: 'secret', tokenId: 'token', tokenSecret: 'secret' };
  exchangeOAuth1.mockReset().mockResolvedValue(credentials);
  let calls = 0;
  c.setAdapter(async request => {
    calls++;
    throw new AxiosError('Unauthorized', 'ERR_BAD_RESPONSE', request, undefined, { status: 401, statusText: 'Unauthorized', headers: {}, config: request, data: {} });
  });
  await c.initialize({ type: 'oauth1', credentials });
  await expect(c.read('customer', '1')).rejects.toThrow();
  expect(calls).toBe(2); expect(exchangeOAuth1).toHaveBeenCalledTimes(2);
  await expect(c.dispatch({ method: 'GET', url: '/customer', params: { limit: 2 } })).rejects.toThrow('query parameters');
  expect(calls).toBe(2);
});

it.each(['trailing base slash', 'custom media headers'])('NetSuite preserves its dispatched URI and headers: %s', async scenario => {
  const c = new NetSuite('ns', logger, service, createMockOutboundGovernanceService());
  const credentials = { accountId: 'ACCOUNT', consumerKey: 'consumer', consumerSecret: 'secret', tokenId: 'token', tokenSecret: 'secret', base_url: `https://account.example.invalid${scenario === 'trailing base slash' ? '/' : ''}` };
  exchangeOAuth1.mockReset().mockResolvedValue(credentials);
  const custom = scenario === 'custom media headers'; let calls = 0;
  c.setAdapter(async request => {
    calls++;
    const header = String(request.headers.get('Authorization'));
    const attrs = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], decodeURIComponent(match[2])]));
    expect(header).toBe(getOAuth1AuthorizationHeader('POST', axios.getUri(request), {
      ...credentials, realm: credentials.accountId, nonce: attrs.oauth_nonce, timestamp: attrs.oauth_timestamp,
    }));
    expect(request.headers.get('Content-Type')).toBe(custom ? 'application/custom+json' : 'application/json');
    expect(request.headers.get('Accept')).toBe(custom ? 'application/custom+json' : 'application/json');
    expect(JSON.parse(request.data as string)).toEqual({ name: 'Customer' });
    const response = { status: 200, statusText: 'OK', headers: {}, config: request, data: {} };
    if (calls === 1) throw new AxiosError('Unauthorized', 'ERR_BAD_RESPONSE', request, undefined, { ...response, status: 401 });
    return response;
  });
  await c.initialize({ type: 'oauth1', credentials });
  await c.dispatch({ method: 'post', url: '/services/rest/record/v1/customer?limit=2', data: { name: 'Customer' },
    headers: custom ? { 'content-type': 'application/custom+json', accept: 'application/custom+json', authorization: 'must-be-replaced' } : undefined });
  expect(calls).toBe(2);
});

it.each([
  ['missing token', { expires_in: 3600 }], ['blank token', { access_token: ' ', expires_in: 3600 }],
  ['non-string token', { access_token: 42, expires_in: 3600 }], ['missing expiry', { access_token: 'token' }],
  ['NaN expiry', { access_token: 'token', expires_in: NaN }], ['infinite expiry', { access_token: 'token', expires_in: Infinity }],
  ['negative expiry', { access_token: 'token', expires_in: -1 }], ['zero expiry', { access_token: 'token', expires_in: 0 }],
  ['overflow expiry', { access_token: 'token', expires_in: 1e308 }], ['string expiry', { access_token: 'token', expires_in: '3600' }],
  ['null response', null],
])('PayPal refuses %s token payloads and later recovers', async (_name, invalidPayload) => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = new PayPal('PayPal', 'p', logger); let payload: unknown = invalidPayload; let businessCalls = 0;
  c.setAdapter(async request => {
    if (request.url === '/business') {
      businessCalls++;
      expect(request.headers.get('Authorization')).toBe('Bearer recovered');
    }
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: request.url === '/business' ? {} : payload };
  });
  await c.initialize(oauth);
  const failed = await c.business().then(() => false, () => true);
  expect(businessCalls).toBe(0); expect(failed).toBe(true); expect(c.authenticated).toBe(false);
  payload = { access_token: 'recovered', expires_in: 3600 };
  expect(await c.authenticate()).toBe(true); await c.business(); expect(businessCalls).toBe(1);
});

it('PayPal preserves its resolving initialize contract while refusing empty replacement credentials', async () => {
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  const c = new PayPal('PayPal', 'p', logger); let calls = 0;
  c.setAdapter(async request => {
    calls++;
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: { access_token: 'token', expires_in: 3600 } };
  });
  await c.initialize(oauth); expect(c.authenticated).toBe(true);
  await expect(c.initialize(invalid)).resolves.toBeUndefined();
  expect(c.authenticated).toBe(false); expect(await c.authenticate()).toBe(false);
  await expect(c.business()).rejects.toThrow('Authentication failed'); expect(calls).toBe(1);
});

it.each(cases)('%s leaves prior demo authentication behind when reinitialized for real credentials', async (_name, create, config) => {
  process.env.NODE_ENV = 'test'; process.env.DEMO_MODE = 'true';
  delete process.env.FORCE_DISABLE_DEMO_MODE;
  const c = create(); let dispatches = 0;
  c.setAdapter?.(async request => {
    dispatches++;
    return { status: 200, statusText: 'OK', headers: {}, config: request, data: { access_token: 'token', expires_in: 3600, id: 'account' } };
  });
  exchange.mockReset().mockResolvedValue({ accessToken: 'token', expiresAt: new Date(Date.now() + 600_000) });
  const demo = { ...config, credentials: { ...config.credentials, host: 'demo.example', clientId: 'demo-client', username: 'demo-user', apiKey: 'demo-key' } };
  await c.initialize(demo); await c.authenticate();
  expect(dispatches).toBe(0); expect(exchange).not.toHaveBeenCalled();
  process.env.NODE_ENV = 'production'; process.env.DEMO_MODE = 'false';
  await c.initialize(config); await c.authenticate();
  expect(dispatches + exchange.mock.calls.length).toBeGreaterThan(0);
});
