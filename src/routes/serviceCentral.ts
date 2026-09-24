import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { ServiceCentralService, WorkOrderUpdateRequest } from '../services/ServiceCentralService';

const router = express.Router();

/**
 * Get ServiceCentralService instance from DI container
 */
function getService(): ServiceCentralService {
  return container.get<ServiceCentralService>(TYPES.ServiceCentralService);
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

/**
 * GET /api/service-central/dashboard
 * Comprehensive service dashboard with metrics, dispatches, and technician status
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

/**
 * GET /api/service-central/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'service-central' });
});

/**
 * GET /api/service-central/metrics
 * Service performance metrics
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  const service = getService();
  const metrics = await service.getMetrics();
  res.json(metrics);
}));

/**
 * GET /api/service-central/tickets-by-priority
 * Tickets grouped by priority level
 */
router.get('/tickets-by-priority', asyncHandler(async (req, res) => {
  const service = getService();
  const ticketsByPriority = await service.getTicketsByPriority();
  res.json(ticketsByPriority);
}));

// =============================================================================
// Work Order Management
// =============================================================================

/**
 * GET /api/service-central/work-orders
 * List work orders with optional filters
 */
router.get('/work-orders', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    status: req.query.status as string | undefined,
    priority: req.query.priority as string | undefined,
    technicianId: req.query.technicianId as string | undefined,
    customerId: req.query.customerId as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const workOrders = await service.getWorkOrders(filters as any);
  res.json(workOrders);
}));

/**
 * GET /api/service-central/work-orders/:id
 * Get a specific work order by ID
 */
router.get('/work-orders/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const workOrder = await service.getWorkOrder(req.params.id);
  if (!workOrder) {
    return res.status(404).json({ error: 'Work order not found' });
  }
  res.json(workOrder);
}));

/**
 * POST /api/service-central/work-orders
 * Create a new work order
 */
router.post('/work-orders', asyncHandler(async (req, res) => {
  const service = getService();
  const { customerId, customerName, title, description, priority, type, location, scheduledDate, scheduledTimeSlot } = req.body;

  if (!customerId || !customerName || !title || !description || !priority || !type || !location) {
    return res.status(400).json({ error: 'Missing required fields: customerId, customerName, title, description, priority, type, location' });
  }

  const workOrder = await service.createWorkOrder({
    customerId,
    customerName,
    title,
    description,
    priority,
    type,
    location,
    scheduledDate,
    scheduledTimeSlot,
  });

  res.status(201).json(workOrder);
}));

/**
 * PUT /api/service-central/work-orders/:id
 * Update a work order
 */
router.put('/work-orders/:id', asyncHandler(async (req, res) => {
  const service = getService();
  // Whitelist allowed fields to prevent mass assignment (must match WorkOrderUpdateRequest)
  const updates: WorkOrderUpdateRequest = {};
  if (req.body.title !== undefined) updates.title = req.body.title;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.priority !== undefined) updates.priority = req.body.priority;
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.scheduledDate !== undefined) updates.scheduledDate = req.body.scheduledDate;
  if (req.body.scheduledTimeSlot !== undefined) updates.scheduledTimeSlot = req.body.scheduledTimeSlot;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;

  const workOrder = await service.updateWorkOrder(req.params.id, updates);
  if (!workOrder) {
    return res.status(404).json({ error: 'Work order not found' });
  }

  res.json(workOrder);
}));

/**
 * POST /api/service-central/work-orders/:id/complete
 * Complete a work order with labor hours, parts used, etc.
 */
router.post('/work-orders/:id/complete', asyncHandler(async (req, res) => {
  const service = getService();
  const { laborHours, partsUsed, notes, customerSignature, satisfactionRating } = req.body;

  if (laborHours === undefined) {
    return res.status(400).json({ error: 'laborHours is required' });
  }

  const workOrder = await service.completeWorkOrder(req.params.id, {
    laborHours,
    partsUsed,
    notes,
    customerSignature,
    satisfactionRating,
  });

  if (!workOrder) {
    return res.status(404).json({ error: 'Work order not found' });
  }

  res.json(workOrder);
}));

/**
 * GET /api/service-central/work-orders/sla/at-risk
 * Get work orders at risk of SLA breach
 */
router.get('/sla/at-risk', asyncHandler(async (req, res) => {
  const service = getService();
  const atRisk = await service.getSLAAtRiskWorkOrders();
  res.json(atRisk);
}));

// =============================================================================
// Technician Management
// =============================================================================

/**
 * GET /api/service-central/technicians
 * List all technicians with optional filters
 */
router.get('/technicians', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    status: req.query.status as string | undefined,
    skill: req.query.skill as string | undefined,
    available: req.query.available === 'true',
  };
  const technicians = await service.getTechnicians(filters as any);
  res.json(technicians);
}));

/**
 * GET /api/service-central/technicians/:id
 * Get a specific technician by ID
 */
router.get('/technicians/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const technician = await service.getTechnician(req.params.id);
  if (!technician) {
    return res.status(404).json({ error: 'Technician not found' });
  }
  res.json(technician);
}));

/**
 * PUT /api/service-central/technicians/:id/status
 * Update a technician's status
 */
router.put('/technicians/:id/status', asyncHandler(async (req, res) => {
  const service = getService();
  const { status, location } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const technician = await service.updateTechnicianStatus(req.params.id, status, location);
  if (!technician) {
    return res.status(404).json({ error: 'Technician not found' });
  }

  res.json(technician);
}));

/**
 * GET /api/service-central/technicians/:id/schedule
 * Get a technician's schedule for a specific date
 */
router.get('/technicians/:id/schedule', asyncHandler(async (req, res) => {
  const service = getService();
  const date = req.query.date as string || new Date().toISOString().split('T')[0];

  const schedule = await service.getTechnicianSchedule(req.params.id, date);
  if (!schedule) {
    return res.status(404).json({ error: 'Technician not found' });
  }

  res.json(schedule);
}));

/**
 * GET /api/service-central/technician-status
 * Get summary status of all technicians
 */
router.get('/technician-status', asyncHandler(async (req, res) => {
  const service = getService();
  const summary = await service.getTechnicianStatusSummary();
  res.json(summary);
}));

/**
 * POST /api/service-central/work-orders/:id/find-technician
 * Find the best technician for a work order
 */
router.post('/work-orders/:id/find-technician', asyncHandler(async (req, res) => {
  const service = getService();
  const result = await service.findBestTechnician(req.params.id);
  res.json(result);
}));

// =============================================================================
// Dispatch Management
// =============================================================================

/**
 * POST /api/service-central/dispatch
 * Dispatch a technician to a work order
 */
router.post('/dispatch', asyncHandler(async (req, res) => {
  const service = getService();
  const { workOrderId, technicianId, scheduledDate, scheduledTimeSlot, notes } = req.body;

  if (!workOrderId || !technicianId) {
    return res.status(400).json({ error: 'workOrderId and technicianId are required' });
  }

  const result = await service.dispatchTechnician({
    workOrderId,
    technicianId,
    scheduledDate,
    scheduledTimeSlot,
    notes,
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.status(201).json(result.dispatch);
}));

/**
 * GET /api/service-central/dispatches/active
 * Get all active dispatches
 */
router.get('/dispatches/active', asyncHandler(async (req, res) => {
  const service = getService();
  const dispatches = await service.getActiveDispatches();
  res.json(dispatches);
}));

/**
 * PUT /api/service-central/dispatches/:id/status
 * Update a dispatch status
 */
router.put('/dispatches/:id/status', asyncHandler(async (req, res) => {
  const service = getService();
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const dispatch = await service.updateDispatchStatus(req.params.id, status);
  if (!dispatch) {
    return res.status(404).json({ error: 'Dispatch not found' });
  }

  res.json(dispatch);
}));

/**
 * GET /api/service-central/work-orders/:id/dispatch-history
 * Get dispatch history for a work order
 */
router.get('/work-orders/:id/dispatch-history', asyncHandler(async (req, res) => {
  const service = getService();
  const history = await service.getDispatchHistory(req.params.id);
  res.json(history);
}));

// =============================================================================
// SLA Management
// =============================================================================

/**
 * GET /api/service-central/slas
 * Get all SLA definitions
 */
router.get('/slas', asyncHandler(async (req, res) => {
  const service = getService();
  const slas = await service.getSLAs();
  res.json(slas);
}));

/**
 * GET /api/service-central/sla/compliance
 * Get SLA compliance report for a date range
 */
router.get('/sla/compliance', asyncHandler(async (req, res) => {
  const service = getService();
  const startDate = req.query.startDate as string || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = req.query.endDate as string || new Date().toISOString().split('T')[0];

  const report = await service.getSLAComplianceReport(startDate, endDate);
  res.json(report);
}));

export { router as serviceCentralRouter };
