import type { CustomerSubscription, UsageAlert } from '../SyncCentralService';

export interface SyncCentralStores {
  subscriptions: Map<string, CustomerSubscription>;
  alerts: Map<string, UsageAlert>;
}

/** Pure per-tenant demo seed for subscriptions + alerts (tiers stay global). */
export function buildSyncCentralSeed(args: { tenantId: string; nowMs: number }): SyncCentralStores {
  const subscriptions = new Map<string, CustomerSubscription>();
  const alerts = new Map<string, UsageAlert>();

  const demoSubscriptions = [
    {
      customerName: 'Acme Corporation',
      tierId: 'tier_enterprise',
      billingCycle: 'annual' as const,
      basePrice: 45000,
    },
    {
      customerName: 'TechStart Solutions',
      tierId: 'tier_professional',
      billingCycle: 'monthly' as const,
      basePrice: 2000,
    },
    {
      customerName: 'Small Business Co',
      tierId: 'tier_starter',
      billingCycle: 'annual' as const,
      basePrice: 8400,
    },
    {
      customerName: 'Global Manufacturing Inc',
      tierId: 'tier_enterprise',
      billingCycle: 'annual' as const,
      basePrice: 52000,
    },
    {
      customerName: 'Digital Marketing Agency',
      tierId: 'tier_professional',
      billingCycle: 'monthly' as const,
      basePrice: 1800,
    },
  ];

  const now = args.nowMs;
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

  demoSubscriptions.forEach((demo, index) => {
    const id = `sub_demo_${now}_${index}`;
    const customerId = `cust_${now}_${index}`;
    const createdAt = thirtyDaysAgo + ((index / demoSubscriptions.length) * (now - thirtyDaysAgo));

    const subscription: CustomerSubscription = {
      id,
      customerId,
      customerName: demo.customerName,
      tierId: demo.tierId,
      status: 'active',
      billingCycle: demo.billingCycle,
      pricing: {
        basePrice: demo.basePrice,
        addOns: [],
        totalMonthly: demo.billingCycle === 'annual' ? demo.basePrice / 12 : demo.basePrice,
        totalAnnual: demo.billingCycle === 'annual' ? demo.basePrice : demo.basePrice * 12,
        currency: 'USD',
      },
      usage: {
        integrations: (index % 5) + 1,
        transactionsThisMonth: 1000 + index * 10000,
        apiCallsThisMonth: 5000 + index * 20000,
        dataTransferGBThisMonth: 1 + index * 10,
        activeConnections: (index % 10) + 1,
        lastUsageUpdate: now - index * 3600000, // staggered within last day
      },
      billing: {
        nextBillingDate: now + (30 * 24 * 60 * 60 * 1000),
        lastBillingDate: now - (30 * 24 * 60 * 60 * 1000),
        paymentMethod: 'credit_card',
        billingContact: {
          name: `Billing Manager ${index + 1}`,
          email: `billing@${demo.customerName.toLowerCase().replace(/\s+/g, '')}.com`,
          company: demo.customerName,
        },
        invoicePreferences: {
          format: 'pdf',
          delivery: 'email',
          terms: 30,
        },
      },
      contract: {
        startDate: createdAt,
        endDate: createdAt + (365 * 24 * 60 * 60 * 1000), // 1 year
        autoRenew: true,
        renewalTerms: 12,
        signedBy: `CEO ${index + 1}`,
        signedAt: createdAt,
      },
      support: {
        accountManager: demo.tierId === 'tier_enterprise' ? `AM_${index + 1}` : undefined,
        supportTier: demo.tierId === 'tier_enterprise' ? 'enterprise'
          : demo.tierId === 'tier_professional' ? 'standard'
          : 'basic',
        incidentsThisMonth: index % 5,
        avgResponseTimeHours: 2 + index * 2, // 2-10 hours
      },
      metadata: {
        createdAt,
        updatedAt: now - index * 3600000,
        salesRep: `sales_rep_${index + 1}`,
        tags: ['demo', demo.tierId.replace('tier_', '')],
      },
    };

    subscriptions.set(id, subscription);
  });

  return { subscriptions, alerts };
}
