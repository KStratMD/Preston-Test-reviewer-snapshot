import { PayPalConnector } from '../../../../src/connectors/PayPalConnector';
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

describe('PayPalConnector', () => {
  let connector: PayPalConnector;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = '0';

    connector = new PayPalConnector('PayPal', 'paypal-test', mockLogger);
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
    it('should log an error if clientId or clientSecret is missing', async () => {
      // Use a non-test/demo clientId so the substring-based demo-mode gate
      // (PayPalConnector.ts:318) doesn't short-circuit; missing clientSecret
      // then triggers the real auth-failure path.
      const authConfig: AuthConfig = { type: 'oauth2', credentials: { clientId: 'live-client-without-secret' } };
      await connector.initialize(authConfig);
      expect(mockLogger.error).toHaveBeenCalledWith('PayPal authentication failed', expect.any(Object));
    });

    it('should authenticate successfully with OAuth2 credentials', async () => {
      // Non-test/demo credential strings so the demo-mode gate doesn't fire.
      const authConfig: AuthConfig = {
        type: 'oauth2',
        credentials: { clientId: 'live-client-id', clientSecret: 'live-secret' },
      };
      makeRequestSpy.mockResolvedValue({ access_token: 'live-token', token_type: 'Bearer', expires_in: 3600 });

      await connector.initialize(authConfig);

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: '/v1/oauth2/token',
      }));
      expect((connector as any).accessToken).toBe('live-token');
    });

    it('should use the PayPal sandbox base URL by default', () => {
      // PayPalConnector.getDefaultBaseUrl() always returns the sandbox host
      // (production hosting requires explicit credential-driven switching, not
      // metadata-driven, and the connector does not currently flip per env).
      expect((connector as any).getDefaultBaseUrl()).toBe('https://api-m.sandbox.paypal.com');
    });
  });

  describe('getPayments', () => {
    it('should call the /v1/payments/payment endpoint with correct parameters', async () => {
      makeRequestSpy.mockResolvedValue({ payments: [], count: 0, next_id: null });

      await connector.getPayments({ count: 10, start_index: 0 });

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/v1/payments/payment'),
      }));
    });

    it('should format payment response correctly', async () => {
      const mockPayment = {
        id: 'PAY-123',
        intent: 'sale',
        state: 'approved',
        cart: 'cart-123',
        create_time: '2023-01-15T10:00:00Z',
        update_time: '2023-01-15T10:05:00Z',
        payer: {
          payment_method: 'paypal',
          status: 'VERIFIED',
          payer_info: {
            email: 'test@example.com',
            first_name: 'John',
            last_name: 'Doe',
            payer_id: 'PAYER123',
          },
        },
        transactions: [{
          amount: {
            total: '100.00',
            currency: 'USD',
          },
          description: 'Test payment',
        }],
      };
      makeRequestSpy.mockResolvedValue({ payments: [mockPayment], count: 1 });

      const payments = await connector.getPayments({ count: 1 });

      expect(payments).toHaveLength(1);
      expect(payments[0].id).toBe('PAY-123');
      expect(payments[0].state).toBe('approved');
    });
  });

  describe('createRefund', () => {
    it('should call the refund endpoint with correct data', async () => {
      makeRequestSpy.mockResolvedValue({
        id: 'REFUND-123',
        state: 'completed',
        amount: { total: '50.00', currency: 'USD' },
      });

      await connector.createRefund('SALE-123', { total: '50.00', currency: 'USD' }, 'Customer request');

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/v1/payments/sale/SALE-123/refund'),
        data: expect.objectContaining({
          amount: { total: '50.00', currency: 'USD' },
        }),
      }));
    });

    it('should handle full refund when amount is not specified', async () => {
      makeRequestSpy.mockResolvedValue({
        id: 'REFUND-456',
        state: 'completed',
      });

      await connector.createRefund('SALE-456');

      expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/v1/payments/sale/SALE-456/refund'),
      }));
    });
  });

  describe('CRUD operations', () => {
    it('should use getPayments for list operation', async () => {
      const spy = jest.spyOn(connector, 'getPayments').mockResolvedValue([]);
      await connector.list('payments', { limit: 10 });
      expect(spy).toHaveBeenCalled();
    });

    it('should use makeRequest for read operation', async () => {
      makeRequestSpy.mockResolvedValue({ id: 'PAY-123', state: 'approved' });
      const result = await connector.read('payment', 'PAY-123');
      expect(result).toBeDefined();
      expect((result as any).id).toBe('PAY-123');
    });

    it('should throw for unsupported create operations on payments', async () => {
      await expect(connector.create('payment', {})).rejects.toThrow();
    });

    it('should throw for unsupported update operations', async () => {
      await expect(connector.update('payment', 'PAY-123', {})).rejects.toThrow('not supported');
    });

    it('should throw for unsupported delete operations', async () => {
      await expect(connector.delete('payment', 'PAY-123')).rejects.toThrow('not supported');
    });
  });

  describe('error handling', () => {
    it('should handle network errors gracefully', async () => {
      makeRequestSpy.mockRejectedValue(new Error('Network error'));
      await expect(connector.getPayments({})).rejects.toThrow();
    });

    it('should handle 401 authentication errors', async () => {
      const authError = new Error('Unauthorized') as any;
      authError.response = { status: 401 };
      makeRequestSpy.mockRejectedValue(authError);
      await expect(connector.getPayments({})).rejects.toThrow();
    });

    it('should handle 429 rate limit errors', async () => {
      const rateLimitError = new Error('Too Many Requests') as any;
      rateLimitError.response = { status: 429, headers: { 'retry-after': '60' } };
      makeRequestSpy.mockRejectedValue(rateLimitError);
      await expect(connector.getPayments({})).rejects.toThrow();
    });
  });

  describe('demo mode', () => {
    beforeEach(async () => {
      process.env.DEMO_MODE = '1';
      connector = new PayPalConnector('PayPal', 'paypal-test', mockLogger);
      // Initialize connector in demo mode (credentials not required)
      await connector.initialize({
        type: 'oauth2',
        credentials: { clientId: 'demo', clientSecret: 'demo' },
      });
    });

    it('should return fixture data in demo mode for list operations', async () => {
      const result = await connector.list('payments', { limit: 5 });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return fixture data in demo mode for read operations', async () => {
      // First list to get a valid ID from fixtures
      const list = await connector.list('payments', { limit: 1 });
      expect(list.length).toBeGreaterThan(0);

      const validId = (list[0] as any).id;
      const result = await connector.read('payment', validId);
      expect(result).toBeDefined();
      expect(result).toHaveProperty('id');
    });
  });

  describe('reconciliation', () => {
    it('should reconcile PayPal sales with NetSuite records', async () => {
      // calculateMatchConfidence (PayPalConnector.ts:747) caps amount+date matches
      // at 0.7. Reaching the strict 0.8 threshold (line 718) requires an
      // externalid <-> sale.id correlation (+0.2). The matching NetSuite record
      // below carries externalid='SALE-MATCH' to push confidence to 0.9.
      const paypalSales = [
        {
          id: 'SALE-MATCH',
          amount: { total: '100.00', currency: 'USD' },
          create_time: '2023-01-15T10:00:00Z',
          state: 'completed',
        },
        {
          id: 'SALE-UNMATCHED',
          amount: { total: '50.00', currency: 'USD' },
          create_time: '2023-01-16T10:00:00Z',
          state: 'completed',
        },
      ] as any[];

      const netsuiteRecords = [
        { amount: 100.00, trandate: '2023-01-15', externalid: 'SALE-MATCH' },
        { amount: 200.00, trandate: '2023-01-17' },
      ];

      const result = await connector.reconcileWithNetSuite(paypalSales, netsuiteRecords);

      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].paypal.id).toBe('SALE-MATCH');
      expect(result.unmatched.length).toBeGreaterThan(0);
    });
  });
});
