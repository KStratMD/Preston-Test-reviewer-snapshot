import './setupEnv';
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import type { AuthService } from '../../src/services/AuthService';
import type { Logger } from '../../src/utils/Logger';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

const requiredEnvVars = [
  'NETSUITE_ACCOUNT_ID',
  'NETSUITE_CONSUMER_KEY',
  'NETSUITE_CONSUMER_SECRET',
  'NETSUITE_TOKEN_ID',
  'NETSUITE_TOKEN_SECRET',
] as const;

const missingEnvVars = requiredEnvVars.filter(name => {
  const value = process.env[name];
  return !value || value.length === 0;
});

if (process.env.NETSUITE_LIVE_TESTS === '1' && missingEnvVars.length > 0) {
   
  console.warn(`Skipping NetSuite live tests. Missing environment variables: ${missingEnvVars.join(', ')}`);
}

const shouldRunLive = process.env.NETSUITE_LIVE_TESTS === '1' && missingEnvVars.length === 0;
const describeLive = shouldRunLive ? describe : describe.skip;

describeLive('NetSuiteConnector live integration (real API)', () => {
  jest.setTimeout(60000);

  const accountId = process.env.NETSUITE_ACCOUNT_ID as string;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY as string;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET as string;
  const tokenId = process.env.NETSUITE_TOKEN_ID as string;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET as string;
  const baseUrl = process.env.NETSUITE_BASE_URL ?? `https://${accountId}.suitetalk.api.netsuite.com`;

  const baseLogger = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    child() {
      return this as unknown as Logger;
    },
  } as unknown as Logger;

  const authService = {
    authenticateOAuth1: async (authCredentials: any) => authCredentials.credentials,
  } as unknown as AuthService;

  let connector: NetSuiteConnector;

  beforeAll(async () => {
    connector = new NetSuiteConnector('live-netsuite', baseLogger, authService, createMockOutboundGovernanceService());
    await connector.initialize({
      type: 'oauth1',
      credentials: {
        accountId,
        consumerKey,
        consumerSecret,
        tokenId,
        tokenSecret,
        baseUrl,
      },
    });

    connector.maxRetries = 2;
    await connector.authenticate();
  });

  it('passes NetSuite connection check', async () => {
    const status = await connector.testConnection();
    expect(status.isConnected).toBe(true);
    expect(status.systemType).toBe('NetSuite');
  });

  it('lists customer records', async () => {
    const customers = await connector.list('customer', { limit: 1 });
    expect(Array.isArray(customers)).toBe(true);
  });
});
