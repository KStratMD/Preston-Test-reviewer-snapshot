import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { QualityCentralService } from '../services/QualityCentralService';

const router = express.Router();

/**
 * Get QualityCentralService instance from DI container
 */
function getService(): QualityCentralService {
  return container.get<QualityCentralService>(TYPES.QualityCentralService);
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

/**
 * GET /api/quality-central/dashboard
 * Comprehensive quality dashboard
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

/**
 * GET /api/quality-central/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'quality-central' });
});

/**
 * GET /api/quality-central/metrics
 * Quality metrics
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  const service = getService();
  const metrics = await service.getMetrics();
  res.json(metrics);
}));

// =============================================================================
// Inspection Management
// =============================================================================

/**
 * GET /api/quality-central/inspections
 * List inspections with optional filters
 */
router.get('/inspections', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    status: req.query.status as string | undefined,
    inspectionType: req.query.inspectionType as string | undefined,
    itemType: req.query.itemType as string | undefined,
    inspectorId: req.query.inspectorId as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const inspections = await service.getInspections(filters as any);
  res.json(inspections);
}));

/**
 * GET /api/quality-central/inspections/:id
 * Get inspection by ID
 */
router.get('/inspections/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const inspection = await service.getInspection(req.params.id);
  if (!inspection) {
    return res.status(404).json({ error: 'Inspection not found' });
  }
  res.json(inspection);
}));

/**
 * POST /api/quality-central/inspections
 * Create a new inspection
 */
router.post('/inspections', asyncHandler(async (req, res) => {
  const service = getService();
  const { itemId, itemName, itemType, batchNumber, lotNumber, inspectorId, inspectorName, inspectionType, checklistId } = req.body;

  if (!itemId || !itemName || !itemType || !inspectorId || !inspectorName || !inspectionType || !checklistId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const inspection = await service.createInspection({
    itemId,
    itemName,
    itemType,
    batchNumber,
    lotNumber,
    inspectorId,
    inspectorName,
    inspectionType,
    checklistId,
  });

  res.status(201).json(inspection);
}));

/**
 * POST /api/quality-central/inspections/:id/start
 * Start an inspection
 */
router.post('/inspections/:id/start', asyncHandler(async (req, res) => {
  const service = getService();
  const inspection = await service.startInspection(req.params.id);
  if (!inspection) {
    return res.status(404).json({ error: 'Inspection not found or already started' });
  }
  res.json(inspection);
}));

/**
 * POST /api/quality-central/inspections/:id/results
 * Submit inspection results
 */
router.post('/inspections/:id/results', asyncHandler(async (req, res) => {
  const service = getService();
  const { checklistResults, defects, notes } = req.body;

  if (!checklistResults) {
    return res.status(400).json({ error: 'checklistResults is required' });
  }

  const inspection = await service.submitInspectionResults(req.params.id, {
    checklistResults,
    defects,
    notes,
  });

  if (!inspection) {
    return res.status(404).json({ error: 'Inspection not found or already completed' });
  }

  res.json(inspection);
}));

// =============================================================================
// Hold Management
// =============================================================================

/**
 * GET /api/quality-central/holds
 * Get hold queue
 */
router.get('/holds', asyncHandler(async (req, res) => {
  const service = getService();
  const holds = await service.getHoldQueue();
  res.json(holds);
}));

/**
 * GET /api/quality-central/holds/:id
 * Get hold item by ID
 */
router.get('/holds/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const hold = await service.getHoldItem(req.params.id);
  if (!hold) {
    return res.status(404).json({ error: 'Hold item not found' });
  }
  res.json(hold);
}));

/**
 * POST /api/quality-central/holds
 * Place item on hold
 */
router.post('/holds', asyncHandler(async (req, res) => {
  const service = getService();
  const { itemId, itemName, itemType, batchNumber, quantity, unit, reason, holdType, inspectionId, createdBy } = req.body;

  if (!itemId || !itemName || !itemType || !quantity || !unit || !reason || !holdType || !createdBy) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const hold = await service.placeOnHold({
    itemId,
    itemName,
    itemType,
    batchNumber,
    quantity,
    unit,
    reason,
    holdType,
    inspectionId,
    createdBy,
  });

  res.status(201).json(hold);
}));

/**
 * POST /api/quality-central/holds/:id/request-release
 * Request release of held item
 */
router.post('/holds/:id/request-release', asyncHandler(async (req, res) => {
  const service = getService();
  const hold = await service.requestRelease(req.params.id);
  if (!hold) {
    return res.status(404).json({ error: 'Hold item not found or not on hold' });
  }
  res.json(hold);
}));

/**
 * POST /api/quality-central/holds/:id/release
 * Release held item
 */
router.post('/holds/:id/release', asyncHandler(async (req, res) => {
  const service = getService();
  const { releasedBy, releaseNotes } = req.body;

  if (!releasedBy) {
    return res.status(400).json({ error: 'releasedBy is required' });
  }

  const hold = await service.releaseItem(req.params.id, { releasedBy, releaseNotes });
  if (!hold) {
    return res.status(404).json({ error: 'Hold item not found or cannot be released' });
  }

  res.json(hold);
}));

/**
 * POST /api/quality-central/holds/:id/reject
 * Reject held item
 */
router.post('/holds/:id/reject', asyncHandler(async (req, res) => {
  const service = getService();
  const { rejectedBy, reason } = req.body;

  if (!rejectedBy || !reason) {
    return res.status(400).json({ error: 'rejectedBy and reason are required' });
  }

  const hold = await service.rejectItem(req.params.id, { rejectedBy, reason });
  if (!hold) {
    return res.status(404).json({ error: 'Hold item not found or cannot be rejected' });
  }

  res.json(hold);
}));

// =============================================================================
// Defect Management
// =============================================================================

/**
 * GET /api/quality-central/defects
 * List defects with optional filters
 */
router.get('/defects', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    type: req.query.type as string | undefined,
    status: req.query.status as string | undefined,
    inspectionId: req.query.inspectionId as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const defects = await service.getDefects(filters as any);
  res.json(defects);
}));

/**
 * GET /api/quality-central/defects/critical
 * Get critical defects
 */
router.get('/defects/critical', asyncHandler(async (req, res) => {
  const service = getService();
  const defects = await service.getCriticalDefects();
  res.json(defects);
}));

/**
 * POST /api/quality-central/defects/:id/resolve
 * Resolve a defect
 */
router.post('/defects/:id/resolve', asyncHandler(async (req, res) => {
  const service = getService();
  const { resolution, status } = req.body;

  if (!resolution || !status) {
    return res.status(400).json({ error: 'resolution and status are required' });
  }

  const defect = await service.resolveDefect(req.params.id, { resolution, status });
  if (!defect) {
    return res.status(404).json({ error: 'Defect not found' });
  }

  res.json(defect);
}));

// =============================================================================
// COA Management
// =============================================================================

/**
 * GET /api/quality-central/coas
 * List COAs with optional filters
 */
router.get('/coas', asyncHandler(async (req, res) => {
  const service = getService();
  const filters = {
    status: req.query.status as string | undefined,
    supplierId: req.query.supplierId as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const coas = await service.getCOAs(filters as any);
  res.json(coas);
}));

/**
 * GET /api/quality-central/coas/pending
 * Get pending COAs
 */
router.get('/coas/pending', asyncHandler(async (req, res) => {
  const service = getService();
  const coas = await service.getPendingCOAs();
  res.json(coas);
}));

/**
 * POST /api/quality-central/coas
 * Create a COA
 */
router.post('/coas', asyncHandler(async (req, res) => {
  const service = getService();
  const { itemId, itemName, batchNumber, lotNumber, supplierId, supplierName, testResults, certificationDate, expirationDate, documentUrl } = req.body;

  if (!itemId || !itemName || !batchNumber || !testResults || !certificationDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const coa = await service.createCOA({
    itemId,
    itemName,
    batchNumber,
    lotNumber,
    supplierId,
    supplierName,
    testResults,
    certificationDate,
    expirationDate,
    documentUrl,
  });

  res.status(201).json(coa);
}));

/**
 * POST /api/quality-central/coas/:id/verify
 * Verify a COA
 */
router.post('/coas/:id/verify', asyncHandler(async (req, res) => {
  const service = getService();
  const { verifiedBy, notes } = req.body;

  if (!verifiedBy) {
    return res.status(400).json({ error: 'verifiedBy is required' });
  }

  const coa = await service.verifyCOA(req.params.id, { verifiedBy, notes });
  if (!coa) {
    return res.status(404).json({ error: 'COA not found or not pending' });
  }

  res.json(coa);
}));

/**
 * POST /api/quality-central/coas/:id/reject
 * Reject a COA
 */
router.post('/coas/:id/reject', asyncHandler(async (req, res) => {
  const service = getService();
  const { rejectedBy, reason } = req.body;

  if (!rejectedBy || !reason) {
    return res.status(400).json({ error: 'rejectedBy and reason are required' });
  }

  const coa = await service.rejectCOA(req.params.id, { rejectedBy, reason });
  if (!coa) {
    return res.status(404).json({ error: 'COA not found or not pending' });
  }

  res.json(coa);
}));

// =============================================================================
// Checklist Management
// =============================================================================

/**
 * GET /api/quality-central/checklists
 * Get all checklists
 */
router.get('/checklists', asyncHandler(async (req, res) => {
  const service = getService();
  const checklists = await service.getChecklists();
  res.json(checklists);
}));

/**
 * GET /api/quality-central/checklists/:id
 * Get checklist by ID
 */
router.get('/checklists/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const checklist = await service.getChecklist(req.params.id);
  if (!checklist) {
    return res.status(404).json({ error: 'Checklist not found' });
  }
  res.json(checklist);
}));

export { router as qualityCentralRouter };
