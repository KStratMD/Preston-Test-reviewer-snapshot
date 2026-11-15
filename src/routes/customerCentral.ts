/**
 * CustomerCentral Routes
 * Provides customer management dashboard data and analytics
 */
import * as express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { CustomerCentralService } from '../services/CustomerCentralService';

const router = express.Router();

/**
 * Get CustomerCentralService instance from DI container
 */
function getService(): CustomerCentralService {
  return container.get<CustomerCentralService>(TYPES.CustomerCentralService);
}

// =============================================================================
// Dashboard & Analytics
// =============================================================================

/**
 * GET /api/customer-central/dashboard
 * Comprehensive customer dashboard with metrics and analytics
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

/**
 * GET /api/customer-central/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

/**
 * GET /api/customer-central/segments
 * Customer segment statistics
 */
router.get('/segments', asyncHandler(async (req, res) => {
  const service = getService();
  const segments = await service.getSegmentStats();
  res.json(segments);
}));

/**
 * GET /api/customer-central/ltv-analysis
 * Lifetime value analysis across customers
 */
router.get('/ltv-analysis', asyncHandler(async (req, res) => {
  const service = getService();
  const analysis = await service.getLifetimeValueAnalysis();
  res.json(analysis);
}));

/**
 * GET /api/customer-central/at-risk
 * Customers at risk of churning
 */
router.get('/at-risk', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
  const atRisk = await service.getAtRiskCustomers(limit);
  res.json(atRisk);
}));

// =============================================================================
// Customer CRUD
// =============================================================================

/**
 * GET /api/customer-central/customers
 * List customers with optional filtering
 */
router.get('/customers', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    segment: req.query.segment as string | undefined,
    status: req.query.status as string | undefined,
    tier: req.query.tier as string | undefined,
    churnRisk: req.query.churnRisk as string | undefined,
    tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
    minLifetimeValue: req.query.minLifetimeValue ? parseFloat(req.query.minLifetimeValue as string) : undefined,
    maxLifetimeValue: req.query.maxLifetimeValue ? parseFloat(req.query.maxLifetimeValue as string) : undefined,
    query: req.query.query as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
  };
  const result = await service.getCustomers(filters as any);
  res.json(result);
}));

/**
 * GET /api/customer-central/customers/:id
 * Get a specific customer by ID
 */
router.get('/customers/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const customer = await service.getCustomer(req.params.id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json(customer);
}));

/**
 * GET /api/customer-central/customers/email/:email
 * Get a customer by email
 */
router.get('/customers/email/:email', asyncHandler(async (req, res) => {
  const service = getService();
  const customer = await service.getCustomerByEmail(req.params.email);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json(customer);
}));

/**
 * POST /api/customer-central/customers
 * Create a new customer
 */
router.post('/customers', asyncHandler(async (req, res) => {
  const service = getService();
  const { name, email, phone, company, type, segment, tier, billingAddress, shippingAddress, contacts, tags, customFields } = req.body;

  if (!name || !email || !type || !segment || !billingAddress) {
    return res.status(400).json({ error: 'Missing required fields: name, email, type, segment, billingAddress' });
  }

  const customer = await service.createCustomer({
    name,
    email,
    phone,
    company,
    type,
    segment,
    tier,
    billingAddress,
    shippingAddress,
    contacts,
    tags,
    customFields,
  });

  res.status(201).json(customer);
}));

/**
 * PUT /api/customer-central/customers/:id
 * Update a customer
 */
router.put('/customers/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const customer = await service.updateCustomer(req.params.id, req.body);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json(customer);
}));

/**
 * DELETE /api/customer-central/customers/:id
 * Delete a customer (soft delete)
 */
router.delete('/customers/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const success = await service.deleteCustomer(req.params.id);
  if (!success) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json({ success: true, message: 'Customer deleted' });
}));

// =============================================================================
// Orders
// =============================================================================

/**
 * GET /api/customer-central/customers/:id/orders
 * Get customer orders
 */
router.get('/customers/:id/orders', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const orders = await service.getCustomerOrders(req.params.id, limit);
  res.json(orders);
}));

/**
 * POST /api/customer-central/customers/:id/orders
 * Record a new order for a customer
 */
router.post('/customers/:id/orders', asyncHandler(async (req, res) => {
  const service = getService();
  const { orderNumber, status, total, subtotal, tax, shipping, discount, items, shippedAt, deliveredAt } = req.body;

  if (!orderNumber || !status || total === undefined || !items) {
    return res.status(400).json({ error: 'Missing required fields: orderNumber, status, total, items' });
  }

  const order = await service.recordOrder(req.params.id, {
    orderNumber,
    status,
    total,
    subtotal: subtotal || total,
    tax: tax || 0,
    shipping: shipping || 0,
    discount: discount || 0,
    items,
    shippedAt: shippedAt || null,
    deliveredAt: deliveredAt || null,
  });

  if (!order) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.status(201).json(order);
}));

/**
 * GET /api/customer-central/orders/:id
 * Get a specific order by ID
 */
router.get('/orders/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const order = await service.getOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(order);
}));

// =============================================================================
// Support Tickets
// =============================================================================

/**
 * GET /api/customer-central/customers/:id/tickets
 * Get customer support tickets
 */
router.get('/customers/:id/tickets', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const tickets = await service.getCustomerTickets(req.params.id, limit);
  res.json(tickets);
}));

/**
 * POST /api/customer-central/customers/:id/tickets
 * Create a support ticket for a customer
 */
router.post('/customers/:id/tickets', asyncHandler(async (req, res) => {
  const service = getService();
  const { subject, description, priority, category } = req.body;

  if (!subject || !description || !priority || !category) {
    return res.status(400).json({ error: 'Missing required fields: subject, description, priority, category' });
  }

  const ticket = await service.createTicket(req.params.id, {
    subject,
    description,
    priority,
    category,
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.status(201).json(ticket);
}));

/**
 * POST /api/customer-central/tickets/:id/resolve
 * Resolve a support ticket
 */
router.post('/tickets/:id/resolve', asyncHandler(async (req, res) => {
  const service = getService();
  const { satisfactionRating } = req.body;

  const ticket = await service.resolveTicket(req.params.id, { satisfactionRating });
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  res.json(ticket);
}));

// =============================================================================
// Customer Health & NPS
// =============================================================================

/**
 * POST /api/customer-central/customers/:id/health-score
 * Update customer health score
 */
router.post('/customers/:id/health-score', asyncHandler(async (req, res) => {
  const service = getService();
  const healthScore = await service.updateHealthScore(req.params.id);
  if (healthScore === null) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  res.json({ healthScore });
}));

/**
 * POST /api/customer-central/customers/:id/nps
 * Record NPS score for a customer
 */
router.post('/customers/:id/nps', asyncHandler(async (req, res) => {
  const service = getService();
  const { score } = req.body;

  if (score === undefined || score < 0 || score > 10) {
    return res.status(400).json({ error: 'NPS score must be between 0 and 10' });
  }

  const customer = await service.recordNPSScore(req.params.id, score);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json(customer);
}));

export { router as customerCentralRouter };
