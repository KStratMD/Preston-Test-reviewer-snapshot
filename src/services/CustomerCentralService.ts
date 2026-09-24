/**
 * CustomerCentralService - Customer Relationship Management
 *
 * Provides comprehensive customer management including:
 * - Customer CRUD operations
 * - Segmentation and lifecycle tracking
 * - Order history and analytics
 * - Support ticket integration
 * - NPS and satisfaction scoring
 * - Churn prediction indicators
 *
 * @module services/CustomerCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from 'pino';

// ============================================================================
// Interfaces
// ============================================================================

export interface Customer {
  id: string;
  externalId?: string; // NetSuite/BC ID
  name: string;
  email: string;
  phone: string;
  company?: string;
  type: 'individual' | 'business';
  segment: 'enterprise' | 'mid-market' | 'smb' | 'startup';
  status: 'active' | 'inactive' | 'churned' | 'prospect';
  tier: 'platinum' | 'gold' | 'silver' | 'bronze';
  billingAddress: Address;
  shippingAddress?: Address;
  contacts: CustomerContact[];
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  metrics: CustomerMetrics;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastOrderAt: string | null;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface CustomerContact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  isPrimary: boolean;
}

export interface CustomerMetrics {
  lifetimeValue: number;
  totalOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  lastOrderValue: number;
  openTickets: number;
  resolvedTickets: number;
  npsScore: number | null;
  satisfactionScore: number | null;
  healthScore: number; // 0-100
  churnRisk: 'low' | 'medium' | 'high';
  daysSinceLastOrder: number;
  paymentHistory: 'excellent' | 'good' | 'fair' | 'poor';
}

export interface CustomerOrder {
  id: string;
  customerId: string;
  orderNumber: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
  total: number;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  items: OrderItem[];
  createdAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';
  category: string;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  satisfactionRating: number | null;
}

export interface CustomerSegmentStats {
  segment: string;
  count: number;
  percentage: number;
  avgLifetimeValue: number;
  avgOrderValue: number;
  totalRevenue: number;
  growth: string;
}

export interface CustomerDashboard {
  summary: {
    activeCustomers: number;
    ordersThisMonth: number;
    openTickets: number;
    customerSatisfaction: number;
  };
  metrics: {
    avgOrderValue: number;
    ordersPerCustomer: number;
    retentionRate: number;
    npsScore: number;
    avgLifetimeValue: number;
    churnRate: number;
  };
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
  };
  recentActivity: ActivityItem[];
  topSegments: CustomerSegmentStats[];
  atRiskCustomers: Customer[];
  recentCustomers: Customer[];
  lastUpdated: number;
}

export interface ActivityItem {
  type: string;
  count: number;
  period: string;
}

export interface CustomerCreateRequest {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  type: Customer['type'];
  segment: Customer['segment'];
  tier?: Customer['tier'];
  billingAddress: Address;
  shippingAddress?: Address;
  contacts?: CustomerContact[];
  tags?: string[];
  customFields?: Record<string, string | number | boolean>;
}

export interface CustomerUpdateRequest {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  segment?: Customer['segment'];
  status?: Customer['status'];
  tier?: Customer['tier'];
  billingAddress?: Address;
  shippingAddress?: Address;
  tags?: string[];
  customFields?: Record<string, string | number | boolean>;
}

export interface CustomerSearchFilters {
  segment?: Customer['segment'];
  status?: Customer['status'];
  tier?: Customer['tier'];
  churnRisk?: CustomerMetrics['churnRisk'];
  tags?: string[];
  minLifetimeValue?: number;
  maxLifetimeValue?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class CustomerCentralService {
  private customers = new Map<string, Customer>();
  private orders = new Map<string, CustomerOrder>();
  private tickets = new Map<string, SupportTicket>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('CustomerCentralService initialized');
    this.initializeDemoData();
  }

  // ==========================================================================
  // Dashboard & Analytics
  // ==========================================================================

  /**
   * Get comprehensive customer dashboard data
   */
  public async getDashboard(): Promise<CustomerDashboard> {
    this.logger.info('Fetching customer dashboard');

    const customers = Array.from(this.customers.values());
    const orders = Array.from(this.orders.values());
    const tickets = Array.from(this.tickets.values());

    const activeCustomers = customers.filter((c) => c.status === 'active');
    const thisMonth = new Date();
    thisMonth.setDate(1);
    const ordersThisMonth = orders.filter(
      (o) => new Date(o.createdAt) >= thisMonth
    );

    const openTickets = tickets.filter(
      (t) => t.status === 'open' || t.status === 'in_progress'
    );

    // Calculate satisfaction
    const ratedTickets = tickets.filter((t) => t.satisfactionRating !== null);
    const avgSatisfaction = ratedTickets.length > 0
      ? ratedTickets.reduce((sum, t) => sum + (t.satisfactionRating || 0), 0) / ratedTickets.length
      : 4.5;

    // Calculate metrics
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // NPS calculation (simulated from satisfaction scores)
    const npsCustomers = customers.filter((c) => c.metrics.npsScore !== null);
    const promoters = npsCustomers.filter((c) => (c.metrics.npsScore || 0) >= 9).length;
    const detractors = npsCustomers.filter((c) => (c.metrics.npsScore || 0) <= 6).length;
    const npsScore = npsCustomers.length > 0
      ? Math.round(((promoters - detractors) / npsCustomers.length) * 100)
      : 65;

    // Sentiment analysis (based on recent ticket satisfaction)
    const recentRatedTickets = ratedTickets.slice(-50);
    const positive = recentRatedTickets.filter((t) => (t.satisfactionRating || 0) >= 4).length;
    const negative = recentRatedTickets.filter((t) => (t.satisfactionRating || 0) <= 2).length;
    const neutral = recentRatedTickets.length - positive - negative;

    // Segment stats
    const segmentStats = await this.getSegmentStats();

    // At-risk customers
    const atRiskCustomers = customers
      .filter((c) => c.metrics.churnRisk === 'high' && c.status === 'active')
      .slice(0, 5);

    // Recent customers
    const recentCustomers = [...customers]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5);

    // Churn rate
    const churnedLast30Days = customers.filter((c) => {
      if (c.status !== 'churned') return false;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return new Date(c.updatedAt) >= thirtyDaysAgo;
    }).length;
    const churnRate = activeCustomers.length > 0
      ? Math.round((churnedLast30Days / (activeCustomers.length + churnedLast30Days)) * 100 * 10) / 10
      : 0;

    return {
      summary: {
        activeCustomers: activeCustomers.length,
        ordersThisMonth: ordersThisMonth.length,
        openTickets: openTickets.length,
        customerSatisfaction: Math.round(avgSatisfaction * 10) / 10,
      },
      metrics: {
        avgOrderValue: Math.round(avgOrderValue),
        ordersPerCustomer: activeCustomers.length > 0
          ? Math.round((totalOrders / activeCustomers.length) * 10) / 10
          : 0,
        retentionRate: 100 - churnRate,
        npsScore,
        avgLifetimeValue: activeCustomers.length > 0
          ? Math.round(activeCustomers.reduce((sum, c) => sum + c.metrics.lifetimeValue, 0) / activeCustomers.length)
          : 0,
        churnRate,
      },
      sentiment: {
        positive: recentRatedTickets.length > 0 ? Math.round((positive / recentRatedTickets.length) * 100) : 75,
        neutral: recentRatedTickets.length > 0 ? Math.round((neutral / recentRatedTickets.length) * 100) : 15,
        negative: recentRatedTickets.length > 0 ? Math.round((negative / recentRatedTickets.length) * 100) : 10,
      },
      recentActivity: [
        { type: 'new_customer', count: recentCustomers.filter((c) => {
          const today = new Date().toISOString().split('T')[0];
          return c.createdAt.startsWith(today);
        }).length || 45, period: 'today' },
        { type: 'orders_placed', count: ordersThisMonth.length || 280, period: 'this_month' },
        { type: 'tickets_resolved', count: tickets.filter((t) => t.status === 'resolved').length || 15, period: 'today' },
        { type: 'reviews_received', count: ratedTickets.length || 12, period: 'today' },
      ],
      topSegments: segmentStats,
      atRiskCustomers,
      recentCustomers,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get segment statistics
   */
  public async getSegmentStats(): Promise<CustomerSegmentStats[]> {
    const customers = Array.from(this.customers.values());
    const segments: Customer['segment'][] = ['enterprise', 'mid-market', 'smb', 'startup'];

    return segments.map((segment) => {
      const segmentCustomers = customers.filter((c) => c.segment === segment);
      const activeSegment = segmentCustomers.filter((c) => c.status === 'active');
      const totalRevenue = segmentCustomers.reduce((sum, c) => sum + c.metrics.totalSpent, 0);
      const avgLTV = segmentCustomers.length > 0
        ? segmentCustomers.reduce((sum, c) => sum + c.metrics.lifetimeValue, 0) / segmentCustomers.length
        : 0;
      const avgOrderValue = segmentCustomers.length > 0
        ? segmentCustomers.reduce((sum, c) => sum + c.metrics.avgOrderValue, 0) / segmentCustomers.length
        : 0;

      // Simulated growth rates
      const growthRates: Record<string, string> = {
        enterprise: '+12%',
        'mid-market': '+8%',
        smb: '+15%',
        startup: '+22%',
      };

      return {
        segment,
        count: activeSegment.length,
        percentage: customers.length > 0 ? Math.round((segmentCustomers.length / customers.length) * 100) : 0,
        avgLifetimeValue: Math.round(avgLTV),
        avgOrderValue: Math.round(avgOrderValue),
        totalRevenue: Math.round(totalRevenue),
        growth: growthRates[segment] || '+5%',
      };
    });
  }

  // ==========================================================================
  // Customer CRUD Operations
  // ==========================================================================

  /**
   * Get all customers with optional filtering
   */
  public async getCustomers(filters?: CustomerSearchFilters): Promise<{
    customers: Customer[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    let customers = Array.from(this.customers.values());

    // Apply filters
    if (filters?.segment) {
      customers = customers.filter((c) => c.segment === filters.segment);
    }
    if (filters?.status) {
      customers = customers.filter((c) => c.status === filters.status);
    }
    if (filters?.tier) {
      customers = customers.filter((c) => c.tier === filters.tier);
    }
    if (filters?.churnRisk) {
      customers = customers.filter((c) => c.metrics.churnRisk === filters.churnRisk);
    }
    if (filters?.tags && filters.tags.length > 0) {
      customers = customers.filter((c) =>
        filters.tags!.some((tag) => c.tags.includes(tag))
      );
    }
    if (filters?.minLifetimeValue !== undefined) {
      customers = customers.filter((c) => c.metrics.lifetimeValue >= filters.minLifetimeValue!);
    }
    if (filters?.maxLifetimeValue !== undefined) {
      customers = customers.filter((c) => c.metrics.lifetimeValue <= filters.maxLifetimeValue!);
    }
    if (filters?.query) {
      const query = filters.query.toLowerCase();
      customers = customers.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.email.toLowerCase().includes(query) ||
          (c.company && c.company.toLowerCase().includes(query))
      );
    }

    // Sort by last activity
    customers.sort((a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    );

    const total = customers.length;
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;

    return {
      customers: customers.slice(offset, offset + limit),
      total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };
  }

  /**
   * Get customer by ID
   */
  public async getCustomer(id: string): Promise<Customer | null> {
    return this.customers.get(id) || null;
  }

  /**
   * Get customer by email
   */
  public async getCustomerByEmail(email: string): Promise<Customer | null> {
    return Array.from(this.customers.values()).find(
      (c) => c.email.toLowerCase() === email.toLowerCase()
    ) || null;
  }

  /**
   * Create a new customer
   */
  public async createCustomer(request: CustomerCreateRequest): Promise<Customer> {
    const id = `CUST-${Date.now()}`;
    const now = new Date().toISOString();

    const customer: Customer = {
      id,
      name: request.name,
      email: request.email,
      phone: request.phone || '',
      company: request.company,
      type: request.type,
      segment: request.segment,
      status: 'active',
      tier: request.tier || 'bronze',
      billingAddress: request.billingAddress,
      shippingAddress: request.shippingAddress,
      contacts: request.contacts || [],
      tags: request.tags || [],
      customFields: request.customFields || {},
      metrics: {
        lifetimeValue: 0,
        totalOrders: 0,
        totalSpent: 0,
        avgOrderValue: 0,
        lastOrderValue: 0,
        openTickets: 0,
        resolvedTickets: 0,
        npsScore: null,
        satisfactionScore: null,
        healthScore: 100,
        churnRisk: 'low',
        daysSinceLastOrder: 0,
        paymentHistory: 'good',
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      lastOrderAt: null,
    };

    this.customers.set(id, customer);
    this.logger.info({ customerId: id }, 'Created customer');

    return customer;
  }

  /**
   * Update a customer
   */
  public async updateCustomer(id: string, updates: CustomerUpdateRequest): Promise<Customer | null> {
    const customer = this.customers.get(id);
    if (!customer) {
      return null;
    }

    const now = new Date().toISOString();

    if (updates.name !== undefined) customer.name = updates.name;
    if (updates.email !== undefined) customer.email = updates.email;
    if (updates.phone !== undefined) customer.phone = updates.phone;
    if (updates.company !== undefined) customer.company = updates.company;
    if (updates.segment !== undefined) customer.segment = updates.segment;
    if (updates.status !== undefined) customer.status = updates.status;
    if (updates.tier !== undefined) customer.tier = updates.tier;
    if (updates.billingAddress !== undefined) customer.billingAddress = updates.billingAddress;
    if (updates.shippingAddress !== undefined) customer.shippingAddress = updates.shippingAddress;
    if (updates.tags !== undefined) customer.tags = updates.tags;
    if (updates.customFields !== undefined) {
      customer.customFields = { ...customer.customFields, ...updates.customFields };
    }

    customer.updatedAt = now;
    customer.lastActivityAt = now;

    this.customers.set(id, customer);
    this.logger.info({ customerId: id }, 'Updated customer');

    return customer;
  }

  /**
   * Delete a customer (soft delete - set status to inactive)
   */
  public async deleteCustomer(id: string): Promise<boolean> {
    const customer = this.customers.get(id);
    if (!customer) {
      return false;
    }

    customer.status = 'inactive';
    customer.updatedAt = new Date().toISOString();
    this.customers.set(id, customer);

    this.logger.info({ customerId: id }, 'Deleted customer (soft)');
    return true;
  }

  // ==========================================================================
  // Order Management
  // ==========================================================================

  /**
   * Get customer orders
   */
  public async getCustomerOrders(customerId: string, limit?: number): Promise<CustomerOrder[]> {
    let orders = Array.from(this.orders.values())
      .filter((o) => o.customerId === customerId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (limit) {
      orders = orders.slice(0, limit);
    }

    return orders;
  }

  /**
   * Get order by ID
   */
  public async getOrder(orderId: string): Promise<CustomerOrder | null> {
    return this.orders.get(orderId) || null;
  }

  /**
   * Record a new order for a customer
   */
  public async recordOrder(
    customerId: string,
    order: Omit<CustomerOrder, 'id' | 'customerId' | 'createdAt'>
  ): Promise<CustomerOrder | null> {
    const customer = this.customers.get(customerId);
    if (!customer) {
      return null;
    }

    const id = `ORD-${Date.now()}`;
    const now = new Date().toISOString();

    const newOrder: CustomerOrder = {
      id,
      customerId,
      ...order,
      createdAt: now,
    };

    this.orders.set(id, newOrder);

    // Update customer metrics
    customer.metrics.totalOrders++;
    customer.metrics.totalSpent += order.total;
    customer.metrics.lastOrderValue = order.total;
    customer.metrics.avgOrderValue = customer.metrics.totalSpent / customer.metrics.totalOrders;
    customer.metrics.lifetimeValue = customer.metrics.totalSpent * 1.2; // Simple LTV calculation
    customer.metrics.daysSinceLastOrder = 0;
    customer.lastOrderAt = now;
    customer.lastActivityAt = now;
    customer.updatedAt = now;

    // Recalculate health score
    this.recalculateHealthScore(customer);

    this.customers.set(customerId, customer);
    this.logger.info({ customerId, orderId: id }, 'Recorded customer order');

    return newOrder;
  }

  // ==========================================================================
  // Support Ticket Management
  // ==========================================================================

  /**
   * Get customer tickets
   */
  public async getCustomerTickets(customerId: string, limit?: number): Promise<SupportTicket[]> {
    let tickets = Array.from(this.tickets.values())
      .filter((t) => t.customerId === customerId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (limit) {
      tickets = tickets.slice(0, limit);
    }

    return tickets;
  }

  /**
   * Create a support ticket
   */
  public async createTicket(
    customerId: string,
    ticket: {
      subject: string;
      description: string;
      priority: SupportTicket['priority'];
      category: string;
    }
  ): Promise<SupportTicket | null> {
    const customer = this.customers.get(customerId);
    if (!customer) {
      return null;
    }

    const id = `TKT-${Date.now()}`;
    const now = new Date().toISOString();

    const newTicket: SupportTicket = {
      id,
      customerId,
      subject: ticket.subject,
      description: ticket.description,
      priority: ticket.priority,
      status: 'open',
      category: ticket.category,
      assignedTo: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      satisfactionRating: null,
    };

    this.tickets.set(id, newTicket);

    // Update customer metrics
    customer.metrics.openTickets++;
    customer.lastActivityAt = now;
    this.customers.set(customerId, customer);

    this.logger.info({ customerId, ticketId: id }, 'Created support ticket');

    return newTicket;
  }

  /**
   * Resolve a support ticket
   */
  public async resolveTicket(
    ticketId: string,
    resolution: { satisfactionRating?: number }
  ): Promise<SupportTicket | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      return null;
    }

    const now = new Date().toISOString();
    ticket.status = 'resolved';
    ticket.resolvedAt = now;
    ticket.updatedAt = now;
    if (resolution.satisfactionRating !== undefined) {
      ticket.satisfactionRating = resolution.satisfactionRating;
    }

    this.tickets.set(ticketId, ticket);

    // Update customer metrics
    const customer = this.customers.get(ticket.customerId);
    if (customer) {
      customer.metrics.openTickets = Math.max(0, customer.metrics.openTickets - 1);
      customer.metrics.resolvedTickets++;
      customer.lastActivityAt = now;

      // Update satisfaction score
      if (resolution.satisfactionRating !== undefined) {
        const customerTickets = Array.from(this.tickets.values())
          .filter((t) => t.customerId === ticket.customerId && t.satisfactionRating !== null);
        customer.metrics.satisfactionScore = customerTickets.length > 0
          ? customerTickets.reduce((sum, t) => sum + (t.satisfactionRating || 0), 0) / customerTickets.length
          : null;
      }

      this.recalculateHealthScore(customer);
      this.customers.set(customer.id, customer);
    }

    this.logger.info({ ticketId }, 'Resolved support ticket');

    return ticket;
  }

  // ==========================================================================
  // Customer Health & Analytics
  // ==========================================================================

  /**
   * Get customers at risk of churning
   */
  public async getAtRiskCustomers(limit?: number): Promise<Customer[]> {
    let atRisk = Array.from(this.customers.values())
      .filter((c) => c.status === 'active' && c.metrics.churnRisk !== 'low')
      .sort((a, b) => {
        const riskOrder = { high: 0, medium: 1, low: 2 };
        return riskOrder[a.metrics.churnRisk] - riskOrder[b.metrics.churnRisk];
      });

    if (limit) {
      atRisk = atRisk.slice(0, limit);
    }

    return atRisk;
  }

  /**
   * Update customer health score
   */
  public async updateHealthScore(customerId: string): Promise<number | null> {
    const customer = this.customers.get(customerId);
    if (!customer) {
      return null;
    }

    this.recalculateHealthScore(customer);
    this.customers.set(customerId, customer);

    return customer.metrics.healthScore;
  }

  /**
   * Record NPS score for a customer
   */
  public async recordNPSScore(customerId: string, score: number): Promise<Customer | null> {
    const customer = this.customers.get(customerId);
    if (!customer || score < 0 || score > 10) {
      return null;
    }

    customer.metrics.npsScore = score;
    customer.lastActivityAt = new Date().toISOString();
    customer.updatedAt = new Date().toISOString();

    this.recalculateHealthScore(customer);
    this.customers.set(customerId, customer);

    this.logger.info({ customerId, npsScore: score }, 'Recorded NPS score');

    return customer;
  }

  /**
   * Get customer lifetime value breakdown
   */
  public async getLifetimeValueAnalysis(): Promise<{
    totalLTV: number;
    avgLTV: number;
    medianLTV: number;
    ltvBySegment: Record<string, number>;
    ltvByTier: Record<string, number>;
    topCustomers: Customer[];
  }> {
    const customers = Array.from(this.customers.values()).filter((c) => c.status === 'active');
    const ltvValues = customers.map((c) => c.metrics.lifetimeValue).sort((a, b) => a - b);

    const totalLTV = ltvValues.reduce((sum, v) => sum + v, 0);
    const avgLTV = customers.length > 0 ? totalLTV / customers.length : 0;
    const medianLTV = ltvValues.length > 0 ? ltvValues[Math.floor(ltvValues.length / 2)] : 0;

    const ltvBySegment: Record<string, number> = {};
    const segments: Customer['segment'][] = ['enterprise', 'mid-market', 'smb', 'startup'];
    segments.forEach((segment) => {
      const segmentCustomers = customers.filter((c) => c.segment === segment);
      ltvBySegment[segment] = segmentCustomers.length > 0
        ? segmentCustomers.reduce((sum, c) => sum + c.metrics.lifetimeValue, 0) / segmentCustomers.length
        : 0;
    });

    const ltvByTier: Record<string, number> = {};
    const tiers: Customer['tier'][] = ['platinum', 'gold', 'silver', 'bronze'];
    tiers.forEach((tier) => {
      const tierCustomers = customers.filter((c) => c.tier === tier);
      ltvByTier[tier] = tierCustomers.length > 0
        ? tierCustomers.reduce((sum, c) => sum + c.metrics.lifetimeValue, 0) / tierCustomers.length
        : 0;
    });

    const topCustomers = [...customers]
      .sort((a, b) => b.metrics.lifetimeValue - a.metrics.lifetimeValue)
      .slice(0, 10);

    return {
      totalLTV: Math.round(totalLTV),
      avgLTV: Math.round(avgLTV),
      medianLTV: Math.round(medianLTV),
      ltvBySegment: Object.fromEntries(
        Object.entries(ltvBySegment).map(([k, v]) => [k, Math.round(v)])
      ),
      ltvByTier: Object.fromEntries(
        Object.entries(ltvByTier).map(([k, v]) => [k, Math.round(v)])
      ),
      topCustomers,
    };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private recalculateHealthScore(customer: Customer): void {
    let score = 100;

    // Deduct for days since last order
    if (customer.metrics.daysSinceLastOrder > 90) {
      score -= 30;
    } else if (customer.metrics.daysSinceLastOrder > 60) {
      score -= 20;
    } else if (customer.metrics.daysSinceLastOrder > 30) {
      score -= 10;
    }

    // Deduct for open tickets
    if (customer.metrics.openTickets > 3) {
      score -= 20;
    } else if (customer.metrics.openTickets > 1) {
      score -= 10;
    }

    // Deduct for low satisfaction
    if (customer.metrics.satisfactionScore !== null) {
      if (customer.metrics.satisfactionScore < 3) {
        score -= 30;
      } else if (customer.metrics.satisfactionScore < 4) {
        score -= 15;
      }
    }

    // Deduct for poor payment history
    if (customer.metrics.paymentHistory === 'poor') {
      score -= 20;
    } else if (customer.metrics.paymentHistory === 'fair') {
      score -= 10;
    }

    // Add for high LTV
    if (customer.metrics.lifetimeValue > 50000) {
      score = Math.min(100, score + 10);
    }

    customer.metrics.healthScore = Math.max(0, Math.min(100, score));

    // Determine churn risk
    if (score < 40) {
      customer.metrics.churnRisk = 'high';
    } else if (score < 70) {
      customer.metrics.churnRisk = 'medium';
    } else {
      customer.metrics.churnRisk = 'low';
    }
  }

  // ==========================================================================
  // Demo Data Initialization
  // ==========================================================================

  private initializeDemoData(): void {
    const now = new Date();

    // Create demo customers
    const demoCustomers: Omit<Customer, 'id' | 'createdAt' | 'updatedAt' | 'lastActivityAt'>[] = [
      {
        name: 'Acme Corporation',
        email: 'contact@acme.com',
        phone: '555-0100',
        company: 'Acme Corporation',
        type: 'business',
        segment: 'enterprise',
        status: 'active',
        tier: 'platinum',
        billingAddress: { line1: '100 Corporate Plaza', city: 'New York', state: 'NY', zipCode: '10001', country: 'USA' },
        contacts: [{ id: 'CON-1', name: 'John Smith', email: 'john@acme.com', phone: '555-0101', role: 'CTO', isPrimary: true }],
        tags: ['enterprise', 'priority'],
        customFields: { industry: 'Technology' },
        metrics: {
          lifetimeValue: 250000,
          totalOrders: 45,
          totalSpent: 180000,
          avgOrderValue: 4000,
          lastOrderValue: 5500,
          openTickets: 1,
          resolvedTickets: 23,
          npsScore: 9,
          satisfactionScore: 4.8,
          healthScore: 95,
          churnRisk: 'low',
          daysSinceLastOrder: 12,
          paymentHistory: 'excellent',
        },
        lastOrderAt: new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: 'TechStart Inc',
        email: 'hello@techstart.io',
        phone: '555-0200',
        company: 'TechStart Inc',
        type: 'business',
        segment: 'startup',
        status: 'active',
        tier: 'silver',
        billingAddress: { line1: '50 Innovation Way', city: 'San Francisco', state: 'CA', zipCode: '94102', country: 'USA' },
        contacts: [{ id: 'CON-2', name: 'Sarah Lee', email: 'sarah@techstart.io', role: 'Founder', isPrimary: true }],
        tags: ['startup', 'tech'],
        customFields: { industry: 'SaaS' },
        metrics: {
          lifetimeValue: 15000,
          totalOrders: 8,
          totalSpent: 12000,
          avgOrderValue: 1500,
          lastOrderValue: 2000,
          openTickets: 0,
          resolvedTickets: 5,
          npsScore: 8,
          satisfactionScore: 4.5,
          healthScore: 88,
          churnRisk: 'low',
          daysSinceLastOrder: 25,
          paymentHistory: 'good',
        },
        lastOrderAt: new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: 'Global Retail Co',
        email: 'purchasing@globalretail.com',
        phone: '555-0300',
        company: 'Global Retail Co',
        type: 'business',
        segment: 'mid-market',
        status: 'active',
        tier: 'gold',
        billingAddress: { line1: '200 Commerce St', city: 'Chicago', state: 'IL', zipCode: '60601', country: 'USA' },
        contacts: [{ id: 'CON-3', name: 'Mike Johnson', email: 'mike@globalretail.com', role: 'Procurement Manager', isPrimary: true }],
        tags: ['retail', 'mid-market'],
        customFields: { industry: 'Retail' },
        metrics: {
          lifetimeValue: 85000,
          totalOrders: 28,
          totalSpent: 72000,
          avgOrderValue: 2571,
          lastOrderValue: 3200,
          openTickets: 2,
          resolvedTickets: 15,
          npsScore: 7,
          satisfactionScore: 4.0,
          healthScore: 72,
          churnRisk: 'medium',
          daysSinceLastOrder: 45,
          paymentHistory: 'good',
        },
        lastOrderAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: 'SmallBiz Solutions',
        email: 'owner@smallbizsolutions.com',
        phone: '555-0400',
        company: 'SmallBiz Solutions',
        type: 'business',
        segment: 'smb',
        status: 'active',
        tier: 'bronze',
        billingAddress: { line1: '75 Main Street', city: 'Austin', state: 'TX', zipCode: '78701', country: 'USA' },
        contacts: [{ id: 'CON-4', name: 'Lisa Brown', email: 'lisa@smallbizsolutions.com', role: 'Owner', isPrimary: true }],
        tags: ['smb'],
        customFields: { industry: 'Consulting' },
        metrics: {
          lifetimeValue: 8000,
          totalOrders: 12,
          totalSpent: 6500,
          avgOrderValue: 542,
          lastOrderValue: 450,
          openTickets: 3,
          resolvedTickets: 8,
          npsScore: 5,
          satisfactionScore: 3.2,
          healthScore: 45,
          churnRisk: 'high',
          daysSinceLastOrder: 75,
          paymentHistory: 'fair',
        },
        lastOrderAt: new Date(now.getTime() - 75 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        name: 'Jane Doe',
        email: 'jane.doe@email.com',
        phone: '555-0500',
        type: 'individual',
        segment: 'smb',
        status: 'active',
        tier: 'silver',
        billingAddress: { line1: '123 Oak Lane', city: 'Portland', state: 'OR', zipCode: '97201', country: 'USA' },
        contacts: [],
        tags: ['individual', 'loyal'],
        customFields: {},
        metrics: {
          lifetimeValue: 5500,
          totalOrders: 22,
          totalSpent: 4800,
          avgOrderValue: 218,
          lastOrderValue: 250,
          openTickets: 0,
          resolvedTickets: 3,
          npsScore: 10,
          satisfactionScore: 5.0,
          healthScore: 98,
          churnRisk: 'low',
          daysSinceLastOrder: 8,
          paymentHistory: 'excellent',
        },
        lastOrderAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];

    demoCustomers.forEach((cust, index) => {
      const id = `CUST-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (365 - index * 30) * 24 * 60 * 60 * 1000).toISOString();
      this.customers.set(id, {
        id,
        ...cust,
        createdAt,
        updatedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
        lastActivityAt: new Date(now.getTime() - index * 12 * 60 * 60 * 1000).toISOString(),
      } as Customer);
    });

    // Create demo orders
    const demoOrders: CustomerOrder[] = [
      {
        id: 'ORD-1001',
        customerId: 'CUST-1000',
        orderNumber: 'SO-2026-1001',
        status: 'delivered',
        total: 5500,
        subtotal: 5000,
        tax: 400,
        shipping: 100,
        discount: 0,
        items: [{ sku: 'PROD-001', name: 'Enterprise License', quantity: 1, unitPrice: 5000, total: 5000 }],
        createdAt: new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString(),
        shippedAt: new Date(now.getTime() - 11 * 24 * 60 * 60 * 1000).toISOString(),
        deliveredAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'ORD-1002',
        customerId: 'CUST-1001',
        orderNumber: 'SO-2026-1002',
        status: 'delivered',
        total: 2000,
        subtotal: 1800,
        tax: 150,
        shipping: 50,
        discount: 0,
        items: [{ sku: 'PROD-002', name: 'Startup Package', quantity: 1, unitPrice: 1800, total: 1800 }],
        createdAt: new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString(),
        shippedAt: new Date(now.getTime() - 24 * 24 * 60 * 60 * 1000).toISOString(),
        deliveredAt: new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    demoOrders.forEach((order) => this.orders.set(order.id, order));

    // Create demo tickets
    const demoTickets: SupportTicket[] = [
      {
        id: 'TKT-1001',
        customerId: 'CUST-1000',
        subject: 'Integration question',
        description: 'Need help with API integration',
        priority: 'medium',
        status: 'open',
        category: 'Technical Support',
        assignedTo: 'agent-1',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        resolvedAt: null,
        satisfactionRating: null,
      },
      {
        id: 'TKT-1002',
        customerId: 'CUST-1003',
        subject: 'Billing inquiry',
        description: 'Question about last invoice',
        priority: 'low',
        status: 'resolved',
        category: 'Billing',
        assignedTo: 'agent-2',
        createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        resolvedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        satisfactionRating: 4,
      },
    ];
    demoTickets.forEach((ticket) => this.tickets.set(ticket.id, ticket));

    this.logger.info(
      {
        customers: this.customers.size,
        orders: this.orders.size,
        tickets: this.tickets.size,
      },
      'CustomerCentralService demo data initialized'
    );
  }
}
