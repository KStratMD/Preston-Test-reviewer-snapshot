import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { PortalCentralService, PortalUser } from '../services/PortalCentralService';

const router = express.Router();

function getService(): PortalCentralService {
  return container.get<PortalCentralService>(TYPES.PortalCentralService);
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'portal-central' });
});

router.get('/metrics', asyncHandler(async (req, res) => {
  const service = getService();
  const metrics = await service.getMetrics();
  res.json(metrics);
}));

// =============================================================================
// Portal User Management
// =============================================================================

router.get('/users', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    customerId: req.query.customerId as string | undefined,
    status: req.query.status as any,
    role: req.query.role as any,
    search: req.query.search as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getUsers(filters);
  res.json(result);
}));

router.get('/users/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const user = await service.getUser(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}));

router.post('/users', asyncHandler(async (req, res) => {
  const service = getService();
  const { customerId, customerName, email, firstName, lastName, role, permissions } = req.body;

  if (!customerId || !customerName || !email || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const user = await service.createUser({
    customerId, customerName, email, firstName, lastName, role, permissions,
  });

  res.status(201).json(user);
}));

router.put('/users/:id', asyncHandler(async (req, res) => {
  const service = getService();
  // Whitelist allowed fields to prevent mass assignment (must match service.updateUser signature)
  const updates: Partial<Pick<PortalUser, 'firstName' | 'lastName' | 'role' | 'status' | 'permissions' | 'mfaEnabled'>> = {};
  if (req.body.firstName !== undefined) updates.firstName = req.body.firstName;
  if (req.body.lastName !== undefined) updates.lastName = req.body.lastName;
  if (req.body.role !== undefined) updates.role = req.body.role;
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.permissions !== undefined) updates.permissions = req.body.permissions;
  if (req.body.mfaEnabled !== undefined) updates.mfaEnabled = req.body.mfaEnabled;

  const user = await service.updateUser(req.params.id, updates);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}));

router.post('/users/:id/activate', asyncHandler(async (req, res) => {
  const service = getService();
  const user = await service.activateUser(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}));

router.post('/users/:id/lock', asyncHandler(async (req, res) => {
  const service = getService();
  const user = await service.lockUser(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}));

router.post('/users/:id/unlock', asyncHandler(async (req, res) => {
  const service = getService();
  const user = await service.unlockUser(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
}));

// =============================================================================
// Knowledge Base
// =============================================================================

router.get('/articles', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    category: req.query.category as string | undefined,
    status: req.query.status as any,
    search: req.query.search as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getArticles(filters);
  res.json(result);
}));

router.get('/articles/popular', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
  const articles = await service.getPopularArticles(limit);
  res.json(articles);
}));

router.get('/articles/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const article = await service.getArticle(req.params.id);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
}));

router.get('/articles/slug/:slug', asyncHandler(async (req, res) => {
  const service = getService();
  const article = await service.getArticleBySlug(req.params.slug);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
}));

router.post('/articles', asyncHandler(async (req, res) => {
  const service = getService();
  const { title, category, content, summary, tags, authorId, authorName } = req.body;

  if (!title || !category || !content || !summary || !authorId || !authorName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const article = await service.createArticle({
    title, category, content, summary, tags, authorId, authorName,
  });

  res.status(201).json(article);
}));

router.put('/articles/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const article = await service.updateArticle(req.params.id, req.body);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
}));

router.post('/articles/:id/publish', asyncHandler(async (req, res) => {
  const service = getService();
  const article = await service.publishArticle(req.params.id);
  if (!article) {
    return res.status(404).json({ error: 'Article not found or already published' });
  }
  res.json(article);
}));

router.post('/articles/:id/archive', asyncHandler(async (req, res) => {
  const service = getService();
  const article = await service.archiveArticle(req.params.id);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
}));

router.post('/articles/:id/rate', asyncHandler(async (req, res) => {
  const service = getService();
  const { helpful } = req.body;
  if (helpful === undefined) {
    return res.status(400).json({ error: 'helpful is required' });
  }
  const article = await service.rateArticle(req.params.id, helpful);
  if (!article) {
    return res.status(404).json({ error: 'Article not found' });
  }
  res.json(article);
}));

// =============================================================================
// FAQ
// =============================================================================

router.get('/faqs', asyncHandler(async (req, res) => {
  const service = getService();
  const category = req.query.category as string | undefined;
  const faqs = await service.getFAQs(category);
  res.json(faqs);
}));

router.get('/faqs/categories', asyncHandler(async (req, res) => {
  const service = getService();
  const categories = await service.getFAQCategories();
  res.json(categories);
}));

router.post('/faqs', asyncHandler(async (req, res) => {
  const service = getService();
  const { question, answer, category, order, isPopular } = req.body;

  if (!question || !answer || !category) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const faq = await service.createFAQ({ question, answer, category, order, isPopular });
  res.status(201).json(faq);
}));

// =============================================================================
// Tickets
// =============================================================================

router.get('/tickets', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    userId: req.query.userId as string | undefined,
    customerId: req.query.customerId as string | undefined,
    status: req.query.status as any,
    priority: req.query.priority as any,
    category: req.query.category as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getTickets(filters);
  res.json(result);
}));

router.get('/tickets/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const ticket = await service.getTicket(req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
}));

router.post('/tickets', asyncHandler(async (req, res) => {
  const service = getService();
  const { userId, userName, customerId, customerName, subject, description, category, priority } = req.body;

  if (!userId || !userName || !customerId || !customerName || !subject || !description || !category) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ticket = await service.createTicket({
    userId, userName, customerId, customerName, subject, description, category, priority,
  });

  res.status(201).json(ticket);
}));

router.put('/tickets/:id/status', asyncHandler(async (req, res) => {
  const service = getService();
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }
  const ticket = await service.updateTicketStatus(req.params.id, status);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
}));

router.post('/tickets/:id/assign', asyncHandler(async (req, res) => {
  const service = getService();
  const { assigneeId, assigneeName } = req.body;
  if (!assigneeId || !assigneeName) {
    return res.status(400).json({ error: 'assigneeId and assigneeName are required' });
  }
  const ticket = await service.assignTicket(req.params.id, assigneeId, assigneeName);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
}));

router.post('/tickets/:id/responses', asyncHandler(async (req, res) => {
  const service = getService();
  const { authorId, authorName, authorType, content, isInternal } = req.body;
  if (!authorId || !authorName || !authorType || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const ticket = await service.addTicketResponse(req.params.id, {
    authorId, authorName, authorType, content, isInternal,
  });
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
}));

router.post('/tickets/:id/rate', asyncHandler(async (req, res) => {
  const service = getService();
  const { rating } = req.body;
  if (rating === undefined || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating is required and must be between 1 and 5' });
  }
  const ticket = await service.rateTicket(req.params.id, rating);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  res.json(ticket);
}));

// =============================================================================
// Notifications
// =============================================================================

router.get('/users/:userId/notifications', asyncHandler(async (req, res) => {
  const service = getService();
  const unreadOnly = req.query.unreadOnly === 'true';
  const notifications = await service.getNotifications(req.params.userId, unreadOnly);
  res.json(notifications);
}));

router.post('/notifications', asyncHandler(async (req, res) => {
  const service = getService();
  const { userId, type, title, message, link, expiresAt } = req.body;
  if (!userId || !type || !title || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const notification = await service.createNotification({
    userId, type, title, message, link, expiresAt,
  });
  res.status(201).json(notification);
}));

router.post('/notifications/:id/read', asyncHandler(async (req, res) => {
  const service = getService();
  const notification = await service.markNotificationRead(req.params.id);
  if (!notification) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  res.json(notification);
}));

router.post('/users/:userId/notifications/read-all', asyncHandler(async (req, res) => {
  const service = getService();
  const count = await service.markAllNotificationsRead(req.params.userId);
  res.json({ markedRead: count });
}));

// =============================================================================
// Announcements
// =============================================================================

router.get('/announcements', asyncHandler(async (req, res) => {
  const service = getService();
  const announcements = await service.getActiveAnnouncements();
  res.json(announcements);
}));

router.post('/announcements', asyncHandler(async (req, res) => {
  const service = getService();
  const { title, content, type, startDate, endDate, targetAudience, targetCustomerIds, createdBy } = req.body;
  if (!title || !content || !type || !startDate || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const announcement = await service.createAnnouncement({
    title, content, type, startDate, endDate, targetAudience, targetCustomerIds, createdBy,
  });
  res.status(201).json(announcement);
}));

// =============================================================================
// Activity
// =============================================================================

router.get('/activity', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
  const activity = await service.getRecentActivity(limit);
  res.json(activity);
}));

export { router as portalCentralRouter };
