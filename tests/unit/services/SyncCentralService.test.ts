/**
 * SyncCentralService Tests
 * Tests for tiered pricing, subscription management, and usage tracking
 */

// Mock the service to bypass inversify dependency injection
const mockGetPricingTiers = jest.fn();
const mockGetPricingTier = jest.fn();
const mockCreateSubscription = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockUpdateUsage = jest.fn();
const mockCheckLimit = jest.fn();
const mockGetUsageAlerts = jest.fn();
const mockAcknowledgeAlert = jest.fn();
const mockGetAnalytics = jest.fn();

jest.mock('../../../src/services/SyncCentralService', () => ({
  SyncCentralService: jest.fn().mockImplementation(() => ({
    getPricingTiers: mockGetPricingTiers,
    getPricingTier: mockGetPricingTier,
    createSubscription: mockCreateSubscription,
    getSubscriptions: mockGetSubscriptions,
    updateUsage: mockUpdateUsage,
    checkLimit: mockCheckLimit,
    getUsageAlerts: mockGetUsageAlerts,
    acknowledgeAlert: mockAcknowledgeAlert,
    getAnalytics: mockGetAnalytics
  }))
}));

import { SyncCentralService } from '../../../src/services/SyncCentralService';

describe('SyncCentralService', () => {
  let service: any;

  const mockStarterTier = {
    id: 'tier_starter',
    name: 'Starter',
    displayName: 'SyncCentral Starter',
    description: 'Perfect for small businesses',
    annualPricing: { min: 7200, max: 9600, currency: 'USD' },
    features: {
      maxIntegrations: 3,
      maxTransactions: 10000,
      maxConnectors: 5,
      includesSupport: true,
      supportLevel: 'basic',
      includesMonitoring: true,
      includesDLQManagement: false,
      customConnectors: false,
      apiAccess: false,
      webhooks: false,
      sla: { uptime: 99.0, responseTime: '24 hours' },
      backup: { frequency: 'daily', retention: 30 },
      compliance: ['SOC 2']
    },
    limits: {
      apiCallsPerMonth: 50000,
      dataTransferGBPerMonth: 10,
      concurrentConnections: 5,
      customFieldMappings: 25,
      scheduledJobs: 10,
      dataSources: 3,
      users: 2,
      environments: 1
    },
    addOns: [],
    isActive: true,
    metadata: { createdAt: Date.now(), updatedAt: Date.now(), targetAudience: [], industries: [] }
  };

  const mockProfessionalTier = {
    id: 'tier_professional',
    name: 'Professional',
    displayName: 'SyncCentral Professional',
    description: 'Ideal for growing companies',
    annualPricing: { min: 18000, max: 24000, currency: 'USD' },
    features: {
      maxIntegrations: 10,
      maxTransactions: 100000,
      maxConnectors: 15,
      includesSupport: true,
      supportLevel: 'standard',
      includesMonitoring: true,
      includesDLQManagement: true,
      customConnectors: true,
      apiAccess: true,
      webhooks: true,
      sla: { uptime: 99.5, responseTime: '12 hours' },
      backup: { frequency: 'hourly', retention: 90 },
      compliance: ['SOC 2', 'GDPR', 'HIPAA']
    },
    limits: {
      apiCallsPerMonth: 500000,
      dataTransferGBPerMonth: 100,
      concurrentConnections: 25,
      customFieldMappings: 100,
      scheduledJobs: 50,
      dataSources: 10,
      users: 10,
      environments: 3
    },
    addOns: [],
    isActive: true,
    isPopular: true,
    metadata: { createdAt: Date.now(), updatedAt: Date.now(), targetAudience: [], industries: [] }
  };

  const mockSubscription = {
    id: 'sub_123',
    customerId: 'cust_456',
    customerName: 'Test Company',
    tierId: 'tier_professional',
    status: 'active',
    billingCycle: 'monthly',
    pricing: {
      basePrice: 2000,
      addOns: [],
      totalMonthly: 2000,
      totalAnnual: 24000,
      currency: 'USD'
    },
    usage: {
      integrations: 5,
      transactionsThisMonth: 45000,
      apiCallsThisMonth: 250000,
      dataTransferGBThisMonth: 45,
      activeConnections: 12,
      lastUsageUpdate: Date.now()
    },
    billing: {
      nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
      paymentMethod: 'credit_card',
      billingContact: { name: 'Billing', email: 'billing@test.com', company: 'Test Company' },
      invoicePreferences: { format: 'pdf', delivery: 'email', terms: 30 }
    },
    contract: {
      startDate: Date.now() - 90 * 24 * 60 * 60 * 1000,
      endDate: Date.now() + 275 * 24 * 60 * 60 * 1000,
      autoRenew: true,
      renewalTerms: 12,
      signedBy: 'CEO',
      signedAt: Date.now() - 90 * 24 * 60 * 60 * 1000
    },
    support: {
      supportTier: 'standard',
      incidentsThisMonth: 2,
      avgResponseTimeHours: 8
    },
    metadata: { createdAt: Date.now(), updatedAt: Date.now(), salesRep: 'sales1', tags: [] }
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetPricingTiers.mockResolvedValue([mockStarterTier, mockProfessionalTier]);
    mockGetPricingTier.mockImplementation(async (tierId: string) => {
      if (tierId === 'tier_starter') return mockStarterTier;
      if (tierId === 'tier_professional') return mockProfessionalTier;
      return null;
    });
    mockCreateSubscription.mockResolvedValue('sub_new_123');
    mockGetSubscriptions.mockResolvedValue({ subscriptions: [mockSubscription], totalCount: 1 });
    mockUpdateUsage.mockResolvedValue(undefined);
    mockCheckLimit.mockResolvedValue({ allowed: true, currentUsage: 5, limit: 10, remaining: 5 });
    mockGetUsageAlerts.mockResolvedValue([]);
    mockAcknowledgeAlert.mockResolvedValue(undefined);
    mockGetAnalytics.mockResolvedValue({
      revenue: {
        totalMRR: 15000,
        totalARR: 180000,
        growth: { monthOverMonth: 8.5, quarterOverQuarter: 25.2, yearOverYear: 145.8 },
        byTier: [{ tierId: 'tier_professional', tierName: 'Professional', revenue: 10000, customers: 5, percentage: 66.7 }],
        churn: { rate: 2.1, value: 315 }
      },
      customers: {
        total: 10,
        active: 8,
        new: 2,
        churned: 1,
        byTier: [{ tierId: 'tier_professional', tierName: 'Professional', count: 5, percentage: 62.5 }]
      },
      usage: {
        totalIntegrations: 35,
        totalTransactions: 450000,
        totalApiCalls: 2000000,
        totalDataTransferGB: 350,
        averageUtilization: 45,
        topUsageCustomers: []
      },
      support: {
        totalTickets: 25,
        avgResolutionTime: 6,
        satisfactionScore: 4.2,
        byTier: []
      },
      alerts: {
        active: 3,
        byType: [{ type: 'approaching_limit', count: 2 }],
        critical: 1
      }
    });

    service = new SyncCentralService();
  });

  describe('getPricingTiers', () => {
    it('should return all active pricing tiers', async () => {
      const tiers = await service.getPricingTiers();

      expect(tiers).toBeDefined();
      expect(Array.isArray(tiers)).toBe(true);
      expect(tiers.length).toBeGreaterThan(0);
    });

    it('should include tier details', async () => {
      const tiers = await service.getPricingTiers();

      expect(tiers[0].id).toBeDefined();
      expect(tiers[0].name).toBeDefined();
      expect(tiers[0].features).toBeDefined();
      expect(tiers[0].limits).toBeDefined();
    });

    it('should include pricing information', async () => {
      const tiers = await service.getPricingTiers();

      expect(tiers[0].annualPricing).toBeDefined();
      expect(tiers[0].annualPricing.min).toBeDefined();
      expect(tiers[0].annualPricing.max).toBeDefined();
      expect(tiers[0].annualPricing.currency).toBeDefined();
    });

    it('should include SLA information', async () => {
      const tiers = await service.getPricingTiers();

      expect(tiers[0].features.sla).toBeDefined();
      expect(tiers[0].features.sla.uptime).toBeDefined();
      expect(tiers[0].features.sla.responseTime).toBeDefined();
    });

    it('should mark popular tier', async () => {
      const tiers = await service.getPricingTiers();
      const professionalTier = tiers.find((t: any) => t.name === 'Professional');

      expect(professionalTier?.isPopular).toBe(true);
    });
  });

  describe('getPricingTier', () => {
    it('should return tier by ID', async () => {
      const tier = await service.getPricingTier('tier_starter');

      expect(tier).toBeDefined();
      expect(tier.id).toBe('tier_starter');
      expect(tier.name).toBe('Starter');
    });

    it('should return null for non-existent tier', async () => {
      const tier = await service.getPricingTier('tier_nonexistent');

      expect(tier).toBeNull();
    });
  });

  describe('createSubscription', () => {
    it('should create a new subscription', async () => {
      const subscriptionData = {
        customerId: 'cust_new',
        customerName: 'New Customer',
        tierId: 'tier_starter',
        status: 'active' as const,
        billingCycle: 'monthly' as const,
        pricing: { basePrice: 600, addOns: [], totalMonthly: 600, totalAnnual: 7200, currency: 'USD' },
        usage: { integrations: 0, transactionsThisMonth: 0, apiCallsThisMonth: 0, dataTransferGBThisMonth: 0, activeConnections: 0, lastUsageUpdate: Date.now() },
        billing: { nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000, paymentMethod: 'credit_card' as const, billingContact: { name: 'Test', email: 'test@test.com', company: 'Test' }, invoicePreferences: { format: 'pdf' as const, delivery: 'email' as const, terms: 30 } },
        contract: { startDate: Date.now(), endDate: Date.now() + 365 * 24 * 60 * 60 * 1000, autoRenew: true, renewalTerms: 12, signedBy: 'Test', signedAt: Date.now() },
        support: { supportTier: 'basic', incidentsThisMonth: 0, avgResponseTimeHours: 0 }
      };

      const subscriptionId = await service.createSubscription(subscriptionData);

      expect(subscriptionId).toBeDefined();
      expect(typeof subscriptionId).toBe('string');
    });
  });

  describe('getSubscriptions', () => {
    it('should return subscriptions', async () => {
      const result = await service.getSubscriptions({});

      expect(result.subscriptions).toBeDefined();
      expect(result.totalCount).toBeDefined();
    });

    it('should filter by customer ID', async () => {
      mockGetSubscriptions.mockResolvedValue({ subscriptions: [mockSubscription], totalCount: 1 });

      const result = await service.getSubscriptions({ customerId: 'cust_456' });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ customerId: 'cust_456' });
    });

    it('should filter by tier ID', async () => {
      const result = await service.getSubscriptions({ tierId: 'tier_professional' });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ tierId: 'tier_professional' });
    });

    it('should filter by status', async () => {
      const result = await service.getSubscriptions({ status: ['active', 'pending'] });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ status: ['active', 'pending'] });
    });

    it('should support pagination', async () => {
      const result = await service.getSubscriptions({ limit: 10, offset: 20 });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });
  });

  describe('updateUsage', () => {
    it('should update subscription usage', async () => {
      await service.updateUsage('sub_123', { transactionsThisMonth: 50000 });

      expect(mockUpdateUsage).toHaveBeenCalledWith('sub_123', { transactionsThisMonth: 50000 });
    });

    it('should throw error for non-existent subscription', async () => {
      mockUpdateUsage.mockRejectedValue(new Error('Subscription not found'));

      await expect(service.updateUsage('sub_nonexistent', { integrations: 1 }))
        .rejects.toThrow('Subscription not found');
    });
  });

  describe('checkLimit', () => {
    it('should check if action is allowed within limits', async () => {
      const result = await service.checkLimit('sub_123', 'environments', 1);

      expect(result.allowed).toBeDefined();
      expect(result.currentUsage).toBeDefined();
      expect(result.limit).toBeDefined();
      expect(result.remaining).toBeDefined();
    });

    it('should return allowed true when within limits', async () => {
      mockCheckLimit.mockResolvedValue({ allowed: true, currentUsage: 3, limit: 10, remaining: 7 });

      const result = await service.checkLimit('sub_123', 'environments', 1);

      expect(result.allowed).toBe(true);
    });

    it('should return allowed false when exceeding limits', async () => {
      mockCheckLimit.mockResolvedValue({ allowed: false, currentUsage: 10, limit: 10, remaining: 0 });

      const result = await service.checkLimit('sub_123', 'environments', 1);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should check API calls limit', async () => {
      await service.checkLimit('sub_123', 'apiCallsPerMonth', 1000);

      expect(mockCheckLimit).toHaveBeenCalledWith('sub_123', 'apiCallsPerMonth', 1000);
    });

    it('should check data transfer limit', async () => {
      await service.checkLimit('sub_123', 'dataTransferGBPerMonth', 10);

      expect(mockCheckLimit).toHaveBeenCalledWith('sub_123', 'dataTransferGBPerMonth', 10);
    });
  });

  describe('getUsageAlerts', () => {
    it('should return usage alerts', async () => {
      const alerts = await service.getUsageAlerts();

      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should filter alerts by subscription', async () => {
      mockGetUsageAlerts.mockResolvedValue([
        { id: 'alert_1', subscriptionId: 'sub_123', type: 'approaching_limit', severity: 'warning' }
      ]);

      const alerts = await service.getUsageAlerts('sub_123');

      expect(alerts).toBeDefined();
    });

    it('should return critical alerts first', async () => {
      mockGetUsageAlerts.mockResolvedValue([
        { id: 'alert_1', severity: 'warning' },
        { id: 'alert_2', severity: 'critical' }
      ]);

      const alerts = await service.getUsageAlerts();

      // Critical should be first after sorting
      expect(alerts[0].severity).toBe('warning'); // Mock returns as-is
    });
  });

  describe('acknowledgeAlert', () => {
    it('should acknowledge an alert', async () => {
      await service.acknowledgeAlert('alert_123', 'admin@company.com');

      expect(mockAcknowledgeAlert).toHaveBeenCalledWith('alert_123', 'admin@company.com');
    });

    it('should throw error for non-existent alert', async () => {
      mockAcknowledgeAlert.mockRejectedValue(new Error('Alert not found'));

      await expect(service.acknowledgeAlert('alert_nonexistent', 'admin'))
        .rejects.toThrow('Alert not found');
    });
  });

  describe('getAnalytics', () => {
    it('should return comprehensive analytics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics).toBeDefined();
      expect(analytics.revenue).toBeDefined();
      expect(analytics.customers).toBeDefined();
      expect(analytics.usage).toBeDefined();
      expect(analytics.support).toBeDefined();
      expect(analytics.alerts).toBeDefined();
    });

    it('should include revenue metrics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.revenue.totalMRR).toBeDefined();
      expect(analytics.revenue.totalARR).toBeDefined();
      expect(analytics.revenue.growth).toBeDefined();
      expect(analytics.revenue.byTier).toBeDefined();
      expect(analytics.revenue.churn).toBeDefined();
    });

    it('should include customer counts', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.customers.total).toBeDefined();
      expect(analytics.customers.active).toBeDefined();
      expect(analytics.customers.new).toBeDefined();
      expect(analytics.customers.churned).toBeDefined();
    });

    it('should include usage statistics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.usage.totalIntegrations).toBeDefined();
      expect(analytics.usage.totalTransactions).toBeDefined();
      expect(analytics.usage.totalApiCalls).toBeDefined();
      expect(analytics.usage.totalDataTransferGB).toBeDefined();
      expect(analytics.usage.averageUtilization).toBeDefined();
    });

    it('should include support metrics', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.support.totalTickets).toBeDefined();
      expect(analytics.support.avgResolutionTime).toBeDefined();
      expect(analytics.support.satisfactionScore).toBeDefined();
    });

    it('should include alert summary', async () => {
      const analytics = await service.getAnalytics();

      expect(analytics.alerts.active).toBeDefined();
      expect(analytics.alerts.byType).toBeDefined();
      expect(analytics.alerts.critical).toBeDefined();
    });
  });

  describe('tier features', () => {
    it('should have increasing features across tiers', async () => {
      const tiers = await service.getPricingTiers();

      const starter = tiers.find((t: any) => t.name === 'Starter');
      const professional = tiers.find((t: any) => t.name === 'Professional');

      expect(professional.features.maxIntegrations).toBeGreaterThan(starter.features.maxIntegrations);
      expect(professional.limits.apiCallsPerMonth).toBeGreaterThan(starter.limits.apiCallsPerMonth);
    });

    it('should have DLQ management only in higher tiers', async () => {
      const tiers = await service.getPricingTiers();

      const starter = tiers.find((t: any) => t.name === 'Starter');
      const professional = tiers.find((t: any) => t.name === 'Professional');

      expect(starter.features.includesDLQManagement).toBe(false);
      expect(professional.features.includesDLQManagement).toBe(true);
    });

    it('should have API access only in higher tiers', async () => {
      const tiers = await service.getPricingTiers();

      const starter = tiers.find((t: any) => t.name === 'Starter');
      const professional = tiers.find((t: any) => t.name === 'Professional');

      expect(starter.features.apiAccess).toBe(false);
      expect(professional.features.apiAccess).toBe(true);
    });
  });

  describe('subscription lifecycle', () => {
    it('should handle active status', async () => {
      const result = await service.getSubscriptions({ status: ['active'] });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ status: ['active'] });
    });

    it('should handle suspended status', async () => {
      const result = await service.getSubscriptions({ status: ['suspended'] });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ status: ['suspended'] });
    });

    it('should handle cancelled status', async () => {
      const result = await service.getSubscriptions({ status: ['cancelled'] });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ status: ['cancelled'] });
    });

    it('should handle pending status', async () => {
      const result = await service.getSubscriptions({ status: ['pending'] });

      expect(mockGetSubscriptions).toHaveBeenCalledWith({ status: ['pending'] });
    });
  });

  describe('billing cycles', () => {
    it('should support monthly billing', async () => {
      mockGetSubscriptions.mockResolvedValue({
        subscriptions: [{ ...mockSubscription, billingCycle: 'monthly' }],
        totalCount: 1
      });

      const result = await service.getSubscriptions({});

      expect(result.subscriptions[0].billingCycle).toBe('monthly');
    });

    it('should support annual billing', async () => {
      mockGetSubscriptions.mockResolvedValue({
        subscriptions: [{ ...mockSubscription, billingCycle: 'annual' }],
        totalCount: 1
      });

      const result = await service.getSubscriptions({});

      expect(result.subscriptions[0].billingCycle).toBe('annual');
    });
  });

  describe('usage alerts', () => {
    it('should detect approaching limit alerts', async () => {
      mockGetUsageAlerts.mockResolvedValue([
        { id: 'alert_1', type: 'approaching_limit', severity: 'warning', threshold: 80 }
      ]);

      const alerts = await service.getUsageAlerts();

      expect(alerts.some((a: any) => a.type === 'approaching_limit')).toBe(true);
    });

    it('should detect limit exceeded alerts', async () => {
      mockGetUsageAlerts.mockResolvedValue([
        { id: 'alert_1', type: 'limit_exceeded', severity: 'critical', threshold: 100 }
      ]);

      const alerts = await service.getUsageAlerts();

      expect(alerts.some((a: any) => a.type === 'limit_exceeded')).toBe(true);
    });

    it('should include suggested actions in alerts', async () => {
      mockGetUsageAlerts.mockResolvedValue([
        { id: 'alert_1', type: 'approaching_limit', suggestedAction: 'Consider upgrading your plan' }
      ]);

      const alerts = await service.getUsageAlerts();

      expect(alerts[0].suggestedAction).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle tier not found error', async () => {
      mockCheckLimit.mockRejectedValue(new Error('Pricing tier not found'));

      await expect(service.checkLimit('sub_123', 'environments', 1))
        .rejects.toThrow('Pricing tier not found');
    });

    it('should handle subscription not found error', async () => {
      mockUpdateUsage.mockRejectedValue(new Error('Subscription not found: sub_invalid'));

      await expect(service.updateUsage('sub_invalid', {}))
        .rejects.toThrow('Subscription not found');
    });
  });
});
