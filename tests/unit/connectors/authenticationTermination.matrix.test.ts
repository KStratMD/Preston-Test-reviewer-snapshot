import axios from 'axios';
import { BaseConnector } from '../../../src/core/BaseConnector';
import { HubSpotConnector } from '../../../src/connectors/HubSpotConnector';
import { OracleConnector } from '../../../src/connectors/OracleConnector';
import { SAPConnector } from '../../../src/connectors/SAPConnector';
import { ShopifyConnector } from '../../../src/connectors/ShopifyConnector';
import { PayPalConnector } from '../../../src/connectors/PayPalConnector';
import { StripeConnector } from '../../../src/connectors/StripeConnector';
import { BusinessCentralConnector } from '../../../src/connectors/BusinessCentralConnector';
import { SuiteCentralProductionConnector } from '../../../src/connectors/SuiteCentralProductionConnector';
import type { Logger } from '../../../src/utils/Logger';
import type { AuthService } from '../../../src/services/AuthService';
import type { OutboundGovernanceService } from '../../../src/services/governance/OutboundGovernanceService';
import type { AuthConfig } from '../../../src/types';

jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
const governance = {} as OutboundGovernanceService;
const auth = { authenticateOAuth2: jest.fn().mockResolvedValue({ accessToken: 'test-token', expiresAt: new Date('2099-01-01') }) } as unknown as AuthService;
const configs: Record<string, AuthConfig> = {
  HubSpot: { type: 'api_key', credentials: { apiKey: 'test-key' } },
  Oracle: { type: 'basic', credentials: { username: 'u', password: 'p', baseUrl: 'https://oracle.test' } },
  SAP: { type: 'basic', credentials: { username: 'u', password: 'p', host: 'sap.test', client: '100' } },
  Shopify: { type: 'oauth2', credentials: { shopName: 'test-shop', accessToken: 'test-token' } },
  PayPal: { type: 'oauth2', credentials: { clientId: 'c', clientSecret: 's' } },
  Stripe: { type: 'api_key', credentials: { apiKey: 'test-key' } },
  BusinessCentral: { type: 'oauth2', credentials: { clientId: 'c', clientSecret: 's', tenantId: 'tenant' } },
  SuiteCentral: { type: 'api_key', credentials: { apiKey: 'test-key', baseUrl: 'https://sc.test', tenantId: 'tenant' } },
};

// Transitive class-local inventory: eight active probes plus guarded Adyen and
// ShipStation. Adyen's guard protects an ensureAuthenticated cycle; ShipStation's
// base-initiated probe bypass remains explicitly deferred by the execution plan.
const cases: Array<[string, () => BaseConnector, string]> = [
  ['HubSpot', () => new HubSpotConnector(logger, governance), '/objects/contacts'],
  ['Oracle', () => new OracleConnector('oracle-test', logger, auth, governance), '/metadata-catalog/'],
  ['SAP', () => new SAPConnector('sap-test', logger, auth), '/SERVICE_SRV/$metadata'],
  ['Shopify', () => new ShopifyConnector('shopify-test', logger), '/shop.json'],
  ['PayPal', () => new PayPalConnector('PayPal', 'paypal-test', logger), '/v1/oauth2/token'],
  ['Stripe', () => new StripeConnector('Stripe', 'stripe-test', logger), '/account'],
  ['BusinessCentral', () => new BusinessCentralConnector('bc-test', logger, auth, governance), '/companies'],
  ['SuiteCentralProduction', () => new SuiteCentralProductionConnector('SuiteCentral', 'sc-test', logger, auth), '/auth/validate'],
];

describe.each(cases)('%s authentication termination', (_name, make, expectedPath) => {
  it('executes the real auth probe and terminates under permanent 401', async () => {
    const originalMode = process.env.SUITECENTRAL_PRODUCTION_MODE;
    const request = jest.fn();
    const client = { request, defaults: { headers: { common: {} } }, interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
    mockAxios.create.mockReturnValue(client as unknown as ReturnType<typeof axios.create>);
    mockAxios.isAxiosError.mockImplementation((error: unknown): error is import('axios').AxiosError => Boolean(error && typeof error === 'object' && 'isAxiosError' in error));
    try {
      const connector = make();
      connector.authConfig = configs[connector.systemType];
      connector['delay'] = jest.fn().mockResolvedValue(undefined);
      if (connector instanceof SuiteCentralProductionConnector) {
        process.env.SUITECENTRAL_PRODUCTION_MODE = 'true';
        request.mockResolvedValue({ data: { status: 'healthy', valid: true, permissions: [], modules: {} }, status: 200, headers: {} });
        await connector.initialize(configs.SuiteCentral);
        expect((connector as unknown as { isProductionMode: boolean }).isProductionMode).toBe(true);
        request.mockReset();
      }
      connector['isAuthenticated'] = false;
      request.mockRejectedValue({ isAxiosError: true, response: { status: 401, headers: {}, data: {} } });
      await expect(connector['makeRequest']({ method: 'GET', url: '/probe' })).rejects.toThrow();
      expect(request.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(request.mock.calls.length).toBeLessThanOrEqual(3);
      expect(request.mock.calls.some(([config]) => config.url === expectedPath)).toBe(true);
      expect(connector['isAuthenticating']).toBe(false);
    } finally {
      if (originalMode === undefined) delete process.env.SUITECENTRAL_PRODUCTION_MODE;
      else process.env.SUITECENTRAL_PRODUCTION_MODE = originalMode;
      jest.clearAllMocks();
    }
  });
});
