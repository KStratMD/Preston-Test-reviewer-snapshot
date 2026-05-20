import './setupEnv'; // Must be first to configure environment
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import { Logger } from '../../src/utils/Logger';
import { AuthService } from '../../src/services/AuthService';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

const hasNetSuiteCredentials = () => {
  return Boolean(
    process.env.NETSUITE_ACCOUNT_ID &&
    process.env.NETSUITE_CONSUMER_KEY &&
    process.env.NETSUITE_CONSUMER_SECRET &&
    process.env.NETSUITE_TOKEN_ID &&
    process.env.NETSUITE_TOKEN_SECRET,
  );
};

if (!hasNetSuiteCredentials()) {
  console.warn('Skipping NetSuite real integration tests: credentials not found in environment');
}

const describeReal = hasNetSuiteCredentials() ? describe : describe.skip;

describeReal('NetSuiteConnector real integration', () => {
  let connector: NetSuiteConnector;
  const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as Logger;

  const mockAuthService = {
    authenticateOAuth1: jest.fn().mockResolvedValue({
      accountId: process.env.NETSUITE_ACCOUNT_ID,
      consumerKey: process.env.NETSUITE_CONSUMER_KEY,
      consumerSecret: process.env.NETSUITE_CONSUMER_SECRET,
      tokenId: process.env.NETSUITE_TOKEN_ID,
      tokenSecret: process.env.NETSUITE_TOKEN_SECRET,
    }),
  } as unknown as AuthService;

  beforeEach(async () => {
    connector = new NetSuiteConnector('test-ns-real', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    await connector.initialize({
      type: 'oauth1',
      credentials: {
        accountId: process.env.NETSUITE_ACCOUNT_ID!,
        consumerKey: process.env.NETSUITE_CONSUMER_KEY!,
        consumerSecret: process.env.NETSUITE_CONSUMER_SECRET!,
        tokenId: process.env.NETSUITE_TOKEN_ID!,
        tokenSecret: process.env.NETSUITE_TOKEN_SECRET!,
        baseUrl: process.env.NETSUITE_BASE_URL,
      },
    });
  });

  it('authenticates successfully with real credentials', async () => {
    const isAuthenticated = await connector.authenticate();
    expect(isAuthenticated).toBe(true);
  });
});
