import type { PaymentProcessor } from '../../../types/paymentCentral';
import type { PaymentCentralRuntime } from '../PaymentCentralRuntime';
import type { ProcessorReader } from '../ports';

export class ProcessorService implements ProcessorReader {
  private processors = new Map<string, PaymentProcessor>();

  constructor(private readonly runtime: PaymentCentralRuntime) {}

  /**
   * Get all configured payment processors
   */
  async getPaymentProcessors(): Promise<PaymentProcessor[]> {
    return Array.from(this.processors.values());
  }

  /**
   * Add or update a payment processor
   */
  async configureProcessor(processor: Omit<PaymentProcessor, 'id'>): Promise<string> {
    const id = this.runtime.createId('proc');
    const fullProcessor: PaymentProcessor = {
      ...processor,
      id,
    };

    this.processors.set(id, fullProcessor);

    this.runtime.logger.info('Payment processor configured', {
      processorId: id,
      name: processor.name,
      type: processor.type,
    });

    return id;
  }

  getProcessorById(id: string): PaymentProcessor | undefined {
    return this.processors.get(id);
  }

  listProcessors(): readonly PaymentProcessor[] {
    return Array.from(this.processors.values());
  }

  seedDemo(): void {
    const processorConfigs = [
      {
        name: 'Stripe',
        type: 'stripe' as const,
        status: 'active' as const,
        apiEndpoint: 'https://api.stripe.com/v1',
        credentials: {
          encrypted: true,
          lastUpdated: this.runtime.now() - 86400000,
          credentialId: 'cred_stripe_prod',
        },
        features: {
          recurring: true,
          multiCurrency: true,
          refunds: true,
          disputes: true,
          webhooks: true,
          reporting: true,
        },
        limits: {
          dailyVolume: 1000000,
          monthlyVolume: 30000000,
          maxTransactionAmount: 999999,
          minTransactionAmount: 50,
        },
        fees: {
          percentage: 2.9,
          fixed: 30,
          currency: 'USD',
        },
        metadata: {
          environment: 'production' as const,
          region: 'US',
          compliance: ['PCI DSS', 'SOC 2', 'ISO 27001'],
        },
      },
      {
        name: 'Adyen',
        type: 'adyen' as const,
        status: 'active' as const,
        apiEndpoint: 'https://checkout-test.adyen.com/v70',
        credentials: {
          encrypted: true,
          lastUpdated: this.runtime.now() - 172800000,
          credentialId: 'cred_adyen_prod',
        },
        features: {
          recurring: true,
          multiCurrency: true,
          refunds: true,
          disputes: true,
          webhooks: true,
          reporting: true,
        },
        limits: {
          dailyVolume: 2000000,
          monthlyVolume: 60000000,
          maxTransactionAmount: 1999999,
          minTransactionAmount: 25,
        },
        fees: {
          percentage: 2.6,
          fixed: 25,
          currency: 'USD',
        },
        metadata: {
          environment: 'production' as const,
          region: 'EU',
          compliance: ['PCI DSS', 'GDPR', 'PSD2'],
        },
      },
      {
        name: 'PayPal Commerce',
        type: 'paypal' as const,
        status: 'active' as const,
        apiEndpoint: 'https://api-m.paypal.com/v2',
        credentials: {
          encrypted: true,
          lastUpdated: this.runtime.now() - 259200000,
          credentialId: 'cred_paypal_prod',
        },
        features: {
          recurring: true,
          multiCurrency: true,
          refunds: true,
          disputes: true,
          webhooks: true,
          reporting: false,
        },
        limits: {
          dailyVolume: 500000,
          monthlyVolume: 15000000,
          maxTransactionAmount: 99999,
          minTransactionAmount: 100,
        },
        fees: {
          percentage: 3.5,
          fixed: 15,
          currency: 'USD',
        },
        metadata: {
          environment: 'production' as const,
          region: 'US',
          compliance: ['PCI DSS', 'SOX'],
        },
      },
    ];

    // Seed ids embed the processor type segment (`proc_${type}_${ts}_${suffix}`)
    // and use a 6-char suffix, both for parity with the original facade.
    // runtime.createId() is intentionally not used here — its shape is
    // `${prefix}_${ts}_${suffix}` with no type segment, which would change ids.
    processorConfigs.forEach(config => {
      const id = `proc_${config.type}_${this.runtime.now()}_${this.runtime.random().toString(36).slice(2, 2 + 6)}`;
      this.processors.set(id, { ...config, id });
    });
  }
}
