import { injectable, inject, unmanaged } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { SystemInfo, AuthConfig, DataRecord } from '../types';
import type { Logger } from '../utils/Logger';
import type { CircuitBreakerOptions } from '../utils/CircuitBreaker';
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

// Generic type for Stripe API list responses (raw API format before transformation)
type StripeApiEntity = Record<string, unknown> & { id: string };

// Union type for all formatted Stripe entities
type StripeEntity = StripeTransaction | StripeCustomer | StripeDispute | StripePayout | StripeApiEntity;

// Generic type for NetSuite records used in reconciliation
type NetSuiteRecord = Record<string, unknown> & { id?: string | number }

export interface StripeTransaction {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_payment_method';
  payment_method?: string;
  customer?: string;
  description?: string;
  created: number;
  updated: number;
  metadata: Record<string, string>;
  fees: {
    amount: number;
    currency: string;
    description: string;
    type: string;
  }[];
  refunds?: {
    id: string;
    amount: number;
    created: number;
    status: string;
  }[];
}

export interface StripeCustomer {
  id: string;
  email?: string;
  name?: string;
  phone?: string;
  address?: {
    city?: string;
    country?: string;
    line1?: string;
    line2?: string;
    postal_code?: string;
    state?: string;
  };
  created: number;
  metadata: Record<string, string>;
  default_source?: string;
  sources: {
    data: {
      id: string;
      brand?: string;
      last4?: string;
      exp_month?: number;
      exp_year?: number;
    }[];
  };
}

export interface StripeDispute {
  id: string;
  amount: number;
  currency: string;
  charge: string;
  created: number;
  status: 'warning_needs_response' | 'warning_under_review' | 'warning_closed' | 'needs_response' | 'under_review' | 'charge_refunded' | 'won' | 'lost';
  reason: string;
  evidence_due_by: number;
}

export interface StripePayout {
  id: string;
  amount: number;
  currency: string;
  arrival_date: number;
  created: number;
  status: 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed';
  type: 'bank_account' | 'card';
  method: 'standard' | 'instant';
  destination?: string;
}

/**
 * Stripe payment processor connector for payment reconciliation and transaction management
 */
@injectable()
export class StripeConnector extends BaseConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real Stripe REST API scaffolding (Bearer token auth); ships demo fallback when isDemoMode() or isTestEnvironment() — no production credential test on file';

  private accessToken?: string;
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, any>>();

  protected defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  constructor(
    @unmanaged() systemType = 'Stripe',
    @unmanaged() systemId = 'stripe',
    @inject(TYPES.Logger) logger: Logger,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.stripe.com/v1';
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    // Check for demo mode
    const demoEnv = isDemoMode() || isTestEnvironment();
    const demoCredentials = config.credentials?.apiKey?.toLowerCase().includes('demo') ||
                           config.credentials?.apiKey?.toLowerCase().includes('test');

    if (demoEnv || demoCredentials) {
      this.demoMode = true;
      this.seedDemoData();
      this.logger.info('Stripe connector initialized in DEMO mode');
      return;
    }

    await this.authenticate();
  }

  private seedDemoData(): void {
    // Load demo transactions from fixture file
    const fixtureData = require('./fixtures/stripe-transactions.json');
    const charges = this.demoStore.get('charge') || new Map();

    fixtureData.stripe.forEach((charge: { id: string }) => {
      charges.set(charge.id, charge);
    });

    this.demoStore.set('charge', charges);
    this.demoStore.set('payment_intent', charges); // Alias for newer API

    // Seed demo customers
    const customers = this.demoStore.get('customer') || new Map();
    customers.set('cus_StripeDemo001', {
      id: 'cus_StripeDemo001',
      email: 'john.doe@demo.com',
      name: 'John Doe',
      created: 1697400000,
      metadata: {}
    });
    customers.set('cus_StripeDemo002', {
      id: 'cus_StripeDemo002',
      email: 'jane.smith@demo.com',
      name: 'Jane Smith',
      created: 1697410000,
      metadata: {}
    });
    this.demoStore.set('customer', customers);

    this.logger.info('Stripe demo data seeded', {
      charges: charges.size,
      customers: customers.size
    });
  }

  private handleAuthError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 401 || err.response?.status === 403) {
      this.isAuthenticated = false;
      throw new Error(
        'Stripe Authentication failed. Please check your API key.\n' +
        'Troubleshooting:\n' +
        '- Verify your Stripe secret key (starts with sk_)\n' +
        '- Check if the key is for the correct environment (test vs live)\n' +
        '- Ensure the key has not been revoked\n' +
        '- Visit https://dashboard.stripe.com/apikeys to manage keys'
      );
    }
  }

  private handleRateLimitError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || '60';
      throw new Error(`Stripe rate limit exceeded. Retry after ${retryAfter} seconds`);
    }
  }

  private handleTimeoutError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        'Stripe request timed out. The API may be slow or unavailable.\n' +
        'Troubleshooting:\n' +
        '- Check Stripe API status at https://status.stripe.com\n' +
        '- Verify network connectivity\n' +
        '- Consider increasing timeout value'
      );
    }
  }

  async search(entityType: string, criteria: unknown): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.searchDemo(entityType, criteria);
    }

    // Basic search implementation for Stripe
    const c = (criteria ?? {}) as { limit?: number; created?: string };
    const params = new URLSearchParams();
    if (c.limit) params.append('limit', c.limit.toString());
    if (c.created) params.append('created', c.created);

    try {
      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/${entityType}s?${params.toString()}`
      });
      return (response.data || []).map(item => ({ id: item.id, fields: item }));
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    if (this.demoMode) {
      return {
        name: 'Stripe (Demo)',
        version: 'v1',
        type: 'Stripe',
        capabilities: [
          'transactions',
          'customers',
          'payments',
          'refunds',
          'disputes',
          'payouts',
          'webhooks',
          'demo_mode'
        ],
        rateLimits: {
          requestsPerMinute: 100,
          requestsPerHour: 1000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: 'https://api.stripe.com/v1',
          authUrl: 'https://api.stripe.com/v1/oauth',
          webhookUrl: 'https://api.stripe.com/v1/webhook_endpoints',
        },
      };
    }

    try {
      // Probe Stripe's /account endpoint to verify connectivity. The returned
      // payload isn't consumed (we return static capability info below).
      await this.makeRequest<StripeApiEntity>({ method: 'GET', url: '/account' });

      return {
        name: 'Stripe',
        version: 'v1',
        type: 'Stripe',
        capabilities: [
          'transactions',
          'customers',
          'payments',
          'refunds',
          'disputes',
          'payouts',
          'webhooks',
        ],
        rateLimits: {
          requestsPerMinute: 100,
          requestsPerHour: 1000,
          requestsPerDay: 100000,
        },
        endpoints: {
          baseUrl: this.getDefaultBaseUrl(),
          authUrl: `${this.getDefaultBaseUrl()}/oauth`,
          webhookUrl: `${this.getDefaultBaseUrl()}/webhook_endpoints`,
        },
      };
    } catch (error) {
      this.handleTimeoutError(error);
      this.logger.error('Failed to get Stripe system info', { error });
      throw error;
    }
  }

  /**
   * Authentication setup for Stripe API
   */
  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('Stripe authentication successful (demo mode)');
      return true;
    }

    try {
      const apiKey = this.authConfig?.credentials?.apiKey;

      if (!apiKey) {
        throw new Error('Stripe API key not found in configuration');
      }

      // Store the API key
      this.accessToken = apiKey;

      // Set authorization header
      this.defaultHeaders['Authorization'] = `Bearer ${apiKey}`;

      // Update HTTP client headers
      this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${apiKey}`;

      // Test authentication by fetching account info
      const response = await this.makeRequest<StripeApiEntity>({
        method: 'GET',
        url: '/account'
      });

      this.logger.info('Stripe authentication successful', {
        accountId: response.id,
      });
      this.isAuthenticated = true;
      return true;
    } catch (error) {
      this.logger.error('Stripe authentication failed', { error });
      this.isAuthenticated = false;
      this.handleAuthError(error);
      return false;
    }
  }

  /**
   * Get transactions/charges with advanced filtering
   */
  async getTransactions(options: {
    limit?: number;
    created?: { gte?: number; lte?: number };
    customer?: string;
    startingAfter?: string;
    endingBefore?: string;
  } = {}): Promise<StripeTransaction[]> {
    try {
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.customer) params.append('customer', options.customer);
      if (options.startingAfter) params.append('starting_after', options.startingAfter);
      if (options.endingBefore) params.append('ending_before', options.endingBefore);
      
      if (options.created) {
        if (options.created.gte) params.append('created[gte]', options.created.gte.toString());
        if (options.created.lte) params.append('created[lte]', options.created.lte.toString());
      }

      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/charges?${params.toString()}`
      });
      
      return response.data.map((charge: unknown) => this.formatStripeTransaction(charge));
    } catch (error) {
      this.logger.error('Failed to get Stripe transactions', { error });
      throw error;
    }
  }

  /**
   * Get a specific transaction by ID
   */
  async getTransaction(chargeId: string): Promise<StripeTransaction> {
    try {
      const response = await this.makeRequest<StripeApiEntity>({
        method: 'GET',
        url: `/charges/${chargeId}`
      });
      return this.formatStripeTransaction(response);
    } catch (error) {
      this.logger.error('Failed to get Stripe transaction', { error, chargeId });
      throw error;
    }
  }

  /**
   * Get customers
   */
  async getCustomers(options: {
    limit?: number;
    email?: string;
    startingAfter?: string;
  } = {}): Promise<StripeCustomer[]> {
    try {
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.email) params.append('email', options.email);
      if (options.startingAfter) params.append('starting_after', options.startingAfter);

      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/customers?${params.toString()}`
      });
      
      return response.data.map((customer: unknown) => this.formatStripeCustomer(customer));
    } catch (error) {
      this.logger.error('Failed to get Stripe customers', { error });
      throw error;
    }
  }

  /**
   * Get customer by ID
   */
  async getCustomer(customerId: string): Promise<StripeCustomer> {
    try {
      const response = await this.makeRequest<StripeApiEntity>({
        method: 'GET',
        url: `/customers/${customerId}`
      });
      return this.formatStripeCustomer(response);
    } catch (error) {
      this.logger.error('Failed to get Stripe customer', { error, customerId });
      throw error;
    }
  }

  /**
   * Get disputes
   */
  async getDisputes(options: {
    limit?: number;
    created?: { gte?: number; lte?: number };
    charge?: string;
  } = {}): Promise<StripeDispute[]> {
    try {
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.charge) params.append('charge', options.charge);
      
      if (options.created) {
        if (options.created.gte) params.append('created[gte]', options.created.gte.toString());
        if (options.created.lte) params.append('created[lte]', options.created.lte.toString());
      }

      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/disputes?${params.toString()}`
      });
      
      return response.data.map((dispute: unknown) => this.formatStripeDispute(dispute));
    } catch (error) {
      this.logger.error('Failed to get Stripe disputes', { error });
      throw error;
    }
  }

  /**
   * Get payouts
   */
  async getPayouts(options: {
    limit?: number;
    created?: { gte?: number; lte?: number };
    status?: string;
  } = {}): Promise<StripePayout[]> {
    try {
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.status) params.append('status', options.status);
      
      if (options.created) {
        if (options.created.gte) params.append('created[gte]', options.created.gte.toString());
        if (options.created.lte) params.append('created[lte]', options.created.lte.toString());
      }

      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/payouts?${params.toString()}`
      });
      
      return response.data.map((payout: unknown) => this.formatStripePayout(payout));
    } catch (error) {
      this.logger.error('Failed to get Stripe payouts', { error });
      throw error;
    }
  }

  /**
   * Create a refund
   */
  async createRefund(chargeId: string, amount?: number, reason?: string): Promise<unknown> {
    try {
      const params = new URLSearchParams();
      params.append('charge', chargeId);
      
      if (amount) params.append('amount', amount.toString());
      if (reason) params.append('reason', reason);

      const response = await this.makeRequest<StripeApiEntity>({
        method: 'POST',
        url: '/refunds',
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to create Stripe refund', { error, chargeId, amount });
      throw error;
    }
  }

  /**
   * Get balance transactions for reconciliation
   */
  async getBalanceTransactions(options: {
    limit?: number;
    created?: { gte?: number; lte?: number };
    type?: string;
    payout?: string;
  } = {}): Promise<StripeApiEntity[]> {
    try {
      const params = new URLSearchParams();
      
      if (options.limit) params.append('limit', options.limit.toString());
      if (options.type) params.append('type', options.type);
      if (options.payout) params.append('payout', options.payout);
      
      if (options.created) {
        if (options.created.gte) params.append('created[gte]', options.created.gte.toString());
        if (options.created.lte) params.append('created[lte]', options.created.lte.toString());
      }

      const response = await this.makeRequest<{ data: StripeApiEntity[] }>({
        method: 'GET',
        url: `/balance_transactions?${params.toString()}`
      });
      
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get Stripe balance transactions', { error });
      throw error;
    }
  }

  /**
   * Set up webhook endpoint
   */
  async setupWebhook(url: string, events: string[]): Promise<unknown> {
    try {
      const params = new URLSearchParams();
      params.append('url', url);
      events.forEach(event => params.append('enabled_events[]', event));

      const response = await this.makeRequest<StripeApiEntity>({
        method: 'POST',
        url: '/webhook_endpoints',
        data: params.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to setup Stripe webhook', { error, url });
      throw error;
    }
  }

  /**
   * Reconcile transactions with NetSuite records
   */
  async reconcileWithNetSuite(transactions: StripeTransaction[], netsuiteRecords: NetSuiteRecord[]): Promise<{
    matched: { stripe: StripeTransaction; netsuite: unknown; confidence: number }[];
    unmatched: StripeTransaction[];
    variances: { stripe: StripeTransaction; netsuite: unknown; variance: number }[];
  }> {
    try {
      const matched: { stripe: StripeTransaction; netsuite: unknown; confidence: number }[] = [];
      const unmatched: StripeTransaction[] = [];
      const variances: { stripe: StripeTransaction; netsuite: unknown; variance: number }[] = [];

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
          const variance = Math.abs(transaction.amount - ((bestMatch as { amount: number }).amount * 100)); // Convert to cents
          
          if (variance === 0) {
            matched.push({ stripe: transaction, netsuite: bestMatch, confidence: bestConfidence });
          } else {
            variances.push({ stripe: transaction, netsuite: bestMatch, variance });
          }
        } else {
          unmatched.push(transaction);
        }
      }

      this.logger.info('Stripe reconciliation completed', {
        totalTransactions: transactions.length,
        matched: matched.length,
        unmatched: unmatched.length,
        variances: variances.length,
      });

      return { matched, unmatched, variances };
    } catch (error) {
      this.logger.error('Failed to reconcile Stripe transactions', { error });
      throw error;
    }
  }

  // Private formatting methods. Stripe API responses aren't typed at this
  // boundary (we go through BaseConnector.makeRequest, not the Stripe SDK),
  // so each formatter narrows its `unknown` input to a local interface that
  // lists exactly the fields we read.
  private formatStripeTransaction(charge: unknown): StripeTransaction {
    // RawStripeRefund mirrors the Stripe API refund shape we consume —
    // declared explicitly rather than derived from StripeTransaction['refunds']
    // so the output type can evolve without silently changing the assumed
    // wire shape.
    type RawStripeRefund = {
      id: string;
      amount: number;
      created: number;
      status: string;
    };
    type RawStripeCharge = {
      id: string;
      amount: number;
      currency: string;
      status: StripeTransaction['status'];
      payment_method?: string;
      customer?: string;
      description?: string;
      created: number;
      metadata?: Record<string, string>;
      balance_transaction?: { fee_details?: StripeTransaction['fees'] };
      refunds?: { data?: RawStripeRefund[] };
    };
    const c = charge as RawStripeCharge;
    return {
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      payment_method: c.payment_method,
      customer: c.customer,
      description: c.description,
      created: c.created * 1000, // Convert to milliseconds
      updated: c.created * 1000, // Stripe doesn't have updated field
      metadata: c.metadata || {},
      fees: c.balance_transaction?.fee_details || [],
      refunds: c.refunds?.data?.map(refund => ({
        id: refund.id,
        amount: refund.amount,
        created: refund.created * 1000,
        status: refund.status,
      })) || [],
    };
  }

  private formatStripeCustomer(customer: unknown): StripeCustomer {
    type RawStripeCustomer = {
      id: string;
      email?: string;
      name?: string;
      phone?: string;
      address?: StripeCustomer['address'];
      created: number;
      metadata?: Record<string, string>;
      default_source?: string;
      sources?: StripeCustomer['sources'];
    };
    const c = customer as RawStripeCustomer;
    return {
      id: c.id,
      email: c.email,
      name: c.name,
      phone: c.phone,
      address: c.address,
      created: c.created * 1000,
      metadata: c.metadata || {},
      default_source: c.default_source,
      sources: c.sources || { data: [] },
    };
  }

  private formatStripeDispute(dispute: unknown): StripeDispute {
    type RawStripeDispute = {
      id: string;
      amount: number;
      currency: string;
      charge: string;
      created: number;
      status: StripeDispute['status'];
      reason: string;
      evidence_due_by: number;
    };
    const d = dispute as RawStripeDispute;
    return {
      id: d.id,
      amount: d.amount,
      currency: d.currency,
      charge: d.charge,
      created: d.created * 1000,
      status: d.status,
      reason: d.reason,
      evidence_due_by: d.evidence_due_by * 1000,
    };
  }

  private formatStripePayout(payout: unknown): StripePayout {
    type RawStripePayout = {
      id: string;
      amount: number;
      currency: string;
      arrival_date: number;
      created: number;
      status: StripePayout['status'];
      type: StripePayout['type'];
      method: StripePayout['method'];
      destination: string;
    };
    const p = payout as RawStripePayout;
    return {
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      arrival_date: p.arrival_date * 1000,
      created: p.created * 1000,
      status: p.status,
      type: p.type,
      method: p.method,
      destination: p.destination,
    };
  }

  private calculateMatchConfidence(stripeTransaction: StripeTransaction, netsuiteRecord: unknown): number {
    let confidence = 0;
    const ns = (netsuiteRecord ?? {}) as {
      amount?: number;
      trandate?: string | number | Date;
      entity?: string;
      memo?: string;
      tranid?: string;
    };

    // Amount matching (most important). Missing ns.amount yields NaN diff
    // (NaN === 0 / NaN <= tol both false), so missing-amount records
    // contribute no amount confidence rather than being treated as a
    // real 0-value amount.
    const netsuiteAmount = ns.amount ?? NaN;
    const amountDiff = Math.abs(stripeTransaction.amount - (netsuiteAmount * 100));
    const amountTolerance = Math.max(stripeTransaction.amount * 0.01, 100); // 1% or $1

    if (amountDiff === 0) {
      confidence += 0.5;
    } else if (amountDiff <= amountTolerance) {
      confidence += 0.3;
    }

    // Date matching. Same NaN-propagation policy.
    const stripeDateMs = stripeTransaction.created;
    const netsuiteDateMs = ns.trandate ? new Date(ns.trandate).getTime() : NaN;
    const dateDiff = Math.abs(stripeDateMs - netsuiteDateMs);
    const dayMs = 24 * 60 * 60 * 1000;

    if (dateDiff <= dayMs) {
      confidence += 0.2;
    } else if (dateDiff <= 3 * dayMs) {
      confidence += 0.1;
    }

    // Customer matching
    if (stripeTransaction.customer && ns.entity) {
      // This would need to be enhanced with actual customer ID mapping
      confidence += 0.1;
    }

    // Description/memo matching
    if (stripeTransaction.description && ns.memo) {
      const desc1 = stripeTransaction.description.toLowerCase();
      const desc2 = ns.memo.toLowerCase();

      if (desc1.includes(desc2) || desc2.includes(desc1)) {
        confidence += 0.1;
      }
    }

    // Reference number matching
    if (stripeTransaction.metadata.reference && ns.tranid) {
      if (stripeTransaction.metadata.reference === ns.tranid) {
        confidence += 0.1;
      }
    }

    return Math.min(confidence, 1.0);
  }

  // BaseConnector abstract method implementations
  async create(entityType: string, data: DataRecord): Promise<DataRecord> {
    if (this.demoMode) {
      return this.createDemo(entityType, data);
    }

    try {
      switch (entityType) {
      case 'refund': {
        const fields = (data.fields ?? {}) as { chargeId?: string; amount?: number; reason?: string };
        if (!fields.chargeId) {
          throw new Error('refund.fields.chargeId is required');
        }
        const refund = await this.createRefund(fields.chargeId, fields.amount, fields.reason);
        return { id: (refund as { id: string }).id, fields: refund as Record<string, unknown> };
      }
      case 'webhook': {
        const fields = (data.fields ?? {}) as { url?: unknown; events?: unknown };
        if (typeof fields.url !== 'string' || !fields.url) {
          throw new Error('webhook.fields.url is required');
        }
        if (
          !Array.isArray(fields.events) ||
          fields.events.length === 0 ||
          !fields.events.every(e => typeof e === 'string')
        ) {
          throw new Error('webhook.fields.events must be a non-empty array of strings');
        }
        const webhook = await this.setupWebhook(fields.url, fields.events);
        return { id: (webhook as { id: string }).id, fields: webhook as Record<string, unknown> };
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
      return this.readDemo(entityType, id);
    }

    try {
      let result: unknown;
      switch (entityType) {
      case 'charge':
      case 'transaction':
        result = await this.getTransaction(id);
        break;
      case 'customer':
        result = await this.getCustomer(id);
        break;
      default:
        throw new Error(`Entity type ${entityType} not supported`);
      }
      return { id: (result as { id: string }).id, fields: result as Record<string, unknown> };
    } catch (error) {
      this.handleTimeoutError(error);
      this.logger.warn(`Failed to read ${entityType} ${id}`, { error });
      return null;
    }
  }

  async update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    if (this.demoMode) {
      return this.updateDemo(entityType, id, data);
    }
    throw new Error('Update operations not supported for Stripe connector');
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    if (this.demoMode) {
      return this.deleteDemo(entityType, id);
    }
    throw new Error('Delete operations not supported for Stripe connector');
  }

  async list(entityType: string, options: unknown = {}): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.listDemo(entityType, options);
    }

    try {
      let results: StripeEntity[];
      // Each branch's options shape differs; cast the generic `unknown`
      // to the per-entity shape rather than `as any`.
      switch (entityType) {
      case 'charges':
      case 'transactions':
        results = await this.getTransactions(options as Parameters<typeof this.getTransactions>[0]);
        break;
      case 'customers':
        results = await this.getCustomers(options as Parameters<typeof this.getCustomers>[0]);
        break;
      case 'disputes':
        results = await this.getDisputes(options as Parameters<typeof this.getDisputes>[0]);
        break;
      case 'payouts':
        results = await this.getPayouts(options as Parameters<typeof this.getPayouts>[0]);
        break;
      default:
        throw new Error(`Entity type ${entityType} not supported`);
      }
      return results.map(item => ({ id: item.id, fields: item }));
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  // Demo mode helper methods
  private normalizeEntityType(entityType: string): string {
    const normalized = entityType.toLowerCase().replace(/s$/, ''); // Remove trailing 's'
    if (normalized.includes('charge') || normalized.includes('transaction')) return 'charge';
    if (normalized.includes('customer')) return 'customer';
    if (normalized.includes('payment')) return 'charge';
    return entityType.toLowerCase();
  }

  private async createDemo(entityType: string, data: DataRecord): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType) || new Map();

    const id = `${entityType}_demo_${Date.now()}`;
    const fields = data.fields as Record<string, unknown>;
    const record: Record<string, unknown> = {
      id,
      ...fields,
      created: Math.floor(Date.now() / 1000),
      metadata: (fields?.metadata as Record<string, unknown>) || {}
    };

    store.set(id, record);
    this.demoStore.set(normalizedType, store);

    this.logger.info(`Demo: Created ${entityType} ${id}`);
    return { id, fields: record };
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const record = store?.get(id);

    if (record) {
      this.logger.info(`Demo: Read ${entityType} ${id}`);
      return { id: record.id, fields: record };
    }

    return null;
  }

  private async updateDemo(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const existing = store?.get(id);

    if (!existing) {
      throw new Error(`${entityType} not found: ${id}`);
    }

    const existingRec = existing as Record<string, unknown> & { metadata?: Record<string, unknown> };
    const fieldsRec = (data.fields ?? {}) as Record<string, unknown> & { metadata?: Record<string, unknown> };
    const updated = {
      ...existingRec,
      ...fieldsRec,
      metadata: {
        ...existingRec.metadata,
        ...fieldsRec.metadata,
      },
    };

    store!.set(id, updated);
    this.logger.info(`Demo: Updated ${entityType} ${id}`);
    return { id, fields: updated };
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

  private async listDemo(entityType: string, options: unknown = {}): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    // Apply filters if any
    const opts = (options ?? {}) as { status?: string; customer?: string; limit?: number };
    if (opts.status) {
      results = results.filter(r => r.status === opts.status);
    }
    if (opts.customer) {
      results = results.filter(r => r.customer === opts.customer);
    }

    // Apply limit
    const limit = opts.limit || results.length;

    this.logger.info(`Demo: Listed ${entityType} (${results.length} results, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit).map(item => ({ id: item.id, fields: item }));
  }

  private async searchDemo(entityType: string, criteria: unknown): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    // Apply search criteria
    const c = (criteria ?? {}) as { filters?: Record<string, unknown>; limit?: number };
    if (c.filters) {
      const filters = c.filters;
      results = results.filter(record => {
        return Object.entries(filters).every(([key, value]) => {
          const fieldValue = record[key];
          if (typeof fieldValue === 'string' && typeof value === 'string') {
            return fieldValue.toLowerCase().includes(value.toLowerCase());
          }
          return fieldValue === value;
        });
      });
    }

    // Apply limit
    const limit = c.limit || results.length;

    this.logger.info(`Demo: Searched ${entityType} (${results.length} matches, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit).map(item => ({ id: item.id, fields: item }));
  }
}
