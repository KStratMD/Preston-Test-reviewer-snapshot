/**
 * SyncCentralService Tests
 * Session 15 - Large untested service (1,046 lines)
 */

import { SyncCentralService } from '../../../../src/services/SyncCentralService';
import type { Logger } from '../../../../src/utils/Logger';
import type { TelemetryService } from '../../../../src/services/TelemetryService';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createMockTelemetryService(): jest.Mocked<TelemetryService> {
  return {
    recordMetric: jest.fn(),
    recordEvent: jest.fn(),
    startSpan: jest.fn(),
    endSpan: jest.fn(),
  } as any;
}

describe('SyncCentralService', () => {
  let service: SyncCentralService;
  let mockLogger: jest.Mocked<Logger>;
  let mockTelemetryService: jest.Mocked<TelemetryService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockTelemetryService = createMockTelemetryService();
    service = new SyncCentralService(mockLogger, mockTelemetryService);
  });

  describe('Initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('SyncCentralService initialized');
    });
  });

  describe('Pricing Tiers', () => {
    it('should get all pricing tiers', async () => {
      const tiers = await service.getPricingTiers();
      expect(Array.isArray(tiers)).toBe(true);
      expect(tiers.length).toBeGreaterThan(0);

      const tier = tiers[0];
      expect(tier).toHaveProperty('id');
      expect(tier).toHaveProperty('name');
      expect(tier).toHaveProperty('displayName');
      expect(tier).toHaveProperty('features');
      expect(tier).toHaveProperty('limits');
    });

    it('should get pricing tier by ID', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const tier = await service.getPricingTier(tiers[0].id);
        expect(tier).not.toBeNull();
        expect(tier?.id).toBe(tiers[0].id);
      }
    });

    it('should return null for non-existent tier', async () => {
      const tier = await service.getPricingTier('non-existent-tier');
      expect(tier).toBeNull();
    });

    it('should have valid tier features', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const tier = tiers[0];
        expect(tier.features).toHaveProperty('maxIntegrations');
        expect(tier.features).toHaveProperty('maxTransactions');
        expect(tier.features).toHaveProperty('includesSupport');
        expect(tier.features).toHaveProperty('supportLevel');
        expect(typeof tier.features.maxIntegrations).toBe('number');
      }
    });

    it('should have valid tier limits', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const tier = tiers[0];
        expect(tier.limits).toHaveProperty('apiCallsPerMonth');
        expect(tier.limits).toHaveProperty('dataTransferGBPerMonth');
        expect(tier.limits).toHaveProperty('users');
        expect(typeof tier.limits.apiCallsPerMonth).toBe('number');
      }
    });
  });

  describe('Subscription Management', () => {
    it('should create subscription', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const subscriptionId = await service.createSubscription({
          customerId: 'cust-123',
          customerName: 'Test Customer',
          tierId: tiers[0].id,
          status: 'active',
          billingCycle: 'monthly',
          pricing: {
            basePrice: 100,
            addOns: [],
            totalMonthly: 100,
            totalAnnual: 1200,
            currency: 'USD',
          },
          usage: {
            integrations: 0,
            transactionsThisMonth: 0,
            apiCallsThisMonth: 0,
            dataTransferGBThisMonth: 0,
            activeConnections: 0,
            lastUsageUpdate: Date.now(),
          },
          billing: {
            nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
            paymentMethod: 'credit_card',
            billingContact: {
              name: 'Test Billing',
              email: 'billing@test.com',
              company: 'Test Company',
            },
            invoicePreferences: {
              emailInvoice: true,
              invoiceEmail: 'billing@test.com',
              ccEmails: [],
            },
          },
        });

        expect(typeof subscriptionId).toBe('string');
        expect(subscriptionId).toContain('sub_');
      }
    });

    it('should get all subscriptions', async () => {
      const result = await service.getSubscriptions({});
      expect(result).toHaveProperty('subscriptions');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.subscriptions)).toBe(true);
    });

    it('should filter subscriptions by status', async () => {
      const result = await service.getSubscriptions({ status: ['active'] });
      expect(result).toHaveProperty('subscriptions');
      expect(Array.isArray(result.subscriptions)).toBe(true);
    });

    it('should filter subscriptions by tier', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const result = await service.getSubscriptions({ tierId: tiers[0].id });
        expect(result).toHaveProperty('subscriptions');
        expect(Array.isArray(result.subscriptions)).toBe(true);
      }
    });

    it('should filter subscriptions by customer', async () => {
      const result = await service.getSubscriptions({ customerId: 'cust-test' });
      expect(result).toHaveProperty('subscriptions');
      expect(Array.isArray(result.subscriptions)).toBe(true);
    });

    it('should support subscription pagination', async () => {
      const result = await service.getSubscriptions({ limit: 5, offset: 0 });
      expect(result.subscriptions.length).toBeLessThanOrEqual(5);
      expect(result).toHaveProperty('totalCount');
    });
  });

  describe('Usage Tracking', () => {
    let subscriptionId: string;

    beforeEach(async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        subscriptionId = await service.createSubscription({
          customerId: 'cust-usage',
          customerName: 'Usage Test Customer',
          tierId: tiers[0].id,
          status: 'active',
          billingCycle: 'monthly',
          pricing: {
            basePrice: 100,
            addOns: [],
            totalMonthly: 100,
            totalAnnual: 1200,
            currency: 'USD',
          },
          usage: {
            integrations: 0,
            transactionsThisMonth: 0,
            apiCallsThisMonth: 0,
            dataTransferGBThisMonth: 0,
            activeConnections: 0,
            lastUsageUpdate: Date.now(),
          },
          billing: {
            nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
            paymentMethod: 'credit_card',
            billingContact: {
              name: 'Test',
              email: 'test@example.com',
              company: 'Test Co',
            },
            invoicePreferences: {
              emailInvoice: true,
              invoiceEmail: 'billing@example.com',
              ccEmails: [],
            },
          },
        });
      }
    });

    it('should update usage', async () => {
      await service.updateUsage(subscriptionId, {
        integrations: 5,
        transactionsThisMonth: 1000,
        apiCallsThisMonth: 5000,
      });

      const result = await service.getSubscriptions({ customerId: 'cust-usage' });
      if (result.subscriptions.length > 0) {
        const subscription = result.subscriptions[0];
        expect(subscription.usage.integrations).toBe(5);
        expect(subscription.usage.transactionsThisMonth).toBe(1000);
      }
    });

    it('should throw error updating non-existent subscription', async () => {
      await expect(
        service.updateUsage('non-existent', { integrations: 5 })
      ).rejects.toThrow('Subscription not found');
    });

    it('should check limits', async () => {
      const result = await service.checkLimit(subscriptionId, 'apiCallsPerMonth', 100);
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('currentUsage');
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('remaining');
      expect(typeof result.allowed).toBe('boolean');
    });

    it('should allow usage within limits', async () => {
      const result = await service.checkLimit(subscriptionId, 'users', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('should throw error checking limits for non-existent subscription', async () => {
      await expect(
        service.checkLimit('non-existent', 'users', 1)
      ).rejects.toThrow('Subscription not found');
    });
  });

  describe('Usage Alerts', () => {
    it('should get all usage alerts', async () => {
      const alerts = await service.getUsageAlerts();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should filter alerts by subscription', async () => {
      const tiers = await service.getPricingTiers();
      if (tiers.length > 0) {
        const subscriptionId = await service.createSubscription({
          customerId: 'cust-alerts',
          customerName: 'Alerts Test',
          tierId: tiers[0].id,
          status: 'active',
          billingCycle: 'monthly',
          pricing: {
            basePrice: 100,
            addOns: [],
            totalMonthly: 100,
            totalAnnual: 1200,
            currency: 'USD',
          },
          usage: {
            integrations: 0,
            transactionsThisMonth: 0,
            apiCallsThisMonth: 0,
            dataTransferGBThisMonth: 0,
            activeConnections: 0,
            lastUsageUpdate: Date.now(),
          },
          billing: {
            nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
            paymentMethod: 'credit_card',
            billingContact: {
              name: 'Test',
              email: 'test@example.com',
              company: 'Test',
            },
            invoicePreferences: {
              emailInvoice: true,
              invoiceEmail: 'billing@example.com',
              ccEmails: [],
            },
          },
        });

        const alerts = await service.getUsageAlerts(subscriptionId);
        expect(Array.isArray(alerts)).toBe(true);
      }
    });

    it('should acknowledge alert', async () => {
      const alerts = await service.getUsageAlerts();
      if (alerts.length > 0) {
        await service.acknowledgeAlert(alerts[0].id, 'admin@example.com');
        // No error thrown means success
        expect(true).toBe(true);
      }
    });

    it('should throw error acknowledging non-existent alert', async () => {
      await expect(
        service.acknowledgeAlert('non-existent-alert', 'admin@example.com')
      ).rejects.toThrow('Alert not found');
    });
  });

  describe('Analytics', () => {
    it('should get analytics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('customers');
      expect(analytics.customers).toHaveProperty('total');
      expect(analytics.customers).toHaveProperty('active');
      expect(analytics.customers).toHaveProperty('new');
      expect(Array.isArray(analytics.customers.byTier)).toBe(true);
      expect(typeof analytics.customers.total).toBe('number');
      expect(typeof analytics.customers.active).toBe('number');
    });

    it('should get revenue analytics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('revenue');
      expect(analytics.revenue).toHaveProperty('totalMRR');
      expect(analytics.revenue).toHaveProperty('totalARR');
      expect(Array.isArray(analytics.revenue.byTier)).toBe(true);
      expect(typeof analytics.revenue.totalMRR).toBe('number');
      expect(typeof analytics.revenue.totalARR).toBe('number');
    });

    it('should get usage analytics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('usage');
      expect(analytics.usage).toHaveProperty('totalIntegrations');
      expect(analytics.usage).toHaveProperty('totalTransactions');
      expect(analytics.usage).toHaveProperty('averageUtilization');
      expect(typeof analytics.usage.totalIntegrations).toBe('number');
    });

    it('should get tier distribution', async () => {
      const analytics = await service.getAnalytics();

      expect(Array.isArray(analytics.customers.byTier)).toBe(true);
      expect(analytics.customers.byTier.length).toBeGreaterThan(0);
      expect(Array.isArray(analytics.revenue.byTier)).toBe(true);
    });

    it('should get alerts summary', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toHaveProperty('alerts');
      expect(analytics.alerts).toHaveProperty('active');
      expect(analytics.alerts).toHaveProperty('critical');
      expect(Array.isArray(analytics.alerts.byType)).toBe(true);
      expect(typeof analytics.alerts.active).toBe('number');
    });
  });
});
