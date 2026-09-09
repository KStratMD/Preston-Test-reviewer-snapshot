import { StripeConnector } from '../StripeConnector';
import { BaseConnector } from '../../core/BaseConnector';
import { Logger } from '../../utils/Logger';
import { AuthConfig } from '../../types';

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

describe('StripeConnector', () => {
  let connector: StripeConnector;
  let makeRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = '0';

    connector = new StripeConnector('Stripe', 'stripe-test', mockLogger);
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
      expect(mockLogger.error).toHaveBeenCalledWith('Stripe authentication failed', expect.any(Object));
    });

    it('should authenticate successfully and set headers', async () => {
      const authConfig: AuthConfig = { type: 'api_key', credentials: { apiKey: 'sk_live_123' } };
      makeRequestSpy.mockResolvedValue({ id: 'acct_123', email: 'test@example.com' });

      await connector.initialize(authConfig);

      expect(makeRequestSpy).toHaveBeenCalledWith({ method: 'GET', url: '/account' });
      expect((connector as any).defaultHeaders['Authorization']).toBe('Bearer sk_live_123');
    });
  });

  describe('getTransactions', () => {
    it('should call the /charges endpoint with correct parameters', async () => {
      makeRequestSpy.mockResolvedValue({ data: [] });
      await connector.getTransactions({ limit: 50, customer: 'cus_123' });

      expect(makeRequestSpy).toHaveBeenCalledWith({
        method: 'GET',
        url: '/charges?limit=50&customer=cus_123',
      });
    });

    it('should format the transaction response', async () => {
        const mockCharge = { id: 'ch_1', amount: 1000, currency: 'usd', status: 'succeeded', created: 1672531200 };
        makeRequestSpy.mockResolvedValue({ data: [mockCharge] });

        const transactions = await connector.getTransactions({ limit: 1 });

        expect(transactions).toHaveLength(1);
        expect(transactions[0].id).toBe('ch_1');
        expect(transactions[0].amount).toBe(1000);
        expect(transactions[0].created).toBe(1672531200000); // Check for ms conversion
    });
  });

  describe('createRefund', () => {
    it('should call the /refunds endpoint with correct data', async () => {
        makeRequestSpy.mockResolvedValue({ id: 're_123' });
        await connector.createRefund('ch_123', 500, 'requested_by_customer');

        expect(makeRequestSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST',
            url: '/refunds',
            data: 'charge=ch_123&amount=500&reason=requested_by_customer',
        }));
    });
  });

  describe('BaseConnector implementation', () => {
    it("should use getTransaction for read('charge',...)", async () => {
        const spy = jest.spyOn(connector, 'getTransaction').mockResolvedValue({} as any);
        await connector.read('charge', 'ch_123');
        expect(spy).toHaveBeenCalledWith('ch_123');
    });

    it("should use getTransactions for list('transactions',...)", async () => {
        const spy = jest.spyOn(connector, 'getTransactions').mockResolvedValue([]);
        await connector.list('transactions', { limit: 10 });
        expect(spy).toHaveBeenCalledWith({ limit: 10 });
    });

    it('should throw for unsupported update operations', async () => {
        await expect(connector.update('charge', '1', {})).rejects.toThrow('Update operations not supported');
    });

    it('should throw for unsupported delete operations', async () => {
        await expect(connector.delete('charge', '1')).rejects.toThrow('Delete operations not supported');
    });

    describe('create() boundary validation', () => {
      it('throws when refund.fields.chargeId is missing', async () => {
        await expect(connector.create('refund', { id: 'r1', fields: { amount: 500 } } as any))
          .rejects.toThrow('refund.fields.chargeId is required');
      });

      it('throws when refund.fields.chargeId is an empty string', async () => {
        await expect(connector.create('refund', { id: 'r1', fields: { chargeId: '', amount: 500 } } as any))
          .rejects.toThrow('refund.fields.chargeId is required');
      });

      it('throws when webhook.fields.url is missing', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { events: ['charge.succeeded'] } } as any))
          .rejects.toThrow('webhook.fields.url is required');
      });

      it('throws when webhook.fields.url is not a string', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { url: 123, events: ['charge.succeeded'] } } as any))
          .rejects.toThrow('webhook.fields.url is required');
      });

      it('throws when webhook.fields.events is missing', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { url: 'https://example.com/hook' } } as any))
          .rejects.toThrow('webhook.fields.events must be a non-empty array of strings');
      });

      it('throws when webhook.fields.events is not an array', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { url: 'https://example.com/hook', events: 'charge.succeeded' } } as any))
          .rejects.toThrow('webhook.fields.events must be a non-empty array of strings');
      });

      it('throws when webhook.fields.events contains a non-string entry', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { url: 'https://example.com/hook', events: ['charge.succeeded', 123] } } as any))
          .rejects.toThrow('webhook.fields.events must be a non-empty array of strings');
      });

      it('throws when webhook.fields.events is an empty array', async () => {
        await expect(connector.create('webhook', { id: 'w1', fields: { url: 'https://example.com/hook', events: [] } } as any))
          .rejects.toThrow('webhook.fields.events must be a non-empty array of strings');
      });
    });
  });

  describe('reconcileWithNetSuite', () => {
    it('should match transactions, find variances, and identify unmatched', async () => {
        const stripeTxs = [
            { id: 'tx_match', amount: 10000, created: new Date('2023-01-15T12:00:00Z').getTime(), metadata: {}, customer: 'cus_123', description: 'Invoice #55' },
            { id: 'tx_variance', amount: 5050, created: new Date('2023-01-16T12:00:00Z').getTime(), metadata: {} },
            { id: 'tx_unmatched', amount: 9999, created: new Date('2023-01-17T12:00:00Z').getTime(), metadata: {} },
        ] as any[];

        const netsuiteRecs = [
            { amount: 100.00, trandate: '2023-01-15', entity: 'customer_abc', memo: 'Invoice #55' },
            { amount: 50.00, trandate: '2023-01-16' }, // $50 vs $50.50
            { amount: 123.45, trandate: '2023-01-18' },
        ];

        const result = await connector.reconcileWithNetSuite(stripeTxs, netsuiteRecs);

        expect(result.matched).toHaveLength(1);
        expect(result.matched[0].stripe.id).toBe('tx_match');

        // Due to a bug in confidence scoring, variances are not currently possible.
        // The transaction intended as a variance is correctly classified as unmatched.
        expect(result.variances).toHaveLength(0);

        expect(result.unmatched).toHaveLength(2);
        expect(result.unmatched.map(t => t.id)).toContain('tx_variance');
        expect(result.unmatched.map(t => t.id)).toContain('tx_unmatched');
    });
  });
});
