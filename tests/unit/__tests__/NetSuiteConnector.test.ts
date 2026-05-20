import { NetSuiteConnector } from '../connectors/NetSuiteConnector';
import type { AuthService } from '../services/AuthService';
import type { Logger } from '../utils/Logger';
import type { AuthConfig } from '../types';
import { createMockOutboundGovernanceService } from '../../governanceTestUtils';

// Mock oauth1 header helper to return predictable value
jest.mock('../utils/oauth1Helper', () => ({
  getOAuth1AuthorizationHeader: jest.fn(() => 'OAuth oauth_consumer_key="ck", oauth_token="tk"'),
}));

describe('NetSuiteConnector', () => {
  beforeAll(() => {
    jest.useRealTimers();
  });

  let connector: NetSuiteConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;

  const oauth1Config: AuthConfig = {
    type: 'oauth1',
    credentials: {
      accountId: '12345',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      tokenId: 'tid',
      tokenSecret: 'ts',
      baseUrl: 'https://12345.suitetalk.api.netsuite.com',
    },
  };

  beforeEach(() => {
    mockAuthService = ({
      authenticateOAuth1: jest.fn(async (c: any) => ({ ...c.credentials })),
    } as unknown) as jest.Mocked<AuthService>;
    mockLogger = ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown) as jest.Mocked<Logger>;
    connector = new NetSuiteConnector('sys', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    // Inject a minimal httpClient
    (connector as any).httpClient = {
      request: jest.fn(),
      defaults: { baseURL: '', headers: { common: {} } },
    };
  });

  it('initializes with OAuth1 and sets baseURL', async () => {
    await connector.initialize(oauth1Config);
    expect((connector as any).httpClient.defaults.baseURL).toBe('https://12345.suitetalk.api.netsuite.com');
    expect(mockLogger.info).toHaveBeenCalledWith('NetSuite connector initialized');
  });

  it('throws on non-OAuth1 config', async () => {
    const bad: AuthConfig = { type: 'basic', credentials: { username: 'u', password: 'p' } as any };
    await expect(connector.initialize(bad)).rejects.toThrow('NetSuite connector requires OAuth1 authentication');
  });

  it('authenticates via AuthService and sets state', async () => {
    await connector.initialize(oauth1Config);
    const ok = await connector.authenticate();
    expect(ok).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('NetSuite authentication successful');
  });

  it('builds OAuth1 headers using helper', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;
    // Force request path, assert header added
    (connector as any).httpClient.request.mockResolvedValue({ data: { internalid: '1' } });
    const res = await connector.read('customer', '1');
    expect(res?.id).toBe('1');
    const call = (connector as any).httpClient.request.mock.calls[0][0];
    expect(call.headers.Authorization).toContain('OAuth');
  });

  it('formats NetSuite data to DataRecord', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;
    (connector as any).httpClient.request.mockResolvedValue({ data: { internalid: 10, companyname: 'Acme', email: 'a@b.com' } });
    const rec = await connector.read('customer', '10');
    expect(rec).toEqual(expect.objectContaining({ id: '10', fields: expect.objectContaining({ name: 'Acme', email: 'a@b.com' }) }));
  });

  it('returns null on 404 read', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;
    const err = new Error('Request failed with status code 404');
    (connector as any).httpClient.request.mockRejectedValue(err);
    const rec = await connector.read('customer', 'missing');
    expect(rec).toBeNull();
  });

  it('creates, updates, deletes, lists and searches records', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;

    // create
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { internalid: '11', companyname: 'New' } });
    const created = await connector.create('customer', { id: '', fields: { name: 'New' } } as any);
    expect(created).toEqual(expect.objectContaining({ id: '11', fields: expect.objectContaining({ name: 'New' }) }));

    // update
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { internalid: '11', companyname: 'Upd' } });
    const updated = await connector.update('customer', '11', { fields: { name: 'Upd' } });
    expect(updated.fields.name).toBe('Upd');

    // list
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { items: [{ internalid: '1', companyname: 'A' }] } });
    const list = await connector.list('customer', { limit: 1 });
    expect(list).toHaveLength(1);

    // search
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { items: [{ internalid: '2', companyname: 'B' }] } });
    const search = await connector.search(
      'customer',
      { filters: { name: { operator: 'contains', value: 'B' } }, limit: 1 } as any,
    );
    expect(search.length).toBeGreaterThan(0);
    expect(search[0]!).toBeDefined();
    expect(search[0]!.id).toBe('2');

    // delete
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: {} });
    const del = await connector.delete('customer', '11');
    expect(del).toBe(true);
  });

  it('webhook setup/remove and getChanges call underlying endpoints', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;

    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { id: 'wh_1' } });
    const id = await connector.setupWebhook('https://example.com/hook', ['create']);
    expect(id).toBe('wh_1');

    (connector as any).httpClient.request.mockResolvedValueOnce({ data: {} });
    const removed = await connector.removeWebhook('wh_1');
    expect(removed).toBe(true);

    // Spy on search
    const spy = jest.spyOn(connector as any, 'search').mockResolvedValue([{ id: 'x', fields: {} }] as any);
    const ch = await connector.getChanges('customer', new Date());
    expect(spy).toHaveBeenCalled();
    expect(Array.isArray(ch)).toBe(true);
    spy.mockRestore();
  });

  it('getSystemInfo returns expected structure', async () => {
    await connector.initialize(oauth1Config);
    (connector as any).isAuthenticated = true;
    (connector as any).httpClient.request.mockResolvedValueOnce({ data: { internalid: 'acc' } });
    const info = await connector.getSystemInfo();
    expect(info).toEqual(expect.objectContaining({ name: 'NetSuite', type: 'NetSuite' }));
  });
});
