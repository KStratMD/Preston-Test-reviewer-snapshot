/**
 * PortalCentralService Unit Tests
 */

import 'reflect-metadata';
import { PortalCentralService } from '../../../../src/services/PortalCentralService';
import type { Logger } from 'pino';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

describe('PortalCentralService', () => {
  let service: PortalCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    service = new PortalCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('PortalCentralService initialized');
    });
  });

  describe('Dashboard & Metrics', () => {
    describe('getDashboard', () => {
      it('should return comprehensive dashboard data', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard).toHaveProperty('summary');
        expect(dashboard).toHaveProperty('metrics');
        expect(dashboard).toHaveProperty('recentTickets');
        expect(dashboard).toHaveProperty('popularArticles');
        expect(dashboard).toHaveProperty('activeAnnouncements');
        expect(dashboard).toHaveProperty('recentActivity');
        expect(dashboard).toHaveProperty('lastUpdated');
      });

      it('should have valid summary', async () => {
        const dashboard = await service.getDashboard();

        expect(dashboard.summary.activeUsers).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.openTickets).toBeGreaterThanOrEqual(0);
        expect(dashboard.summary.pendingActions).toBeGreaterThanOrEqual(0);
      });
    });

    describe('getMetrics', () => {
      it('should return portal metrics', async () => {
        const metrics = await service.getMetrics();

        expect(metrics).toHaveProperty('totalUsers');
        expect(metrics).toHaveProperty('activeUsers');
        expect(metrics).toHaveProperty('pendingUsers');
        expect(metrics).toHaveProperty('lockedUsers');
        expect(metrics).toHaveProperty('totalSessions');
        expect(metrics).toHaveProperty('activeSessions');
        expect(metrics).toHaveProperty('totalTickets');
        expect(metrics).toHaveProperty('openTickets');
        expect(metrics).toHaveProperty('resolvedTickets');
        expect(metrics).toHaveProperty('totalArticles');
        expect(metrics).toHaveProperty('publishedArticles');
        expect(metrics).toHaveProperty('totalFAQs');
      });
    });
  });

  describe('Portal User Management', () => {
    describe('getUsers', () => {
      it('should return users', async () => {
        const result = await service.getUsers();
        expect(result.users.length).toBeGreaterThan(0);
        expect(result.total).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const result = await service.getUsers({ status: 'active' });
        result.users.forEach((u) => expect(u.status).toBe('active'));
      });

      it('should filter by role', async () => {
        const result = await service.getUsers({ role: 'admin' });
        result.users.forEach((u) => expect(u.role).toBe('admin'));
      });

      it('should limit results', async () => {
        const result = await service.getUsers({ limit: 2 });
        expect(result.users.length).toBeLessThanOrEqual(2);
      });
    });

    describe('getUser', () => {
      it('should return user by ID', async () => {
        const users = await service.getUsers();
        const user = await service.getUser(users.users[0].id);
        expect(user).not.toBeNull();
        expect(user!.id).toBe(users.users[0].id);
      });

      it('should return null for non-existent', async () => {
        const user = await service.getUser('NON-EXISTENT');
        expect(user).toBeNull();
      });
    });

    describe('createUser', () => {
      it('should create a new portal user', async () => {
        const user = await service.createUser({
          customerId: 'CUST-TEST',
          customerName: 'Test Customer',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
        });

        expect(user.id).toMatch(/^PU-/);
        expect(user.status).toBe('pending');
        expect(user.role).toBe('user');
        expect(user.email).toBe('test@example.com');
      });

      it('should set default permissions', async () => {
        const user = await service.createUser({
          customerId: 'CUST-TEST',
          customerName: 'Test Customer',
          email: 'test2@example.com',
          firstName: 'Test',
          lastName: 'User2',
        });

        expect(user.permissions).toContain('view_account');
        expect(user.permissions).toContain('create_tickets');
        expect(user.permissions).toContain('view_kb');
      });
    });

    describe('updateUser', () => {
      it('should update user fields', async () => {
        const users = await service.getUsers();
        const updated = await service.updateUser(users.users[0].id, {
          firstName: 'Updated',
          lastName: 'Name',
        });

        expect(updated).not.toBeNull();
        expect(updated!.firstName).toBe('Updated');
        expect(updated!.lastName).toBe('Name');
      });

      it('should return null for non-existent', async () => {
        const result = await service.updateUser('NON-EXISTENT', { firstName: 'Test' });
        expect(result).toBeNull();
      });
    });

    describe('activateUser', () => {
      it('should activate a pending user', async () => {
        const created = await service.createUser({
          customerId: 'CUST-TEST',
          customerName: 'Test Customer',
          email: 'activate@example.com',
          firstName: 'Test',
          lastName: 'Activate',
        });

        const activated = await service.activateUser(created.id);
        expect(activated).not.toBeNull();
        expect(activated!.status).toBe('active');
      });
    });

    describe('lockUser and unlockUser', () => {
      it('should lock and unlock a user', async () => {
        const users = await service.getUsers({ status: 'active' });
        if (users.users.length > 0) {
          const locked = await service.lockUser(users.users[0].id);
          expect(locked!.status).toBe('locked');

          const unlocked = await service.unlockUser(users.users[0].id);
          expect(unlocked!.status).toBe('active');
        }
      });
    });
  });

  describe('Knowledge Base', () => {
    describe('getArticles', () => {
      it('should return articles', async () => {
        const result = await service.getArticles();
        expect(result.articles.length).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const result = await service.getArticles({ status: 'published' });
        result.articles.forEach((a) => expect(a.status).toBe('published'));
      });

      it('should search articles', async () => {
        const result = await service.getArticles({ search: 'getting started' });
        expect(result.articles.length).toBeGreaterThan(0);
      });
    });

    describe('getArticle', () => {
      it('should return article by ID and increment view count', async () => {
        const articles = await service.getArticles();
        const initialViews = articles.articles[0].viewCount;

        const article = await service.getArticle(articles.articles[0].id);
        expect(article).not.toBeNull();
        expect(article!.viewCount).toBe(initialViews + 1);
      });

      it('should return null for non-existent', async () => {
        const article = await service.getArticle('NON-EXISTENT');
        expect(article).toBeNull();
      });
    });

    describe('getArticleBySlug', () => {
      it('should return article by slug', async () => {
        const article = await service.getArticleBySlug('getting-started-with-the-portal');
        expect(article).not.toBeNull();
        expect(article!.slug).toBe('getting-started-with-the-portal');
      });
    });

    describe('getPopularArticles', () => {
      it('should return popular articles sorted by view count', async () => {
        const popular = await service.getPopularArticles(3);
        expect(popular.length).toBeLessThanOrEqual(3);

        for (let i = 1; i < popular.length; i++) {
          expect(popular[i - 1].viewCount).toBeGreaterThanOrEqual(popular[i].viewCount);
        }
      });
    });

    describe('createArticle', () => {
      it('should create a new article', async () => {
        const article = await service.createArticle({
          title: 'Test Article',
          category: 'Testing',
          content: 'This is test content',
          summary: 'Test summary',
          tags: ['test'],
          authorId: 'AUTH-001',
          authorName: 'Test Author',
        });

        expect(article.id).toMatch(/^KB-/);
        expect(article.status).toBe('draft');
        expect(article.slug).toBe('test-article');
        expect(article.viewCount).toBe(0);
      });
    });

    describe('publishArticle', () => {
      it('should publish a draft article', async () => {
        const created = await service.createArticle({
          title: 'Publish Test',
          category: 'Testing',
          content: 'Content',
          summary: 'Summary',
          authorId: 'AUTH-001',
          authorName: 'Author',
        });

        const published = await service.publishArticle(created.id);
        expect(published).not.toBeNull();
        expect(published!.status).toBe('published');
        expect(published!.publishedAt).not.toBeNull();
      });

      it('should return null for already published article', async () => {
        const articles = await service.getArticles({ status: 'published' });
        if (articles.articles.length > 0) {
          const result = await service.publishArticle(articles.articles[0].id);
          expect(result).toBeNull();
        }
      });
    });

    describe('archiveArticle', () => {
      it('should archive an article', async () => {
        const created = await service.createArticle({
          title: 'Archive Test',
          category: 'Testing',
          content: 'Content',
          summary: 'Summary',
          authorId: 'AUTH-001',
          authorName: 'Author',
        });

        const archived = await service.archiveArticle(created.id);
        expect(archived).not.toBeNull();
        expect(archived!.status).toBe('archived');
      });
    });

    describe('rateArticle', () => {
      it('should rate article as helpful', async () => {
        const articles = await service.getArticles();
        const initialHelpful = articles.articles[0].helpfulCount;

        const rated = await service.rateArticle(articles.articles[0].id, true);
        expect(rated!.helpfulCount).toBe(initialHelpful + 1);
      });

      it('should rate article as not helpful', async () => {
        const articles = await service.getArticles();
        const initialNotHelpful = articles.articles[0].notHelpfulCount;

        const rated = await service.rateArticle(articles.articles[0].id, false);
        expect(rated!.notHelpfulCount).toBe(initialNotHelpful + 1);
      });
    });
  });

  describe('FAQ Management', () => {
    describe('getFAQs', () => {
      it('should return FAQs', async () => {
        const faqs = await service.getFAQs();
        expect(faqs.length).toBeGreaterThan(0);
      });

      it('should filter by category', async () => {
        const faqs = await service.getFAQs('Account');
        faqs.forEach((f) => expect(f.category).toBe('Account'));
      });
    });

    describe('getFAQCategories', () => {
      it('should return unique categories', async () => {
        const categories = await service.getFAQCategories();
        expect(categories.length).toBeGreaterThan(0);
        expect(new Set(categories).size).toBe(categories.length);
      });
    });

    describe('createFAQ', () => {
      it('should create a new FAQ', async () => {
        const faq = await service.createFAQ({
          question: 'Test Question?',
          answer: 'Test Answer',
          category: 'Testing',
        });

        expect(faq.id).toMatch(/^FAQ-/);
        expect(faq.question).toBe('Test Question?');
        expect(faq.viewCount).toBe(0);
      });
    });
  });

  describe('Ticket Management', () => {
    describe('getTickets', () => {
      it('should return tickets', async () => {
        const result = await service.getTickets();
        expect(result.tickets.length).toBeGreaterThan(0);
      });

      it('should filter by status', async () => {
        const result = await service.getTickets({ status: 'open' });
        result.tickets.forEach((t) => expect(t.status).toBe('open'));
      });

      it('should filter by priority', async () => {
        const result = await service.getTickets({ priority: 'high' });
        result.tickets.forEach((t) => expect(t.priority).toBe('high'));
      });
    });

    describe('getTicket', () => {
      it('should return ticket by ID', async () => {
        const tickets = await service.getTickets();
        const ticket = await service.getTicket(tickets.tickets[0].id);
        expect(ticket).not.toBeNull();
      });

      it('should return null for non-existent', async () => {
        const ticket = await service.getTicket('NON-EXISTENT');
        expect(ticket).toBeNull();
      });
    });

    describe('createTicket', () => {
      it('should create a new ticket', async () => {
        const ticket = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Test Subject',
          description: 'Test Description',
          category: 'Technical',
        });

        expect(ticket.id).toMatch(/^TKT-/);
        expect(ticket.status).toBe('open');
        expect(ticket.priority).toBe('medium');
        expect(ticket.responses).toHaveLength(0);
      });

      it('should use specified priority', async () => {
        const ticket = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Urgent Issue',
          description: 'This is urgent',
          category: 'Technical',
          priority: 'urgent',
        });

        expect(ticket.priority).toBe('urgent');
      });
    });

    describe('updateTicketStatus', () => {
      it('should update ticket status', async () => {
        const created = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Status Test',
          description: 'Testing status update',
          category: 'Technical',
        });

        const updated = await service.updateTicketStatus(created.id, 'in_progress');
        expect(updated!.status).toBe('in_progress');
      });

      it('should set resolvedAt when resolved', async () => {
        const created = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Resolve Test',
          description: 'Testing resolve',
          category: 'Technical',
        });

        const resolved = await service.updateTicketStatus(created.id, 'resolved');
        expect(resolved!.resolvedAt).not.toBeNull();
      });
    });

    describe('assignTicket', () => {
      it('should assign ticket to agent', async () => {
        const created = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Assign Test',
          description: 'Testing assignment',
          category: 'Technical',
        });

        const assigned = await service.assignTicket(created.id, 'AGENT-001', 'Support Agent');
        expect(assigned!.assigneeId).toBe('AGENT-001');
        expect(assigned!.assigneeName).toBe('Support Agent');
        expect(assigned!.status).toBe('in_progress');
      });
    });

    describe('addTicketResponse', () => {
      it('should add response to ticket', async () => {
        const created = await service.createTicket({
          userId: 'PU-1000',
          userName: 'Test User',
          customerId: 'CUST-001',
          customerName: 'Test Customer',
          subject: 'Response Test',
          description: 'Testing responses',
          category: 'Technical',
        });

        const withResponse = await service.addTicketResponse(created.id, {
          authorId: 'AGENT-001',
          authorName: 'Support Agent',
          authorType: 'agent',
          content: 'Thank you for contacting us.',
        });

        expect(withResponse!.responses).toHaveLength(1);
        expect(withResponse!.responses[0].content).toBe('Thank you for contacting us.');
        expect(withResponse!.status).toBe('in_progress');
      });
    });

    describe('rateTicket', () => {
      it('should rate ticket satisfaction', async () => {
        const tickets = await service.getTickets({ status: 'resolved' });
        if (tickets.tickets.length > 0) {
          const rated = await service.rateTicket(tickets.tickets[0].id, 5);
          expect(rated!.satisfactionRating).toBe(5);
        }
      });

      it('should return null for invalid rating', async () => {
        const tickets = await service.getTickets();
        const result = await service.rateTicket(tickets.tickets[0].id, 6);
        expect(result).toBeNull();
      });
    });
  });

  describe('Notifications', () => {
    describe('createNotification and getNotifications', () => {
      it('should create and retrieve notifications', async () => {
        const notification = await service.createNotification({
          userId: 'PU-1000',
          type: 'info',
          title: 'Test Notification',
          message: 'This is a test',
        });

        expect(notification.id).toMatch(/^NOTIF-/);
        expect(notification.isRead).toBe(false);

        const notifications = await service.getNotifications('PU-1000');
        expect(notifications.some((n) => n.id === notification.id)).toBe(true);
      });

      it('should filter unread only', async () => {
        const notifications = await service.getNotifications('PU-1000', true);
        notifications.forEach((n) => expect(n.isRead).toBe(false));
      });
    });

    describe('markNotificationRead', () => {
      it('should mark notification as read', async () => {
        const created = await service.createNotification({
          userId: 'PU-1000',
          type: 'success',
          title: 'Read Test',
          message: 'Mark as read test',
        });

        const read = await service.markNotificationRead(created.id);
        expect(read!.isRead).toBe(true);
      });
    });

    describe('markAllNotificationsRead', () => {
      it('should mark all user notifications as read', async () => {
        const uniqueUserId = `PU-TEST-${Date.now()}`;

        const n1 = await service.createNotification({
          userId: uniqueUserId,
          type: 'info',
          title: 'Test 1',
          message: 'Message 1',
        });

        // Small delay to ensure unique IDs
        await new Promise((resolve) => setTimeout(resolve, 5));

        const n2 = await service.createNotification({
          userId: uniqueUserId,
          type: 'info',
          title: 'Test 2',
          message: 'Message 2',
        });

        // Verify both were created with different IDs
        expect(n1.id).not.toBe(n2.id);

        const count = await service.markAllNotificationsRead(uniqueUserId);
        expect(count).toBe(2);

        const unread = await service.getNotifications(uniqueUserId, true);
        expect(unread).toHaveLength(0);
      });
    });
  });

  describe('Announcements', () => {
    describe('getActiveAnnouncements', () => {
      it('should return active announcements', async () => {
        const announcements = await service.getActiveAnnouncements();
        expect(Array.isArray(announcements)).toBe(true);
        announcements.forEach((a) => expect(a.isActive).toBe(true));
      });
    });

    describe('createAnnouncement', () => {
      it('should create an announcement', async () => {
        const announcement = await service.createAnnouncement({
          title: 'Test Announcement',
          content: 'This is a test announcement',
          type: 'info',
          startDate: new Date().toISOString(),
          createdBy: 'STAFF-001',
        });

        expect(announcement.id).toMatch(/^ANN-/);
        expect(announcement.isActive).toBe(true);
        expect(announcement.targetAudience).toBe('all');
      });
    });
  });

  describe('Activity', () => {
    describe('getRecentActivity', () => {
      it('should return recent activity logs', async () => {
        const activity = await service.getRecentActivity(10);
        expect(Array.isArray(activity)).toBe(true);
      });

      it('should respect limit parameter', async () => {
        const activity = await service.getRecentActivity(2);
        expect(activity.length).toBeLessThanOrEqual(2);
      });
    });
  });
});
