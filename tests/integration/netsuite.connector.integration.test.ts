import './setupEnv'; // Must be first to configure environment
import nock from 'nock';
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import { Logger } from '../../src/utils/Logger';
import { AuthService } from '../../src/services/AuthService';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

// Ensure proxies don't interfere with mocked HTTP requests
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';

describe('NetSuiteConnector integration', () => {
  const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as Logger;

  const mockAuthService = {
    authenticateOAuth1: jest.fn().mockResolvedValue({
      accountId: 'test',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      tokenId: 'ti',
      tokenSecret: 'ts',
    }),
  } as unknown as AuthService;

  let connector: NetSuiteConnector;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    connector = new NetSuiteConnector('test-ns', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    await connector.initialize({
      type: 'oauth1',
      credentials: {
        accountId: 'test',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenId: 'ti',
        tokenSecret: 'ts',
        // Use a baseUrl that doesn't trigger demo mode (avoid 'mock' and 'demo' keywords)
        baseUrl: 'https://test.netsuite.com',
      },
    });
    await connector.authenticate();
    // Disable proxy usage to ensure nock intercepts requests
    (connector as any).httpClient.defaults.proxy = false;
    // demoMode is now handled by DemoConnectorDecorator at the DI layer,
    // so no override needed here — the raw connector always makes real requests.
    connector.maxRetries = 2;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('performs CRUD operations with mocked endpoints', async () => {
    // Create
    nock('https://test.netsuite.com')
      .post('/services/rest/record/v1/customer')
      .reply(200, {
        internalid: '123',
        companyname: 'Acme',
        email: 'a@b.com',
      });

    const created = await connector.create('customer', {
      id: '',
      fields: { name: 'Acme', email: 'a@b.com' },
    });
    expect(created.id).toBe('123');

    // Read
    nock('https://test.netsuite.com')
      .get('/services/rest/record/v1/customer/123')
      .reply(200, {
        internalid: '123',
        companyname: 'Acme',
        email: 'a@b.com',
      });

    const read = await connector.read('customer', '123');
    expect(read?.id).toBe('123');

    // Update
    nock('https://test.netsuite.com')
      .patch('/services/rest/record/v1/customer/123')
      .reply(200, {
        internalid: '123',
        companyname: 'Acme Updated',
      });

    const updated = await connector.update('customer', '123', {
      fields: { name: 'Acme Updated' },
    });
    expect((updated.fields as Record<string, unknown>).name).toBe('Acme Updated');

    // Delete
    nock('https://test.netsuite.com')
      .delete('/services/rest/record/v1/customer/123')
      .reply(204);

    const deleted = await connector.delete('customer', '123');
    expect(deleted).toBe(true);

    expect(nock.isDone()).toBe(true);
  });

  it('retries failed requests before succeeding', async () => {
    nock('https://test.netsuite.com')
      .get('/services/rest/record/v1/customer/123')
      .reply(500, { message: 'server error' })
      .get('/services/rest/record/v1/customer/123')
      .reply(200, {
        internalid: '123',
        companyname: 'Acme',
      });

    const result = await connector.read('customer', '123');
    expect(result?.id).toBe('123');
    expect(nock.isDone()).toBe(true);
  });

  it('throws after exceeding retry attempts', async () => {
    nock('https://test.netsuite.com')
      .get('/services/rest/record/v1/customer/123')
      .times(2)
      .reply(500, { message: 'server error' });

    await expect(connector.read('customer', '123')).rejects.toThrow('Server error');
    expect(nock.isDone()).toBe(true);
  });
});
