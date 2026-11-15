/**
 * InventoryCentralService Tests
 * Tests for warehouse management, stock tracking, movements, reorder suggestions
 */

import { InventoryCentralService } from '../../../../src/services/InventoryCentralService';
import type { Logger } from '../../../../src/utils/Logger';

// Create mocks
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

describe('InventoryCentralService', () => {
  let service: InventoryCentralService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    service = new InventoryCentralService(mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with demo data', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('InventoryCentralService initialized');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'InventoryCentralService demo data initialized',
        expect.objectContaining({
          warehouses: expect.any(Number),
          products: expect.any(Number),
          stockLevels: expect.any(Number),
          movements: expect.any(Number),
          cycleCounts: expect.any(Number),
        })
      );
    });
  });

  describe('getDashboard', () => {
    it('should return comprehensive dashboard data', async () => {
      const dashboard = await service.getDashboard();

      expect(dashboard).toHaveProperty('summary');
      expect(dashboard).toHaveProperty('metrics');
      expect(dashboard).toHaveProperty('warehouseUtilization');
      expect(dashboard).toHaveProperty('lowStockItems');
      expect(dashboard).toHaveProperty('recentMovements');
      expect(dashboard).toHaveProperty('generatedAt');
    });

    it('should have valid summary values', async () => {
      const dashboard = await service.getDashboard();

      expect(dashboard.summary.totalSKUs).toBeGreaterThan(0);
      expect(dashboard.summary.inventoryValue).toBeGreaterThan(0);
      expect(typeof dashboard.summary.lowStockAlerts).toBe('number');
      expect(typeof dashboard.summary.reorderPending).toBe('number');
    });

    it('should include warehouse utilization', async () => {
      const dashboard = await service.getDashboard();

      expect(dashboard.warehouseUtilization.length).toBeGreaterThan(0);
      dashboard.warehouseUtilization.forEach(wh => {
        expect(wh).toHaveProperty('warehouseId');
        expect(wh).toHaveProperty('warehouseName');
        expect(wh).toHaveProperty('items');
        expect(wh).toHaveProperty('value');
        expect(wh).toHaveProperty('utilization');
      });
    });
  });

  describe('getInventoryMetrics', () => {
    it('should return inventory metrics', async () => {
      const metrics = await service.getInventoryMetrics();

      expect(metrics).toHaveProperty('totalItems');
      expect(metrics).toHaveProperty('totalSKUs');
      expect(metrics).toHaveProperty('activeSKUs');
      expect(metrics).toHaveProperty('discontinuedSKUs');
      expect(metrics).toHaveProperty('totalValue');
      expect(metrics).toHaveProperty('avgTurnoverRate');
      expect(metrics).toHaveProperty('stockoutRate');
      expect(metrics).toHaveProperty('overstockRate');
      expect(metrics).toHaveProperty('inventoryAccuracy');
      expect(metrics).toHaveProperty('lowStockCount');
      expect(metrics).toHaveProperty('outOfStockCount');
      expect(metrics).toHaveProperty('reorderPending');
    });

    it('should have positive item counts', async () => {
      const metrics = await service.getInventoryMetrics();

      expect(metrics.totalItems).toBeGreaterThan(0);
      expect(metrics.totalSKUs).toBeGreaterThan(0);
      expect(metrics.activeSKUs).toBeGreaterThan(0);
    });

    it('should have reasonable rates', async () => {
      const metrics = await service.getInventoryMetrics();

      expect(metrics.stockoutRate).toBeGreaterThanOrEqual(0);
      expect(metrics.stockoutRate).toBeLessThanOrEqual(100);
      expect(metrics.overstockRate).toBeGreaterThanOrEqual(0);
      expect(metrics.overstockRate).toBeLessThanOrEqual(100);
      expect(metrics.inventoryAccuracy).toBeGreaterThanOrEqual(0);
      expect(metrics.inventoryAccuracy).toBeLessThanOrEqual(100);
    });
  });

  describe('getWarehouses', () => {
    it('should return all warehouses', async () => {
      const warehouses = await service.getWarehouses();

      expect(warehouses.length).toBeGreaterThan(0);
      warehouses.forEach(wh => {
        expect(wh).toHaveProperty('id');
        expect(wh).toHaveProperty('name');
        expect(wh).toHaveProperty('code');
        expect(wh).toHaveProperty('type');
        expect(wh).toHaveProperty('status');
        expect(wh).toHaveProperty('capacity');
        expect(wh).toHaveProperty('currentUtilization');
      });
    });

    it('should filter by status', async () => {
      const activeWarehouses = await service.getWarehouses({ status: 'active' });

      activeWarehouses.forEach(wh => {
        expect(wh.status).toBe('active');
      });
    });

    it('should filter by type', async () => {
      const distributionWarehouses = await service.getWarehouses({ type: 'distribution' });

      distributionWarehouses.forEach(wh => {
        expect(wh.type).toBe('distribution');
      });
    });

    it('should sort by name', async () => {
      const warehouses = await service.getWarehouses();

      for (let i = 0; i < warehouses.length - 1; i++) {
        expect(warehouses[i].name.localeCompare(warehouses[i + 1].name)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('getWarehouse', () => {
    it('should return warehouse by ID', async () => {
      const warehouses = await service.getWarehouses();
      const warehouse = await service.getWarehouse(warehouses[0].id);

      expect(warehouse).toBeDefined();
      expect(warehouse!.id).toBe(warehouses[0].id);
    });

    it('should return undefined for non-existent warehouse', async () => {
      const warehouse = await service.getWarehouse('non-existent-id');
      expect(warehouse).toBeUndefined();
    });
  });

  describe('getProducts', () => {
    it('should return all products', async () => {
      const products = await service.getProducts();

      expect(products.length).toBeGreaterThan(0);
      products.forEach(product => {
        expect(product).toHaveProperty('id');
        expect(product).toHaveProperty('sku');
        expect(product).toHaveProperty('name');
        expect(product).toHaveProperty('category');
        expect(product).toHaveProperty('cost');
        expect(product).toHaveProperty('price');
        expect(product).toHaveProperty('status');
      });
    });

    it('should filter by status', async () => {
      const activeProducts = await service.getProducts({ status: 'active' });

      activeProducts.forEach(product => {
        expect(product.status).toBe('active');
      });
    });

    it('should filter by category', async () => {
      const products = await service.getProducts();
      const category = products[0].category;
      const filteredProducts = await service.getProducts({ category });

      filteredProducts.forEach(product => {
        expect(product.category).toBe(category);
      });
    });

    it('should search by keyword', async () => {
      const products = await service.getProducts({ search: 'Widget' });

      products.forEach(product => {
        const searchable = `${product.sku} ${product.name} ${product.description}`.toLowerCase();
        expect(searchable).toContain('widget');
      });
    });

    it('should sort by SKU', async () => {
      const products = await service.getProducts();

      for (let i = 0; i < products.length - 1; i++) {
        expect(products[i].sku.localeCompare(products[i + 1].sku)).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('getProduct', () => {
    it('should return product by ID', async () => {
      const products = await service.getProducts();
      const product = await service.getProduct(products[0].id);

      expect(product).toBeDefined();
      expect(product!.id).toBe(products[0].id);
    });

    it('should return undefined for non-existent product', async () => {
      const product = await service.getProduct('non-existent-id');
      expect(product).toBeUndefined();
    });
  });

  describe('getProductBySku', () => {
    it('should return product by SKU', async () => {
      const products = await service.getProducts();
      const product = await service.getProductBySku(products[0].sku);

      expect(product).toBeDefined();
      expect(product!.sku).toBe(products[0].sku);
    });

    it('should return undefined for non-existent SKU', async () => {
      const product = await service.getProductBySku('NON-EXISTENT-SKU');
      expect(product).toBeUndefined();
    });
  });

  describe('getStockLevels', () => {
    it('should return all stock levels', async () => {
      const stockLevels = await service.getStockLevels();

      expect(stockLevels.length).toBeGreaterThan(0);
      stockLevels.forEach(stock => {
        expect(stock).toHaveProperty('productId');
        expect(stock).toHaveProperty('sku');
        expect(stock).toHaveProperty('warehouseId');
        expect(stock).toHaveProperty('quantityOnHand');
        expect(stock).toHaveProperty('quantityAvailable');
        expect(stock).toHaveProperty('quantityReserved');
        expect(stock).toHaveProperty('stockStatus');
      });
    });

    it('should filter by warehouse', async () => {
      const warehouses = await service.getWarehouses();
      const stockLevels = await service.getStockLevels({ warehouseId: warehouses[0].id });

      stockLevels.forEach(stock => {
        expect(stock.warehouseId).toBe(warehouses[0].id);
      });
    });

    it('should filter by product', async () => {
      const products = await service.getProducts();
      const stockLevels = await service.getStockLevels({ productId: products[0].id });

      stockLevels.forEach(stock => {
        expect(stock.productId).toBe(products[0].id);
      });
    });

    it('should filter by stock status', async () => {
      const lowStockLevels = await service.getStockLevels({ status: 'low_stock' });

      lowStockLevels.forEach(stock => {
        expect(stock.stockStatus).toBe('low_stock');
      });
    });
  });

  describe('getStockLevel', () => {
    it('should return stock level for specific product and warehouse', async () => {
      const stockLevels = await service.getStockLevels();
      const stock = stockLevels[0];
      const result = await service.getStockLevel(stock.productId, stock.warehouseId);

      expect(result).toBeDefined();
      expect(result!.productId).toBe(stock.productId);
      expect(result!.warehouseId).toBe(stock.warehouseId);
    });

    it('should return undefined for non-existent combination', async () => {
      const result = await service.getStockLevel('non-existent', 'non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('getLowStockAlerts', () => {
    it('should return low stock alerts', async () => {
      const alerts = await service.getLowStockAlerts();

      // May or may not have alerts depending on demo data
      alerts.forEach(alert => {
        expect(alert).toHaveProperty('productId');
        expect(alert).toHaveProperty('sku');
        expect(alert).toHaveProperty('currentStock');
        expect(alert).toHaveProperty('reorderPoint');
        expect(alert).toHaveProperty('daysToStockout');
        expect(alert).toHaveProperty('priority');
        expect(alert).toHaveProperty('suggestedAction');
        expect(alert.currentStock).toBeLessThan(alert.reorderPoint);
      });
    });

    it('should sort by priority', async () => {
      const alerts = await service.getLowStockAlerts();
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

      for (let i = 0; i < alerts.length - 1; i++) {
        expect(priorityOrder[alerts[i].priority]).toBeLessThanOrEqual(priorityOrder[alerts[i + 1].priority]);
      }
    });
  });

  describe('getRecentMovements', () => {
    it('should return recent movements', async () => {
      const movements = await service.getRecentMovements();

      expect(movements.length).toBeGreaterThan(0);
      movements.forEach(mov => {
        expect(mov).toHaveProperty('id');
        expect(mov).toHaveProperty('type');
        expect(mov).toHaveProperty('productId');
        expect(mov).toHaveProperty('quantity');
        expect(mov).toHaveProperty('timestamp');
        expect(mov).toHaveProperty('performedBy');
      });
    });

    it('should respect limit parameter', async () => {
      const movements = await service.getRecentMovements(3);
      expect(movements.length).toBeLessThanOrEqual(3);
    });

    it('should sort by timestamp descending', async () => {
      const movements = await service.getRecentMovements();

      for (let i = 0; i < movements.length - 1; i++) {
        expect(movements[i].timestamp).toBeGreaterThanOrEqual(movements[i + 1].timestamp);
      }
    });
  });

  describe('getInventoryValuation', () => {
    it('should return inventory valuation', async () => {
      const valuation = await service.getInventoryValuation();

      expect(valuation).toHaveProperty('totalValue');
      expect(valuation).toHaveProperty('totalItems');
      expect(valuation).toHaveProperty('totalSKUs');
      expect(valuation).toHaveProperty('byWarehouse');
      expect(valuation).toHaveProperty('byCategory');
      expect(valuation).toHaveProperty('currency');
      expect(valuation).toHaveProperty('asOfDate');
    });

    it('should have warehouse breakdown', async () => {
      const valuation = await service.getInventoryValuation();

      expect(valuation.byWarehouse.length).toBeGreaterThan(0);
      valuation.byWarehouse.forEach(wh => {
        expect(wh).toHaveProperty('warehouseId');
        expect(wh).toHaveProperty('warehouseName');
        expect(wh).toHaveProperty('value');
        expect(wh).toHaveProperty('items');
      });
    });

    it('should have category breakdown with percentages', async () => {
      const valuation = await service.getInventoryValuation();

      expect(valuation.byCategory.length).toBeGreaterThan(0);
      valuation.byCategory.forEach(cat => {
        expect(cat).toHaveProperty('category');
        expect(cat).toHaveProperty('value');
        expect(cat).toHaveProperty('items');
        expect(cat).toHaveProperty('percentage');
        expect(cat.percentage).toBeGreaterThanOrEqual(0);
        expect(cat.percentage).toBeLessThanOrEqual(100);
      });
    });

    it('should use USD as currency', async () => {
      const valuation = await service.getInventoryValuation();
      expect(valuation.currency).toBe('USD');
    });
  });

  describe('getReorderSuggestions', () => {
    it('should return reorder suggestions', async () => {
      const suggestions = await service.getReorderSuggestions();

      suggestions.forEach(suggestion => {
        expect(suggestion).toHaveProperty('productId');
        expect(suggestion).toHaveProperty('sku');
        expect(suggestion).toHaveProperty('currentStock');
        expect(suggestion).toHaveProperty('reorderPoint');
        expect(suggestion).toHaveProperty('suggestedQuantity');
        expect(suggestion).toHaveProperty('estimatedCost');
        expect(suggestion).toHaveProperty('priority');
        expect(suggestion).toHaveProperty('reason');
        expect(suggestion.currentStock).toBeLessThan(suggestion.reorderPoint);
      });
    });

    it('should sort by priority', async () => {
      const suggestions = await service.getReorderSuggestions();
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

      for (let i = 0; i < suggestions.length - 1; i++) {
        expect(priorityOrder[suggestions[i].priority]).toBeLessThanOrEqual(priorityOrder[suggestions[i + 1].priority]);
      }
    });
  });

  describe('recordMovement', () => {
    it('should record receipt movement', async () => {
      const products = await service.getProducts({ status: 'active' });
      const warehouses = await service.getWarehouses();
      const product = products[0];
      const warehouse = warehouses[0];

      const initialStock = await service.getStockLevel(product.id, warehouse.id);
      const initialQty = initialStock?.quantityOnHand || 0;

      const result = await service.recordMovement('receipt', product.id, 100, {
        toWarehouseId: warehouse.id,
        referenceNumber: 'PO-TEST-001',
        referenceType: 'purchase_order',
        performedBy: 'test@company.com',
      });

      expect(result.success).toBe(true);
      expect(result.movement).toBeDefined();
      expect(result.movement!.type).toBe('receipt');
      expect(result.movement!.quantity).toBe(100);

      const updatedStock = await service.getStockLevel(product.id, warehouse.id);
      expect(updatedStock!.quantityOnHand).toBe(initialQty + 100);
    });

    it('should record shipment movement', async () => {
      const stockLevels = await service.getStockLevels({ status: 'in_stock' });
      const stockWithQuantity = stockLevels.find(s => s.quantityAvailable >= 10);

      if (stockWithQuantity) {
        const initialQty = stockWithQuantity.quantityOnHand;

        const result = await service.recordMovement('shipment', stockWithQuantity.productId, 10, {
          fromWarehouseId: stockWithQuantity.warehouseId,
          referenceNumber: 'SO-TEST-001',
          referenceType: 'sales_order',
          performedBy: 'test@company.com',
        });

        expect(result.success).toBe(true);

        const updatedStock = await service.getStockLevel(stockWithQuantity.productId, stockWithQuantity.warehouseId);
        expect(updatedStock!.quantityOnHand).toBe(initialQty - 10);
      }
    });

    it('should record transfer movement', async () => {
      const stockLevels = await service.getStockLevels({ status: 'in_stock' });
      const warehouses = await service.getWarehouses();
      const stockWithQuantity = stockLevels.find(s => s.quantityAvailable >= 5);

      if (stockWithQuantity && warehouses.length >= 2) {
        const targetWarehouse = warehouses.find(w => w.id !== stockWithQuantity.warehouseId);

        if (targetWarehouse) {
          const result = await service.recordMovement('transfer', stockWithQuantity.productId, 5, {
            fromWarehouseId: stockWithQuantity.warehouseId,
            toWarehouseId: targetWarehouse.id,
            referenceNumber: 'TO-TEST-001',
            referenceType: 'transfer_order',
            performedBy: 'test@company.com',
          });

          expect(result.success).toBe(true);
          expect(result.movement!.type).toBe('transfer');
        }
      }
    });

    it('should fail for non-existent product', async () => {
      const warehouses = await service.getWarehouses();

      const result = await service.recordMovement('receipt', 'non-existent-product', 100, {
        toWarehouseId: warehouses[0].id,
        performedBy: 'test@company.com',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should fail for non-existent warehouse', async () => {
      const products = await service.getProducts();

      const result = await service.recordMovement('receipt', products[0].id, 100, {
        toWarehouseId: 'non-existent-warehouse',
        performedBy: 'test@company.com',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should fail for insufficient stock on shipment', async () => {
      const stockLevels = await service.getStockLevels();
      const stock = stockLevels[0];

      const result = await service.recordMovement('shipment', stock.productId, stock.quantityAvailable + 1000, {
        fromWarehouseId: stock.warehouseId,
        referenceNumber: 'SO-TEST-002',
        referenceType: 'sales_order',
        performedBy: 'test@company.com',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Insufficient stock');
    });
  });

  describe('getCycleCounts', () => {
    it('should return cycle counts', async () => {
      const cycleCounts = await service.getCycleCounts();

      expect(cycleCounts.length).toBeGreaterThan(0);
      cycleCounts.forEach(cc => {
        expect(cc).toHaveProperty('id');
        expect(cc).toHaveProperty('warehouseId');
        expect(cc).toHaveProperty('status');
        expect(cc).toHaveProperty('scheduledDate');
        expect(cc).toHaveProperty('items');
        expect(cc).toHaveProperty('totalItems');
        expect(cc).toHaveProperty('itemsCounted');
      });
    });

    it('should filter by warehouse', async () => {
      const warehouses = await service.getWarehouses();
      const cycleCounts = await service.getCycleCounts({ warehouseId: warehouses[0].id });

      cycleCounts.forEach(cc => {
        expect(cc.warehouseId).toBe(warehouses[0].id);
      });
    });

    it('should filter by status', async () => {
      const cycleCounts = await service.getCycleCounts({ status: 'in_progress' });

      cycleCounts.forEach(cc => {
        expect(cc.status).toBe('in_progress');
      });
    });
  });

  describe('getCycleCount', () => {
    it('should return cycle count by ID', async () => {
      const cycleCounts = await service.getCycleCounts();
      const cycleCount = await service.getCycleCount(cycleCounts[0].id);

      expect(cycleCount).toBeDefined();
      expect(cycleCount!.id).toBe(cycleCounts[0].id);
    });

    it('should return undefined for non-existent cycle count', async () => {
      const cycleCount = await service.getCycleCount('non-existent-id');
      expect(cycleCount).toBeUndefined();
    });
  });

  describe('inventory calculations', () => {
    it('should calculate days of supply correctly', () => {
      expect(service.calculateDaysOfSupply(100, 10)).toBe(10);
      expect(service.calculateDaysOfSupply(100, 0)).toBe(999);
      expect(service.calculateDaysOfSupply(50, 7)).toBe(8); // Rounds up
    });

    it('should calculate reorder point correctly', () => {
      // ROP = (daily sales × lead time) + safety stock
      expect(service.calculateReorderPoint(10, 7, 20)).toBe(90); // (10*7)+20 = 90
      expect(service.calculateReorderPoint(5, 14, 10)).toBe(80); // (5*14)+10 = 80
    });

    it('should calculate EOQ correctly', () => {
      // EOQ = sqrt((2 × annual demand × ordering cost) / holding cost)
      // sqrt((2 × 1000 × 50) / 2) = sqrt(50000) ≈ 224
      const eoq = service.calculateEOQ(1000, 50, 2);
      expect(eoq).toBe(224);
    });

    it('should handle zero holding cost in EOQ', () => {
      const eoq = service.calculateEOQ(1000, 50, 0);
      expect(eoq).toBe(0);
    });
  });
});
