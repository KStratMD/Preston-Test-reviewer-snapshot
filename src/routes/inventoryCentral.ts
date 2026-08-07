import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { InventoryCentralService, MovementType } from '../services/InventoryCentralService';

const router = express.Router();

/**
 * Get InventoryCentralService from DI container
 */
function getService(): InventoryCentralService {
  return container.get<InventoryCentralService>(TYPES.InventoryCentralService);
}

/**
 * InventoryCentral Dashboard API
 * GET /api/inventory-central/dashboard
 * Returns comprehensive inventory dashboard with stock levels, alerts, movements
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = getService();
  const dashboard = await service.getDashboard();
  res.json(dashboard);
}));

/**
 * Health check endpoint
 * GET /api/inventory-central/health
 */
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'inventory-central' });
});

/**
 * Get inventory metrics
 * GET /api/inventory-central/metrics
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  const service = getService();
  const metrics = await service.getInventoryMetrics();
  res.json(metrics);
}));

/**
 * Get all warehouses
 * GET /api/inventory-central/warehouses
 * Query params: status, type
 */
router.get('/warehouses', asyncHandler(async (req, res) => {
  const service = getService();
  const filters: {
    status?: 'active' | 'inactive' | 'maintenance';
    type?: 'distribution' | 'fulfillment' | 'manufacturing' | 'retail';
  } = {};

  if (req.query.status) {
    filters.status = req.query.status as typeof filters.status;
  }
  if (req.query.type) {
    filters.type = req.query.type as typeof filters.type;
  }

  const warehouses = await service.getWarehouses(filters);
  res.json(warehouses);
}));

/**
 * Get warehouse by ID
 * GET /api/inventory-central/warehouses/:id
 */
router.get('/warehouses/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const warehouse = await service.getWarehouse(req.params.id);

  if (!warehouse) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }

  res.json(warehouse);
}));

/**
 * Get warehouse utilization
 * GET /api/inventory-central/utilization
 */
router.get('/utilization', asyncHandler(async (req, res) => {
  const service = getService();
  const utilization = await service.getWarehouseUtilization();
  res.json(utilization);
}));

/**
 * Get all products
 * GET /api/inventory-central/products
 * Query params: status, category, search
 */
router.get('/products', asyncHandler(async (req, res) => {
  const service = getService();
  const filters: {
    status?: 'active' | 'discontinued' | 'pending' | 'seasonal';
    category?: string;
    search?: string;
  } = {};

  if (req.query.status) {
    filters.status = req.query.status as typeof filters.status;
  }
  if (req.query.category) {
    filters.category = req.query.category as string;
  }
  if (req.query.search) {
    filters.search = req.query.search as string;
  }

  const products = await service.getProducts(filters);
  res.json(products);
}));

/**
 * Get product by ID
 * GET /api/inventory-central/products/:id
 */
router.get('/products/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const product = await service.getProduct(req.params.id);

  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }

  res.json(product);
}));

/**
 * Get product by SKU
 * GET /api/inventory-central/products/sku/:sku
 */
router.get('/products/sku/:sku', asyncHandler(async (req, res) => {
  const service = getService();
  const product = await service.getProductBySku(req.params.sku);

  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }

  res.json(product);
}));

/**
 * Get stock levels
 * GET /api/inventory-central/stock
 * Query params: warehouseId, productId, status
 */
router.get('/stock', asyncHandler(async (req, res) => {
  const service = getService();
  const filters: {
    warehouseId?: string;
    productId?: string;
    status?: 'in_stock' | 'low_stock' | 'out_of_stock' | 'overstock';
  } = {};

  if (req.query.warehouseId) {
    filters.warehouseId = req.query.warehouseId as string;
  }
  if (req.query.productId) {
    filters.productId = req.query.productId as string;
  }
  if (req.query.status) {
    filters.status = req.query.status as typeof filters.status;
  }

  const stockLevels = await service.getStockLevels(filters);
  res.json(stockLevels);
}));

/**
 * Get stock level for specific product at warehouse
 * GET /api/inventory-central/stock/:productId/:warehouseId
 */
router.get('/stock/:productId/:warehouseId', asyncHandler(async (req, res) => {
  const service = getService();
  const stockLevel = await service.getStockLevel(req.params.productId, req.params.warehouseId);

  if (!stockLevel) {
    res.status(404).json({ error: 'Stock level not found' });
    return;
  }

  res.json(stockLevel);
}));

/**
 * Get low stock alerts
 * GET /api/inventory-central/alerts
 */
router.get('/alerts', asyncHandler(async (req, res) => {
  const service = getService();
  const alerts = await service.getLowStockAlerts();
  res.json(alerts);
}));

/**
 * Get reorder suggestions
 * GET /api/inventory-central/reorder-suggestions
 */
router.get('/reorder-suggestions', asyncHandler(async (req, res) => {
  const service = getService();
  const suggestions = await service.getReorderSuggestions();
  res.json(suggestions);
}));

/**
 * Get inventory valuation
 * GET /api/inventory-central/valuation
 */
router.get('/valuation', asyncHandler(async (req, res) => {
  const service = getService();
  const valuation = await service.getInventoryValuation();
  res.json(valuation);
}));

/**
 * Get recent movements
 * GET /api/inventory-central/movements
 * Query params: limit (default: 20)
 */
router.get('/movements', asyncHandler(async (req, res) => {
  const service = getService();
  const limit = parseInt(req.query.limit as string) || 20;
  const movements = await service.getRecentMovements(limit);
  res.json(movements);
}));

/**
 * Record an inventory movement
 * POST /api/inventory-central/movements
 * Body: { type, productId, quantity, fromWarehouseId?, toWarehouseId?, referenceNumber?, referenceType?, reason?, performedBy, notes? }
 */
router.post('/movements', asyncHandler(async (req, res) => {
  const service = getService();
  const { type, productId, quantity, fromWarehouseId, toWarehouseId, referenceNumber, referenceType, reason, performedBy, notes } = req.body;

  if (!type || !productId || quantity === undefined || !performedBy) {
    res.status(400).json({ success: false, message: 'type, productId, quantity, and performedBy are required' });
    return;
  }

  const validTypes: MovementType[] = ['receipt', 'shipment', 'transfer', 'adjustment', 'return', 'cycle_count'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ success: false, message: `Invalid movement type. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  const result = await service.recordMovement(type, productId, quantity, {
    fromWarehouseId,
    toWarehouseId,
    referenceNumber,
    referenceType,
    reason,
    performedBy,
    notes,
  });

  res.json(result);
}));

/**
 * Get cycle counts
 * GET /api/inventory-central/cycle-counts
 * Query params: warehouseId, status
 */
router.get('/cycle-counts', asyncHandler(async (req, res) => {
  const service = getService();
  const filters: {
    warehouseId?: string;
    status?: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  } = {};

  if (req.query.warehouseId) {
    filters.warehouseId = req.query.warehouseId as string;
  }
  if (req.query.status) {
    filters.status = req.query.status as typeof filters.status;
  }

  const cycleCounts = await service.getCycleCounts(filters);
  res.json(cycleCounts);
}));

/**
 * Get cycle count by ID
 * GET /api/inventory-central/cycle-counts/:id
 */
router.get('/cycle-counts/:id', asyncHandler(async (req, res) => {
  const service = getService();
  const cycleCount = await service.getCycleCount(req.params.id);

  if (!cycleCount) {
    res.status(404).json({ error: 'Cycle count not found' });
    return;
  }

  res.json(cycleCount);
}));

export { router as inventoryCentralRouter };
