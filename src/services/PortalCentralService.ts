/**
 * PortalCentralService - Customer Portal Management
 *
 * Provides comprehensive portal management including:
 * - Portal user management
 * - Self-service capabilities
 * - Knowledge base / FAQ
 * - Ticket submission and tracking
 * - Account management
 * - Notifications and alerts
 * - Portal analytics
 *
 * @module services/PortalCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from 'pino';

// ============================================================================
// Interfaces
// ============================================================================

export interface PortalUser {
  id: string;
  customerId: string;
  customerName: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin' | 'user' | 'viewer';
  status: 'active' | 'inactive' | 'pending' | 'locked';
  permissions: string[];
  lastLogin: string | null;
  loginCount: number;
  mfaEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortalSession {
  id: string;
  userId: string;
  userEmail: string;
  ipAddress: string;
  userAgent: string;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  isActive: boolean;
}

export interface KnowledgeArticle {
  id: string;
  title: string;
  slug: string;
  category: string;
  content: string;
  summary: string;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
  isPopular: boolean;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortalTicket {
  id: string;
  userId: string;
  userName: string;
  customerId: string;
  customerName: string;
  subject: string;
  description: string;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
  assigneeId: string | null;
  assigneeName: string | null;
  responses: TicketResponse[];
  attachments: TicketAttachment[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  satisfactionRating: number | null;
}

export interface TicketResponse {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorType: 'customer' | 'agent' | 'system';
  content: string;
  isInternal: boolean;
  createdAt: string;
}

export interface TicketAttachment {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface PortalNotification {
  id: string;
  userId: string;
  type: 'info' | 'warning' | 'success' | 'error';
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface PortalAnnouncement {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'maintenance' | 'feature' | 'important';
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  targetAudience: 'all' | 'admin' | 'specific';
  targetCustomerIds: string[];
  createdBy: string;
  createdAt: string;
}

export interface PortalMetrics {
  totalUsers: number;
  activeUsers: number;
  pendingUsers: number;
  lockedUsers: number;
  totalSessions: number;
  activeSessions: number;
  avgSessionDuration: number;
  totalTickets: number;
  openTickets: number;
  resolvedTickets: number;
  avgResolutionTime: number;
  ticketSatisfactionScore: number;
  totalArticles: number;
  publishedArticles: number;
  totalFAQs: number;
  articleViewsToday: number;
}

export interface PortalDashboard {
  summary: {
    activeUsers: number;
    openTickets: number;
    pendingActions: number;
    satisfactionScore: number;
  };
  metrics: PortalMetrics;
  recentTickets: PortalTicket[];
  popularArticles: KnowledgeArticle[];
  activeAnnouncements: PortalAnnouncement[];
  recentActivity: PortalActivityLog[];
  lastUpdated: number;
}

export interface PortalActivityLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  resource: string;
  resourceId: string;
  details: string | null;
  ipAddress: string;
  timestamp: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class PortalCentralService {
  private users = new Map<string, PortalUser>();
  private sessions = new Map<string, PortalSession>();
  private articles = new Map<string, KnowledgeArticle>();
  private faqs = new Map<string, FAQ>();
  private tickets = new Map<string, PortalTicket>();
  private notifications = new Map<string, PortalNotification>();
  private announcements = new Map<string, PortalAnnouncement>();
  private activityLogs = new Map<string, PortalActivityLog>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('PortalCentralService initialized');
    this.initializeDemoData();
  }

  // ==========================================================================
  // Dashboard & Metrics
  // ==========================================================================

  /**
   * Get comprehensive portal dashboard data
   */
  public async getDashboard(): Promise<PortalDashboard> {
    this.logger.info('Fetching portal central dashboard');

    const metrics = await this.getMetrics();
    const recentTickets = await this.getTickets({ status: 'open', limit: 5 });
    const popularArticles = await this.getPopularArticles(5);
    const activeAnnouncements = await this.getActiveAnnouncements();
    const recentActivity = await this.getRecentActivity(10);

    return {
      summary: {
        activeUsers: metrics.activeUsers,
        openTickets: metrics.openTickets,
        pendingActions: await this.getPendingActionsCount(),
        satisfactionScore: metrics.ticketSatisfactionScore,
      },
      metrics,
      recentTickets: recentTickets.tickets,
      popularArticles,
      activeAnnouncements,
      recentActivity,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get portal metrics
   */
  public async getMetrics(): Promise<PortalMetrics> {
    const users = Array.from(this.users.values());
    const sessions = Array.from(this.sessions.values());
    const tickets = Array.from(this.tickets.values());
    const articles = Array.from(this.articles.values());
    const faqs = Array.from(this.faqs.values());

    const activeUsers = users.filter((u) => u.status === 'active').length;
    const pendingUsers = users.filter((u) => u.status === 'pending').length;
    const lockedUsers = users.filter((u) => u.status === 'locked').length;

    const activeSessions = sessions.filter((s) => s.isActive).length;
    const avgSessionDuration = this.calculateAvgSessionDuration(sessions);

    const openTickets = tickets.filter((t) => ['open', 'in_progress', 'waiting_customer'].includes(t.status)).length;
    const resolvedTickets = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed').length;
    const avgResolutionTime = this.calculateAvgResolutionTime(tickets);
    const ticketSatisfactionScore = this.calculateSatisfactionScore(tickets);

    const publishedArticles = articles.filter((a) => a.status === 'published').length;
    const articleViewsToday = articles.reduce((sum, a) => sum + Math.floor(a.viewCount * 0.1), 0); // Demo

    return {
      totalUsers: users.length,
      activeUsers,
      pendingUsers,
      lockedUsers,
      totalSessions: sessions.length,
      activeSessions,
      avgSessionDuration,
      totalTickets: tickets.length,
      openTickets,
      resolvedTickets,
      avgResolutionTime,
      ticketSatisfactionScore,
      totalArticles: articles.length,
      publishedArticles,
      totalFAQs: faqs.length,
      articleViewsToday,
    };
  }

  // ==========================================================================
  // Portal User Management
  // ==========================================================================

  /**
   * Get portal users with optional filtering
   */
  public async getUsers(filters?: {
    customerId?: string;
    status?: PortalUser['status'];
    role?: PortalUser['role'];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ users: PortalUser[]; total: number }> {
    let users = Array.from(this.users.values());

    if (filters?.customerId) {
      users = users.filter((u) => u.customerId === filters.customerId);
    }
    if (filters?.status) {
      users = users.filter((u) => u.status === filters.status);
    }
    if (filters?.role) {
      users = users.filter((u) => u.role === filters.role);
    }
    if (filters?.search) {
      const search = filters.search.toLowerCase();
      users = users.filter(
        (u) =>
          u.email.toLowerCase().includes(search) ||
          u.firstName.toLowerCase().includes(search) ||
          u.lastName.toLowerCase().includes(search) ||
          u.customerName.toLowerCase().includes(search)
      );
    }

    users.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = users.length;
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;

    return {
      users: users.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get user by ID
   */
  public async getUser(id: string): Promise<PortalUser | null> {
    return this.users.get(id) || null;
  }

  /**
   * Create a portal user
   */
  public async createUser(data: {
    customerId: string;
    customerName: string;
    email: string;
    firstName: string;
    lastName: string;
    role?: PortalUser['role'];
    permissions?: string[];
  }): Promise<PortalUser> {
    const id = `PU-${Date.now()}`;
    const now = new Date().toISOString();

    const user: PortalUser = {
      id,
      customerId: data.customerId,
      customerName: data.customerName,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role || 'user',
      status: 'pending',
      permissions: data.permissions || ['view_account', 'create_tickets', 'view_kb'],
      lastLogin: null,
      loginCount: 0,
      mfaEnabled: false,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(id, user);
    this.logActivity(id, `${data.firstName} ${data.lastName}`, 'Created', 'user', id);

    this.logger.info({ userId: id }, 'Created portal user');

    return user;
  }

  /**
   * Update a portal user
   */
  public async updateUser(id: string, updates: Partial<Pick<PortalUser, 'firstName' | 'lastName' | 'role' | 'status' | 'permissions' | 'mfaEnabled'>>): Promise<PortalUser | null> {
    const user = this.users.get(id);
    if (!user) {
      return null;
    }

    if (updates.firstName !== undefined) user.firstName = updates.firstName;
    if (updates.lastName !== undefined) user.lastName = updates.lastName;
    if (updates.role !== undefined) user.role = updates.role;
    if (updates.status !== undefined) user.status = updates.status;
    if (updates.permissions !== undefined) user.permissions = updates.permissions;
    if (updates.mfaEnabled !== undefined) user.mfaEnabled = updates.mfaEnabled;

    user.updatedAt = new Date().toISOString();

    this.users.set(id, user);
    this.logger.info({ userId: id }, 'Updated portal user');

    return user;
  }

  /**
   * Activate a pending user
   */
  public async activateUser(id: string): Promise<PortalUser | null> {
    return this.updateUser(id, { status: 'active' });
  }

  /**
   * Lock a user account
   */
  public async lockUser(id: string): Promise<PortalUser | null> {
    return this.updateUser(id, { status: 'locked' });
  }

  /**
   * Unlock a user account
   */
  public async unlockUser(id: string): Promise<PortalUser | null> {
    return this.updateUser(id, { status: 'active' });
  }

  // ==========================================================================
  // Knowledge Base
  // ==========================================================================

  /**
   * Get articles with optional filtering
   */
  public async getArticles(filters?: {
    category?: string;
    status?: KnowledgeArticle['status'];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ articles: KnowledgeArticle[]; total: number }> {
    let articles = Array.from(this.articles.values());

    if (filters?.category) {
      articles = articles.filter((a) => a.category === filters.category);
    }
    if (filters?.status) {
      articles = articles.filter((a) => a.status === filters.status);
    }
    if (filters?.search) {
      const search = filters.search.toLowerCase();
      articles = articles.filter(
        (a) =>
          a.title.toLowerCase().includes(search) ||
          a.content.toLowerCase().includes(search) ||
          a.tags.some((t) => t.toLowerCase().includes(search))
      );
    }

    articles.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const total = articles.length;
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;

    return {
      articles: articles.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get article by ID
   */
  public async getArticle(id: string): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(id);
    if (article) {
      // Increment view count
      article.viewCount++;
      this.articles.set(id, article);
    }
    return article || null;
  }

  /**
   * Get article by slug
   */
  public async getArticleBySlug(slug: string): Promise<KnowledgeArticle | null> {
    const article = Array.from(this.articles.values()).find((a) => a.slug === slug);
    if (article) {
      article.viewCount++;
      this.articles.set(article.id, article);
    }
    return article || null;
  }

  /**
   * Get popular articles
   */
  public async getPopularArticles(limit = 5): Promise<KnowledgeArticle[]> {
    return Array.from(this.articles.values())
      .filter((a) => a.status === 'published')
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, limit);
  }

  /**
   * Create an article
   */
  public async createArticle(data: {
    title: string;
    category: string;
    content: string;
    summary: string;
    tags?: string[];
    authorId: string;
    authorName: string;
  }): Promise<KnowledgeArticle> {
    const id = `KB-${Date.now()}`;
    const now = new Date().toISOString();
    const slug = this.generateSlug(data.title);

    const article: KnowledgeArticle = {
      id,
      title: data.title,
      slug,
      category: data.category,
      content: data.content,
      summary: data.summary,
      tags: data.tags || [],
      status: 'draft',
      viewCount: 0,
      helpfulCount: 0,
      notHelpfulCount: 0,
      authorId: data.authorId,
      authorName: data.authorName,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };

    this.articles.set(id, article);
    this.logger.info({ articleId: id }, 'Created knowledge article');

    return article;
  }

  /**
   * Update an article
   */
  public async updateArticle(id: string, updates: Partial<Pick<KnowledgeArticle, 'title' | 'category' | 'content' | 'summary' | 'tags'>>): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(id);
    if (!article) {
      return null;
    }

    if (updates.title !== undefined) {
      article.title = updates.title;
      article.slug = this.generateSlug(updates.title);
    }
    if (updates.category !== undefined) article.category = updates.category;
    if (updates.content !== undefined) article.content = updates.content;
    if (updates.summary !== undefined) article.summary = updates.summary;
    if (updates.tags !== undefined) article.tags = updates.tags;

    article.updatedAt = new Date().toISOString();

    this.articles.set(id, article);

    return article;
  }

  /**
   * Publish an article
   */
  public async publishArticle(id: string): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(id);
    if (!article || article.status === 'published') {
      return null;
    }

    article.status = 'published';
    article.publishedAt = new Date().toISOString();
    article.updatedAt = article.publishedAt;

    this.articles.set(id, article);

    return article;
  }

  /**
   * Archive an article
   */
  public async archiveArticle(id: string): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(id);
    if (!article) {
      return null;
    }

    article.status = 'archived';
    article.updatedAt = new Date().toISOString();

    this.articles.set(id, article);

    return article;
  }

  /**
   * Rate an article as helpful or not
   */
  public async rateArticle(id: string, helpful: boolean): Promise<KnowledgeArticle | null> {
    const article = this.articles.get(id);
    if (!article) {
      return null;
    }

    if (helpful) {
      article.helpfulCount++;
    } else {
      article.notHelpfulCount++;
    }

    this.articles.set(id, article);

    return article;
  }

  // ==========================================================================
  // FAQ Management
  // ==========================================================================

  /**
   * Get FAQs
   */
  public async getFAQs(category?: string): Promise<FAQ[]> {
    let faqs = Array.from(this.faqs.values());

    if (category) {
      faqs = faqs.filter((f) => f.category === category);
    }

    return faqs.sort((a, b) => a.order - b.order);
  }

  /**
   * Get FAQ categories
   */
  public async getFAQCategories(): Promise<string[]> {
    const categories = new Set(Array.from(this.faqs.values()).map((f) => f.category));
    return Array.from(categories);
  }

  /**
   * Create an FAQ
   */
  public async createFAQ(data: {
    question: string;
    answer: string;
    category: string;
    order?: number;
    isPopular?: boolean;
  }): Promise<FAQ> {
    const id = `FAQ-${Date.now()}`;
    const now = new Date().toISOString();

    const faq: FAQ = {
      id,
      question: data.question,
      answer: data.answer,
      category: data.category,
      order: data.order || 0,
      isPopular: data.isPopular || false,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.faqs.set(id, faq);

    return faq;
  }

  // ==========================================================================
  // Ticket Management
  // ==========================================================================

  /**
   * Get tickets with optional filtering
   */
  public async getTickets(filters?: {
    userId?: string;
    customerId?: string;
    status?: PortalTicket['status'];
    priority?: PortalTicket['priority'];
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tickets: PortalTicket[]; total: number }> {
    let tickets = Array.from(this.tickets.values());

    if (filters?.userId) {
      tickets = tickets.filter((t) => t.userId === filters.userId);
    }
    if (filters?.customerId) {
      tickets = tickets.filter((t) => t.customerId === filters.customerId);
    }
    if (filters?.status) {
      tickets = tickets.filter((t) => t.status === filters.status);
    }
    if (filters?.priority) {
      tickets = tickets.filter((t) => t.priority === filters.priority);
    }
    if (filters?.category) {
      tickets = tickets.filter((t) => t.category === filters.category);
    }

    // Sort by priority then date
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    tickets.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const total = tickets.length;
    const offset = filters?.offset || 0;
    const limit = filters?.limit || 50;

    return {
      tickets: tickets.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get ticket by ID
   */
  public async getTicket(id: string): Promise<PortalTicket | null> {
    return this.tickets.get(id) || null;
  }

  /**
   * Create a ticket
   */
  public async createTicket(data: {
    userId: string;
    userName: string;
    customerId: string;
    customerName: string;
    subject: string;
    description: string;
    category: string;
    priority?: PortalTicket['priority'];
  }): Promise<PortalTicket> {
    const id = `TKT-${Date.now()}`;
    const now = new Date().toISOString();

    const ticket: PortalTicket = {
      id,
      userId: data.userId,
      userName: data.userName,
      customerId: data.customerId,
      customerName: data.customerName,
      subject: data.subject,
      description: data.description,
      category: data.category,
      priority: data.priority || 'medium',
      status: 'open',
      assigneeId: null,
      assigneeName: null,
      responses: [],
      attachments: [],
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      closedAt: null,
      satisfactionRating: null,
    };

    this.tickets.set(id, ticket);
    this.logActivity(data.userId, data.userName, 'Created Ticket', 'ticket', id);

    this.logger.info({ ticketId: id }, 'Created portal ticket');

    return ticket;
  }

  /**
   * Update ticket status
   */
  public async updateTicketStatus(id: string, status: PortalTicket['status']): Promise<PortalTicket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) {
      return null;
    }

    const now = new Date().toISOString();
    ticket.status = status;
    ticket.updatedAt = now;

    if (status === 'resolved') {
      ticket.resolvedAt = now;
    } else if (status === 'closed') {
      ticket.closedAt = now;
    }

    this.tickets.set(id, ticket);

    return ticket;
  }

  /**
   * Assign ticket to agent
   */
  public async assignTicket(id: string, assigneeId: string, assigneeName: string): Promise<PortalTicket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket) {
      return null;
    }

    ticket.assigneeId = assigneeId;
    ticket.assigneeName = assigneeName;
    ticket.status = 'in_progress';
    ticket.updatedAt = new Date().toISOString();

    this.tickets.set(id, ticket);

    return ticket;
  }

  /**
   * Add response to ticket
   */
  public async addTicketResponse(
    ticketId: string,
    response: {
      authorId: string;
      authorName: string;
      authorType: TicketResponse['authorType'];
      content: string;
      isInternal?: boolean;
    }
  ): Promise<PortalTicket | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      return null;
    }

    const responseId = `RSP-${Date.now()}`;
    const now = new Date().toISOString();

    ticket.responses.push({
      id: responseId,
      ticketId,
      authorId: response.authorId,
      authorName: response.authorName,
      authorType: response.authorType,
      content: response.content,
      isInternal: response.isInternal || false,
      createdAt: now,
    });

    ticket.updatedAt = now;

    // Update status based on who responded
    if (response.authorType === 'agent' && ticket.status === 'open') {
      ticket.status = 'in_progress';
    } else if (response.authorType === 'customer' && ticket.status === 'waiting_customer') {
      ticket.status = 'in_progress';
    }

    this.tickets.set(ticketId, ticket);

    return ticket;
  }

  /**
   * Rate ticket satisfaction
   */
  public async rateTicket(id: string, rating: number): Promise<PortalTicket | null> {
    const ticket = this.tickets.get(id);
    if (!ticket || rating < 1 || rating > 5) {
      return null;
    }

    ticket.satisfactionRating = rating;
    ticket.updatedAt = new Date().toISOString();

    this.tickets.set(id, ticket);

    return ticket;
  }

  // ==========================================================================
  // Notifications & Announcements
  // ==========================================================================

  /**
   * Get user notifications
   */
  public async getNotifications(userId: string, unreadOnly = false): Promise<PortalNotification[]> {
    let notifications = Array.from(this.notifications.values())
      .filter((n) => n.userId === userId);

    if (unreadOnly) {
      notifications = notifications.filter((n) => !n.isRead);
    }

    return notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Create notification
   */
  public async createNotification(data: {
    userId: string;
    type: PortalNotification['type'];
    title: string;
    message: string;
    link?: string;
    expiresAt?: string;
  }): Promise<PortalNotification> {
    const id = `NOTIF-${Date.now()}`;
    const now = new Date().toISOString();

    const notification: PortalNotification = {
      id,
      userId: data.userId,
      type: data.type,
      title: data.title,
      message: data.message,
      link: data.link || null,
      isRead: false,
      createdAt: now,
      expiresAt: data.expiresAt || null,
    };

    this.notifications.set(id, notification);

    return notification;
  }

  /**
   * Mark notification as read
   */
  public async markNotificationRead(id: string): Promise<PortalNotification | null> {
    const notification = this.notifications.get(id);
    if (!notification) {
      return null;
    }

    notification.isRead = true;
    this.notifications.set(id, notification);

    return notification;
  }

  /**
   * Mark all notifications as read
   */
  public async markAllNotificationsRead(userId: string): Promise<number> {
    let count = 0;
    this.notifications.forEach((notification, id) => {
      if (notification.userId === userId && !notification.isRead) {
        notification.isRead = true;
        this.notifications.set(id, notification);
        count++;
      }
    });
    return count;
  }

  /**
   * Get active announcements
   */
  public async getActiveAnnouncements(): Promise<PortalAnnouncement[]> {
    const now = new Date();
    return Array.from(this.announcements.values())
      .filter((a) => {
        const startDate = new Date(a.startDate);
        const endDate = a.endDate ? new Date(a.endDate) : null;
        return a.isActive && startDate <= now && (!endDate || endDate >= now);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Create announcement
   */
  public async createAnnouncement(data: {
    title: string;
    content: string;
    type: PortalAnnouncement['type'];
    startDate: string;
    endDate?: string;
    targetAudience?: PortalAnnouncement['targetAudience'];
    targetCustomerIds?: string[];
    createdBy: string;
  }): Promise<PortalAnnouncement> {
    const id = `ANN-${Date.now()}`;
    const now = new Date().toISOString();

    const announcement: PortalAnnouncement = {
      id,
      title: data.title,
      content: data.content,
      type: data.type,
      startDate: data.startDate,
      endDate: data.endDate || null,
      isActive: true,
      targetAudience: data.targetAudience || 'all',
      targetCustomerIds: data.targetCustomerIds || [],
      createdBy: data.createdBy,
      createdAt: now,
    };

    this.announcements.set(id, announcement);

    return announcement;
  }

  // ==========================================================================
  // Activity & Analytics
  // ==========================================================================

  /**
   * Get recent activity
   */
  public async getRecentActivity(limit = 10): Promise<PortalActivityLog[]> {
    return Array.from(this.activityLogs.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private async getPendingActionsCount(): Promise<number> {
    const pendingUsers = Array.from(this.users.values()).filter((u) => u.status === 'pending').length;
    const openTickets = Array.from(this.tickets.values()).filter((t) => t.status === 'open').length;
    return pendingUsers + openTickets;
  }

  private calculateAvgSessionDuration(sessions: PortalSession[]): number {
    const completedSessions = sessions.filter((s) => !s.isActive);
    if (completedSessions.length === 0) return 0;

    const totalMinutes = completedSessions.reduce((sum, s) => {
      const start = new Date(s.startedAt).getTime();
      const end = new Date(s.lastActivityAt).getTime();
      return sum + (end - start) / (1000 * 60);
    }, 0);

    return Math.round((totalMinutes / completedSessions.length) * 10) / 10;
  }

  private calculateAvgResolutionTime(tickets: PortalTicket[]): number {
    const resolvedTickets = tickets.filter((t) => t.resolvedAt);
    if (resolvedTickets.length === 0) return 0;

    const totalHours = resolvedTickets.reduce((sum, t) => {
      const created = new Date(t.createdAt).getTime();
      const resolved = new Date(t.resolvedAt!).getTime();
      return sum + (resolved - created) / (1000 * 60 * 60);
    }, 0);

    return Math.round((totalHours / resolvedTickets.length) * 10) / 10;
  }

  private calculateSatisfactionScore(tickets: PortalTicket[]): number {
    const ratedTickets = tickets.filter((t) => t.satisfactionRating !== null);
    if (ratedTickets.length === 0) return 0;

    const totalScore = ratedTickets.reduce((sum, t) => sum + (t.satisfactionRating || 0), 0);
    return Math.round((totalScore / ratedTickets.length) * 10) / 10;
  }

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private logActivity(
    userId: string,
    userName: string,
    action: string,
    resource: string,
    resourceId: string,
    details?: string
  ): void {
    const id = `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 4)}`;
    this.activityLogs.set(id, {
      id,
      userId,
      userName,
      action,
      resource,
      resourceId,
      details: details || null,
      ipAddress: '127.0.0.1',
      timestamp: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // Demo Data Initialization
  // ==========================================================================

  private initializeDemoData(): void {
    const now = new Date();

    // Demo Users
    const demoUsers: Omit<PortalUser, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        customerId: 'CUST-001',
        customerName: 'Acme Corp',
        email: 'john.smith@acme.com',
        firstName: 'John',
        lastName: 'Smith',
        role: 'admin',
        status: 'active',
        permissions: ['view_account', 'create_tickets', 'view_kb', 'manage_users'],
        lastLogin: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        loginCount: 42,
        mfaEnabled: true,
      },
      {
        customerId: 'CUST-001',
        customerName: 'Acme Corp',
        email: 'jane.doe@acme.com',
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'user',
        status: 'active',
        permissions: ['view_account', 'create_tickets', 'view_kb'],
        lastLogin: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        loginCount: 15,
        mfaEnabled: false,
      },
      {
        customerId: 'CUST-002',
        customerName: 'Tech Solutions',
        email: 'mike@techsolutions.com',
        firstName: 'Mike',
        lastName: 'Johnson',
        role: 'admin',
        status: 'active',
        permissions: ['view_account', 'create_tickets', 'view_kb', 'manage_users'],
        lastLogin: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        loginCount: 28,
        mfaEnabled: true,
      },
      {
        customerId: 'CUST-003',
        customerName: 'Global Industries',
        email: 'sarah@global.com',
        firstName: 'Sarah',
        lastName: 'Wilson',
        role: 'user',
        status: 'pending',
        permissions: ['view_account', 'create_tickets', 'view_kb'],
        lastLogin: null,
        loginCount: 0,
        mfaEnabled: false,
      },
    ];

    demoUsers.forEach((user, index) => {
      const id = `PU-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (90 - index * 15) * 24 * 60 * 60 * 1000).toISOString();
      this.users.set(id, { id, ...user, createdAt, updatedAt: createdAt } as PortalUser);
    });

    // Demo Articles
    const demoArticles: Omit<KnowledgeArticle, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        title: 'Getting Started with the Portal',
        slug: 'getting-started-with-the-portal',
        category: 'Getting Started',
        content: 'Welcome to our customer portal! This guide will help you get started...',
        summary: 'Learn the basics of using our customer portal.',
        tags: ['onboarding', 'basics', 'tutorial'],
        status: 'published',
        viewCount: 1250,
        helpfulCount: 45,
        notHelpfulCount: 3,
        authorId: 'STAFF-001',
        authorName: 'Support Team',
        publishedAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        title: 'How to Submit a Support Ticket',
        slug: 'how-to-submit-a-support-ticket',
        category: 'Support',
        content: 'Follow these steps to submit a support ticket...',
        summary: 'Step-by-step guide to creating support tickets.',
        tags: ['support', 'tickets', 'help'],
        status: 'published',
        viewCount: 890,
        helpfulCount: 32,
        notHelpfulCount: 2,
        authorId: 'STAFF-001',
        authorName: 'Support Team',
        publishedAt: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        title: 'Account Settings and Security',
        slug: 'account-settings-and-security',
        category: 'Account',
        content: 'Manage your account settings and security options...',
        summary: 'Configure your account settings and enable MFA.',
        tags: ['account', 'security', 'mfa', 'settings'],
        status: 'published',
        viewCount: 675,
        helpfulCount: 28,
        notHelpfulCount: 1,
        authorId: 'STAFF-002',
        authorName: 'Security Team',
        publishedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];

    demoArticles.forEach((article, index) => {
      const id = `KB-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (70 - index * 15) * 24 * 60 * 60 * 1000).toISOString();
      this.articles.set(id, { id, ...article, createdAt, updatedAt: createdAt } as KnowledgeArticle);
    });

    // Demo FAQs
    const demoFAQs: Omit<FAQ, 'id' | 'createdAt' | 'updatedAt'>[] = [
      { question: 'How do I reset my password?', answer: 'Click the "Forgot Password" link on the login page...', category: 'Account', order: 1, isPopular: true, viewCount: 500 },
      { question: 'What are your support hours?', answer: 'Our support team is available 24/7...', category: 'Support', order: 1, isPopular: true, viewCount: 350 },
      { question: 'How do I enable two-factor authentication?', answer: 'Go to Settings > Security > Enable MFA...', category: 'Security', order: 1, isPopular: true, viewCount: 280 },
      { question: 'Can I add additional users?', answer: 'Yes, admin users can add team members...', category: 'Account', order: 2, isPopular: false, viewCount: 150 },
    ];

    demoFAQs.forEach((faq, index) => {
      const id = `FAQ-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (60 - index * 10) * 24 * 60 * 60 * 1000).toISOString();
      this.faqs.set(id, { id, ...faq, createdAt, updatedAt: createdAt });
    });

    // Demo Tickets
    const demoTickets: Omit<PortalTicket, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        userId: 'PU-1000',
        userName: 'John Smith',
        customerId: 'CUST-001',
        customerName: 'Acme Corp',
        subject: 'Unable to access reports',
        description: 'I am unable to access the reports section...',
        category: 'Technical',
        priority: 'high',
        status: 'open',
        assigneeId: null,
        assigneeName: null,
        responses: [],
        attachments: [],
        resolvedAt: null,
        closedAt: null,
        satisfactionRating: null,
      },
      {
        userId: 'PU-1001',
        userName: 'Jane Doe',
        customerId: 'CUST-001',
        customerName: 'Acme Corp',
        subject: 'Question about billing',
        description: 'I have a question about our latest invoice...',
        category: 'Billing',
        priority: 'medium',
        status: 'in_progress',
        assigneeId: 'AGENT-001',
        assigneeName: 'Support Agent',
        responses: [
          { id: 'RSP-001', ticketId: 'TKT-1001', authorId: 'AGENT-001', authorName: 'Support Agent', authorType: 'agent', content: 'Thank you for reaching out. Let me look into this...', isInternal: false, createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
        ],
        attachments: [],
        resolvedAt: null,
        closedAt: null,
        satisfactionRating: null,
      },
      {
        userId: 'PU-1002',
        userName: 'Mike Johnson',
        customerId: 'CUST-002',
        customerName: 'Tech Solutions',
        subject: 'Feature request: Export to Excel',
        description: 'It would be great if we could export data to Excel format...',
        category: 'Feature Request',
        priority: 'low',
        status: 'resolved',
        assigneeId: 'AGENT-002',
        assigneeName: 'Product Team',
        responses: [],
        attachments: [],
        resolvedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        closedAt: null,
        satisfactionRating: 5,
      },
    ];

    demoTickets.forEach((ticket, index) => {
      const id = `TKT-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (5 - index) * 24 * 60 * 60 * 1000).toISOString();
      this.tickets.set(id, { id, ...ticket, createdAt, updatedAt: createdAt } as PortalTicket);
    });

    // Demo Announcements
    const demoAnnouncements: Omit<PortalAnnouncement, 'id' | 'createdAt'>[] = [
      {
        title: 'Scheduled Maintenance',
        content: 'We will be performing scheduled maintenance on Saturday from 2 AM - 4 AM EST.',
        type: 'maintenance',
        startDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        isActive: true,
        targetAudience: 'all',
        targetCustomerIds: [],
        createdBy: 'STAFF-001',
      },
      {
        title: 'New Feature: Enhanced Reporting',
        content: 'We are excited to announce our new enhanced reporting features!',
        type: 'feature',
        startDate: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: null,
        isActive: true,
        targetAudience: 'all',
        targetCustomerIds: [],
        createdBy: 'STAFF-002',
      },
    ];

    demoAnnouncements.forEach((announcement, index) => {
      const id = `ANN-${1000 + index}`;
      const createdAt = new Date(now.getTime() - (10 - index * 5) * 24 * 60 * 60 * 1000).toISOString();
      this.announcements.set(id, { id, ...announcement, createdAt });
    });

    // Demo Activity Logs
    this.logActivity('PU-1000', 'John Smith', 'Logged In', 'session', 'SES-001');
    this.logActivity('PU-1001', 'Jane Doe', 'Created Ticket', 'ticket', 'TKT-1001');
    this.logActivity('PU-1002', 'Mike Johnson', 'Viewed Article', 'article', 'KB-1000');

    this.logger.info(
      {
        users: this.users.size,
        articles: this.articles.size,
        faqs: this.faqs.size,
        tickets: this.tickets.size,
        announcements: this.announcements.size,
      },
      'PortalCentralService demo data initialized'
    );
  }
}
