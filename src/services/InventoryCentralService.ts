import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';

/**
 * Warehouse location
 */
export interface Warehouse {
  id: string;
  name: string;
  code: string;
  address: string;
  city: string;
  state: string;
  country: string;
  type: 'distribution' | 'fulfillment' | 'manufacturing' | 'retail';
  status: 'active' | 'inactive' | 'maintenance';
  capacity: number;
  currentUtilization: number;
  contactEmail: string;
  contactPhone: string;
  netSuiteId?: string;
  createdAt: number;
}

/**
 * Product/SKU definition
 */
export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  subcategory?: string;
  uom: string; // Unit of measure
  cost: number;
  price: number;
  weight: number;
  weightUnit: 'lb' | 'kg' | 'oz' | 'g';
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: 'in' | 'cm';
  };
  status: 'active' | 'discontinued' | 'pending' | 'seasonal';
  reorderPoint: number;
  reorderQuantity: number;
  leadTimeDays: number;
  safetyStock: number;
  maxStock: number;
  vendorId?: string;
  vendorName?: string;
  netSuiteId?: string;
  barcode?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Stock level at a specific warehouse
 */
export interface StockLevel {
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityReserved: number;
  quantityOnOrder: number;
  quantityInTransit: number;
  reorderPoint: number;
  reorderQuantity: number;
  lastCountDate?: number;
  lastMovementDate?: number;
  averageDailySales: number;
  daysOfSupply: number;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock' | 'overstock';
}

/**
 * Low stock alert
 */
export interface LowStockAlert {
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  currentStock: number;
  reorderPoint: number;
  reorderQuantity: number;
  daysToStockout: number;
  estimatedStockoutDate: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedAction: string;
  vendorId?: string;
  vendorName?: string;
  leadTimeDays: number;
}

/**
 * Inventory movement types
 */
export type MovementType = 'receipt' | 'shipment' | 'transfer' | 'adjustment' | 'return' | 'cycle_count';

/**
 * Inventory movement record
 */
export interface InventoryMovement {
  id: string;
  type: MovementType;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  fromWarehouseId?: string;
  fromWarehouseName?: string;
  toWarehouseId?: string;
  toWarehouseName?: string;
  referenceNumber?: string;
  referenceType?: 'purchase_order' | 'sales_order' | 'transfer_order' | 'work_order';
  reason?: string;
  cost: number;
  performedBy: string;
  timestamp: number;
  notes?: string;
  netSuiteId?: string;
}

/**
 * Reorder suggestion
 */
export interface ReorderSuggestion {
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  currentStock: number;
  reorderPoint: number;
  suggestedQuantity: number;
  estimatedCost: number;
  vendorId?: string;
  vendorName?: string;
  leadTimeDays: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

/**
 * Cycle count record
 */
export interface CycleCount {
  id: string;
  warehouseId: string;
  warehouseName: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduledDate: number;
  startedAt?: number;
  completedAt?: number;
  assignedTo: string;
  items: CycleCountItem[];
  totalItems: number;
  itemsCounted: number;
  varianceCount: number;
  varianceValue: number;
}

/**
 * Cycle count item
 */
export interface CycleCountItem {
  productId: string;
  sku: string;
  productName: string;
  location: string;
  systemQuantity: number;
  countedQuantity?: number;
  variance?: number;
  varianceValue?: number;
  status: 'pending' | 'counted' | 'verified';
}

/**
 * Inventory valuation summary
 */
export interface InventoryValuation {
  totalValue: number;
  totalItems: number;
  totalSKUs: number;
  byWarehouse: {
    warehouseId: string;
    warehouseName: string;
    value: number;
    items: number;
  }[];
  byCategory: {
    category: string;
    value: number;
    items: number;
    percentage: number;
  }[];
  currency: string;
  asOfDate: number;
}

/**
 * Inventory metrics
 */
export interface InventoryMetrics {
  totalItems: number;
  totalSKUs: number;
  activeSKUs: number;
  discontinuedSKUs: number;
  totalValue: number;
  avgTurnoverRate: number;
  stockoutRate: number;
  overstockRate: number;
  inventoryAccuracy: number;
  avgDaysOfSupply: number;
  lowStockCount: number;
  outOfStockCount: number;
  reorderPending: number;
  currency: string;
  calculatedAt: number;
}

/**
 * Dashboard response
 */
export interface InventoryCentralDashboard {
  summary: {
    totalSKUs: number;
    lowStockAlerts: number;
    reorderPending: number;
    inventoryValue: number;
  };
  metrics: InventoryMetrics;
  warehouseUtilization: {
    warehouseId: string;
    warehouseName: string;
    items: number;
    value: number;
    utilization: number;
  }[];
  lowStockItems: LowStockAlert[];
  recentMovements: InventoryMovement[];
  generatedAt: number;
}

/**
 * InventoryCentralService
 *
 * Provides comprehensive inventory management including:
 * - Multi-warehouse inventory tracking
 * - SKU/product management
 * - Stock level monitoring
 * - Reorder point algorithms
 * - Low stock alerts
 * - Inventory movements (receipts, transfers, shipments, adjustments)
 * - Cycle count management
 * - Inventory valuation
 */
@injectable()
export class InventoryCentralService {
  // Demo data stores
  private warehouses = new Map<string, Warehouse>();
  private products = new Map<string, Product>();
  private stockLevels = new Map<string, StockLevel>(); // key: `${productId}-${warehouseId}`
  private movements = new Map<string, InventoryMovement>();
  private cycleCounts = new Map<string, CycleCount>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {
    this.logger.info('InventoryCentralService initialized');
    this.initializeDemoData();
  }

  /**
   * Initialize demo data for testing and development
   */
  private initializeDemoData(): void {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // Initialize Warehouses
    const warehousesData: Warehouse[] = [
      { id: 'wh-main', name: 'Main Distribution Center', code: 'MAIN', address: '100 Industrial Blvd', city: 'Dallas', state: 'TX', country: 'USA', type: 'distribution', status: 'active', capacity: 100000, currentUtilization: 82, contactEmail: 'main@warehouse.com', contactPhone: '555-100-0001', createdAt: now - 365 * day },
      { id: 'wh-west', name: 'West Coast Fulfillment', code: 'WEST', address: '200 Pacific Ave', city: 'Los Angeles', state: 'CA', country: 'USA', type: 'fulfillment', status: 'active', capacity: 50000, currentUtilization: 71, contactEmail: 'west@warehouse.com', contactPhone: '555-200-0002', createdAt: now - 180 * day },
      { id: 'wh-east', name: 'East Coast Distribution', code: 'EAST', address: '300 Atlantic Way', city: 'Newark', state: 'NJ', country: 'USA', type: 'distribution', status: 'active', capacity: 45000, currentUtilization: 75, contactEmail: 'east@warehouse.com', contactPhone: '555-300-0003', createdAt: now - 120 * day },
    ];
    warehousesData.forEach(wh => this.warehouses.set(wh.id, wh));

    // Initialize Products
    const productsData: Product[] = [
      { id: 'prod-001', sku: 'SKU-4521', name: 'Widget Assembly A', description: 'Primary widget assembly unit', category: 'Assemblies', uom: 'EA', cost: 45.00, price: 89.99, weight: 2.5, weightUnit: 'lb', status: 'active', reorderPoint: 50, reorderQuantity: 200, leadTimeDays: 14, safetyStock: 25, maxStock: 500, vendorId: 'vend-1', vendorName: 'Parts Supplier Co', createdAt: now - 300 * day, updatedAt: now - 5 * day },
      { id: 'prod-002', sku: 'SKU-2341', name: 'Component X-42', description: 'Critical component for assembly', category: 'Components', uom: 'EA', cost: 12.50, price: 24.99, weight: 0.5, weightUnit: 'lb', status: 'active', reorderPoint: 25, reorderQuantity: 100, leadTimeDays: 7, safetyStock: 15, maxStock: 300, vendorId: 'vend-2', vendorName: 'Component World', createdAt: now - 280 * day, updatedAt: now - 10 * day },
      { id: 'prod-003', sku: 'SKU-7892', name: 'Module B-7', description: 'Electronic module B series', category: 'Modules', uom: 'EA', cost: 78.00, price: 149.99, weight: 1.2, weightUnit: 'lb', status: 'active', reorderPoint: 40, reorderQuantity: 150, leadTimeDays: 21, safetyStock: 20, maxStock: 400, vendorId: 'vend-3', vendorName: 'Tech Modules Inc', createdAt: now - 250 * day, updatedAt: now - 3 * day },
      { id: 'prod-004', sku: 'SKU-1234', name: 'Standard Bracket', description: 'Universal mounting bracket', category: 'Hardware', uom: 'EA', cost: 3.25, price: 7.99, weight: 0.3, weightUnit: 'lb', status: 'active', reorderPoint: 100, reorderQuantity: 500, leadTimeDays: 5, safetyStock: 50, maxStock: 1000, vendorId: 'vend-4', vendorName: 'Hardware Direct', createdAt: now - 200 * day, updatedAt: now - 1 * day },
      { id: 'prod-005', sku: 'SKU-5678', name: 'Power Supply Unit', description: '12V DC power supply', category: 'Electronics', uom: 'EA', cost: 35.00, price: 69.99, weight: 1.8, weightUnit: 'lb', status: 'active', reorderPoint: 30, reorderQuantity: 100, leadTimeDays: 10, safetyStock: 15, maxStock: 250, vendorId: 'vend-5', vendorName: 'Power Tech', createdAt: now - 180 * day, updatedAt: now - 7 * day },
      { id: 'prod-006', sku: 'SKU-9012', name: 'Cable Assembly Kit', description: 'Complete wiring harness kit', category: 'Cables', uom: 'KIT', cost: 22.00, price: 44.99, weight: 0.8, weightUnit: 'lb', status: 'active', reorderPoint: 60, reorderQuantity: 200, leadTimeDays: 8, safetyStock: 30, maxStock: 500, vendorId: 'vend-6', vendorName: 'Cable Solutions', createdAt: now - 160 * day, updatedAt: now - 2 * day },
      { id: 'prod-007', sku: 'SKU-3456', name: 'Sensor Module Pro', description: 'Advanced sensing module', category: 'Sensors', uom: 'EA', cost: 95.00, price: 189.99, weight: 0.4, weightUnit: 'lb', status: 'active', reorderPoint: 20, reorderQuantity: 80, leadTimeDays: 28, safetyStock: 10, maxStock: 200, vendorId: 'vend-7', vendorName: 'Sensor Tech', createdAt: now - 140 * day, updatedAt: now - 4 * day },
      { id: 'prod-008', sku: 'SKU-7890', name: 'Display Panel 7"', description: '7 inch LCD display panel', category: 'Displays', uom: 'EA', cost: 65.00, price: 129.99, weight: 0.6, weightUnit: 'lb', status: 'active', reorderPoint: 25, reorderQuantity: 100, leadTimeDays: 18, safetyStock: 12, maxStock: 250, vendorId: 'vend-8', vendorName: 'Display World', createdAt: now - 120 * day, updatedAt: now - 6 * day },
      { id: 'prod-009', sku: 'SKU-OLD-001', name: 'Legacy Controller', description: 'Discontinued controller unit', category: 'Controllers', uom: 'EA', cost: 120.00, price: 0, weight: 2.0, weightUnit: 'lb', status: 'discontinued', reorderPoint: 0, reorderQuantity: 0, leadTimeDays: 0, safetyStock: 0, maxStock: 0, vendorId: 'vend-9', vendorName: 'Old Parts Inc', createdAt: now - 500 * day, updatedAt: now - 100 * day },
      { id: 'prod-010', sku: 'SKU-SEASON-01', name: 'Holiday Bundle Pack', description: 'Seasonal promotional bundle', category: 'Bundles', uom: 'PACK', cost: 85.00, price: 149.99, weight: 5.0, weightUnit: 'lb', status: 'seasonal', reorderPoint: 50, reorderQuantity: 200, leadTimeDays: 14, safetyStock: 25, maxStock: 600, vendorId: 'vend-1', vendorName: 'Parts Supplier Co', createdAt: now - 60 * day, updatedAt: now - 1 * day },
    ];
    productsData.forEach(prod => this.products.set(prod.id, prod));

    // Initialize Stock Levels
    const stockData: Omit<StockLevel, 'stockStatus'>[] = [
      // Main warehouse
      { productId: 'prod-001', sku: 'SKU-4521', productName: 'Widget Assembly A', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 12, quantityAvailable: 10, quantityReserved: 2, quantityOnOrder: 200, quantityInTransit: 0, reorderPoint: 50, reorderQuantity: 200, averageDailySales: 4, daysOfSupply: 3, lastMovementDate: now - 1 * day },
      { productId: 'prod-002', sku: 'SKU-2341', productName: 'Component X-42', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 8, quantityAvailable: 5, quantityReserved: 3, quantityOnOrder: 100, quantityInTransit: 50, reorderPoint: 25, reorderQuantity: 100, averageDailySales: 4, daysOfSupply: 2, lastMovementDate: now - 2 * day },
      { productId: 'prod-003', sku: 'SKU-7892', productName: 'Module B-7', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 15, quantityAvailable: 12, quantityReserved: 3, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 40, reorderQuantity: 150, averageDailySales: 3, daysOfSupply: 5, lastMovementDate: now - 1 * day },
      { productId: 'prod-004', sku: 'SKU-1234', productName: 'Standard Bracket', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 850, quantityAvailable: 800, quantityReserved: 50, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 100, reorderQuantity: 500, averageDailySales: 25, daysOfSupply: 34, lastMovementDate: now - 0.5 * day },
      { productId: 'prod-005', sku: 'SKU-5678', productName: 'Power Supply Unit', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 145, quantityAvailable: 130, quantityReserved: 15, quantityOnOrder: 0, quantityInTransit: 100, reorderPoint: 30, reorderQuantity: 100, averageDailySales: 5, daysOfSupply: 29, lastMovementDate: now - 3 * day },
      { productId: 'prod-006', sku: 'SKU-9012', productName: 'Cable Assembly Kit', warehouseId: 'wh-main', warehouseName: 'Main Distribution Center', quantityOnHand: 320, quantityAvailable: 280, quantityReserved: 40, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 60, reorderQuantity: 200, averageDailySales: 12, daysOfSupply: 27, lastMovementDate: now - 1 * day },
      // West warehouse
      { productId: 'prod-001', sku: 'SKU-4521', productName: 'Widget Assembly A', warehouseId: 'wh-west', warehouseName: 'West Coast Fulfillment', quantityOnHand: 45, quantityAvailable: 40, quantityReserved: 5, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 50, reorderQuantity: 200, averageDailySales: 2, daysOfSupply: 22, lastMovementDate: now - 2 * day },
      { productId: 'prod-004', sku: 'SKU-1234', productName: 'Standard Bracket', warehouseId: 'wh-west', warehouseName: 'West Coast Fulfillment', quantityOnHand: 420, quantityAvailable: 400, quantityReserved: 20, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 100, reorderQuantity: 500, averageDailySales: 15, daysOfSupply: 28, lastMovementDate: now - 1 * day },
      { productId: 'prod-007', sku: 'SKU-3456', productName: 'Sensor Module Pro', warehouseId: 'wh-west', warehouseName: 'West Coast Fulfillment', quantityOnHand: 65, quantityAvailable: 60, quantityReserved: 5, quantityOnOrder: 80, quantityInTransit: 0, reorderPoint: 20, reorderQuantity: 80, averageDailySales: 2, daysOfSupply: 32, lastMovementDate: now - 4 * day },
      // East warehouse
      { productId: 'prod-002', sku: 'SKU-2341', productName: 'Component X-42', warehouseId: 'wh-east', warehouseName: 'East Coast Distribution', quantityOnHand: 92, quantityAvailable: 85, quantityReserved: 7, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 25, reorderQuantity: 100, averageDailySales: 3, daysOfSupply: 31, lastMovementDate: now - 1 * day },
      { productId: 'prod-005', sku: 'SKU-5678', productName: 'Power Supply Unit', warehouseId: 'wh-east', warehouseName: 'East Coast Distribution', quantityOnHand: 78, quantityAvailable: 70, quantityReserved: 8, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 30, reorderQuantity: 100, averageDailySales: 3, daysOfSupply: 26, lastMovementDate: now - 2 * day },
      { productId: 'prod-008', sku: 'SKU-7890', productName: 'Display Panel 7"', warehouseId: 'wh-east', warehouseName: 'East Coast Distribution', quantityOnHand: 55, quantityAvailable: 50, quantityReserved: 5, quantityOnOrder: 0, quantityInTransit: 0, reorderPoint: 25, reorderQuantity: 100, averageDailySales: 2, daysOfSupply: 27, lastMovementDate: now - 3 * day },
    ];

    stockData.forEach(stock => {
      const stockLevel: StockLevel = {
        ...stock,
        stockStatus: this.calculateStockStatus(stock.quantityOnHand, stock.reorderPoint, stock.reorderQuantity * 2),
      };
      this.stockLevels.set(`${stock.productId}-${stock.warehouseId}`, stockLevel);
    });

    // Initialize Inventory Movements
    const movementsData: InventoryMovement[] = [
      { id: 'mov-001', type: 'receipt', productId: 'prod-004', sku: 'SKU-1234', productName: 'Standard Bracket', quantity: 500, toWarehouseId: 'wh-main', toWarehouseName: 'Main Distribution Center', referenceNumber: 'PO-2024-1234', referenceType: 'purchase_order', cost: 1625.00, performedBy: 'warehouse@company.com', timestamp: now - 0.5 * day },
      { id: 'mov-002', type: 'transfer', productId: 'prod-005', sku: 'SKU-5678', productName: 'Power Supply Unit', quantity: 100, fromWarehouseId: 'wh-main', fromWarehouseName: 'Main Distribution Center', toWarehouseId: 'wh-east', toWarehouseName: 'East Coast Distribution', referenceNumber: 'TO-2024-567', referenceType: 'transfer_order', cost: 3500.00, performedBy: 'logistics@company.com', timestamp: now - 1 * day },
      { id: 'mov-003', type: 'shipment', productId: 'prod-006', sku: 'SKU-9012', productName: 'Cable Assembly Kit', quantity: 250, fromWarehouseId: 'wh-main', fromWarehouseName: 'Main Distribution Center', referenceNumber: 'SO-2024-8901', referenceType: 'sales_order', cost: 5500.00, performedBy: 'fulfillment@company.com', timestamp: now - 2 * day },
      { id: 'mov-004', type: 'adjustment', productId: 'prod-002', sku: 'SKU-2341', productName: 'Component X-42', quantity: -5, toWarehouseId: 'wh-main', toWarehouseName: 'Main Distribution Center', reason: 'Damaged inventory write-off', cost: -62.50, performedBy: 'inventory@company.com', timestamp: now - 3 * day },
      { id: 'mov-005', type: 'return', productId: 'prod-001', sku: 'SKU-4521', productName: 'Widget Assembly A', quantity: 10, toWarehouseId: 'wh-main', toWarehouseName: 'Main Distribution Center', referenceNumber: 'RMA-2024-456', reason: 'Customer return - defective', cost: 450.00, performedBy: 'returns@company.com', timestamp: now - 4 * day },
      { id: 'mov-006', type: 'receipt', productId: 'prod-007', sku: 'SKU-3456', productName: 'Sensor Module Pro', quantity: 80, toWarehouseId: 'wh-west', toWarehouseName: 'West Coast Fulfillment', referenceNumber: 'PO-2024-1235', referenceType: 'purchase_order', cost: 7600.00, performedBy: 'warehouse@company.com', timestamp: now - 5 * day },
    ];
    movementsData.forEach(mov => this.movements.set(mov.id, mov));

    // Initialize Cycle Counts
    const cycleCountsData: CycleCount[] = [
      {
        id: 'cc-001',
        warehouseId: 'wh-main',
        warehouseName: 'Main Distribution Center',
        status: 'in_progress',
        scheduledDate: now - 1 * day,
        startedAt: now - 0.5 * day,
        assignedTo: 'counter@company.com',
        items: [
          { productId: 'prod-001', sku: 'SKU-4521', productName: 'Widget Assembly A', location: 'A-01-01', systemQuantity: 12, countedQuantity: 11, variance: -1, varianceValue: -45, status: 'counted' },
          { productId: 'prod-002', sku: 'SKU-2341', productName: 'Component X-42', location: 'A-02-03', systemQuantity: 8, status: 'pending' },
          { productId: 'prod-004', sku: 'SKU-1234', productName: 'Standard Bracket', location: 'B-01-02', systemQuantity: 850, countedQuantity: 852, variance: 2, varianceValue: 6.50, status: 'counted' },
        ],
        totalItems: 3,
        itemsCounted: 2,
        varianceCount: 2,
        varianceValue: -38.50,
      },
    ];
    cycleCountsData.forEach(cc => this.cycleCounts.set(cc.id, cc));

    this.logger.info('InventoryCentralService demo data initialized', {
      warehouses: this.warehouses.size,
      products: this.products.size,
      stockLevels: this.stockLevels.size,
      movements: this.movements.size,
      cycleCounts: this.cycleCounts.size,
    });
  }

  /**
   * Calculate stock status based on quantity levels
   */
  private calculateStockStatus(onHand: number, reorderPoint: number, maxStock: number): StockLevel['stockStatus'] {
    if (onHand <= 0) return 'out_of_stock';
    if (onHand < reorderPoint) return 'low_stock';
    if (onHand > maxStock) return 'overstock';
    return 'in_stock';
  }

  /**
   * Get the full inventory central dashboard
   */
  public async getDashboard(): Promise<InventoryCentralDashboard> {
    this.logger.info('Generating InventoryCentral dashboard');

    const metrics = await this.getInventoryMetrics();
    const lowStockAlerts = await this.getLowStockAlerts();
    const recentMovements = await this.getRecentMovements(10);
    const warehouseUtilization = await this.getWarehouseUtilization();

    return {
      summary: {
        totalSKUs: metrics.totalSKUs,
        lowStockAlerts: lowStockAlerts.length,
        reorderPending: metrics.reorderPending,
        inventoryValue: metrics.totalValue,
      },
      metrics,
      warehouseUtilization,
      lowStockItems: lowStockAlerts.slice(0, 10),
      recentMovements,
      generatedAt: Date.now(),
    };
  }

  /**
   * Get inventory metrics
   */
  public async getInventoryMetrics(): Promise<InventoryMetrics> {
    const products = Array.from(this.products.values());
    const stockLevels = Array.from(this.stockLevels.values());

    const activeSKUs = products.filter(p => p.status === 'active').length;
    const discontinuedSKUs = products.filter(p => p.status === 'discontinued').length;

    // Calculate total items and value
    let totalItems = 0;
    let totalValue = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let overstockCount = 0;
    let totalDaysOfSupply = 0;

    stockLevels.forEach(stock => {
      const product = this.products.get(stock.productId);
      if (product) {
        totalItems += stock.quantityOnHand;
        totalValue += stock.quantityOnHand * product.cost;
        totalDaysOfSupply += stock.daysOfSupply;

        if (stock.stockStatus === 'low_stock') lowStockCount++;
        if (stock.stockStatus === 'out_of_stock') outOfStockCount++;
        if (stock.stockStatus === 'overstock') overstockCount++;
      }
    });

    // Count reorder suggestions
    const reorderPending = stockLevels.filter(s => s.quantityOnHand < s.reorderPoint && s.quantityOnOrder === 0).length;

    // Calculate rates
    const stockoutRate = stockLevels.length > 0 ? (outOfStockCount / stockLevels.length) * 100 : 0;
    const overstockRate = stockLevels.length > 0 ? (overstockCount / stockLevels.length) * 100 : 0;
    const avgDaysOfSupply = stockLevels.length > 0 ? totalDaysOfSupply / stockLevels.length : 0;

    return {
      totalItems,
      totalSKUs: products.length,
      activeSKUs,
      discontinuedSKUs,
      totalValue: Math.round(totalValue * 100) / 100,
      avgTurnoverRate: 6.2, // Demo value - would calculate from historical data
      stockoutRate: Math.round(stockoutRate * 10) / 10,
      overstockRate: Math.round(overstockRate * 10) / 10,
      inventoryAccuracy: 98.7, // Demo value - would calculate from cycle counts
      avgDaysOfSupply: Math.round(avgDaysOfSupply),
      lowStockCount,
      outOfStockCount,
      reorderPending,
      currency: 'USD',
      calculatedAt: Date.now(),
    };
  }

  /**
   * Get warehouse utilization
   */
  public async getWarehouseUtilization(): Promise<InventoryCentralDashboard['warehouseUtilization']> {
    const warehouses = Array.from(this.warehouses.values());
    const stockLevels = Array.from(this.stockLevels.values());

    return warehouses.map(warehouse => {
      const warehouseStock = stockLevels.filter(s => s.warehouseId === warehouse.id);
      const items = warehouseStock.reduce((sum, s) => sum + s.quantityOnHand, 0);
      const value = warehouseStock.reduce((sum, s) => {
        const product = this.products.get(s.productId);
        return sum + (product ? s.quantityOnHand * product.cost : 0);
      }, 0);

      return {
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        items,
        value: Math.round(value * 100) / 100,
        utilization: warehouse.currentUtilization,
      };
    });
  }

  /**
   * Get low stock alerts
   */
  public async getLowStockAlerts(): Promise<LowStockAlert[]> {
    const stockLevels = Array.from(this.stockLevels.values());
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const alerts: LowStockAlert[] = [];

    stockLevels.forEach(stock => {
      if (stock.quantityOnHand < stock.reorderPoint) {
        const product = this.products.get(stock.productId);
        if (product && product.status === 'active') {
          const daysToStockout = stock.averageDailySales > 0
            ? Math.ceil(stock.quantityAvailable / stock.averageDailySales)
            : 999;

          let priority: LowStockAlert['priority'] = 'low';
          if (daysToStockout <= 1) priority = 'critical';
          else if (daysToStockout <= 3) priority = 'high';
          else if (daysToStockout <= 7) priority = 'medium';

          alerts.push({
            productId: stock.productId,
            sku: stock.sku,
            productName: stock.productName,
            warehouseId: stock.warehouseId,
            warehouseName: stock.warehouseName,
            currentStock: stock.quantityOnHand,
            reorderPoint: stock.reorderPoint,
            reorderQuantity: stock.reorderQuantity,
            daysToStockout,
            estimatedStockoutDate: now + daysToStockout * day,
            priority,
            suggestedAction: stock.quantityOnOrder > 0
              ? `PO in transit (${stock.quantityOnOrder} units)`
              : `Create PO for ${stock.reorderQuantity} units`,
            vendorId: product.vendorId,
            vendorName: product.vendorName,
            leadTimeDays: product.leadTimeDays,
          });
        }
      }
    });

    // Sort by priority and days to stockout
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return alerts.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.daysToStockout - b.daysToStockout;
    });
  }

  /**
   * Get recent inventory movements
   */
  public async getRecentMovements(limit = 20): Promise<InventoryMovement[]> {
    const movements = Array.from(this.movements.values());
    return movements
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get all warehouses
   */
  public async getWarehouses(filters?: {
    status?: Warehouse['status'];
    type?: Warehouse['type'];
  }): Promise<Warehouse[]> {
    let warehouses = Array.from(this.warehouses.values());

    if (filters?.status) {
      warehouses = warehouses.filter(wh => wh.status === filters.status);
    }
    if (filters?.type) {
      warehouses = warehouses.filter(wh => wh.type === filters.type);
    }

    return warehouses.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get warehouse by ID
   */
  public async getWarehouse(warehouseId: string): Promise<Warehouse | undefined> {
    return this.warehouses.get(warehouseId);
  }

  /**
   * Get all products
   */
  public async getProducts(filters?: {
    status?: Product['status'];
    category?: string;
    search?: string;
  }): Promise<Product[]> {
    let products = Array.from(this.products.values());

    if (filters?.status) {
      products = products.filter(p => p.status === filters.status);
    }
    if (filters?.category) {
      products = products.filter(p => p.category === filters.category);
    }
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      products = products.filter(p =>
        p.sku.toLowerCase().includes(searchLower) ||
        p.name.toLowerCase().includes(searchLower) ||
        p.description.toLowerCase().includes(searchLower)
      );
    }

    return products.sort((a, b) => a.sku.localeCompare(b.sku));
  }

  /**
   * Get product by ID
   */
  public async getProduct(productId: string): Promise<Product | undefined> {
    return this.products.get(productId);
  }

  /**
   * Get product by SKU
   */
  public async getProductBySku(sku: string): Promise<Product | undefined> {
    return Array.from(this.products.values()).find(p => p.sku === sku);
  }

  /**
   * Get stock levels with optional filters
   */
  public async getStockLevels(filters?: {
    warehouseId?: string;
    productId?: string;
    status?: StockLevel['stockStatus'];
  }): Promise<StockLevel[]> {
    let stockLevels = Array.from(this.stockLevels.values());

    if (filters?.warehouseId) {
      stockLevels = stockLevels.filter(s => s.warehouseId === filters.warehouseId);
    }
    if (filters?.productId) {
      stockLevels = stockLevels.filter(s => s.productId === filters.productId);
    }
    if (filters?.status) {
      stockLevels = stockLevels.filter(s => s.stockStatus === filters.status);
    }

    return stockLevels.sort((a, b) => a.sku.localeCompare(b.sku));
  }

  /**
   * Get stock level for a specific product at a specific warehouse
   */
  public async getStockLevel(productId: string, warehouseId: string): Promise<StockLevel | undefined> {
    return this.stockLevels.get(`${productId}-${warehouseId}`);
  }

  /**
   * Get inventory valuation
   */
  public async getInventoryValuation(): Promise<InventoryValuation> {
    const stockLevels = Array.from(this.stockLevels.values());
    const warehouses = Array.from(this.warehouses.values());

    let totalValue = 0;
    let totalItems = 0;
    const uniqueSkus = new Set<string>();
    const categoryTotals = new Map<string, { value: number; items: number }>();
    const warehouseTotals = new Map<string, { value: number; items: number }>();

    stockLevels.forEach(stock => {
      const product = this.products.get(stock.productId);
      if (product) {
        const value = stock.quantityOnHand * product.cost;
        totalValue += value;
        totalItems += stock.quantityOnHand;
        uniqueSkus.add(stock.sku);

        // By category
        const categoryKey = product.category;
        const categoryData = categoryTotals.get(categoryKey) || { value: 0, items: 0 };
        categoryData.value += value;
        categoryData.items += stock.quantityOnHand;
        categoryTotals.set(categoryKey, categoryData);

        // By warehouse
        const whData = warehouseTotals.get(stock.warehouseId) || { value: 0, items: 0 };
        whData.value += value;
        whData.items += stock.quantityOnHand;
        warehouseTotals.set(stock.warehouseId, whData);
      }
    });

    const byWarehouse = warehouses.map(wh => {
      const data = warehouseTotals.get(wh.id) || { value: 0, items: 0 };
      return {
        warehouseId: wh.id,
        warehouseName: wh.name,
        value: Math.round(data.value * 100) / 100,
        items: data.items,
      };
    });

    const byCategory = Array.from(categoryTotals.entries()).map(([category, data]) => ({
      category,
      value: Math.round(data.value * 100) / 100,
      items: data.items,
      percentage: totalValue > 0 ? Math.round((data.value / totalValue) * 1000) / 10 : 0,
    })).sort((a, b) => b.value - a.value);

    return {
      totalValue: Math.round(totalValue * 100) / 100,
      totalItems,
      totalSKUs: uniqueSkus.size,
      byWarehouse,
      byCategory,
      currency: 'USD',
      asOfDate: Date.now(),
    };
  }

  /**
   * Get reorder suggestions
   */
  public async getReorderSuggestions(): Promise<ReorderSuggestion[]> {
    const stockLevels = Array.from(this.stockLevels.values());
    const suggestions: ReorderSuggestion[] = [];

    stockLevels.forEach(stock => {
      if (stock.quantityOnHand < stock.reorderPoint && stock.quantityOnOrder === 0) {
        const product = this.products.get(stock.productId);
        if (product && product.status === 'active') {
          const daysToStockout = stock.averageDailySales > 0
            ? Math.ceil(stock.quantityAvailable / stock.averageDailySales)
            : 999;

          let priority: ReorderSuggestion['priority'] = 'low';
          if (daysToStockout <= 1) priority = 'critical';
          else if (daysToStockout <= 3) priority = 'high';
          else if (daysToStockout <= 7) priority = 'medium';

          suggestions.push({
            productId: stock.productId,
            sku: stock.sku,
            productName: stock.productName,
            warehouseId: stock.warehouseId,
            warehouseName: stock.warehouseName,
            currentStock: stock.quantityOnHand,
            reorderPoint: stock.reorderPoint,
            suggestedQuantity: stock.reorderQuantity,
            estimatedCost: stock.reorderQuantity * product.cost,
            vendorId: product.vendorId,
            vendorName: product.vendorName,
            leadTimeDays: product.leadTimeDays,
            priority,
            reason: `Stock (${stock.quantityOnHand}) below reorder point (${stock.reorderPoint})`,
          });
        }
      }
    });

    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * Record an inventory movement
   */
  public async recordMovement(
    type: MovementType,
    productId: string,
    quantity: number,
    options: {
      fromWarehouseId?: string;
      toWarehouseId?: string;
      referenceNumber?: string;
      referenceType?: InventoryMovement['referenceType'];
      reason?: string;
      performedBy: string;
      notes?: string;
    }
  ): Promise<{ success: boolean; message: string; movement?: InventoryMovement }> {
    const product = this.products.get(productId);
    if (!product) {
      return { success: false, message: `Product ${productId} not found` };
    }

    // Validate warehouse(s)
    if (options.fromWarehouseId && !this.warehouses.has(options.fromWarehouseId)) {
      return { success: false, message: `From warehouse ${options.fromWarehouseId} not found` };
    }
    if (options.toWarehouseId && !this.warehouses.has(options.toWarehouseId)) {
      return { success: false, message: `To warehouse ${options.toWarehouseId} not found` };
    }

    // Validate quantity for shipments/transfers
    if ((type === 'shipment' || type === 'transfer') && options.fromWarehouseId) {
      const stockLevel = this.stockLevels.get(`${productId}-${options.fromWarehouseId}`);
      if (!stockLevel || stockLevel.quantityAvailable < quantity) {
        return {
          success: false,
          message: `Insufficient stock. Available: ${stockLevel?.quantityAvailable || 0}, Requested: ${quantity}`,
        };
      }
    }

    const movementId = `mov-${Date.now()}`;
    const movement: InventoryMovement = {
      id: movementId,
      type,
      productId,
      sku: product.sku,
      productName: product.name,
      quantity,
      fromWarehouseId: options.fromWarehouseId,
      fromWarehouseName: options.fromWarehouseId ? this.warehouses.get(options.fromWarehouseId)?.name : undefined,
      toWarehouseId: options.toWarehouseId,
      toWarehouseName: options.toWarehouseId ? this.warehouses.get(options.toWarehouseId)?.name : undefined,
      referenceNumber: options.referenceNumber,
      referenceType: options.referenceType,
      reason: options.reason,
      cost: quantity * product.cost,
      performedBy: options.performedBy,
      timestamp: Date.now(),
      notes: options.notes,
    };

    // Update stock levels
    if (options.fromWarehouseId) {
      const fromStock = this.stockLevels.get(`${productId}-${options.fromWarehouseId}`);
      if (fromStock) {
        fromStock.quantityOnHand -= quantity;
        fromStock.quantityAvailable -= quantity;
        fromStock.lastMovementDate = Date.now();
        fromStock.stockStatus = this.calculateStockStatus(fromStock.quantityOnHand, fromStock.reorderPoint, fromStock.reorderQuantity * 2);
      }
    }

    if (options.toWarehouseId) {
      const toKey = `${productId}-${options.toWarehouseId}`;
      let toStock = this.stockLevels.get(toKey);
      if (!toStock) {
        // Create new stock record
        const warehouse = this.warehouses.get(options.toWarehouseId)!;
        toStock = {
          productId,
          sku: product.sku,
          productName: product.name,
          warehouseId: options.toWarehouseId,
          warehouseName: warehouse.name,
          quantityOnHand: 0,
          quantityAvailable: 0,
          quantityReserved: 0,
          quantityOnOrder: 0,
          quantityInTransit: 0,
          reorderPoint: product.reorderPoint,
          reorderQuantity: product.reorderQuantity,
          averageDailySales: 0,
          daysOfSupply: 0,
          stockStatus: 'out_of_stock',
        };
        this.stockLevels.set(toKey, toStock);
      }
      toStock.quantityOnHand += quantity;
      toStock.quantityAvailable += quantity;
      toStock.lastMovementDate = Date.now();
      toStock.stockStatus = this.calculateStockStatus(toStock.quantityOnHand, toStock.reorderPoint, toStock.reorderQuantity * 2);
    }

    this.movements.set(movementId, movement);
    this.logger.info('Inventory movement recorded', { movementId, type, productId, quantity });

    return {
      success: true,
      message: `${type} of ${quantity} units recorded for ${product.sku}`,
      movement,
    };
  }

  /**
   * Get cycle counts
   */
  public async getCycleCounts(filters?: {
    warehouseId?: string;
    status?: CycleCount['status'];
  }): Promise<CycleCount[]> {
    let counts = Array.from(this.cycleCounts.values());

    if (filters?.warehouseId) {
      counts = counts.filter(cc => cc.warehouseId === filters.warehouseId);
    }
    if (filters?.status) {
      counts = counts.filter(cc => cc.status === filters.status);
    }

    return counts.sort((a, b) => b.scheduledDate - a.scheduledDate);
  }

  /**
   * Get cycle count by ID
   */
  public async getCycleCount(cycleCountId: string): Promise<CycleCount | undefined> {
    return this.cycleCounts.get(cycleCountId);
  }

  /**
   * Calculate days of supply based on current stock and average daily sales
   */
  public calculateDaysOfSupply(currentStock: number, averageDailySales: number): number {
    if (averageDailySales <= 0) return 999;
    return Math.ceil(currentStock / averageDailySales);
  }

  /**
   * Calculate reorder point based on lead time and safety stock
   */
  public calculateReorderPoint(averageDailySales: number, leadTimeDays: number, safetyStock: number): number {
    return Math.ceil(averageDailySales * leadTimeDays + safetyStock);
  }

  /**
   * Calculate economic order quantity (EOQ)
   */
  public calculateEOQ(annualDemand: number, orderingCost: number, holdingCostPerUnit: number): number {
    if (holdingCostPerUnit <= 0) return 0;
    return Math.ceil(Math.sqrt((2 * annualDemand * orderingCost) / holdingCostPerUnit));
  }
}
