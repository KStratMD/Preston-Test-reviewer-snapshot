import { injectable, inject, unmanaged } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { SystemInfo, AuthConfig, DataRecord } from '../types';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
import type { ListOptions, SearchCriteria } from '../interfaces/IConnector';
import { TYPES } from '../inversify/types';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';

// Type guard helper for error objects with HTTP response
interface ErrorWithResponse {
  response?: {
    status?: number;
    headers?: Record<string, string>;
  };
  code?: string;
}

// Generic type for PayPal API list responses (raw API format before transformation)
type PayPalApiEntity = Record<string, unknown> & { id: string };

// Union type for all formatted PayPal entities
type PayPalEntity = PayPalTransaction | PayPalSale | PayPalAuthorization | PayPalRefund | PayPalDispute | PayPalPayout | PayPalApiEntity;

// Generic type for NetSuite records used in reconciliation
type NetSuiteRecord = Record<string, unknown> & { id?: string | number }

export interface PayPalTransaction {
  id: string;
  intent: 'sale' | 'authorize' | 'order';
  state: 'created' | 'approved' | 'failed' | 'cancelled' | 'expired';
  cart: string;
  create_time: string;
  update_time: string;
  payer: {
    payment_method: string;
    status: string;
    payer_info: {
      email?: string;
      first_name?: string;
      last_name?: string;
      payer_id?: string;
      phone?: string;
      country_code?: string;
    };
  };
  transactions: {
    amount: {
      total: string;
      currency: string;
      details?: {
        subtotal?: string;
        tax?: string;
        shipping?: string;
        handling_fee?: string;
        insurance?: string;
        shipping_discount?: string;
      };
    };
    payee?: {
      merchant_id: string;
      email?: string;
    };
    description?: string;
    invoice_number?: string;
    item_list?: {
      items: {
        name: string;
        sku?: string;
        price: string;
        currency: string;
        quantity: string;
      }[];
    };
    related_resources: {
      sale?: PayPalSale;
      authorization?: PayPalAuthorization;
      refund?: PayPalRefund;
    }[];
  }[];
}

export interface PayPalSale {
  id: string;
  state: 'completed' | 'partially_refunded' | 'pending' | 'refunded' | 'denied';
  amount: {
    total: string;
    currency: string;
  };
  payment_mode: string;
  protection_eligibility: string;
  protection_eligibility_type: string;
  transaction_fee: {
    value: string;
    currency: string;
  };
  parent_payment: string;
  create_time: string;
  update_time: string;
  links: {
    href: string;
    rel: string;
    method: string;
  }[];
}

/**
 * Subset of PayPal sale fields that the `/v1/reporting/transactions`
 * endpoint actually returns. Distinct from `PayPalSale` (which models the
 * payment-API shape) because the reporting API has narrower coverage:
 * `transaction_fee` is a scalar string here, `links` is absent, and most
 * fields are optional. `id` is required because `getSales` filters out
 * records with no `transaction_id`.
 */
export interface PayPalSaleReport {
  id: string;
  state?: string;
  amount: {
    total?: string;
    currency?: string;
  };
  payment_mode?: string;
  protection_eligibility?: string;
  protection_eligibility_type: string;
  transaction_fee?: string;
  parent_payment?: string;
  create_time?: string;
  update_time?: string;
}

export interface PayPalAuthorization {
  id: string;
  state: 'pending' | 'authorized' | 'captured' | 'partially_captured' | 'expired' | 'voided';
  amount: {
    total: string;
    currency: string;
  };
  parent_payment: string;
  valid_until: string;
  create_time: string;
  update_time: string;
}

export interface PayPalRefund {
  id: string;
  state: 'pending' | 'completed' | 'cancelled' | 'failed';
  amount: {
    total: string;
    currency: string;
  };
  sale_id?: string;
  capture_id?: string;
  parent_payment: string;
  description?: string;
  create_time: string;
  update_time: string;
}

export interface PayPalDispute {
  id: string;
  status: 'open' | 'waiting_for_buyer_response' | 'waiting_for_seller_response' | 'under_review' | 'resolved';
  reason: string;
  dispute_amount: {
    currency: string;
    value: string;
  };
  create_time: string;
  update_time: string;
  disputed_transactions: {
    seller_transaction_id: string;
    buyer_transaction_id: string;
    create_time: string;
  }[];
}

export interface PayPalPayout {
  batch_header: {
    payout_batch_id: string;
    batch_status: 'pending' | 'processing' | 'success' | 'denied' | 'canceled';
    time_created: string;
    time_completed?: string;
    sender_batch_header: {
      sender_batch_id: string;
      email_subject?: string;
      email_message?: string;
    };
    amount: {
      currency: string;
      value: string;
    };
    fees: {
      currency: string;
      value: string;
    };
  };
  items: {
    payout_item_id: string;
    transaction_id?: string;
    transaction_status: 'success' | 'failed' | 'pending' | 'unclaimed' | 'returned' | 'onhold' | 'blocked' | 'refunded' | 'reversed';
    payout_item: {
      recipient_type: 'email' | 'phone' | 'paypal_id';
      amount: {
        currency: string;
        value: string;
      };
      note?: string;
      receiver: string;
      sender_item_id?: string;
    };
    time_processed?: string;
  }[];
}

/**
 * PayPal payment processor connector for payment reconciliation and transaction management
 */
@injectable()
export class PayPalConnector extends BaseConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real PayPal REST API OAuth2 client-credentials scaffolding; ships demo fallback when isDemoMode() or isTestEnvironment() — no production credential test on file';

  private accessToken?: string;
  private tokenExpiry?: number;
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, any>>();

  protected defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  constructor(
    @unmanaged() systemType = 'PayPal',
    @unmanaged() systemId = 'paypal',
    @inject(TYPES.Logger) logger: Logger,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    // Use sandbox for demo, production would be https://api-m.paypal.com
    return 'https://api-m.sandbox.paypal.com';
  }

  async getSystemInfo(): Promise<SystemInfo> {
    if (this.demoMode) {
      return {
        name: 'PayPal (Demo)',
        type: 'PayPal',
        version: 'v2',
        capabilities: [
          'payments',
          'transactions',
          'refunds',
          'disputes',
          'payouts',
          'webhooks',
          'subscriptions',
          'demo_mode'
        ],
        rateLimits: {
          requestsPerMinute: 50,
          requestsPerHour: 1000,
          requestsPerDay: 50000,
        },
        endpoints: {
          baseUrl: 'https://api-m.sandbox.paypal.com',
          authUrl: 'https://api-m.sandbox.paypal.com/v1/oauth2/token',
          webhookUrl: 'https://api-m.sandbox.paypal.com/v1/notifications/webhooks',
        },
      };
    }

    try {
      await this.ensureAuthenticated();

      return {
        name: 'PayPal',
        type: 'PayPal',
        version: 'v2',
        capabilities: [
          'payments',
          'transactions',
          'refunds',
          'disputes',
          'payouts',
          'webhooks',
          'subscriptions',
        ],
        rateLimits: {
          requestsPerMinute: 50,
          requestsPerHour: 1000,
          requestsPerDay: 50000,
        },
        endpoints: {
          baseUrl: this.getDefaultBaseUrl(),
          authUrl: `${this.getDefaultBaseUrl()}/v1/oauth2/token`,
          webhookUrl: `${this.getDefaultBaseUrl()}/v1/notifications/webhooks`,
        },
      };
    } catch (error) {
      this.handleTimeoutError(error);
      this.logger.error('Failed to get PayPal system info', { error });
      throw error;
    }
  }

  /**
   * Authentication using OAuth 2.0 client credentials flow
   */
  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    // Check for demo mode
    const demoEnv = isDemoMode() || isTestEnvironment();
    const clientId = config.credentials?.username || config.credentials?.clientId;
    const demoCredentials = clientId?.toLowerCase().includes('demo') || clientId?.toLowerCase().includes('test');

    if (demoEnv || demoCredentials) {
      this.demoMode = true;
      this.seedDemoData();
      this.logger.info('PayPal connector initialized in DEMO mode');
      return;
    }

    await this.authenticate();
  }

  private seedDemoData(): void {
    const fixtureData = require('./fixtures/paypal-transactions.json');
    const payments = this.demoStore.get('payment') || new Map();

    fixtureData.paypal.forEach((payment: { id: string }) => {
      payments.set(payment.id, payment);
    });

    this.demoStore.set('payment', payments);
    this.logger.info('PayPal demo data seeded', { payments: payments.size });
  }

  private handleAuthError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 401 || err.response?.status === 403) {
      this.isAuthenticated = false;
      throw new Error(
        'PayPal Authentication failed. Please check your credentials.\n' +
        'Troubleshooting:\n' +
        '- Verify your PayPal client ID and secret\n' +
        '- Check if credentials are for the correct environment (sandbox vs live)\n' +
        '- Ensure the app has proper permissions\n' +
        '- Visit https://developer.paypal.com/dashboard to manage credentials'
      );
    }
  }

  private handleRateLimitError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || '60';
      throw new Error(`PayPal rate limit exceeded. Retry after ${retryAfter} seconds`);
    }
  }

  private handleTimeoutError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        'PayPal request timed out. The API may be slow or unavailable.\n' +
        'Troubleshooting:\n' +
        '- Check PayPal API status\n' +
        '- Verify network connectivity\n' +
        '- Consider increasing timeout value'
      );
    }
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('PayPal authentication successful (demo mode)');
      return true;
    }

    try {
      const clientId = this.authConfig.credentials?.username || this.authConfig.credentials?.clientId;
      const clientSecret = this.authConfig.credentials?.password || this.authConfig.credentials?.clientSecret;
      
      if (!clientId || !clientSecret) {
        throw new Error('PayPal client credentials not configured');
      }

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      
      const response = await this.makeRequest<{ access_token: string; expires_in: number }>({
        method: 'POST',
        url: '/v1/oauth2/token',
        data: 'grant_type=client_credentials',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Accept': 'application/json',
          'Accept-Language': 'en_US',
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      });

      this.accessToken = response.access_token;
      this.tokenExpiry = Date.now() + (response.expires_in * 1000);

      // Mirror onto the local map for parity with sibling payment connectors
      this.defaultHeaders['Authorization'] = `Bearer ${this.accessToken}`;
      // BaseConnector.makeRequest dispatches via this.httpClient.request(config)
      // and never reads this.defaultHeaders, so the Bearer token must be set
      // on the axios instance defaults to actually appear on outgoing
      // authenticated requests. Without this line, every getPayments /
      // getSales / getDisputes call would go out unauthenticated.
      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`;

      this.logger.info('PayPal authentication successful');
      this.isAuthenticated = true;
      return true;
    } catch (error) {
      this.logger.error('PayPal authentication failed', { error });
      this.isAuthenticated = false;
      this.handleAuthError(error);
      return false;
    }
  }

  /**
   * Ensure we have a valid access token
   */
  protected override async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken || !this.tokenExpiry || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
  }

  /**
   * Get payment transactions
   */
  async getPayments(options: {
    count?: number;
    start_index?: number;
    start_time?: string; // ISO 8601
    end_time?: string;   // ISO 8601
    sort_by?: 'create_time' | 'update_time';
    sort_order?: 'asc' | 'desc';
  } = {}): Promise<PayPalTransaction[]> {
    try {
      await this.ensureAuthenticated();

      const params = new URLSearchParams();

      if (options.count) params.append('count', options.count.toString());
      if (options.start_index) params.append('start_index', options.start_index.toString());
      if (options.start_time) params.append('start_time', options.start_time);
      if (options.end_time) params.append('end_time', options.end_time);
      if (options.sort_by) params.append('sort_by', options.sort_by);
      if (options.sort_order) params.append('sort_order', options.sort_order);

      const response = await this.makeRequest<{ payments: PayPalTransaction[] }>({
        method: 'GET',
        url: `/v1/payments/payment?${params.toString()}`
      });
      
      return response.payments || [];
    } catch (error) {
      this.logger.error('Failed to get PayPal payments', { error });
      throw error;
    }
  }

  /**
   * Get a specific payment by ID
   */
  async getPayment(paymentId: string): Promise<PayPalTransaction> {
    try {
      await this.ensureAuthenticated();

      const response = await this.makeRequest<PayPalTransaction>({
        method: 'GET',
        url: `/v1/payments/payment/${paymentId}`
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to get PayPal payment', { error, paymentId });
      throw error;
    }
  }

  /**
   * Get sales/captures for reconciliation.
   *
   * The PayPal reporting API (`/v1/reporting/transactions`) returns a
   * fundamentally different shape from the payment-API `PayPalSale` type
   * (e.g. `transaction_fee` is a scalar `fee_amount` here vs. a
   * `{ value, currency }` object on `PayPalSale`, and `links` is absent),
   * so the function returns only the subset of fields that the reporting
   * API actually produces. Records with no `transaction_id` are dropped
   * because downstream reconciliation requires a non-empty id.
   */
  async getSales(options: {
    start_time?: string;
    end_time?: string;
    transaction_id?: string;
    transaction_type?: 'all' | 'payment' | 'refund';
    transaction_status?: 'success' | 'pending' | 'failed';
    page_size?: number;
    page?: number;
  } = {}): Promise<PayPalSaleReport[]> {
    try {
      await this.ensureAuthenticated();

      const params = new URLSearchParams();

      if (options.start_time) params.append('start_time', options.start_time);
      if (options.end_time) params.append('end_time', options.end_time);
      if (options.transaction_id) params.append('transaction_id', options.transaction_id);
      if (options.transaction_type) params.append('transaction_type', options.transaction_type);
      if (options.transaction_status) params.append('transaction_status', options.transaction_status);
      if (options.page_size) params.append('page_size', options.page_size.toString());
      if (options.page) params.append('page', options.page.toString());

      const response = await this.makeRequest<{ transaction_details: PayPalApiEntity[] }>({
        method: 'GET',
        url: `/v1/reporting/transactions?${params.toString()}`
      });

      // Transform reporting API response. The reporting API wraps each
      // entry in a `transaction_info` object with snake_case fields; type
      // the wrapper inline so the field reads are checked.
      type ReportingTransaction = {
        transaction_info?: {
          transaction_id?: string;
          transaction_status?: string;
          transaction_amount?: { value?: string; currency_code?: string };
          payment_method_type?: string;
          protection_eligibility?: string;
          protection_eligibility_type?: string;
          fee_amount?: string;
          transaction_initiation_date?: string;
          transaction_updated_date?: string;
          paypal_reference_id?: string;
        };
      };

      const details = Array.isArray(response.transaction_details) ? response.transaction_details : [];
      const sales: PayPalSaleReport[] = [];
      for (const tx of details) {
        const info = (tx as ReportingTransaction).transaction_info;
        // Drop records with no transaction id — reconciliation requires it.
        if (!info?.transaction_id) continue;
        sales.push({
          id: info.transaction_id,
          state: info.transaction_status,
          amount: {
            total: info.transaction_amount?.value,
            currency: info.transaction_amount?.currency_code,
          },
          payment_mode: info.payment_method_type,
          protection_eligibility: info.protection_eligibility,
          protection_eligibility_type: info.protection_eligibility_type || 'ELIGIBLE',
          transaction_fee: info.fee_amount,
          create_time: info.transaction_initiation_date,
          update_time: info.transaction_updated_date,
          parent_payment: info.paypal_reference_id,
        });
      }
      return sales;
    } catch (error) {
      this.logger.error('Failed to get PayPal sales', { error });
      throw error;
    }
  }

  /**
   * Create a refund
   */
  async createRefund(saleId: string, amount?: { total: string; currency: string }, note?: string): Promise<PayPalRefund> {
    try {
      await this.ensureAuthenticated();

      const refundData: { amount?: { total: string; currency: string }; description?: string } = {};
      if (amount) refundData.amount = amount;
      if (note) refundData.description = note;

      const response = await this.makeRequest<PayPalRefund>({
        method: 'POST',
        url: `/v1/payments/sale/${saleId}/refund`,
        data: refundData
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to create PayPal refund', { error, saleId });
      throw error;
    }
  }

  /**
   * Get disputes
   */
  async getDisputes(options: {
    dispute_state?: string;
    page_size?: number;
    next_page_token?: string;
    start_time?: string;
    disputed_transaction_id?: string;
  } = {}): Promise<{ disputes: PayPalDispute[]; links: PayPalApiEntity[] }> {
    try {
      await this.ensureAuthenticated();

      const params = new URLSearchParams();
      
      if (options.dispute_state) params.append('dispute_state', options.dispute_state);
      if (options.page_size) params.append('page_size', options.page_size.toString());
      if (options.next_page_token) params.append('next_page_token', options.next_page_token);
      if (options.start_time) params.append('start_time', options.start_time);
      if (options.disputed_transaction_id) params.append('disputed_transaction_id', options.disputed_transaction_id);

      const response = await this.makeRequest<{ items: PayPalDispute[]; links: PayPalApiEntity[] }>({
        method: 'GET',
        url: `/v1/customer/disputes?${params.toString()}`
      });
      
      return {
        disputes: response.items || [],
        links: response.links || [],
      };
    } catch (error) {
      this.logger.error('Failed to get PayPal disputes', { error });
      throw error;
    }
  }

  /**
   * Get payouts
   */
  async getPayouts(options: {
    page_size?: number;
    page?: number;
    total_required?: boolean;
  } = {}): Promise<{ payouts: PayPalPayout[]; total_items?: number }> {
    try {
      await this.ensureAuthenticated();

      const params = new URLSearchParams();
      
      if (options.page_size) params.append('page_size', options.page_size.toString());
      if (options.page) params.append('page', options.page.toString());
      if (options.total_required) params.append('total_required', 'true');

      const response = await this.makeRequest<{ payouts: PayPalPayout[]; total_items?: number }>({
        method: 'GET',
        url: `/v1/payments/payouts?${params.toString()}`
      });
      
      return {
        payouts: response.payouts || [],
        total_items: response.total_items,
      };
    } catch (error) {
      this.logger.error('Failed to get PayPal payouts', { error });
      throw error;
    }
  }

  /**
   * Create a webhook
   */
  async setupWebhook(url: string, events: string[]): Promise<unknown> {
    try {
      await this.ensureAuthenticated();

      const webhookData = {
        url,
        event_types: events.map(eventType => ({ name: eventType })),
      };

      const response = await this.makeRequest<unknown>({
        method: 'POST',
        url: '/v1/notifications/webhooks',
        data: webhookData
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to setup PayPal webhook', { error, url });
      throw error;
    }
  }

  /**
   * Reconcile PayPal transactions with NetSuite records
   */
  async reconcileWithNetSuite(transactions: PayPalSale[], netsuiteRecords: NetSuiteRecord[]): Promise<{
    matched: { paypal: PayPalSale; netsuite: unknown; confidence: number }[];
    unmatched: PayPalSale[];
    variances: { paypal: PayPalSale; netsuite: unknown; variance: number }[];
  }> {
    try {
      const matched: { paypal: PayPalSale; netsuite: unknown; confidence: number }[] = [];
      const unmatched: PayPalSale[] = [];
      const variances: { paypal: PayPalSale; netsuite: unknown; variance: number }[] = [];

      for (const transaction of transactions) {
        let bestMatch = null;
        let bestConfidence = 0;

        for (const nsRecord of netsuiteRecords) {
          const confidence = this.calculateMatchConfidence(transaction, nsRecord);
          
          if (confidence > bestConfidence) {
            bestMatch = nsRecord;
            bestConfidence = confidence;
          }
        }

        if (bestMatch && bestConfidence > 0.8) {
          const paypalAmount = parseFloat(transaction.amount.total);
          const netsuiteAmount = (bestMatch as { amount: number }).amount;
          const variance = Math.abs(paypalAmount - netsuiteAmount);
          
          if (variance < 0.01) { // Less than 1 cent difference
            matched.push({ paypal: transaction, netsuite: bestMatch, confidence: bestConfidence });
          } else {
            variances.push({ paypal: transaction, netsuite: bestMatch, variance });
          }
        } else {
          unmatched.push(transaction);
        }
      }

      this.logger.info('PayPal reconciliation completed', {
        totalTransactions: transactions.length,
        matched: matched.length,
        unmatched: unmatched.length,
        variances: variances.length,
      });

      return { matched, unmatched, variances };
    } catch (error) {
      this.logger.error('Failed to reconcile PayPal transactions', { error });
      throw error;
    }
  }

  private calculateMatchConfidence(paypalSale: PayPalSale, netsuiteRecord: unknown): number {
    let confidence = 0;
    const ns = (netsuiteRecord ?? {}) as {
      amount?: number;
      trandate?: string | number | Date;
      externalid?: string;
      memo?: string;
    };

    // Amount matching (most important). Preserve the original behavior:
    // when ns.amount is undefined the diff is NaN (NaN < 0.01 is false), so
    // missing-amount NetSuite records contribute no amount confidence
    // rather than being treated as a real 0-value amount that could
    // incorrectly match small PayPal amounts.
    const paypalAmount = parseFloat(paypalSale.amount.total);
    const netsuiteAmount = ns.amount ?? NaN;
    const amountDiff = Math.abs(paypalAmount - netsuiteAmount);
    const amountTolerance = Math.max(paypalAmount * 0.01, 0.01); // 1% or 1 cent

    if (amountDiff < 0.01) {
      confidence += 0.5;
    } else if (amountDiff <= amountTolerance) {
      confidence += 0.3;
    }

    // Date matching. Same NaN-propagation policy: missing trandate yields
    // NaN dateDiff and skips both confidence branches.
    const paypalDate = new Date(paypalSale.create_time).getTime();
    const netsuiteDate = ns.trandate ? new Date(ns.trandate).getTime() : NaN;
    const dateDiff = Math.abs(paypalDate - netsuiteDate);
    const dayMs = 24 * 60 * 60 * 1000;

    if (dateDiff <= dayMs) {
      confidence += 0.2;
    } else if (dateDiff <= 3 * dayMs) {
      confidence += 0.1;
    }

    // Transaction ID matching
    if (paypalSale.id && ns.externalid) {
      if (paypalSale.id === ns.externalid) {
        confidence += 0.2;
      }
    }

    // Reference matching
    if (paypalSale.parent_payment && ns.memo) {
      if (ns.memo.includes(paypalSale.parent_payment)) {
        confidence += 0.1;
      }
    }

    return Math.min(confidence, 1.0);
  }

  // BaseConnector abstract method implementations
  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    if (this.demoMode) {
      return this.createDemo(entityType, data) as unknown as DataRecord;
    }

    try {
      switch (entityType) {
      case 'refund': {
        const refund = data as { saleId: string; amount?: { total: string; currency: string }; note?: string };
        return await this.createRefund(refund.saleId, refund.amount, refund.note) as unknown as DataRecord;
      }
      case 'webhook': {
        const webhook = data as { url: string; events: string[] };
        return await this.setupWebhook(webhook.url, webhook.events) as unknown as DataRecord;
      }
      default:
        throw new Error(`Create operation for ${entityType} not supported`);
      }
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  async read(entityType: string, id: string): Promise<DataRecord | null> {
    if (this.demoMode) {
      return this.readDemo(entityType, id) as unknown as DataRecord | null;
    }

    try {
      switch (entityType) {
      case 'payment':
        return await this.getPayment(id) as unknown as DataRecord;
      default:
        throw new Error(`Entity type ${entityType} not supported`);
      }
    } catch (error: unknown) {
      this.handleTimeoutError(error);
      throw error;
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    if (this.demoMode) {
      return this.updateDemo(entityType, id, data) as unknown as DataRecord;
    }
    throw new Error('Update operations not supported for PayPal connector');
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    if (this.demoMode) {
      return this.deleteDemo(entityType, id);
    }
    throw new Error('Delete operations not supported for PayPal connector');
  }

  async list(entityType: string, options?: ListOptions): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.listDemo(entityType, options) as unknown as DataRecord[];
    }

    try {
      // Each branch's options shape differs; cast the generic ListOptions
      // to the per-entity shape rather than `as any` (which silenced
      // mismatches without flagging them).
      switch (entityType) {
      case 'payments':
        return await this.getPayments(options as Parameters<typeof this.getPayments>[0]) as unknown as DataRecord[];
      case 'sales':
        return await this.getSales(options as Parameters<typeof this.getSales>[0]) as unknown as DataRecord[];
      case 'disputes': {
        const disputeResult = await this.getDisputes(options as Parameters<typeof this.getDisputes>[0]);
        return disputeResult.disputes as unknown as DataRecord[];
      }
      case 'payouts': {
        const payoutResult = await this.getPayouts(options as Parameters<typeof this.getPayouts>[0]);
        return payoutResult.payouts as unknown as DataRecord[];
      }
      default:
        throw new Error(`Entity type ${entityType} not supported`);
      }
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  async search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.searchDemo(entityType, criteria) as unknown as DataRecord[];
    }

    // SearchCriteria is loosely typed; the route layer passes camelCase
    // hints (startTime, endTime, transactionId, etc.) that PayPal's APIs
    // expect as snake_case. Narrow once at the top instead of casting each
    // field access.
    const c = criteria as {
      startTime?: string;
      endTime?: string;
      limit?: number;
      sortBy?: 'create_time' | 'update_time';
      sortOrder?: 'asc' | 'desc';
      transactionId?: string;
      status?: 'success' | 'pending' | 'failed';
    };

    try {
      switch (entityType) {
      case 'payments':
        return await this.getPayments({
          start_time: c.startTime,
          end_time: c.endTime,
          count: c.limit,
          sort_by: c.sortBy,
          sort_order: c.sortOrder
        }) as unknown as DataRecord[];
      case 'sales':
        return await this.getSales({
          start_time: c.startTime,
          end_time: c.endTime,
          transaction_id: c.transactionId,
          transaction_status: c.status,
          page_size: c.limit
        }) as unknown as DataRecord[];
      default:
        throw new Error(`Search for entity type ${entityType} not supported`);
      }
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  // Demo mode helper methods
  private normalizeEntityType(entityType: string): string {
    const normalized = entityType.toLowerCase().replace(/s$/, '');
    if (normalized.includes('payment')) return 'payment';
    if (normalized.includes('sale')) return 'payment'; // Sales are part of payments
    return entityType.toLowerCase();
  }

  private async createDemo(entityType: string, data: unknown): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType) || new Map();

    const id = `${entityType}_demo_${Date.now()}`;
    const record: DataRecord = {
      id,
      ...(data as Record<string, unknown>),
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
      state: 'created'
    };

    store.set(id, record);
    this.demoStore.set(normalizedType, store);

    this.logger.info(`Demo: Created ${entityType} ${id}`);
    return record;
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const record = store?.get(id);

    if (record) {
      this.logger.info(`Demo: Read ${entityType} ${id}`);
      return record as DataRecord;
    }

    throw new Error(`${entityType} not found: ${id}`);
  }

  private async updateDemo(entityType: string, id: string, data: unknown): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const existing = store?.get(id);

    if (!existing) {
      throw new Error(`${entityType} not found: ${id}`);
    }

    const updated: DataRecord = {
      ...(existing as Record<string, unknown>),
      ...(data as Record<string, unknown>),
      update_time: new Date().toISOString()
    };

    store!.set(id, updated);
    this.logger.info(`Demo: Updated ${entityType} ${id}`);
    return updated;
  }

  private async deleteDemo(entityType: string, id: string): Promise<boolean> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const result = store?.delete(id) || false;

    if (result) {
      this.logger.info(`Demo: Deleted ${entityType} ${id}`);
    }

    return result;
  }

  private async listDemo(entityType: string, options: unknown = {}): Promise<PayPalEntity[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    // Apply filters. Demo callers pass loose option objects; narrow once.
    const opts = (options ?? {}) as {
      state?: string;
      status?: string;
      count?: number;
      page_size?: number;
      limit?: number;
    };
    if (opts.state || opts.status) {
      const filterState = opts.state || opts.status;
      results = results.filter(r => r.state === filterState);
    }

    // Apply limit
    const limit = opts.count || opts.page_size || opts.limit || results.length;

    this.logger.info(`Demo: Listed ${entityType} (${results.length} results, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit);
  }

  private async searchDemo(entityType: string, criteria: unknown): Promise<PayPalEntity[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    const c = (criteria ?? {}) as {
      status?: string;
      state?: string;
      startTime?: string | number | Date;
      endTime?: string | number | Date;
      limit?: number;
      page_size?: number;
    };

    // Apply filters
    if (c.status || c.state) {
      const filterState = c.status || c.state;
      results = results.filter(r => r.state === filterState);
    }

    if (c.startTime) {
      const startTime = new Date(c.startTime).getTime();
      results = results.filter(r => new Date(r.create_time).getTime() >= startTime);
    }

    if (c.endTime) {
      const endTime = new Date(c.endTime).getTime();
      results = results.filter(r => new Date(r.create_time).getTime() <= endTime);
    }

    // Apply limit
    const limit = c.limit || c.page_size || results.length;

    this.logger.info(`Demo: Searched ${entityType} (${results.length} matches, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit);
  }
}
