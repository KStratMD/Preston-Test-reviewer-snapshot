import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { TelemetryService } from './TelemetryService';
import { TenantSandbox } from './common/TenantSandbox';
import { buildSyncCentralSeed, type SyncCentralStores } from './syncCentral/syncCentralDemoSeed';

export interface PricingTier {
  id: string;
  name: string;
  displayName: string;
  description: string;
  annualPricing: {
    min: number;
    max: number;
    currency: string;
  };
  features: {
    maxIntegrations: number;
    maxTransactions: number; // per month
    maxConnectors: number;
    includesSupport: boolean;
    supportLevel: 'basic' | 'standard' | 'premium' | 'enterprise';
    includesMonitoring: boolean;
    includesDLQManagement: boolean;
    customConnectors: boolean;
    apiAccess: boolean;
    webhooks: boolean;
    sla: {
      uptime: number; // percentage
      responseTime: string;
    };
    backup: {
      frequency: 'daily' | 'hourly' | 'realtime';
      retention: number; // days
    };
    compliance: string[];
  };
  limits: {
    apiCallsPerMonth: number;
    dataTransferGBPerMonth: number;
    concurrentConnections: number;
    customFieldMappings: number;
    scheduledJobs: number;
    dataSources: number;
    users: number;
    environments: number;
  };
  addOns: {
    id: string;
    name: string;
    description: string;
    monthlyPrice: number;
    unit: string;
  }[];
  isActive: boolean;
  isPopular?: boolean;
  metadata: {
    createdAt: number;
    updatedAt: number;
    targetAudience: string[];
    industries: string[];
  };
}

export interface CustomerSubscription {
  id: string;
  customerId: string;
  customerName: string;
  tierId: string;
  status: 'active' | 'suspended' | 'cancelled' | 'pending' | 'expired';
  billingCycle: 'monthly' | 'annual';
  pricing: {
    basePrice: number;
    addOns: {
      addOnId: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
    }[];
    totalMonthly: number;
    totalAnnual: number;
    currency: string;
  };
  usage: {
    integrations: number;
    transactionsThisMonth: number;
    apiCallsThisMonth: number;
    dataTransferGBThisMonth: number;
    activeConnections: number;
    lastUsageUpdate: number;
  };
  billing: {
    nextBillingDate: number;
    lastBillingDate?: number;
    paymentMethod: 'credit_card' | 'ach' | 'wire' | 'invoice';
    billingContact: {
      name: string;
      email: string;
      company: string;
    };
    invoicePreferences: {
      format: 'pdf' | 'xml';
      delivery: 'email' | 'portal';
      terms: number; // days
    };
  };
  contract: {
    startDate: number;
    endDate: number;
    autoRenew: boolean;
    renewalTerms: number; // months
    customTerms?: string;
    signedBy: string;
    signedAt: number;
  };
  support: {
    accountManager?: string;
    supportTier: string;
    incidentsThisMonth: number;
    avgResponseTimeHours: number;
  };
  metadata: {
    createdAt: number;
    updatedAt: number;
    salesRep: string;
    referralSource?: string;
    tags: string[];
  };
}

export interface UsageAlert {
  id: string;
  customerId: string;
  subscriptionId: string;
  type: 'approaching_limit' | 'limit_exceeded' | 'billing_anomaly' | 'compliance_issue';
  severity: 'info' | 'warning' | 'critical';
  metric: string;
  currentValue: number;
  limitValue: number;
  threshold: number; // percentage of limit that triggered alert
  message: string;
  suggestedAction: string;
  createdAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  resolvedAt?: number;
  autoResolved: boolean;
}

export interface SyncCentralAnalytics {
  revenue: {
    totalMRR: number; // Monthly Recurring Revenue
    totalARR: number; // Annual Recurring Revenue
    growth: {
      monthOverMonth: number;
      quarterOverQuarter: number;
      yearOverYear: number;
    };
    byTier: {
      tierId: string;
      tierName: string;
      revenue: number;
      customers: number;
      percentage: number;
    }[];
    churn: {
      rate: number;
      value: number;
    };
  };
  customers: {
    total: number;
    active: number;
    new: number;
    churned: number;
    byTier: {
      tierId: string;
      tierName: string;
      count: number;
      percentage: number;
    }[];
  };
  usage: {
    totalIntegrations: number;
    totalTransactions: number;
    totalApiCalls: number;
    totalDataTransferGB: number;
    averageUtilization: number; // percentage of limits used
    topUsageCustomers: {
      customerId: string;
      customerName: string;
      utilization: number;
      tier: string;
    }[];
  };
  support: {
    totalTickets: number;
    avgResolutionTime: number; // hours
    satisfactionScore: number; // 1-5
    byTier: {
      tierId: string;
      tickets: number;
      avgResolutionTime: number;
    }[];
  };
  alerts: {
    active: number;
    byType: {
      type: UsageAlert['type'];
      count: number;
    }[];
    critical: number;
  };
}

/**
 * SyncCentral Service - Tiered pricing and subscription management
 * Implements the three-tier pricing model: Starter, Professional, Enterprise
 * 
 * NOTE: This service provides comprehensive subscription management with
 * usage tracking, billing, and tier enforcement capabilities.
 */
@injectable()
export class SyncCentralService {
  private readonly tiers = new Map<string, PricingTier>();
  private readonly sandbox = new TenantSandbox<SyncCentralStores>(buildSyncCentralSeed);

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.TelemetryService) private telemetryService: TelemetryService,
  ) {
    this.logger.info('SyncCentralService initialized');
    this.initializePricingTiers();
  }

  /**
   * Get all pricing tiers
   */
  async getPricingTiers(): Promise<PricingTier[]> {
    return Array.from(this.tiers.values()).filter(tier => tier.isActive);
  }

  /**
   * Get pricing tier by ID
   */
  async getPricingTier(tierId: string): Promise<PricingTier | null> {
    return this.tiers.get(tierId) || null;
  }

  /**
   * Create customer subscription
   */
  async createSubscription(tenantId: string, subscriptionData: Omit<CustomerSubscription, 'id' | 'metadata'>): Promise<string> {
    const { subscriptions } = this.sandbox.forTenant(tenantId);
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

    const subscription: CustomerSubscription = {
      ...subscriptionData,
      id,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salesRep: 'demo_sales',
        tags: [],
      },
    };

    subscriptions.set(id, subscription);

    this.logger.info('Customer subscription created', {
      subscriptionId: id,
      customerId: subscription.customerId,
      tierId: subscription.tierId,
    });

    return id;
  }

  /**
   * Get customer subscriptions
   */
  async getSubscriptions(tenantId: string, filters: {
    customerId?: string;
    tierId?: string;
    status?: string[];
    limit?: number;
    offset?: number;
  } = {}): Promise<{ subscriptions: CustomerSubscription[]; totalCount: number }> {
    const { subscriptions } = this.sandbox.forTenant(tenantId);
    let filteredSubscriptions = Array.from(subscriptions.values());

    if (filters.customerId) {
      filteredSubscriptions = filteredSubscriptions.filter(s => s.customerId === filters.customerId);
    }

    if (filters.tierId) {
      filteredSubscriptions = filteredSubscriptions.filter(s => s.tierId === filters.tierId);
    }

    if (filters.status && filters.status.length > 0) {
      filteredSubscriptions = filteredSubscriptions.filter(s => filters.status!.includes(s.status));
    }

    const totalCount = filteredSubscriptions.length;

    // Sort by most recent first
    filteredSubscriptions.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);

    // Apply pagination
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    const page = filteredSubscriptions.slice(offset, offset + limit);

    return { subscriptions: page, totalCount };
  }

  /**
   * Cancel an active/pending subscription.
   * Keeps the record for audit/reporting while preventing further renewals.
   */
  async cancelSubscription(
    tenantId: string,
    subscriptionId: string,
    reason?: string,
    cancelledBy = 'system'
  ): Promise<CustomerSubscription> {
    const { subscriptions } = this.sandbox.forTenant(tenantId);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    if (subscription.status === 'cancelled') {
      return subscription;
    }

    const cancellableStatuses: CustomerSubscription['status'][] = ['active', 'pending'];
    if (!cancellableStatuses.includes(subscription.status)) {
      throw new Error(`Subscription status '${subscription.status}' cannot be cancelled`);
    }

    const now = Date.now();
    subscription.status = 'cancelled';
    subscription.contract.autoRenew = false;
    subscription.metadata.updatedAt = now;

    if (reason) {
      const reasonTag = `cancel_reason:${reason.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      if (!subscription.metadata.tags.includes(reasonTag)) {
        subscription.metadata.tags.push(reasonTag);
      }
    }

    subscriptions.set(subscriptionId, subscription);

    this.logger.info('Subscription cancelled', {
      subscriptionId,
      customerId: subscription.customerId,
      cancelledBy,
      reason: reason || 'not_specified',
      cancelledAt: now,
    });

    return subscription;
  }

  /**
   * Update subscription usage
   */
  async updateUsage(tenantId: string, subscriptionId: string, usage: Partial<CustomerSubscription['usage']>): Promise<void> {
    const { subscriptions } = this.sandbox.forTenant(tenantId);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    subscription.usage = {
      ...subscription.usage,
      ...usage,
      lastUsageUpdate: Date.now(),
    };

    subscription.metadata.updatedAt = Date.now();
    subscriptions.set(subscriptionId, subscription);

    // Check for usage alerts
    await this.checkUsageLimits(tenantId, subscriptionId);

    this.logger.debug('Subscription usage updated', {
      subscriptionId,
      usage: Object.keys(usage),
    });
  }

  /**
   * Check if customer can perform action based on their tier
   */
  async checkLimit(tenantId: string, subscriptionId: string, limitType: keyof PricingTier['limits'], requestedAmount = 1): Promise<{
    allowed: boolean;
    currentUsage: number;
    limit: number;
    remaining: number;
  }> {
    const { subscriptions } = this.sandbox.forTenant(tenantId);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    const tier = this.tiers.get(subscription.tierId);
    if (!tier) {
      throw new Error(`Pricing tier not found: ${subscription.tierId}`);
    }

    const limit = tier.limits[limitType];
    let currentUsage: number;

    // Map limit types to current usage
    switch (limitType) {
      case 'environments':
        currentUsage = subscription.usage.integrations;
        break;
      case 'apiCallsPerMonth':
        currentUsage = subscription.usage.apiCallsThisMonth;
        break;
      case 'dataTransferGBPerMonth':
        currentUsage = subscription.usage.dataTransferGBThisMonth;
        break;
      case 'concurrentConnections':
        currentUsage = subscription.usage.activeConnections;
        break;
      default:
        currentUsage = 0;
    }

    const remaining = limit - currentUsage;
    const allowed = currentUsage + requestedAmount <= limit;

    return {
      allowed,
      currentUsage,
      limit,
      remaining,
    };
  }

  /**
   * Get usage alerts for a subscription
   */
  async getUsageAlerts(tenantId: string, subscriptionId?: string): Promise<UsageAlert[]> {
    const { alerts } = this.sandbox.forTenant(tenantId);
    let alertList = Array.from(alerts.values());

    if (subscriptionId) {
      alertList = alertList.filter(a => a.subscriptionId === subscriptionId);
    }

    // Sort by severity and timestamp
    alertList.sort((a, b) => {
      const severityOrder = { 'critical': 3, 'warning': 2, 'info': 1 };
      const aSeverity = severityOrder[a.severity];
      const bSeverity = severityOrder[b.severity];

      if (aSeverity !== bSeverity) {
        return bSeverity - aSeverity;
      }

      return b.createdAt - a.createdAt;
    });

    return alertList.filter(a => !a.resolvedAt); // Only return unresolved alerts
  }

  /**
   * Acknowledge usage alert
   */
  async acknowledgeAlert(tenantId: string, alertId: string, acknowledgedBy: string): Promise<void> {
    const { alerts } = this.sandbox.forTenant(tenantId);
    const alert = alerts.get(alertId);
    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    alert.acknowledgedAt = Date.now();
    alert.acknowledgedBy = acknowledgedBy;
    alerts.set(alertId, alert);

    this.logger.info('Usage alert acknowledged', { alertId, acknowledgedBy });
  }

  /**
   * Get SyncCentral analytics
   */
  async getAnalytics(tenantId: string): Promise<SyncCentralAnalytics> {
    const { subscriptions: subscriptionsMap, alerts: alertsMap } = this.sandbox.forTenant(tenantId);
    const subscriptions = Array.from(subscriptionsMap.values());
    const activeSubscriptions = subscriptions.filter(s => s.status === 'active');
    const now = Date.now();
    const lastMonth = now - (30 * 24 * 60 * 60 * 1000);

    // Revenue calculations
    const totalMRR = activeSubscriptions.reduce((sum, s) => sum + s.pricing.totalMonthly, 0);
    const totalARR = totalMRR * 12;
    
    // Calculate revenue by tier
    const tierRevenue = new Map<string, { revenue: number; customers: number; name: string }>();
    activeSubscriptions.forEach(s => {
      const tier = this.tiers.get(s.tierId);
      const stats = tierRevenue.get(s.tierId) || { revenue: 0, customers: 0, name: tier?.name || 'Unknown' };
      stats.revenue += s.pricing.totalMonthly;
      stats.customers += 1;
      tierRevenue.set(s.tierId, stats);
    });

    const revenueByTier = Array.from(tierRevenue.entries()).map(([tierId, stats]) => ({
      tierId,
      tierName: stats.name,
      revenue: stats.revenue,
      customers: stats.customers,
      percentage: totalMRR > 0 ? (stats.revenue / totalMRR) * 100 : 0,
    }));

    // Customer stats by tier
    const customersByTier = Array.from(tierRevenue.entries()).map(([tierId, stats]) => ({
      tierId,
      tierName: stats.name,
      count: stats.customers,
      percentage: activeSubscriptions.length > 0 ? (stats.customers / activeSubscriptions.length) * 100 : 0,
    }));

    // Usage statistics
    const totalIntegrations = activeSubscriptions.reduce((sum, s) => sum + s.usage.integrations, 0);
    const totalTransactions = activeSubscriptions.reduce((sum, s) => sum + s.usage.transactionsThisMonth, 0);
    const totalApiCalls = activeSubscriptions.reduce((sum, s) => sum + s.usage.apiCallsThisMonth, 0);
    const totalDataTransferGB = activeSubscriptions.reduce((sum, s) => sum + s.usage.dataTransferGBThisMonth, 0);

    // Calculate average utilization
    let totalUtilization = 0;
    let utilizationCount = 0;

    for (const subscription of activeSubscriptions) {
      const tier = this.tiers.get(subscription.tierId);
      if (tier) {
        const integrationUtil = (subscription.usage.integrations / tier.features.maxIntegrations) * 100;
        const apiUtil = (subscription.usage.apiCallsThisMonth / tier.limits.apiCallsPerMonth) * 100;
        const dataUtil = (subscription.usage.dataTransferGBThisMonth / tier.limits.dataTransferGBPerMonth) * 100;
        
        totalUtilization += (integrationUtil + apiUtil + dataUtil) / 3;
        utilizationCount++;
      }
    }

    const averageUtilization = utilizationCount > 0 ? totalUtilization / utilizationCount : 0;

    // Top usage customers
    const topUsageCustomers = activeSubscriptions
      .map(s => {
        const tier = this.tiers.get(s.tierId);
        if (!tier) return null;
        
        const utilization = ((s.usage.integrations / tier.features.maxIntegrations) * 100 +
                           (s.usage.apiCallsThisMonth / tier.limits.apiCallsPerMonth) * 100 +
                           (s.usage.dataTransferGBThisMonth / tier.limits.dataTransferGBPerMonth) * 100) / 3;
        
        return {
          customerId: s.customerId,
          customerName: s.customerName,
          utilization,
          tier: tier.name,
        };
      })
      .filter(c => c !== null)
      .sort((a, b) => b!.utilization - a!.utilization)
      .slice(0, 10);

    // Support statistics
    const totalTickets = activeSubscriptions.reduce((sum, s) => sum + s.support.incidentsThisMonth, 0);
    const avgResolutionTime = activeSubscriptions.length > 0 ?
      activeSubscriptions.reduce((sum, s) => sum + s.support.avgResponseTimeHours, 0) / activeSubscriptions.length : 0;

    const supportByTier = Array.from(tierRevenue.entries()).map(([tierId, stats]) => {
      const tierSubscriptions = activeSubscriptions.filter(s => s.tierId === tierId);
      const tickets = tierSubscriptions.reduce((sum, s) => sum + s.support.incidentsThisMonth, 0);
      const avgTime = tierSubscriptions.length > 0 ?
        tierSubscriptions.reduce((sum, s) => sum + s.support.avgResponseTimeHours, 0) / tierSubscriptions.length : 0;
      
      return {
        tierId,
        tickets,
        avgResolutionTime: avgTime,
      };
    });

    // Alert statistics
    const activeAlerts = Array.from(alertsMap.values()).filter(a => !a.resolvedAt);
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical').length;
    
    const alertsByType = new Map<UsageAlert['type'], number>();
    activeAlerts.forEach(a => {
      alertsByType.set(a.type, (alertsByType.get(a.type) || 0) + 1);
    });

    const alertsBreakdown = Array.from(alertsByType.entries()).map(([type, count]) => ({
      type,
      count,
    }));

    return {
      revenue: {
        totalMRR,
        totalARR,
        growth: {
          monthOverMonth: 8.5, // Demo data
          quarterOverQuarter: 25.2,
          yearOverYear: 145.8,
        },
        byTier: revenueByTier,
        churn: {
          rate: 2.1, // Demo: 2.1% monthly churn
          value: totalMRR * 0.021,
        },
      },
      customers: {
        total: subscriptions.length,
        active: activeSubscriptions.length,
        new: subscriptions.filter(s => s.metadata.createdAt >= lastMonth).length,
        churned: subscriptions.filter(s => s.status === 'cancelled').length,
        byTier: customersByTier,
      },
      usage: {
        totalIntegrations,
        totalTransactions,
        totalApiCalls,
        totalDataTransferGB,
        averageUtilization,
        topUsageCustomers: topUsageCustomers,
      },
      support: {
        totalTickets,
        avgResolutionTime,
        satisfactionScore: 4.2, // Demo: 4.2/5 satisfaction
        byTier: supportByTier,
      },
      alerts: {
        active: activeAlerts.length,
        byType: alertsBreakdown,
        critical: criticalAlerts,
      },
    };
  }

  /**
   * Check usage limits and create alerts if necessary
   */
  private async checkUsageLimits(tenantId: string, subscriptionId: string): Promise<void> {
    const { subscriptions, alerts } = this.sandbox.forTenant(tenantId);
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return;

    const tier = this.tiers.get(subscription.tierId);
    if (!tier) return;

    const checks = [
      {
        metric: 'integrations',
        current: subscription.usage.integrations,
        limit: tier.features.maxIntegrations,
      },
      {
        metric: 'apiCalls',
        current: subscription.usage.apiCallsThisMonth,
        limit: tier.limits.apiCallsPerMonth,
      },
      {
        metric: 'dataTransfer',
        current: subscription.usage.dataTransferGBThisMonth,
        limit: tier.limits.dataTransferGBPerMonth,
      },
      {
        metric: 'connections',
        current: subscription.usage.activeConnections,
        limit: tier.limits.concurrentConnections,
      },
    ];

    for (const check of checks) {
      const percentage = (check.current / check.limit) * 100;

      // Create alerts at 80% and 100% thresholds
      if (percentage >= 80 && percentage < 100) {
        await this.createUsageAlert(alerts, subscription, check.metric, check.current, check.limit, 80, 'approaching_limit');
      } else if (percentage >= 100) {
        await this.createUsageAlert(alerts, subscription, check.metric, check.current, check.limit, 100, 'limit_exceeded');
      }
    }
  }

  /**
   * Create usage alert
   */
  private async createUsageAlert(
    alerts: Map<string, UsageAlert>,
    subscription: CustomerSubscription,
    metric: string,
    current: number,
    limit: number,
    threshold: number,
    type: UsageAlert['type']
  ): Promise<void> {
    // Check if similar alert already exists
    const existingAlert = Array.from(alerts.values()).find(a =>
      a.subscriptionId === subscription.id &&
      a.metric === metric &&
      a.type === type &&
      !a.resolvedAt
    );

    if (existingAlert) return; // Don't create duplicate alerts

    const alertId = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    const severity: UsageAlert['severity'] = threshold >= 100 ? 'critical' : threshold >= 80 ? 'warning' : 'info';

    const alert: UsageAlert = {
      id: alertId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      type,
      severity,
      metric,
      currentValue: current,
      limitValue: limit,
      threshold,
      message: this.getAlertMessage(type, metric, current, limit, threshold),
      suggestedAction: this.getSuggestedAction(type, metric, subscription.tierId),
      createdAt: Date.now(),
      autoResolved: false,
    };

    alerts.set(alertId, alert);

    this.logger.warn('Usage alert created', {
      alertId,
      customerId: subscription.customerId,
      metric,
      threshold,
      type,
      severity,
    });
  }

  /**
   * Get alert message
   */
  private getAlertMessage(type: UsageAlert['type'], metric: string, current: number, limit: number, threshold: number): string {
    const percentage = Math.round((current / limit) * 100);
    
    switch (type) {
      case 'approaching_limit':
        return `${metric} usage is at ${percentage}% (${current}/${limit}). Consider upgrading your plan to avoid service interruption.`;
      case 'limit_exceeded':
        return `${metric} limit exceeded: ${current}/${limit} (${percentage}%). Please upgrade your plan or reduce usage.`;
      default:
        return `Usage alert for ${metric}: ${current}/${limit}`;
    }
  }

  /**
   * Get suggested action for alert
   */
  private getSuggestedAction(type: UsageAlert['type'], metric: string, tierId: string): string {
    if (type === 'limit_exceeded') {
      return tierId === 'tier_enterprise' ? 
        'Contact your account manager to discuss custom limits' :
        'Upgrade to the next tier or contact sales for custom pricing';
    } else if (type === 'approaching_limit') {
      return 'Review usage patterns and consider upgrading your plan';
    }
    
    return 'Monitor usage and take appropriate action';
  }

  /**
   * Initialize pricing tiers
   */
  private initializePricingTiers(): void {
    const tiers: PricingTier[] = [
      {
        id: 'tier_starter',
        name: 'Starter',
        displayName: 'SyncCentral Starter',
        description: 'Perfect for small businesses getting started with integrations',
        annualPricing: {
          min: 7200,
          max: 9600,
          currency: 'USD',
        },
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
          sla: {
            uptime: 99.0,
            responseTime: '24 hours',
          },
          backup: {
            frequency: 'daily',
            retention: 30,
          },
          compliance: ['SOC 2'],
        },
        limits: {
          apiCallsPerMonth: 50000,
          dataTransferGBPerMonth: 10,
          concurrentConnections: 5,
          customFieldMappings: 25,
          scheduledJobs: 10,
          dataSources: 3,
          users: 2,
          environments: 1,
        },
        addOns: [
          {
            id: 'addon_extra_integration',
            name: 'Additional Integration',
            description: 'Add one more integration to your plan',
            monthlyPrice: 99,
            unit: 'per integration',
          },
          {
            id: 'addon_extra_transactions',
            name: 'Extra Transactions',
            description: 'Add 10,000 transactions per month',
            monthlyPrice: 49,
            unit: 'per 10k transactions',
          },
        ],
        isActive: true,
        metadata: {
          createdAt: Date.now() - (90 * 24 * 60 * 60 * 1000),
          updatedAt: Date.now() - (30 * 24 * 60 * 60 * 1000),
          targetAudience: ['small_business', 'startup'],
          industries: ['retail', 'services', 'ecommerce'],
        },
      },
      {
        id: 'tier_professional',
        name: 'Professional',
        displayName: 'SyncCentral Professional',
        description: 'Ideal for growing companies with moderate integration needs',
        annualPricing: {
          min: 18000,
          max: 24000,
          currency: 'USD',
        },
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
          sla: {
            uptime: 99.5,
            responseTime: '12 hours',
          },
          backup: {
            frequency: 'hourly',
            retention: 90,
          },
          compliance: ['SOC 2', 'GDPR', 'HIPAA'],
        },
        limits: {
          apiCallsPerMonth: 500000,
          dataTransferGBPerMonth: 100,
          concurrentConnections: 25,
          customFieldMappings: 100,
          scheduledJobs: 50,
          dataSources: 10,
          users: 10,
          environments: 3,
        },
        addOns: [
          {
            id: 'addon_extra_integration_pro',
            name: 'Additional Integration',
            description: 'Add one more integration to your plan',
            monthlyPrice: 149,
            unit: 'per integration',
          },
          {
            id: 'addon_premium_support',
            name: 'Premium Support',
            description: 'Upgrade to premium support with faster response times',
            monthlyPrice: 499,
            unit: 'monthly',
          },
        ],
        isActive: true,
        isPopular: true,
        metadata: {
          createdAt: Date.now() - (90 * 24 * 60 * 60 * 1000),
          updatedAt: Date.now() - (30 * 24 * 60 * 60 * 1000),
          targetAudience: ['medium_business', 'growing_company'],
          industries: ['manufacturing', 'healthcare', 'finance', 'technology'],
        },
      },
      {
        id: 'tier_enterprise',
        name: 'Enterprise',
        displayName: 'SyncCentral Enterprise',
        description: 'Comprehensive solution for large organizations with complex integration requirements',
        annualPricing: {
          min: 30600,
          max: 60000,
          currency: 'USD',
        },
        features: {
          maxIntegrations: -1, // Unlimited
          maxTransactions: 1000000,
          maxConnectors: -1, // Unlimited
          includesSupport: true,
          supportLevel: 'enterprise',
          includesMonitoring: true,
          includesDLQManagement: true,
          customConnectors: true,
          apiAccess: true,
          webhooks: true,
          sla: {
            uptime: 99.9,
            responseTime: '4 hours',
          },
          backup: {
            frequency: 'realtime',
            retention: 365,
          },
          compliance: ['SOC 2', 'GDPR', 'HIPAA', 'PCI DSS', 'ISO 27001'],
        },
        limits: {
          apiCallsPerMonth: 5000000,
          dataTransferGBPerMonth: 1000,
          concurrentConnections: 100,
          customFieldMappings: -1, // Unlimited
          scheduledJobs: -1, // Unlimited
          dataSources: -1, // Unlimited
          users: -1, // Unlimited
          environments: 10,
        },
        addOns: [
          {
            id: 'addon_dedicated_support',
            name: 'Dedicated Account Manager',
            description: 'Personal account manager and technical advisor',
            monthlyPrice: 2000,
            unit: 'monthly',
          },
          {
            id: 'addon_custom_development',
            name: 'Custom Development Hours',
            description: 'Professional services for custom development',
            monthlyPrice: 200,
            unit: 'per hour',
          },
        ],
        isActive: true,
        metadata: {
          createdAt: Date.now() - (90 * 24 * 60 * 60 * 1000),
          updatedAt: Date.now() - (30 * 24 * 60 * 60 * 1000),
          targetAudience: ['enterprise', 'large_corporation'],
          industries: ['fortune_500', 'government', 'healthcare_systems', 'financial_services'],
        },
      },
    ];

    tiers.forEach(tier => {
      this.tiers.set(tier.id, tier);
    });

    this.logger.info('Pricing tiers initialized', {
      tiers: this.tiers.size,
    });
  }

}

