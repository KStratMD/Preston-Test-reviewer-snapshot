import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import { DynamicsConnector } from '../../src/connectors/DynamicsConnector';
import { BusinessCentralConnector } from '../../src/connectors/BusinessCentralConnector';
import { OracleConnector } from '../../src/connectors/OracleConnector';
import { SalesforceConnector } from '../../src/connectors/SalesforceConnector';
import { SAPConnector } from '../../src/connectors/SAPConnector';
import { Logger } from '../../src/utils/Logger';
import { AuthService, TokenInfo } from '../../src/services/AuthService';
import type { DataRecord } from '../../src/types';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis()
} as unknown as Logger;

const mockAuthService = {
  authenticateOAuth2: jest.fn<Promise<TokenInfo>, []>(async () => ({
    accessToken: 'test',
    expiresAt: new Date(Date.now() + 3600 * 1000),
    tokenType: 'Bearer',
    issued: new Date()
  })),
  authenticateOAuth1: jest.fn(),
} as unknown as AuthService;

describe('Connector Unit Tests', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DEMO_MODE: process.env.DEMO_MODE,
  };

  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = '0';
  });

  afterAll(() => {
    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    if (originalEnv.DEMO_MODE === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = originalEnv.DEMO_MODE;
    }
  });

  afterEach(() => jest.restoreAllMocks());
  describe('NetSuiteConnector data mapping', () => {
    const connector = new NetSuiteConnector('ns-test', mockLogger, mockAuthService, createMockOutboundGovernanceService());
    const privateAccess = connector as unknown as {
      formatDataForNetSuite(data: Partial<DataRecord>): Record<string, unknown>;
      formatDataFromNetSuite(data: unknown, entity: string): DataRecord;
    };

    it('should map fields to NetSuite format', () => {
      const result = privateAccess.formatDataForNetSuite({
        fields: { name: 'Acme', phone: '123' }
      });
      expect(result.companyname).toBe('Acme');
      expect(result.phone).toBe('123');
    });

    it('should map fields from NetSuite format', () => {
      const data = privateAccess.formatDataFromNetSuite({
        internalid: '1',
        companyname: 'Acme'
      }, 'customer');
      expect(data.id).toBe('1');
      expect(data.fields.name).toBe('Acme');
    });
  });

  describe('DynamicsConnector authentication', () => {
    const connector = new DynamicsConnector('dyn-test', mockLogger, mockAuthService);
    const privateDyn = connector as unknown as { authConfig: { expiresAt: Date } };

    beforeEach(async () => {
      await connector.initialize({
        type: 'oauth2',
        credentials: {
          tenantId: 'tid',
          clientId: 'cid',
          clientSecret: 'sec',
          resourceUrl: 'https://example.com'
        }
      });
    });

    it('stores token expiry on authenticate', async () => {
      await connector.authenticate();
      expect(privateDyn.authConfig.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('NetSuiteConnector authentication', () => {
    it('throws when token retrieval fails', async () => {
      const failingAuth = {
        authenticateOAuth1: jest.fn().mockRejectedValue(new Error('Token error')),
      } as unknown as AuthService;

      const connector = new NetSuiteConnector('ns-auth', mockLogger, failingAuth, createMockOutboundGovernanceService());

      await connector.initialize({
        type: 'oauth1',
        credentials: {
          accountId: 'acct',
          consumerKey: 'key',
          consumerSecret: 'secret',
          tokenId: 'tid',
          tokenSecret: 'tsec',
        },
      });

      await expect(connector.authenticate()).rejects.toThrow('Token error');
    });
  });

  describe('BusinessCentralConnector', () => {
    it('authenticates via OAuth2 and fetches company ID', async () => {
      const connector = new BusinessCentralConnector('bc-test', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      await connector.initialize({
        type: 'oauth2',
        credentials: {
          tenantId: 'tid',
          clientId: 'cid',
          clientSecret: 'sec',
        },
      });

      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ value: [{ id: 'comp-1' }] });

      await connector.authenticate();

      expect((connector as any).companyId).toBe('comp-1');
      expect((connector as any).isAuthenticated).toBe(true);
      expect(connector['httpClient'].defaults.headers.common['Authorization']).toContain('Bearer');
    });

    it('maps data to and from Business Central format', () => {
      const connector = new BusinessCentralConnector('bc-map', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      const access = connector as any;

      const formatted = access.formatDataForBusinessCentral({ fields: { name: 'Acme', phone: '123' } });
      expect(formatted).toMatchObject({ displayName: 'Acme', phoneNumber: '123' });

      const mapped = access.formatDataFromBusinessCentral({ id: '1', displayName: 'Acme' }, 'customer');
      expect(mapped.id).toBe('1');
      expect(mapped.fields.name).toBe('Acme');
    });

    it('handles API errors gracefully', async () => {
      const connector = new BusinessCentralConnector('bc-err', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      (connector as any).authConfig = { type: 'oauth2', credentials: {} };
      (connector as any).isAuthenticated = true;
      (connector as any).companyId = 'comp-1';
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('boom'));

      await expect(connector.read('customer', '1')).rejects.toThrow('Failed to read customer 1: boom');
    });
  });

  describe('OracleConnector', () => {
    it('authenticates using basic auth', async () => {
      const connector = new OracleConnector('oracle-test', mockLogger, mockAuthService);
      await connector.initialize({
        type: 'basic',
        // Use a host that does not trigger demo mode in tests
        credentials: { username: 'u', password: 'p', host: 'oracle.real.local' },
      });

      const reqSpy = jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({});
      await connector.authenticate();

      expect(reqSpy).toHaveBeenCalled();
      expect(connector['httpClient'].defaults.headers.common['Authorization']).toContain('Basic');
    });

    it('maps data to and from Oracle format', () => {
      const connector = new OracleConnector('oracle-map', mockLogger, mockAuthService);
      const access = connector as any;

      const formatted = access.formatDataForOracle({ fields: { name: 'Acme', email: 'a@b.com' } });
      expect(formatted).toMatchObject({ NAME: 'Acme', EMAIL: 'a@b.com' });

      const mapped = access.formatDataFromOracle({ CUSTOMER_ID: '1', NAME: 'Acme' }, 'customer');
      expect(mapped.id).toBe('1');
      expect(mapped.fields.name).toBe('Acme');
    });

    it('handles API errors gracefully', async () => {
      const connector = new OracleConnector('oracle-err', mockLogger, mockAuthService);
      await connector.initialize({
        type: 'basic',
        // Use a host that does not trigger demo mode in tests
        credentials: { username: 'u', password: 'p', host: 'oracle.real.local' },
      });
      (connector as any).isAuthenticated = true;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('fail'));

      await expect(connector.create('customer', { id: '1', fields: { name: 'Acme' } })).rejects.toThrow('Failed to create customer: fail');
    });
  });

  describe('SalesforceConnector', () => {
    it('authenticates and sets instance URL', async () => {
      const authService = {
        authenticateOAuth2: jest.fn(async () => ({
          accessToken: 'sf-token',
          expiresAt: new Date(Date.now() + 3600 * 1000),
          tokenType: 'Bearer',
          issued: new Date(),
          instanceUrl: 'https://instance.salesforce.com',
        })),
        authenticateOAuth1: jest.fn(),
      } as unknown as AuthService;

      const connector = new SalesforceConnector('sf-test', mockLogger, authService, createMockOutboundGovernanceService());
      await connector.initialize({
        type: 'oauth2',
        credentials: { clientId: 'cid', clientSecret: 'sec', username: 'user', password: 'pass', securityToken: 'tok' },
      });

      await connector.authenticate();

      expect(connector['httpClient'].defaults.baseURL).toContain('https://instance.salesforce.com');
      expect(connector['httpClient'].defaults.headers.common['Authorization']).toContain('Bearer sf-token');
    });

    it('maps data to and from Salesforce format', () => {
      const connector = new SalesforceConnector('sf-map', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      const access = connector as any;

      const formatted = access.formatDataForSalesforce({ fields: { name: 'Acme', email: 'a@b.com' } });
      expect(formatted).toMatchObject({ Name: 'Acme', Email: 'a@b.com' });

      const mapped = access.formatDataFromSalesforce({ Id: '1', Name: 'Acme' }, 'account');
      expect(mapped.id).toBe('1');
      expect(mapped.fields.name).toBe('Acme');
    });

    it('handles API errors gracefully', async () => {
      const connector = new SalesforceConnector('sf-err', mockLogger, mockAuthService, createMockOutboundGovernanceService());
      (connector as any).authConfig = { type: 'oauth2', credentials: {} };
      (connector as any).isAuthenticated = true;
      jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({ success: false, errors: ['bad'] });

      await expect(connector.create('account', { id: '1', fields: {} })).rejects.toThrow('Salesforce create failed: bad');
    });
  });

  describe('SAPConnector', () => {
    it('authenticates using basic auth', async () => {
      const connector = new SAPConnector('sap-test', mockLogger, mockAuthService);
      await connector.initialize({
        type: 'basic',
        credentials: { username: 'u', password: 'p', client: '100', systemId: 'SYS', host: 'localhost' },
      });

      const reqSpy = jest.spyOn(connector as any, 'makeRequest').mockResolvedValue({});
      await connector.authenticate();

      expect(reqSpy).toHaveBeenCalled();
      expect(connector['httpClient'].defaults.headers.common['Authorization']).toContain('Basic');
    });

    it('maps data to and from SAP format', () => {
      const connector = new SAPConnector('sap-map', mockLogger, mockAuthService);
      const access = connector as any;

      const formatted = access.formatDataForSAP({ fields: { name: 'John', email: 'john@example.com' } });
      expect(formatted).toMatchObject({ BusinessPartnerFullName: 'John', EmailAddress: 'john@example.com' });

      const mapped = access.formatDataFromSAP({ __metadata: { uri: 'u', type: 't' }, BusinessPartner: '1', BusinessPartnerFullName: 'John' }, 'business_partner');
      expect(mapped.id).toBe('1');
      expect(mapped.fields.name).toBe('John');
    });

    it('handles API errors gracefully', async () => {
      const connector = new SAPConnector('sap-err', mockLogger, mockAuthService);
      await connector.initialize({
        type: 'basic',
        credentials: { username: 'u', password: 'p', client: '100', systemId: 'SYS', host: 'localhost' },
      });
      (connector as any).isAuthenticated = true;
      jest.spyOn(connector as any, 'makeRequest').mockRejectedValue(new Error('boom'));

      await expect(connector.read('business_partner', '1')).rejects.toThrow('Failed to read business_partner 1: boom');
    });
  });
});
