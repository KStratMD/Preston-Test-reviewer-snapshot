import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { isDemoMode, isTestEnvironment } from '../config/runtimeFlags';

/**
 * PayQuicker recipient account
 */
export interface PayQuickerRecipient {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'active' | 'pending' | 'suspended' | 'closed';
  walletId?: string;
  currency: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * PayQuicker payout request
 */
export interface PayQuickerPayoutRequest {
  recipientId: string;
  amount: number;
  currency: string;
  description?: string;
  reference?: string;
  destinationType: 'wallet' | 'bank' | 'card';
}

/**
 * PayQuicker payout response
 */
export interface PayQuickerPayout {
  id: string;
  recipientId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  description?: string;
  reference?: string;
  destinationType: string;
  fee: number;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

/**
 * PayQuicker balance response
 */
export interface PayQuickerBalance {
  walletId: string;
  currency: string;
  available: number;
  pending: number;
  total: number;
}

/**
 * PayQuickerConnector - Stub implementation for PayQuicker payment platform
 *
 * PayQuicker is a global payments platform for payroll, payouts, and disbursements.
 * This stub provides the basic structure for future implementation.
 *
 * API Documentation: https://docs.payquicker.com/
 */
@injectable()
export class PayQuickerConnector {
  static readonly productionStatus = 'stub' as const;
  static readonly statusEvidence = 'Explicit stub: authenticate() throws "not yet implemented" at PayQuickerConnector.ts:132; CRUD methods return demo stub responses';
  static readonly proofCard = 'docs/review/proof-cards/payquicker-connector.md';

  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('PayQuickerConnector initialized (stub mode)');
  }

  /**
   * Get system information
   */
  async getSystemInfo(): Promise<{
    name: string;
    version: string;
    status: string;
    metadata: Record<string, unknown>;
  }> {
    return {
      name: 'PayQuicker',
      version: '1.0.0',
      status: 'healthy',
      metadata: {
        mode: isDemoMode() ? 'demo' : 'production',
        apiVersion: 'v1',
        stubImplementation: true,
      },
    };
  }

  /**
   * Test connection to PayQuicker
   */
  async testConnection(): Promise<boolean> {
    if (isDemoMode() || isTestEnvironment()) {
      this.logger.info('PayQuicker connection test (demo mode): success');
      return true;
    }

    // In production, would verify OAuth credentials
    this.logger.warn('PayQuicker connector is in stub mode - full implementation pending');
    return true;
  }

  /**
   * Authenticate with PayQuicker OAuth2
   */
  private async authenticate(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (isDemoMode() || isTestEnvironment()) {
      this.accessToken = 'demo-token-payquicker';
      this.tokenExpiry = Date.now() + 3600000;
      return this.accessToken;
    }

    // In production: implement OAuth2 client credentials flow
    throw new Error('PayQuicker authentication not yet implemented - use demo mode');
  }

  /**
   * Create a new recipient account
   */
  async createRecipient(data: {
    email: string;
    firstName: string;
    lastName: string;
    country: string;
    currency?: string;
  }): Promise<PayQuickerRecipient> {
    await this.authenticate();

    // Demo mode stub response
    const recipient: PayQuickerRecipient = {
      id: `PQ-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      status: 'pending',
      currency: data.currency || 'USD',
      country: data.country,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.logger.info('Created PayQuicker recipient (stub)', { recipientId: recipient.id });
    return recipient;
  }

  /**
   * Get a recipient by ID
   */
  async getRecipient(recipientId: string): Promise<PayQuickerRecipient | null> {
    await this.authenticate();

    // Demo mode stub response
    return {
      id: recipientId,
      email: 'demo@example.com',
      firstName: 'Demo',
      lastName: 'User',
      status: 'active',
      walletId: `WALLET-${recipientId}`,
      currency: 'USD',
      country: 'US',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Initiate a payout to a recipient
   */
  async createPayout(request: PayQuickerPayoutRequest): Promise<PayQuickerPayout> {
    await this.authenticate();

    const fee = Math.round(request.amount * 0.015 * 100) / 100; // 1.5% fee

    // Demo mode stub response
    const payout: PayQuickerPayout = {
      id: `PQPO-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`,
      recipientId: request.recipientId,
      amount: request.amount,
      currency: request.currency,
      status: 'processing',
      description: request.description,
      reference: request.reference,
      destinationType: request.destinationType,
      fee,
      createdAt: new Date().toISOString(),
    };

    this.logger.info('Created PayQuicker payout (stub)', {
      payoutId: payout.id,
      amount: payout.amount,
      recipientId: payout.recipientId,
    });

    return payout;
  }

  /**
   * Get payout status
   */
  async getPayoutStatus(payoutId: string): Promise<PayQuickerPayout | null> {
    await this.authenticate();

    // Demo mode stub response - always completed
    return {
      id: payoutId,
      recipientId: 'PQ-DEMO-RECIPIENT',
      amount: 100.00,
      currency: 'USD',
      status: 'completed',
      destinationType: 'wallet',
      fee: 1.50,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Get wallet balance
   */
  async getBalance(walletId: string): Promise<PayQuickerBalance> {
    await this.authenticate();

    // Demo mode stub response
    return {
      walletId,
      currency: 'USD',
      available: 10000.00,
      pending: 500.00,
      total: 10500.00,
    };
  }

  /**
   * List payouts with optional filters
   */
  async listPayouts(): Promise<{ payouts: PayQuickerPayout[]; total: number }> {
    await this.authenticate();

    // Demo mode stub response
    const payouts: PayQuickerPayout[] = [
      {
        id: 'PQPO-DEMO-001',
        recipientId: 'PQ-DEMO-001',
        amount: 500.00,
        currency: 'USD',
        status: 'completed',
        destinationType: 'wallet',
        fee: 7.50,
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        completedAt: new Date(Date.now() - 82800000).toISOString(),
      },
      {
        id: 'PQPO-DEMO-002',
        recipientId: 'PQ-DEMO-002',
        amount: 250.00,
        currency: 'USD',
        status: 'processing',
        destinationType: 'bank',
        fee: 3.75,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
      },
    ];

    return {
      payouts,
      total: payouts.length,
    };
  }

  /**
   * Cancel a pending payout
   */
  async cancelPayout(payoutId: string): Promise<boolean> {
    await this.authenticate();

    this.logger.info('Cancelled PayQuicker payout (stub)', { payoutId });
    return true;
  }

  /**
   * Disconnect from PayQuicker
   */
  async disconnect(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.logger.info('PayQuicker connector disconnected');
  }
}
