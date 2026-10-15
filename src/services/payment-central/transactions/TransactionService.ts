import type {
  PaymentTransaction,
  PaymentTransactionFilters,
  PaymentTransactionListResult,
} from '../../../types/paymentCentral';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';
import type { ProcessorReader, TransactionReader } from '../ports';

export class TransactionService implements TransactionReader {
  private transactions = new Map<string, PaymentTransaction>();

  constructor(
    private readonly processorReader: ProcessorReader,
    private readonly runtime: PaymentCentralRuntime,
  ) {}

  /**
   * Get payment transactions with filtering
   */
  async getTransactions(filters: PaymentTransactionFilters = {}): Promise<PaymentTransactionListResult> {
    let filteredTransactions = Array.from(this.transactions.values());

    // Apply filters
    if (filters.processorIds && filters.processorIds.length > 0) {
      filteredTransactions = filteredTransactions.filter(t =>
        filters.processorIds!.includes(t.processorId)
      );
    }

    if (filters.status && filters.status.length > 0) {
      filteredTransactions = filteredTransactions.filter(t =>
        filters.status!.includes(t.status)
      );
    }

    if (filters.dateRange) {
      filteredTransactions = filteredTransactions.filter(t =>
        t.timestamp >= filters.dateRange!.start &&
        t.timestamp <= filters.dateRange!.end
      );
    }

    if (filters.amountRange) {
      filteredTransactions = filteredTransactions.filter(t =>
        t.amount >= filters.amountRange!.min &&
        t.amount <= filters.amountRange!.max
      );
    }

    if (filters.customerIds && filters.customerIds.length > 0) {
      filteredTransactions = filteredTransactions.filter(t =>
        filters.customerIds!.includes(t.customer.id)
      );
    }

    if (filters.syncStatus && filters.syncStatus.length > 0) {
      filteredTransactions = filteredTransactions.filter(t =>
        filters.syncStatus!.includes(t.businessCentral.syncStatus)
      );
    }

    const totalCount = filteredTransactions.length;

    // Sort by timestamp (most recent first)
    filteredTransactions.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const transactions = filteredTransactions.slice(offset, offset + limit);

    return { transactions, totalCount };
  }

  /**
   * Sync transaction to Business Central
   */
  async syncTransactionToBusinessCentral(transactionId: string): Promise<{
    success: boolean;
    syncId?: string;
    error?: string;
  }> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    try {
      // Simulate Business Central API call
      const syncId = `sync_${this.runtime.now()}_${this.runtime.random().toString(36).slice(2, 11)}`;

      // Update transaction sync status
      transaction.businessCentral.syncStatus = 'synced';
      transaction.businessCentral.syncAttempts++;
      transaction.businessCentral.lastSyncAttempt = this.runtime.now();

      // Simulate 90% success rate
      const success = this.runtime.random() > 0.1;

      if (!success) {
        transaction.businessCentral.syncStatus = 'failed';
        transaction.businessCentral.syncErrors = [
          'GL_ACCOUNT_NOT_FOUND: Invalid GL account for merchant category',
          'CUSTOMER_LOOKUP_FAILED: Customer ID not found in Business Central'
        ];
        return {
          success: false,
          error: 'Failed to sync to Business Central: ' + transaction.businessCentral.syncErrors.join(', ')
        };
      }

      this.runtime.logger.info('Transaction synced to Business Central', {
        transactionId,
        syncId,
        amount: transaction.amount,
        processorId: transaction.processorId,
      });

      return { success: true, syncId };
    } catch (error) {
      transaction.businessCentral.syncStatus = 'failed';
      transaction.businessCentral.syncAttempts++;
      transaction.businessCentral.lastSyncAttempt = this.runtime.now();
      transaction.businessCentral.syncErrors = [
        error instanceof Error ? error.message : 'Unknown sync error'
      ];

      this.runtime.logger.error('Failed to sync transaction to Business Central', {
        error,
        transactionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown sync error'
      };
    }
  }

  getTransactionById(id: string): PaymentTransaction | undefined {
    return this.transactions.get(id);
  }

  listTransactions(): readonly PaymentTransaction[] {
    return Array.from(this.transactions.values());
  }

  seedDemo(): void {
    const processorIds = this.processorReader.listProcessors().map(p => p.id);
    const now = this.runtime.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < 1500; i++) { // Generate 1500 sample transactions
      const transactionId = `txn_${this.runtime.now()}_${i}_${this.runtime.random().toString(36).slice(2, 11)}`;
      const processorId = processorIds[Math.floor(this.runtime.random() * processorIds.length)];
      if (!processorId) continue; // Skip if no processor available
      const processor = this.processorReader.getProcessorById(processorId);
      if (!processor) {
        throw new Error(`Processor ${processorId || 'unknown'} not found`);
      }

      const amount = Math.floor(this.runtime.random() * 50000) + 500; // $5 - $500
      const timestamp = thirtyDaysAgo + this.runtime.random() * (now - thirtyDaysAgo);

      const transaction: PaymentTransaction = {
        id: transactionId,
        processorId: processorId || 'unknown',
        processorTransactionId: `${processor.type}_${this.runtime.random().toString(36).slice(2, 2 + 12)}`,
        amount,
        currency: 'USD',
        status: this.getRandomStatus(),
        type: this.getRandomType(),
        timestamp,
        customer: {
          id: `cust_${this.runtime.random().toString(36).slice(2, 2 + 10)}`,
          email: `customer${i}@example.com`,
          name: `Customer ${i + 1}`,
        },
        merchant: {
          id: `merch_${this.runtime.random().toString(36).slice(2, 2 + 8)}`,
          name: this.getRandomMerchant(),
          mcc: this.getRandomMCC(),
        },
        paymentMethod: {
          type: this.getRandomPaymentMethod(),
          last4: Math.floor(this.runtime.random() * 9999).toString().padStart(4, '0'),
          brand: this.getRandomCardBrand(),
          country: 'US',
        },
        fees: {
          processingFee: Math.floor(amount * processor.fees.percentage / 100) + processor.fees.fixed,
          platformFee: Math.floor(amount * 0.005), // 0.5%
          networkFee: Math.floor(this.runtime.random() * 20) + 5,
          total: 0, // Will be calculated below
        },
        risk: {
          score: this.runtime.random() * 100,
          level: this.getRandomRiskLevel(),
          reasons: this.getRandomRiskReasons(),
        },
        businessCentral: {
          customerId: this.runtime.random() > 0.3 ? `BC_CUST_${this.runtime.random().toString(36).slice(2, 2 + 8)}` : undefined,
          invoiceId: this.runtime.random() > 0.5 ? `BC_INV_${this.runtime.random().toString(36).slice(2, 2 + 10)}` : undefined,
          glAccount: '4010-SALES-REVENUE',
          syncStatus: this.getRandomSyncStatus(),
          syncAttempts: Math.floor(this.runtime.random() * 3),
          lastSyncAttempt: this.runtime.random() > 0.3 ? timestamp + this.runtime.random() * 86400000 : undefined,
          syncErrors: this.runtime.random() > 0.8 ? ['GL_ACCOUNT_MISMATCH', 'CUSTOMER_NOT_FOUND'] : undefined,
        },
        metadata: {
          ipAddress: `192.168.${Math.floor(this.runtime.random() * 255)}.${Math.floor(this.runtime.random() * 255)}`,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          referrer: 'https://example-merchant.com/checkout',
        },
      };

      // Calculate total fees
      transaction.fees.total = transaction.fees.processingFee +
                              transaction.fees.platformFee +
                              transaction.fees.networkFee;

      this.transactions.set(transactionId, transaction);
    }
  }

  private getRandomStatus(): PaymentTransaction['status'] {
    const statuses: PaymentTransaction['status'][] = ['pending', 'completed', 'failed', 'cancelled', 'refunded', 'disputed'];
    const weights = [0.05, 0.85, 0.05, 0.02, 0.02, 0.01]; // 85% completed
    return this.weightedRandom(statuses, weights);
  }

  private getRandomType(): PaymentTransaction['type'] {
    const types: PaymentTransaction['type'][] = ['payment', 'refund', 'chargeback', 'fee', 'adjustment'];
    const weights = [0.90, 0.05, 0.02, 0.02, 0.01]; // 90% payments
    return this.weightedRandom(types, weights);
  }

  private getRandomMerchant(): string {
    const merchants = [
      'Acme E-commerce LLC',
      'Global Retail Solutions',
      'TechStart Innovations',
      'Premium Services Inc',
      'Digital Marketplace Co',
      'Enterprise Solutions Group',
      'Professional Services LLC',
      'Modern Commerce Solutions',
      'Advanced Technology Partners',
      'Strategic Business Solutions',
    ];
    const selected = merchants[Math.floor(this.runtime.random() * merchants.length)];
    return selected || 'Unknown Merchant';
  }

  private getRandomMCC(): string {
    const mccs = [
      '5411', // Grocery Stores
      '5812', // Eating Places, Restaurants
      '5999', // Miscellaneous Retail
      '7372', // Software Development
      '8062', // Hospitals
      '5541', // Service Stations
      '5912', // Drug Stores and Pharmacies
      '7011', // Hotels, Motels
      '4121', // Taxicabs and Limousines
      '5661', // Shoe Stores
    ];
    const selected = mccs[Math.floor(this.runtime.random() * mccs.length)];
    return selected || '5999';
  }

  private getRandomPaymentMethod(): PaymentTransaction['paymentMethod']['type'] {
    const methods: PaymentTransaction['paymentMethod']['type'][] = ['card', 'ach', 'wire', 'wallet', 'cryptocurrency'];
    const weights = [0.75, 0.15, 0.05, 0.04, 0.01]; // 75% cards
    return this.weightedRandom(methods, weights);
  }

  private getRandomCardBrand(): string {
    const brands = ['visa', 'mastercard', 'amex', 'discover', 'diners', 'jcb'];
    const weights = [0.45, 0.30, 0.15, 0.05, 0.03, 0.02];
    return this.weightedRandom(brands, weights);
  }

  private getRandomRiskLevel(): PaymentTransaction['risk']['level'] {
    const levels: PaymentTransaction['risk']['level'][] = ['low', 'medium', 'high', 'blocked'];
    const weights = [0.70, 0.25, 0.04, 0.01]; // 70% low risk
    return this.weightedRandom(levels, weights);
  }

  private getRandomRiskReasons(): string[] {
    const allReasons = [
      'New customer',
      'High transaction amount',
      'International card',
      'Velocity check triggered',
      'IP geolocation mismatch',
      'Device fingerprint anomaly',
      'Historical chargeback risk',
      'Merchant category risk',
    ];

    const count = Math.floor(this.runtime.random() * 3) + 1; // 1-3 reasons
    const shuffled = [...allReasons].sort(() => 0.5 - this.runtime.random());
    return shuffled.slice(0, count);
  }

  private getRandomSyncStatus(): PaymentTransaction['businessCentral']['syncStatus'] {
    const statuses: PaymentTransaction['businessCentral']['syncStatus'][] = ['pending', 'synced', 'failed', 'ignored'];
    const weights = [0.15, 0.75, 0.08, 0.02]; // 75% synced
    return this.weightedRandom(statuses, weights);
  }

  private weightedRandom<T>(items: T[], weights: number[]): T {
    const random = this.runtime.random();
    let cumulativeWeight = 0;

    for (let i = 0; i < items.length; i++) {
      cumulativeWeight += weights[i] || 0;
      if (random <= cumulativeWeight) {
        const item = items[i];
        if (item !== undefined) {
          return item;
        }
      }
    }

    const lastItem = items[items.length - 1];
    if (lastItem !== undefined) {
      return lastItem;
    }
    throw new Error('No items available for weighted random selection');
  }
}
