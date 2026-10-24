import './setupEnv'; // Must be first to configure environment
import nock from 'nock';
import { SalesforceConnector } from '../../src/connectors/SalesforceConnector';
import { Logger } from '../../src/utils/Logger';
import { AuthService } from '../../src/services/AuthService';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

// Ensure proxies don't interfere with mocked HTTP requests
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';

describe('SalesforceConnector integration', () => {
  const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as Logger;

  const mockAuthService = {
    authenticateOAuth2: jest.fn().mockResolvedValue({
      accessToken: 'test-token',
      instanceUrl: 'https://mock.salesforce.com',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    }),
  } as unknown as AuthService;

  let connector: SalesforceConnector;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    connector = new SalesforceConnector('test-sf', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    await connector.initialize({
      type: 'oauth2',
      credentials: {
        clientId: 'id',
        clientSecret: 'secret',
        username: 'user',
        password: 'pass',
        securityToken: 'token',
        instanceUrl: 'https://mock.salesforce.com',
      },
    });
    await connector.authenticate();
    // Disable proxy usage to ensure nock intercepts requests
    (connector as any).httpClient.defaults.proxy = false;
    connector.maxRetries = 2; // keep tests fast
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('performs CRUD operations with mocked endpoints', async () => {
    // Create
    nock('https://mock.salesforce.com')
      .post('/services/data/v59.0/sobjects/Account')
      .reply(201, { id: '001', success: true, errors: [] });

    nock('https://mock.salesforce.com')
      .get('/services/data/v59.0/sobjects/Account/001')
      .reply(200, { Id: '001', Name: 'Acme' });

    const created = await connector.create('account', {
      id: '',
      fields: { name: 'Acme' },
    });
    expect(created.id).toBe('001');
    expect((created.fields as Record<string, unknown>).name).toBe('Acme');

    // Update
    nock('https://mock.salesforce.com')
      .patch('/services/data/v59.0/sobjects/Account/001')
      .reply(204);

    nock('https://mock.salesforce.com')
      .get('/services/data/v59.0/sobjects/Account/001')
      .reply(200, { Id: '001', Name: 'Acme Updated' });

    const updated = await connector.update('account', '001', {
      fields: { name: 'Acme Updated' },
    });
    expect((updated.fields as Record<string, unknown>).name).toBe('Acme Updated');

    // Read
    nock('https://mock.salesforce.com')
      .get('/services/data/v59.0/sobjects/Account/001')
      .reply(200, { Id: '001', Name: 'Acme Updated' });

    const read = await connector.read('account', '001');
    expect(read?.id).toBe('001');

    // Delete
    nock('https://mock.salesforce.com')
      .delete('/services/data/v59.0/sobjects/Account/001')
      .reply(204);

    const deleted = await connector.delete('account', '001');
    expect(deleted).toBe(true);

    expect(nock.isDone()).toBe(true);
  });

  it('retries failed requests before succeeding', async () => {
    nock('https://mock.salesforce.com')
      .get('/services/data/v59.0/sobjects/Account/001')
      .reply(500, { message: 'server error' })
      .get('/services/data/v59.0/sobjects/Account/001')
      .reply(200, { Id: '001', Name: 'Acme' });

    const record = await connector.read('account', '001');
    expect(record?.id).toBe('001');
    expect(nock.isDone()).toBe(true);
  });

  it('throws after exceeding retry attempts', async () => {
    nock('https://mock.salesforce.com')
      .get('/services/data/v59.0/sobjects/Account/001')
      .times(2)
      .reply(500, { message: 'server error' });

    await expect(connector.read('account', '001')).rejects.toThrow('Server error');
    expect(nock.isDone()).toBe(true);
  });
});

