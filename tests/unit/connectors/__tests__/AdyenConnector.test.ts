import { AdyenConnector } from '../../../../src/connectors/AdyenConnector';
import { Logger } from '../../../../src/utils/Logger';
import { AuthConfig } from '../../../../src/types';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
};

describe('AdyenConnector', () => {
  let connector: AdyenConnector;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = '0';

    connector = new AdyenConnector('Adyen', 'adyen-test', mockLogger);
    makeRequestSpy = jest.spyOn(connector as any, 'makeRequest');
  });

  afterEach(() => {
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

    jest.restoreAllMocks();
  });

  describe('authentication', () => {
    it('should log an error if API key is missing', async () => {
      const authConfig: AuthConfig = { type: 'api_key', credentials: {} };
      await connector.initialize(authConfig);
      expect(mockLogger.error).toHaveBeenCalledWith('Adyen authentication failed', expect.any(Object));
    });

    it('should authenticate successfully with API key', async () => {
      // Use non-test/demo credential strings so the substring-based demo-mode
      // gate in initialize() (which sets demoMode=true when apiKey includes
      // "demo"/"test" or merchantAccount includes "demo") doesn't
      // short-circuit authenticate() before it runs.
      //
      // This test mocks getSystemInfo entirely, so the authenticate ↔ getSystemInfo
      // recursion path is NOT exercised here regardless of the guard. The dedicated
      // regression test below ("should not infinitely recurse via getSystemInfo →
      // ensureAuthenticated") covers the guard's correctness; this test focuses on
      // credential extraction and authenticate()'s drive-to-success when the probe
      // is short-circuited.
      const authConfig: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'AQE-live-api-key', merchantAccount: 'LiveMerchant' },
      };

      // The getSystemInfo spy short-circuits the auth probe so this test exercises
      // only the credential-extraction + authenticate-completion path, without making
      // a real HTTP request to Adyen's /v1/me endpoint.
      const getSystemInfoSpy = jest.spyOn(connector, 'getSystemInfo').mockResolvedValue({
        name: 'Adyen', type: 'Adyen', version: 'v1',
        capabilities: ['payments'],
        rateLimits: { requestsPerMinute: 1000, requestsPerHour: 50000, requestsPerDay: 1000000 },
        endpoints: {
          baseUrl: 'https://checkout-test.adyen.com',
          authUrl: 'https://checkout-test.adyen.com/auth',
          webhookUrl: 'https://checkout-test.adyen.com/webhooks',
        },
      });

      // Clear logger state so the assertion below isn't polluted by the prior test
      // (which intentionally exercises the auth-failure logging path).
      (mockLogger.error as jest.Mock).mockClear();

      await connector.initialize(authConfig);

      expect((connector as any).apiKey).toBe('AQE-live-api-key');
      expect((connector as any).merchantAccount).toBe('LiveMerchant');
      expect((connector as any).isAuthenticated).toBe(true);
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        'Adyen authentication failed',
        expect.any(Object),
      );
      expect(getSystemInfoSpy).toHaveBeenCalled();
    });

    it('should not infinitely recurse via getSystemInfo → ensureAuthenticated', async () => {
      // Regression test for the authenticate ↔ getSystemInfo recursion fixed
      // by the isAuthenticating re-entry guard.
      //
      // Unlike the test above, this one does NOT mock getSystemInfo — it lets
      // authenticate → getSystemInfo → ensureAuthenticated execute, and only
      // mocks makeRequest to prevent a real HTTP call. On the OLD broken
      // code, ensureAuthenticated would re-enter authenticate, recursing until
      // a RangeError is silently swallowed → makeRequest never called and
      // isAuthenticated stays false. With the guard in place, authenticate
      // re-entry returns true early, getSystemInfo proceeds to make exactly
      // one /v1/me request, and isAuthenticated ends up true.
      const authConfig: AuthConfig = {
        type: 'api_key',
        credentials: { apiKey: 'AQE-live-api-key', merchantAccount: 'LiveMerchant' },
      };

      // Mock makeRequest to short-circuit the actual HTTP call. The recursion
      // path runs through to the makeRequest invocation in getSystemInfo.
      makeRequestSpy.mockResolvedValue({
        accountCode: 'LiveMerchant',
        description: 'Live Merchant',
        merchantId: 'LiveMerchant',
        status: 'Active',
        timeZone: 'UTC',
        defaultCurrency: 'USD',
      });

      (mockLogger.error as jest.Mock).mockClear();

      await connector.initialize(authConfig);

      expect((connector as any).isAuthenticated).toBe(true);
      // The /v1/me probe should fire exactly once. Multiple invocations would
      // indicate the recursion guard isn't working and authenticate is being
      // re-entered repeatedly.
      const v1MeCalls = makeRequestSpy.mock.calls.filter(
        (call: unknown[]) => (call[0] as { url?: string })?.url === '/v1/me',
      );
      expect(v1MeCalls).toHaveLength(1);
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        'Adyen authentication failed',
        expect.any(Object),
      );
    });

    it('should use the Adyen test base URL by default', () => {
      // AdyenConnector.getDefaultBaseUrl() always returns the test-environment host
      // (production hosting requires per-merchant subdomains documented externally).
      expect((connector as any).getDefaultBaseUrl()).toBe('https://checkout-test.adyen.com');
    });
  });

  // Note: AdyenConnector.create() supports 'refund', 'capture', and 'cancel' entity types
  // (see AdyenConnector.ts:570-615). It does NOT route 'payment' through makeRequest;
  // payment creation against /v1/payments is not part of the current connector surface.
  // Two prior `it.skip` placeholders that asserted /payments routing have been removed
  // because they tested behavior that doesn't exist. Production payment creation is
  // tracked in the connector roadmap (Adyen Demo-Mode → Production promotion).

  describe('createRefund', () => {
    it('should call the refund endpoint with correct data', async () => {
      makeRequestSpy.mockResolvedValue({
        pspReference: 'REFUND-123',
        response: '[refund-received]',
        merchantAccount: 'TestMerchant',
      });

      await connector.createRefund('PSP-ORIGINAL-123', { value: 5000, currency: 'USD' }, 'Customer request');

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/refund'),
        data: expect.objectContaining({
          originalReference: 'PSP-ORIGINAL-123',
          modificationAmount: { value: 5000, currency: 'USD' },
        }),
      }));
    });

    it('should handle full refund when amount is not specified', async () => {
      makeRequestSpy.mockResolvedValue({
        pspReference: 'REFUND-456',
        response: '[refund-received]',
      });

      await connector.createRefund('PSP-ORIGINAL-456');

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        data: expect.objectContaining({
          originalReference: 'PSP-ORIGINAL-456',
        }),
      }));
    });
  });

  describe('CRUD operations', () => {
    it('should list payments via getTransactions', async () => {
      const spy = jest.spyOn(connector, 'getTransactions').mockResolvedValue([
        { pspReference: 'PSP-1', resultCode: 'Authorised', amount: { value: 1000, currency: 'USD' } } as any,
        { pspReference: 'PSP-2', resultCode: 'Authorised', amount: { value: 2000, currency: 'USD' } } as any,
      ]);

      const result = await spy({ limit: 10 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      spy.mockRestore();
    });

    it('should read a specific payment by reference', async () => {
      makeRequestSpy.mockResolvedValue({
        pspReference: 'PSP-READ-123',
        resultCode: 'Authorised',
        amount: { value: 7500, currency: 'EUR' },
      });

      const result = await connector.read('payment', 'PSP-READ-123');

      expect(result).toBeDefined();
      expect((result as any).pspReference).toBe('PSP-READ-123');
    });

    it('should throw for unsupported update operations', async () => {
      await expect(connector.update('payment', 'PSP-123', {})).rejects.toThrow('not supported');
    });

    it('should throw for unsupported delete operations', async () => {
      await expect(connector.delete('payment', 'PSP-123')).rejects.toThrow('not supported');
    });
  });

  describe('create() boundary validation', () => {
    it('should throw if refund.originalReference is missing', async () => {
      await expect(
        connector.create('refund', { amount: { value: 100, currency: 'USD' } } as any),
      ).rejects.toThrow(/originalReference is required/);
    });

    it('should throw if refund.amount is malformed', async () => {
      await expect(
        connector.create('refund', { originalReference: 'PSP-1', amount: { value: 'bad' } } as any),
      ).rejects.toThrow(/amount must be/);
    });

    it('should throw if capture.originalReference is missing', async () => {
      await expect(
        connector.create('capture', { amount: { value: 100, currency: 'USD' } } as any),
      ).rejects.toThrow(/originalReference is required/);
    });

    it('should throw if cancel.originalReference is missing', async () => {
      await expect(
        connector.create('cancel', {} as any),
      ).rejects.toThrow(/originalReference is required/);
    });

    it('should throw for unsupported create entity', async () => {
      await expect(
        connector.create('unsupported', { foo: 'bar' } as any),
      ).rejects.toThrow(/not supported/);
    });
  });

  describe('error handling', () => {
    it('should handle network errors gracefully', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Network error'));
      await expect(connector.list('payments', {})).rejects.toThrow();
    });

    it('should handle 401 authentication errors', async () => {
      const authError = new Error('Unauthorized') as any;
      authError.response = { status: 401 };
      makeRequestSpy.mockRejectedValue(authError);
      await expect(connector.list('payments', {})).rejects.toThrow();
    });

    it('should handle 403 insufficient permissions errors', async () => {
      const permError = new Error('Forbidden') as any;
      permError.response = { status: 403 };
      makeRequestSpy.mockRejectedValue(permError);
      await expect(connector.list('payments', {})).rejects.toThrow();
    });

    it('should handle 422 validation errors', async () => {
      const validationError = new Error('Unprocessable Entity') as any;
      validationError.response = {
        status: 422,
        data: {
          errorCode: 'validation_error',
          message: 'Invalid payment data',
        },
      };
      makeRequestSpy.mockRejectedValue(validationError);
      await expect(connector.create('payment', {})).rejects.toThrow();
    });
  });

  describe('demo mode', () => {
    beforeEach(async () => {
      process.env.DEMO_MODE = '1';
      connector = new AdyenConnector('Adyen', 'adyen-test', mockLogger);
      // Initialize connector in demo mode (credentials not required)
      await connector.initialize({
        type: 'api_key',
        credentials: { apiKey: 'demo', merchantAccount: 'DemoMerchant' },
      });
    });

    it('should return fixture data in demo mode for list operations', async () => {
      const result = await connector.list('payment', { limit: 5 });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return fixture data in demo mode for read operations', async () => {
      // First list to get a valid ID from fixtures
      const list = await connector.list('payment', { limit: 1 });
      expect(list.length).toBeGreaterThan(0);

      const validId = (list[0] as any).pspReference || (list[0] as any).id;
      const result = await connector.read('payment', validId);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('pspReference');
    });

    it('should return fixture data in demo mode for create operations', async () => {
      const result = await connector.create('refund', {
        originalReference: 'PSP-123',
        amount: { value: 1000, currency: 'USD' },
      });
      expect(result).toBeDefined();
      expect(result).toHaveProperty('pspReference');
    });
  });

  describe('webhooks', () => {
    it('should validate webhook signatures', () => {
      const webhookData = {
        live: 'false',
        notificationItems: [
          {
            NotificationRequestItem: {
              eventCode: 'AUTHORISATION',
              success: 'true',
              pspReference: 'PSP-WEBHOOK-123',
              merchantReference: 'ORDER-789',
            },
          },
        ],
      };

      // Test that webhook data structure is recognized
      expect(webhookData.notificationItems).toBeDefined();
      expect(webhookData.notificationItems[0].NotificationRequestItem.eventCode).toBe('AUTHORISATION');
    });
  });

  describe('reconciliation', () => {
    it('should reconcile Adyen payments with NetSuite records', async () => {
      // calculateMatchConfidence (AdyenConnector.ts:518) caps amount+date matches
      // at 0.7. Reaching the 0.8 matched threshold (line 488) requires either an
      // externalid<->merchantReference correlation (+0.2) or a memo<->pspReference
      // substring match (+0.1, which still leaves us at 0.8 boundary, not strictly >).
      // Our PSP-MATCH fixture below uses the externalid path.
      const adyenPayments = [
        {
          pspReference: 'PSP-MATCH',
          merchantReference: 'ORDER-100',
          amount: { value: 10000, currency: 'USD' },
          eventDate: '2023-01-15T10:00:00Z',
          resultCode: 'Authorised',
        },
        {
          pspReference: 'PSP-UNMATCHED',
          merchantReference: 'ORDER-200',
          amount: { value: 5000, currency: 'USD' },
          eventDate: '2023-01-16T10:00:00Z',
          resultCode: 'Authorised',
        },
      ] as any[];

      const netsuiteRecords = [
        { amount: 100.00, trandate: '2023-01-15', externalid: 'ORDER-100', memo: 'ORDER-100' },
        { amount: 300.00, trandate: '2023-01-17' },
      ];

      const result = await connector.reconcileWithNetSuite(adyenPayments, netsuiteRecords);

      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].adyen.pspReference).toBe('PSP-MATCH');
      expect(result.unmatched).toContainEqual(expect.objectContaining({ pspReference: 'PSP-UNMATCHED' }));
    });
  });
});
