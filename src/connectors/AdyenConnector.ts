import { injectable, inject, unmanaged } from 'inversify';
import { BaseConnector } from '../core/BaseConnector';
import type { SystemInfo, AuthConfig, DataRecord } from '../types';
import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
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

function isAdyenAmount(value: unknown): value is { value: number; currency: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { value?: unknown }).value === 'number' &&
    typeof (value as { currency?: unknown }).currency === 'string'
  );
}

export interface AdyenPayment {
  pspReference: string;
  resultCode: 'Authorised' | 'Refused' | 'Error' | 'Cancelled' | 'Pending' | 'Received';
  amount: {
    value: number;
    currency: string;
  };
  merchantReference: string;
  paymentMethod: {
    type: string;
    brand?: string;
    lastFour?: string;
  };
  creationDate: string;
  status: string;
  eventCode?: string;
  success?: boolean;
  reason?: string;
  additionalData?: Record<string, string>;
  fraudResult?: {
    accountScore: number;
    results: {
      accountScore: number;
      checkId: number;
      name: string;
    }[];
  };
}

export interface AdyenTransaction {
  pspReference: string;
  originalReference?: string;
  merchantReference: string;
  amount: {
    value: number;
    currency: string;
  };
  eventCode: 'AUTHORISATION' | 'CAPTURE' | 'REFUND' | 'CANCELLATION' | 'CHARGEBACK';
  eventDate: string;
  success: boolean;
  paymentMethod: string;
  operations: string[];
  merchantAccountCode: string;
  additionalData?: Record<string, string>;
}

export interface AdyenModification {
  pspReference: string;
  status: 'received' | 'success' | 'failed';
  response?: string;
}

export interface AdyenAccount {
  accountCode: string;
  description: string;
  merchantId: string;
  status: 'Active' | 'Inactive' | 'Suspended';
  timeZone: string;
  defaultCurrency: string;
}

export interface AdyenReconciliationRecord {
  adyenReference: string;
  netsuiteTransactionId?: string;
  amount: number;
  currency: string;
  status: 'matched' | 'unmatched' | 'disputed';
  confidence: number;
  matchedAt?: Date;
  discrepancies?: string[];
  metadata: {
    adyenStatus: string;
    netsuiteStatus?: string;
    merchantReference?: string;
    eventCode?: string;
  };
}

/**
 * Adyen payment processor connector for payment reconciliation and transaction management
 */
@injectable()
export class AdyenConnector extends BaseConnector {
  static readonly productionStatus = 'demo_only' as const;
  static readonly statusEvidence = 'Real Adyen API scaffolding (checkout-test.adyen.com); ships demo fallback when isDemoMode() or isTestEnvironment() — no production credential test on file';

  private apiKey?: string;
  private merchantAccount?: string;
  private demoMode = false;
  private readonly demoStore = new Map<string, Map<string, DataRecord>>();

  protected defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  constructor(
    @unmanaged() systemType = 'Adyen',
    @unmanaged() systemId = 'adyen',
    @inject(TYPES.Logger) logger: Logger,
    @unmanaged() circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    super(systemType, systemId, logger, circuitBreakerOptions);
  }

  protected getDefaultBaseUrl(): string {
    // Use test environment for demo, production would be https://checkout-live.adyen.com
    return 'https://checkout-test.adyen.com';
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;
    this.apiKey = config.credentials?.apiKey;
    const credMerchant = config.credentials?.merchantAccount;
    this.merchantAccount = config.credentials?.username
      ?? (typeof credMerchant === 'string' ? credMerchant : undefined);

    // Check for demo mode
    const demoEnv = isDemoMode() || isTestEnvironment();
    const demoCredentials = this.apiKey?.toLowerCase().includes('demo') ||
                           this.apiKey?.toLowerCase().includes('test') ||
                           this.merchantAccount?.toLowerCase().includes('demo');

    if (demoEnv || demoCredentials) {
      this.demoMode = true;
      this.seedDemoData();
      this.logger.info('Adyen connector initialized in DEMO mode');
      return;
    }

    if (this.apiKey) {
      this.defaultHeaders['X-API-Key'] = this.apiKey;
    }

    await this.authenticate();
  }

  private seedDemoData(): void {
    const fixtureData = require('./fixtures/adyen-payments.json') as { adyen: (DataRecord & { pspReference: string })[] };
    const payments = this.demoStore.get('payment') ?? new Map<string, DataRecord>();

    fixtureData.adyen.forEach((payment) => {
      payments.set(payment.pspReference, payment);
    });

    this.demoStore.set('payment', payments);
    this.logger.info('Adyen demo data seeded', { payments: payments.size });
  }

  private handleAuthError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 401 || err.response?.status === 403) {
      this.isAuthenticated = false;
      throw new Error(
        'Adyen Authentication failed. Please check your credentials.\n' +
        'Troubleshooting:\n' +
        '- Verify your Adyen API key (starts with AQE...)\n' +
        '- Check if the key is for the correct environment (test vs live)\n' +
        '- Ensure the merchant account is correct\n' +
        '- Verify API key permissions in Adyen Customer Area'
      );
    }
  }

  private handleRateLimitError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || '60';
      throw new Error(`Adyen rate limit exceeded. Retry after ${retryAfter} seconds`);
    }
  }

  private handleTimeoutError(error: unknown): void {
    const err = error as ErrorWithResponse;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        'Adyen request timed out. The API may be slow or unavailable.\n' +
        'Troubleshooting:\n' +
        '- Check Adyen API status\n' +
        '- Verify network connectivity\n' +
        '- Consider increasing timeout value'
      );
    }
  }

  async authenticate(): Promise<boolean> {
    if (this.demoMode) {
      this.isAuthenticated = true;
      this.logger.info('Adyen authentication successful (demo mode)');
      return true;
    }

    // Re-entry guard: getSystemInfo() (the auth probe below) calls
    // ensureAuthenticated(), which calls authenticate() if !isAuthenticated.
    // Without this guard, authenticate → getSystemInfo → ensureAuthenticated
    // → authenticate would recurse infinitely until a RangeError is silently
    // swallowed by the catch block (handleAuthError only re-throws on HTTP
    // 401/403). Mirrors ShipStationConnector's pattern.
    if (this.isAuthenticating) return true;
    this.isAuthenticating = true;

    try {
      if (!this.apiKey || !this.merchantAccount) {
        throw new Error('Adyen API key and merchant account not configured');
      }

      // Test the connection with a simple account info request
      await this.getSystemInfo();

      this.logger.info('Adyen authentication successful');
      this.isAuthenticated = true;
      return true;
    } catch (error) {
      this.logger.error('Adyen authentication failed', { error });
      this.isAuthenticated = false;
      this.handleAuthError(error);
      return false;
    } finally {
      this.isAuthenticating = false;
    }
  }

  async getSystemInfo(): Promise<SystemInfo> {
    if (this.demoMode) {
      return {
        name: 'Adyen (Demo)',
        type: 'Adyen',
        version: 'v1',
        capabilities: [
          'payments',
          'modifications',
          'transactions',
          'refunds',
          'captures',
          'cancellations',
          'reconciliation',
          'demo_mode'
        ],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 60000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: 'https://checkout-test.adyen.com',
          authUrl: 'https://checkout-test.adyen.com/v1/authenticate',
          webhookUrl: 'https://checkout-test.adyen.com/v1/webhooks',
        },
      };
    }

    try {
      await this.ensureAuthenticated();

      // Get merchant account details to verify connection
      const response = await this.makeRequest<AdyenAccount>({
        method: 'POST',
        url: '/v1/me',
        data: {
          merchantAccount: this.merchantAccount
        }
      });

      return {
        name: this.systemType,
        type: 'Adyen',
        version: 'v1',
        capabilities: [
          'payments',
          'modifications',
          'transactions',
          'refunds',
          'captures',
          'cancellations',
          'reconciliation'
        ],
        rateLimits: {
          requestsPerMinute: 1000,
          requestsPerHour: 50000,
          requestsPerDay: 1000000,
        },
        endpoints: {
          baseUrl: this.httpClient.defaults.baseURL || 'https://checkout-test.adyen.com',
          authUrl: `${this.httpClient.defaults.baseURL || 'https://checkout-test.adyen.com'}/auth`,
          webhookUrl: `${this.httpClient.defaults.baseURL || 'https://checkout-test.adyen.com'}/webhooks`,
        },
      };
    } catch (error) {
      this.handleTimeoutError(error);
      this.logger.error('Failed to get Adyen system info', { error });
      throw error;
    }
  }

  protected override async ensureAuthenticated(): Promise<void> {
    if (!this.isAuthenticated) {
      await this.authenticate();
    }
  }

  /**
   * Get payment transactions for reconciliation
   */
  async getTransactions(options: {
    from?: string; // ISO date string
    to?: string;   // ISO date string
    merchantReference?: string;
    pspReference?: string;
    limit?: number;
  } = {}): Promise<AdyenTransaction[]> {
    try {
      await this.ensureAuthenticated();

      const requestData: unknown = {
        merchantAccount: this.merchantAccount,
        ...options
      };

      const response = await this.makeRequest<{ data: AdyenTransaction[] }>({
        method: 'POST',
        url: '/v1/transactions',
        data: requestData
      });

      return response.data || [];
    } catch (error) {
      this.logger.error('Failed to get Adyen transactions', { error });
      throw error;
    }
  }

  /**
   * Get payment details
   */
  async getPayment(pspReference: string): Promise<AdyenPayment> {
    try {
      await this.ensureAuthenticated();

      const response = await this.makeRequest<AdyenPayment>({
        method: 'POST',
        url: '/v1/payments/details',
        data: {
          merchantAccount: this.merchantAccount,
          pspReference
        }
      });

      return response;
    } catch (error) {
      this.logger.error('Failed to get Adyen payment', { error, pspReference });
      throw error;
    }
  }

  /**
   * Create a refund
   */
  async createRefund(
    originalReference: string, 
    amount: { value: number; currency: string },
    reference?: string
  ): Promise<AdyenModification> {
    try {
      await this.ensureAuthenticated();

      const refundData = {
        merchantAccount: this.merchantAccount,
        originalReference,
        modificationAmount: amount,
        reference: reference || `REFUND-${Date.now()}`
      };

      const response = await this.makeRequest<AdyenModification>({
        method: 'POST',
        url: '/v1/refund',
        data: refundData
      });

      return response;
    } catch (error) {
      this.logger.error('Failed to create Adyen refund', { error, originalReference });
      throw error;
    }
  }

  /**
   * Capture an authorization
   */
  async capturePayment(
    originalReference: string,
    amount: { value: number; currency: string },
    reference?: string
  ): Promise<AdyenModification> {
    try {
      await this.ensureAuthenticated();

      const captureData = {
        merchantAccount: this.merchantAccount,
        originalReference,
        modificationAmount: amount,
        reference: reference || `CAPTURE-${Date.now()}`
      };

      const response = await this.makeRequest<AdyenModification>({
        method: 'POST',
        url: '/v1/capture',
        data: captureData
      });

      return response;
    } catch (error) {
      this.logger.error('Failed to capture Adyen payment', { error, originalReference });
      throw error;
    }
  }

  /**
   * Cancel an authorization
   */
  async cancelPayment(
    originalReference: string,
    reference?: string
  ): Promise<AdyenModification> {
    try {
      await this.ensureAuthenticated();

      const cancelData = {
        merchantAccount: this.merchantAccount,
        originalReference,
        reference: reference || `CANCEL-${Date.now()}`
      };

      const response = await this.makeRequest<AdyenModification>({
        method: 'POST',
        url: '/v1/cancel',
        data: cancelData
      });

      return response;
    } catch (error) {
      this.logger.error('Failed to cancel Adyen payment', { error, originalReference });
      throw error;
    }
  }

  /**
   * Reconcile Adyen transactions with NetSuite records
   */
  async reconcileWithNetSuite(transactions: AdyenTransaction[], netsuiteRecords: unknown[]): Promise<{
    matched: { adyen: AdyenTransaction; netsuite: unknown; confidence: number }[];
    unmatched: AdyenTransaction[];
    variances: { adyen: AdyenTransaction; netsuite: unknown; variance: number }[];
  }> {
    try {
      const matched: { adyen: AdyenTransaction; netsuite: unknown; confidence: number }[] = [];
      const unmatched: AdyenTransaction[] = [];
      const variances: { adyen: AdyenTransaction; netsuite: unknown; variance: number }[] = [];

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
          // Convert Adyen amount (in cents) to decimal
          const adyenAmount = transaction.amount.value / 100;
          const netsuiteAmount = (bestMatch as { amount: number }).amount;
          const variance = Math.abs(adyenAmount - netsuiteAmount);
          
          if (variance < 0.01) { // Less than 1 cent difference
            matched.push({ adyen: transaction, netsuite: bestMatch, confidence: bestConfidence });
          } else {
            variances.push({ adyen: transaction, netsuite: bestMatch, variance });
          }
        } else {
          unmatched.push(transaction);
        }
      }

      this.logger.info('Adyen reconciliation completed', {
        totalTransactions: transactions.length,
        matched: matched.length,
        unmatched: unmatched.length,
        variances: variances.length,
      });

      return { matched, unmatched, variances };
    } catch (error) {
      this.logger.error('Failed to reconcile Adyen transactions', { error });
      throw error;
    }
  }

  private calculateMatchConfidence(adyenTx: AdyenTransaction, netsuiteRecord: unknown): number {
    const ns = (netsuiteRecord ?? {}) as {
      amount?: number;
      trandate?: string;
      externalid?: string;
      memo?: string;
    };

    let confidence = 0;

    // Amount matching (most important) - Adyen amounts are in cents
    const adyenAmount = adyenTx.amount.value / 100;
    const netsuiteAmount = ns.amount as number; // preserve NaN if missing
    const amountDiff = Math.abs(adyenAmount - netsuiteAmount);
    const amountTolerance = Math.max(adyenAmount * 0.01, 0.01); // 1% or 1 cent

    if (amountDiff < 0.01) {
      confidence += 0.5;
    } else if (amountDiff <= amountTolerance) {
      confidence += 0.3;
    }

    // Date matching
    const adyenDate = new Date(adyenTx.eventDate).getTime();
    const netsuiteDate = new Date(ns.trandate as string).getTime(); // preserve NaN if missing
    const dateDiff = Math.abs(adyenDate - netsuiteDate);
    const dayMs = 24 * 60 * 60 * 1000;

    if (dateDiff <= dayMs) {
      confidence += 0.2;
    } else if (dateDiff <= 3 * dayMs) {
      confidence += 0.1;
    }

    // Reference matching
    if (adyenTx.merchantReference && ns.externalid) {
      if (adyenTx.merchantReference === ns.externalid) {
        confidence += 0.2;
      }
    }

    // PSP Reference matching
    if (adyenTx.pspReference && ns.memo) {
      if (ns.memo.includes(adyenTx.pspReference)) {
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
        const fields = data as { originalReference?: unknown; amount?: unknown; reference?: unknown };
        if (typeof fields.originalReference !== 'string' || !fields.originalReference) {
          throw new Error('refund.originalReference is required');
        }
        if (!isAdyenAmount(fields.amount)) {
          throw new Error('refund.amount must be { value: number, currency: string }');
        }
        const reference = typeof fields.reference === 'string' ? fields.reference : undefined;
        return await this.createRefund(fields.originalReference, fields.amount, reference) as unknown as DataRecord;
      }
      case 'capture': {
        const fields = data as { originalReference?: unknown; amount?: unknown; reference?: unknown };
        if (typeof fields.originalReference !== 'string' || !fields.originalReference) {
          throw new Error('capture.originalReference is required');
        }
        if (!isAdyenAmount(fields.amount)) {
          throw new Error('capture.amount must be { value: number, currency: string }');
        }
        const reference = typeof fields.reference === 'string' ? fields.reference : undefined;
        return await this.capturePayment(fields.originalReference, fields.amount, reference) as unknown as DataRecord;
      }
      case 'cancel': {
        const fields = data as { originalReference?: unknown; reference?: unknown };
        if (typeof fields.originalReference !== 'string' || !fields.originalReference) {
          throw new Error('cancel.originalReference is required');
        }
        const reference = typeof fields.reference === 'string' ? fields.reference : undefined;
        return await this.cancelPayment(fields.originalReference, reference) as unknown as DataRecord;
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
      return this.updateDemo(entityType, id, data);
    }
    throw new Error('Update operations not supported for Adyen connector');
  }

  async delete(entityType: string, id: string): Promise<boolean> {
    if (this.demoMode) {
      return this.deleteDemo(entityType, id);
    }
    throw new Error('Delete operations not supported for Adyen connector');
  }

  async list(entityType: string, options: unknown = {}): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.listDemo(entityType, options);
    }

    try {
      switch (entityType) {
      case 'transactions':
        return this.getTransactions(options) as unknown as DataRecord[];
      default:
        throw new Error(`Entity type ${entityType} not supported`);
      }
    } catch (error: unknown) {
      this.handleRateLimitError(error);
      this.handleTimeoutError(error);
      throw error;
    }
  }

  async search(entityType: string, criteria: unknown): Promise<DataRecord[]> {
    if (this.demoMode) {
      return this.searchDemo(entityType, criteria);
    }

    try {
      switch (entityType) {
      case 'transactions': {
        const c = (criteria ?? {}) as {
          startDate?: string;
          endDate?: string;
          merchantReference?: string;
          pspReference?: string;
          limit?: number;
        };
        return this.getTransactions({
          from: c.startDate,
          to: c.endDate,
          merchantReference: c.merchantReference,
          pspReference: c.pspReference,
          limit: c.limit
        }) as unknown as DataRecord[];
      }
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
    if (normalized.includes('payment') || normalized.includes('transaction')) return 'payment';
    return entityType.toLowerCase();
  }

  private async createDemo(entityType: string, data: unknown): Promise<DataRecord> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType) ?? new Map<string, DataRecord>();

    const pspReference = `ADY-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;
    const record: DataRecord = {
      pspReference,
      ...(data as Record<string, unknown>),
      resultCode: 'Authorised',
      creationDate: new Date().toISOString(),
      status: 'success'
    };

    store.set(pspReference, record);
    this.demoStore.set(normalizedType, store);

    this.logger.info(`Demo: Created ${entityType} ${pspReference}`);
    return record;
  }

  private async readDemo(entityType: string, id: string): Promise<DataRecord | null> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);
    const record = store?.get(id);

    if (record) {
      this.logger.info(`Demo: Read ${entityType} ${id}`);
      return record;
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
      ...(data as Record<string, unknown>)
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

  private async listDemo(entityType: string, options: unknown = {}): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    const opts = (options ?? {}) as {
      resultCode?: string;
      merchantReference?: string;
      limit?: number;
    };

    // Apply filters
    if (opts.resultCode) {
      results = results.filter(r => r.resultCode === opts.resultCode);
    }
    if (opts.merchantReference) {
      results = results.filter(r => r.merchantReference === opts.merchantReference);
    }

    // Apply limit
    const limit = opts.limit || results.length;

    this.logger.info(`Demo: Listed ${entityType} (${results.length} results, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit);
  }

  private async searchDemo(entityType: string, criteria: unknown): Promise<DataRecord[]> {
    const normalizedType = this.normalizeEntityType(entityType);
    const store = this.demoStore.get(normalizedType);

    if (!store) {
      return [];
    }

    let results = Array.from(store.values());

    const c = (criteria ?? {}) as {
      pspReference?: string;
      merchantReference?: string;
      resultCode?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
    };

    // Apply filters
    if (c.pspReference) {
      results = results.filter(r => r.pspReference === c.pspReference);
    }
    if (c.merchantReference) {
      const ref = c.merchantReference;
      results = results.filter(r => typeof r.merchantReference === 'string' && r.merchantReference.includes(ref));
    }
    if (c.resultCode) {
      results = results.filter(r => r.resultCode === c.resultCode);
    }

    // Date filtering
    if (c.startDate) {
      const startDate = new Date(c.startDate).getTime();
      results = results.filter(r => typeof r.creationDate === 'string' && new Date(r.creationDate).getTime() >= startDate);
    }
    if (c.endDate) {
      const endDate = new Date(c.endDate).getTime();
      results = results.filter(r => typeof r.creationDate === 'string' && new Date(r.creationDate).getTime() <= endDate);
    }

    // Apply limit
    const limit = c.limit || results.length;

    this.logger.info(`Demo: Searched ${entityType} (${results.length} matches, returning ${Math.min(limit, results.length)})`);
    return results.slice(0, limit);
  }
}
