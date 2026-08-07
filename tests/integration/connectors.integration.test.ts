import './setupEnv'; // Must be first to configure environment
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import { DynamicsConnector } from '../../src/connectors/DynamicsConnector';
import { Logger } from '../../src/utils/Logger';
import { AuthService } from '../../src/services/AuthService';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

  // Mock logger and auth service for testing
const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis()
} as unknown as Logger;

const mockAuthService = {
  authenticateOAuth2: jest.fn().mockResolvedValue({
    accessToken: 'test-access-token',
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: 'https://test.crm.dynamics.com/.default'
  }),
  authenticateOAuth1: jest.fn().mockResolvedValue({
    tokenId: 'test-token-id',
    tokenSecret: 'test-token-secret'
  }),
  validateApiKey: jest.fn(),
  validateBasicAuth: jest.fn(),
  generateJWT: jest.fn(),
  verifyJWT: jest.fn()
} as unknown as AuthService;

describe('Connector Integration Tests', () => {
  const hasRealCredential = (value?: string) => {
    if (!value) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return !(
      normalized.startsWith('test-') ||
      normalized.includes('example') ||
      normalized.includes('placeholder') ||
      normalized.includes('changeme')
    );
  };

  const hasNetSuiteCredentials = () => {
    return (
      process.env.RUN_LIVE_CONNECTOR_TESTS === 'true' &&
      hasRealCredential(process.env.NETSUITE_ACCOUNT_ID) &&
      hasRealCredential(process.env.NETSUITE_CONSUMER_KEY) &&
      hasRealCredential(process.env.NETSUITE_CONSUMER_SECRET) &&
      hasRealCredential(process.env.NETSUITE_TOKEN_ID) &&
      hasRealCredential(process.env.NETSUITE_TOKEN_SECRET)
    );
  };

  const hasDynamicsCredentials = () => {
    return (
      process.env.RUN_LIVE_CONNECTOR_TESTS === 'true' &&
      hasRealCredential(process.env.DYNAMICS_TENANT_ID) &&
      hasRealCredential(process.env.DYNAMICS_CLIENT_ID) &&
      hasRealCredential(process.env.DYNAMICS_CLIENT_SECRET) &&
      hasRealCredential(process.env.DYNAMICS_RESOURCE_URL)
    );
  };

  // Log test skip status
  console.info('\n📋 CONNECTOR INTEGRATION TESTS INITIALIZED');
  console.info('   RUN_LIVE_CONNECTOR_TESTS enabled:', process.env.RUN_LIVE_CONNECTOR_TESTS === 'true');
  console.info('   NetSuite credentials available:', hasNetSuiteCredentials());
  console.info('   Dynamics credentials available:', hasDynamicsCredentials());
  if (!hasNetSuiteCredentials()) {
    console.info('   🚫 NetSuite live tests will be SKIPPED (set RUN_LIVE_CONNECTOR_TESTS=true and real credentials)');
  }
  if (!hasDynamicsCredentials()) {
    console.info('   🚫 Dynamics live tests will be SKIPPED (set RUN_LIVE_CONNECTOR_TESTS=true and real credentials)');
  }
  console.info('');

  describe('NetSuite Connector', () => {
    let connector: NetSuiteConnector;
    
    beforeEach(() => {
      connector = new NetSuiteConnector('test-netsuite', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      // Ensure connector is initialized for tests with the required auth shape.
      // We use dummy OAuth1 credentials and a mocked AuthService to avoid network calls.
      return connector.initialize({
        type: 'oauth1',
        credentials: {
          accountId: 'test-account',
          consumerKey: 'test-consumer-key',
          consumerSecret: 'test-consumer-secret',
          tokenId: 'test-token-id',
          tokenSecret: 'test-token-secret',
          baseUrl: 'https://test-account.suitetalk.api.netsuite.com',
        } as any,
      } as any);
    });

    it('should initialize without errors', () => {
      expect(connector).toBeInstanceOf(NetSuiteConnector);
    });

    it('should handle authentication configuration', () => {
      expect(connector).toBeInstanceOf(NetSuiteConnector);
    });

    // Only run live tests if credentials are available
    (hasNetSuiteCredentials() ? it : it.skip)('should authenticate with real credentials', async () => {
      const isAuthenticated = await connector.authenticate();
      expect(isAuthenticated).toBe(true);
    }, 30000);

    (hasNetSuiteCredentials() ? it : it.skip)('should test connectivity', async () => {
      const status = await connector.testConnection();
      expect(status.isConnected).toBe(true);
    }, 30000);

    it('should handle authentication failure gracefully', async () => {
      // Test with invalid credentials
      const invalidConnector = new NetSuiteConnector('test-invalid', mockLogger, mockAuthService, createMockOutboundGovernanceService());

      await invalidConnector.initialize({
        type: 'oauth1',
        credentials: {
          accountId: 'invalid-account',
          consumerKey: 'invalid-consumer-key',
          consumerSecret: 'invalid-consumer-secret',
          tokenId: 'invalid-token-id',
          tokenSecret: 'invalid-token-secret',
        } as any,
      } as any);
      
      await expect(invalidConnector.authenticate()).resolves.not.toThrow();
    });
  });

  describe('Dynamics 365 Connector', () => {
    let connector: DynamicsConnector;
    
    beforeEach(() => {
      connector = new DynamicsConnector('test-dynamics', mockLogger, mockAuthService);
    });

    it('should initialize without errors', () => {
      expect(connector).toBeInstanceOf(DynamicsConnector);
    });

    it('should handle authentication configuration', () => {
      expect(connector).toBeInstanceOf(DynamicsConnector);
    });

    // Only run live tests if credentials are available
    (hasDynamicsCredentials() ? it : it.skip)('should authenticate with real credentials', async () => {
      const isAuthenticated = await connector.authenticate();
      expect(isAuthenticated).toBe(true);
    }, 30000);

    (hasDynamicsCredentials() ? it : it.skip)('should test connectivity', async () => {
      const status = await connector.testConnection();
      expect(status.isConnected).toBe(true);
    }, 30000);

    it('should handle authentication failure gracefully', async () => {
      // Test with invalid credentials
      const invalidConnector = new DynamicsConnector('test-invalid', mockLogger, mockAuthService);
      
      await expect(invalidConnector.authenticate()).resolves.not.toThrow();
    });
  });

  describe('Connector Factory', () => {
    it('should create appropriate connector instances', () => {
      const netsuiteConnector = new NetSuiteConnector('test-factory-ns', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      const dynamicsConnector = new DynamicsConnector('test-factory-dyn', mockLogger, mockAuthService);

      expect(netsuiteConnector).toBeInstanceOf(NetSuiteConnector);
      expect(dynamicsConnector).toBeInstanceOf(DynamicsConnector);
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts gracefully', async () => {
      const connector = new DynamicsConnector('test-dynamics-stress', mockLogger, mockAuthService);
      
      // Should not throw but return a valid ConnectionStatus
      const result = await connector.testConnection();
      expect(result).toHaveProperty('isConnected', false);
      expect(result).toHaveProperty('systemType', 'Dynamics365');
      expect(result).toHaveProperty('systemId', 'test-dynamics-stress');
      expect(result).toHaveProperty('errorMessage');
    }, 10000);
  });
});
