/**
 * ShipStation 3PL Routes
 *
 * REST API endpoints for ShipStation shipping and fulfillment integration.
 * Created: January 8, 2026 (Phase 2 - SuiteCentral Parity)
 */

import { Router, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { ShipStationConnector } from '../connectors/ShipStationConnector';
import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import { getCount, buildPagination, parsePagination } from './paginationHelpers';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

const router = Router();

// Track initialization state
let connectorInitialized = false;

// Get connector and logger from DI container
const getConnector = (): IConnector => {
  return container.get<IConnector>(TYPES.ShipStationConnector);
};

const getLogger = (): Logger => {
  return container.get<Logger>(TYPES.Logger);
};

/**
 * Ensure connector is initialized before use.
 * Uses demo mode if no credentials are configured.
 */
const ensureInitialized = async (connector: IConnector): Promise<void> => {
  if (connectorInitialized) return;

  const logger = getLogger();
  logger.info('Initializing ShipStation connector for API routes');

  // Initialize with demo config - connector will detect demo mode automatically
  await connector.initialize({
    type: 'api_key',
    credentials: {
      apiKey: process.env.SHIPSTATION_API_KEY || 'demo_key',
      apiSecret: process.env.SHIPSTATION_API_SECRET || 'demo_secret',
    },
  });

  connectorInitialized = true;
};

/**
 * GET /api/shipstation/orders
 * List orders with optional filters
 */
router.get('/orders', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { status, orderNumber, startDate, endDate } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (status) filters.orderStatus = status;
    if (orderNumber) filters.orderNumber = orderNumber;
    if (startDate) filters.orderDateStart = startDate;
    if (endDate) filters.orderDateEnd = endDate;

    const orders = await connector.list('orders', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'orders', filters);
    res.json({
      orders,
      pagination: buildPagination(page, pageSize, orders.length, count),
    });
  } catch (error) {
    logger.error('Error fetching ShipStation orders', { error });
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/shipstation/orders/:orderNumber
 * Get order by order number
 */
router.get('/orders/:orderNumber', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    let order;
    if ('getOrderByNumber' in connector) {
      order = await (connector as ShipStationConnector).getOrderByNumber(req.params.orderNumber);
    } else {
      // Decorator wraps the connector — search by orderNumber field instead of ID lookup
      const results = await connector.search('orders', {
        filters: { orderNumber: req.params.orderNumber },
      });
      order = results[0] ?? null;
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    logger.error('Error fetching ShipStation order', { error, orderNumber: req.params.orderNumber });
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * POST /api/shipstation/orders/:orderId/ship
 * Mark order as shipped
 */
router.post('/orders/:orderId/ship', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const orderId = parseInt(req.params.orderId, 10);
    const { carrierCode, serviceCode, trackingNumber, shipDate, notifyCustomer } = req.body;

    if (!carrierCode) {
      return res.status(400).json({ error: 'Carrier code is required' });
    }

    if (!('markOrderShipped' in connector)) {
      return res.json({ success: true, message: 'Order marked as shipped (demo)' });
    }
    const order = await (connector as ShipStationConnector).markOrderShipped(orderId, {
      carrierCode,
      serviceCode,
      trackingNumber,
      shipDate,
      notifyCustomer,
    });

    res.json(order);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'shipstation.order.mark_shipped',
      resourceId: req.params.orderId,
    })) return;
    logger.error('Error marking order as shipped', { error, orderId: req.params.orderId });
    res.status(500).json({ error: 'Failed to mark order as shipped' });
  }
});

/**
 * GET /api/shipstation/shipments
 * List shipments with optional filters
 */
router.get('/shipments', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { startDate, endDate, carrierCode } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (startDate) filters.shipDateStart = startDate;
    if (endDate) filters.shipDateEnd = endDate;
    if (carrierCode) filters.carrierCode = carrierCode;

    const shipments = await connector.list('shipments', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'shipments', filters);
    res.json({
      shipments,
      pagination: buildPagination(page, pageSize, shipments.length, count),
    });
  } catch (error) {
    logger.error('Error fetching ShipStation shipments', { error });
    res.status(500).json({ error: 'Failed to fetch shipments' });
  }
});

/**
 * POST /api/shipstation/shipments/:shipmentId/void
 * Void a shipment label
 */
router.post('/shipments/:shipmentId/void', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const shipmentId = parseInt(req.params.shipmentId, 10);

    if (!('voidLabel' in connector)) {
      return res.json({ success: true, message: 'Label voided (demo)' });
    }
    const success = await (connector as ShipStationConnector).voidLabel(shipmentId);

    if (success) {
      res.json({ success: true, message: 'Label voided successfully' });
    } else {
      res.status(404).json({ error: 'Shipment not found or could not be voided' });
    }
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'shipstation.shipment.void',
      resourceId: req.params.shipmentId,
    })) return;
    logger.error('Error voiding shipment', { error, shipmentId: req.params.shipmentId });
    res.status(500).json({ error: 'Failed to void shipment' });
  }
});

/**
 * GET /api/shipstation/carriers
 * List available carriers
 */
router.get('/carriers', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const carriers = await connector.list('carriers', {});
    res.json(carriers);
  } catch (error) {
    logger.error('Error fetching ShipStation carriers', { error });
    res.status(500).json({ error: 'Failed to fetch carriers' });
  }
});

/**
 * GET /api/shipstation/warehouses
 * List warehouses
 */
router.get('/warehouses', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const warehouses = await connector.list('warehouses', {});
    res.json(warehouses);
  } catch (error) {
    logger.error('Error fetching ShipStation warehouses', { error });
    res.status(500).json({ error: 'Failed to fetch warehouses' });
  }
});

/**
 * GET /api/shipstation/products
 * List products with optional filters
 */
router.get('/products', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { sku, name } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (sku) filters.sku = sku;
    if (name) filters.name = name;

    const products = await connector.list('products', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'products', filters);
    res.json({
      products,
      pagination: buildPagination(page, pageSize, products.length, count),
    });
  } catch (error) {
    logger.error('Error fetching ShipStation products', { error });
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/**
 * POST /api/shipstation/rates
 * Get shipping rates
 */
router.post('/rates', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const {
      carrierCode,
      serviceCode,
      packageCode,
      fromPostalCode,
      toState,
      toCountry,
      toPostalCode,
      toCity,
      weight,
      dimensions,
      confirmation,
      residential,
    } = req.body;

    if (!carrierCode || !fromPostalCode || !toCountry || !toPostalCode || !weight) {
      return res.status(400).json({
        error: 'Missing required fields: carrierCode, fromPostalCode, toCountry, toPostalCode, weight',
      });
    }

    if (!('getShippingRates' in connector)) {
      return res.json({ rates: [] });
    }
    const rates = await (connector as ShipStationConnector).getShippingRates({
      carrierCode,
      serviceCode,
      packageCode,
      fromPostalCode,
      toState,
      toCountry,
      toPostalCode,
      toCity,
      weight,
      dimensions,
      confirmation,
      residential,
    });

    res.json({ rates });
  } catch (error) {
    logger.error('Error getting shipping rates', { error });
    res.status(500).json({ error: 'Failed to get shipping rates' });
  }
});

/**
 * GET /api/shipstation/tracking/:carrierCode/:trackingNumber
 * Get tracking information
 */
router.get('/tracking/:carrierCode/:trackingNumber', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { carrierCode, trackingNumber } = req.params;

    const events = 'getTrackingInfo' in connector
      ? await (connector as ShipStationConnector).getTrackingInfo(carrierCode, trackingNumber)
      : [];

    res.json({
      carrierCode,
      trackingNumber,
      events,
    });
  } catch (error) {
    logger.error('Error fetching tracking info', { error, ...req.params });
    res.status(500).json({ error: 'Failed to fetch tracking information' });
  }
});

/**
 * GET /api/shipstation/statistics
 * Get order statistics for dashboard
 */
router.get('/statistics', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);

    const orderCount = getCount(connector, 'orders');
    const shipmentCount = getCount(connector, 'shipments');

    // Only list entities whose counts are unknown — avoid unnecessary API calls.
    // NOTE: Real connectors return a single API page from list(), so fallback
    // totals may undercount large datasets. Accurate real-API totals require
    // connector-layer changes to surface API pagination metadata (future PR).
    const [ordersFallback, shipmentsFallback] = await Promise.all([
      orderCount === -1 ? connector.list('orders') : Promise.resolve(null),
      shipmentCount === -1 ? connector.list('shipments') : Promise.resolve(null),
    ]);

    res.json({
      totalOrders: orderCount !== -1 ? orderCount : ordersFallback!.length,
      totalShipments: shipmentCount !== -1 ? shipmentCount : shipmentsFallback!.length,
    });
  } catch (error) {
    logger.error('Error fetching ShipStation statistics', { error });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/shipstation/dashboard
 * Get dashboard summary data
 */
router.get('/dashboard', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);

    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
      10,
    );

    const pendingFilters = { orderStatus: 'awaiting_shipment' };
    const pendingCount = getCount(connector, 'orders', pendingFilters);
    const orderCount = getCount(connector, 'orders');
    const shipmentCount = getCount(connector, 'shipments');

    const [orders, shipments, carriers, warehouses, ordersFb, shipmentsFb] = await Promise.all([
      connector.list('orders', { filters: pendingFilters, limit: pageSize, offset }),
      connector.list('shipments', { limit: pageSize, offset }),
      connector.list('carriers', {}),
      connector.list('warehouses', {}),
      orderCount === -1 ? connector.list('orders') : Promise.resolve(null),
      shipmentCount === -1 ? connector.list('shipments') : Promise.resolve(null),
    ]);

    const statistics = {
      totalOrders: orderCount !== -1 ? orderCount : ordersFb!.length,
      totalShipments: shipmentCount !== -1 ? shipmentCount : shipmentsFb!.length,
    };

    res.json({
      statistics,
      pendingOrders: orders,
      recentShipments: shipments,
      carriers,
      warehouses,
      pendingOrdersPagination: buildPagination(page, pageSize, orders.length, pendingCount),
      shipmentsPagination: buildPagination(page, pageSize, shipments.length, shipmentCount),
    });
  } catch (error) {
    logger.error('Error fetching ShipStation dashboard', { error });
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/**
 * GET /api/shipstation/health
 * Health check endpoint
 */
router.get('/health', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const healthy = await connector.testConnection();

    res.json({
      status: healthy ? 'healthy' : 'unhealthy',
      connector: 'shipstation',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('ShipStation health check failed', { error });
    res.status(503).json({
      status: 'unhealthy',
      connector: 'shipstation',
      error: 'Health check failed',
    });
  }
});

export const shipStationRouter = router;
