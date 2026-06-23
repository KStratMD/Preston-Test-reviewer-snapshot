/**
 * Fixture Connector API Routes
 *
 * Provides API endpoints for testing planned connectors using fixture data.
 * Enables AI agent testing and development without requiring real API credentials.
 */

import { Router, Request, Response } from 'express';
import { MockConnectorAdapter } from '../connectors/MockConnectorAdapter';
import { SystemId } from '../connectors/fixtures';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { guardedWrite } from '../governance/sourceOfTruth/guardedWrite';
import type { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import type { SourceSystem } from '../governance/sourceOfTruth/SourceOfTruthManifest';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import { extractIdentityContext } from '../services/governance/identityContext';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../services/governance/ApprovalQueueService';

// OwnershipResolver and ApprovalQueueService are async-bound (toDynamicValue with await);
// AuditService is sync-bound but kept on the async path for uniformity.
const getOwnershipResolver = (): Promise<OwnershipResolver> =>
  container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);

const getAuditService = (): AuditService =>
  container.get<AuditService>(TYPES.AuditService);

const getApprovalQueueService = (): Promise<ApprovalQueueService> =>
  container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);

const router = Router();

// System ID type guard
function isValidSystemId(systemId: string): systemId is SystemId {
  const validSystems: SystemId[] = [
    'squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce',
    'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero'
  ];
  return validSystems.includes(systemId as SystemId);
}

/**
 * GET /api/fixtures/:systemId/test-connection
 * Test connection to fixture-based connector
 */
router.get('/:systemId/test-connection', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const result = await connector.testConnection();

    res.json({
      success: true,
      ...result
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

/**
 * GET /api/fixtures/:systemId/customers
 * List customers from fixture data
 */
router.get('/:systemId/customers', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const customers = await connector.listCustomers();

    res.json({
      success: true,
      systemId,
      count: customers.length,
      data: customers
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/customers/:id
 * Get single customer by ID
 */
router.get('/:systemId/customers/:id', async (req: Request, res: Response) => {
  try {
    const { systemId, id } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const customer = await connector.getCustomer(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: `Customer not found: ${id}`
      });
    }

    res.json({
      success: true,
      systemId,
      data: customer
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/fixtures/:systemId/customers
 * Create customer (mock - returns data with generated ID)
 */
router.post('/:systemId/customers', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    // Copilot R10 on PR #851: map the validated `:systemId` to the
    // corresponding canonical SourceSystem so guardedWrite audits and
    // ownership-evaluates against the actual target rather than always
    // 'squire'. Copilot R18 on PR #851: previously fell back to 'squire'
    // for unmapped fixture systems (quickbooks, woocommerce, square, xero,
    // etc.) — but since this value feeds guardedWrite as `targetSystem`
    // and the route hardcodes `entity: 'customer'`, an unmapped fixture
    // hitting customer (NetSuite-owned) would be evaluated as Squire
    // writing a NetSuite-owned customer → 409 ownership_blocked even
    // though the user intent is a demo write. Reject upfront with 400
    // so the operator sees the unmapped-system condition explicitly.
    const FIXTURE_SYSTEM_TO_SOURCE: Readonly<Record<string, SourceSystem>> = {
      netsuite: 'netsuite',
      salesforce: 'salesforce',
      businesscentral: 'business_central',
      hubspot: 'hubspot',
      shipstation: 'shipstation',
      stripe: 'stripe',
      shopify: 'shopify',
      squire: 'squire',
      suiteCentral: 'squire',
    };
    const mappedTargetSystem = FIXTURE_SYSTEM_TO_SOURCE[systemId];
    if (!mappedTargetSystem) {
      res.status(400).json({
        error: 'unmapped_fixture_system',
        message: `Fixture system '${systemId}' has no SourceSystem mapping; cannot evaluate ownership policy. Add an entry to FIXTURE_SYSTEM_TO_SOURCE or use a mapped system.`,
        systemId,
        mappedSystems: Object.keys(FIXTURE_SYSTEM_TO_SOURCE),
      });
      return;
    }
    const targetSourceSystem: SourceSystem = mappedTargetSystem;

    const customer = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: targetSourceSystem,
          entity: 'customer',
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'create',
        },
        do: () => connector.createCustomer(req.body),
      },
      {
        ownershipResolver: await getOwnershipResolver(),
        auditService: getAuditService(),
        approvalQueueService: await getApprovalQueueService(),
      },
    );

    res.status(201).json({
      success: true,
      systemId,
      data: customer,
      message: 'Mock customer created (fixture mode - not persisted)'
    });
  } catch (error: unknown) {
    // Copilot R1 (PR 13b) cluster-A5: guardedWrite throws
    // WriteBlockedError subclasses (OwnershipViolationError /
    // OwnershipBlockedError / LoopDetectedError) and
    // OwnershipPendingApprovalError on the queue_for_human path. Without
    // delegating to handleApprovalQueueError first, every ownership block
    // would surface as a 500 instead of the PR's contract:
    //   - 409 { error: 'ownership_violation' | ... } for hard blocks
    //   - 202 { pendingApprovalId, pollUrl } for queued writes
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'fixture.customer',
      resourceId: 'new',
    })) return;
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/products
 * List products from fixture data
 */
router.get('/:systemId/products', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const products = await connector.listProducts();

    res.json({
      success: true,
      systemId,
      count: products.length,
      data: products
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/orders
 * List orders from fixture data
 */
router.get('/:systemId/orders', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const orders = await connector.listOrders();

    res.json({
      success: true,
      systemId,
      count: orders.length,
      data: orders
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/orders/:id
 * Get single order by ID
 */
router.get('/:systemId/orders/:id', async (req: Request, res: Response) => {
  try {
    const { systemId, id } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const order = await connector.getOrder(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: `Order not found: ${id}`
      });
    }

    res.json({
      success: true,
      systemId,
      data: order
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/vendors
 * List vendors from fixture data
 */
router.get('/:systemId/vendors', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const vendors = await connector.listVendors();

    res.json({
      success: true,
      systemId,
      count: vendors.length,
      data: vendors
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/invoices
 * List invoices from fixture data
 */
router.get('/:systemId/invoices', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const invoices = await connector.listInvoices();

    res.json({
      success: true,
      systemId,
      count: invoices.length,
      data: invoices
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/inventory
 * List inventory from fixture data
 */
router.get('/:systemId/inventory', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const inventory = await connector.listInventory();

    res.json({
      success: true,
      systemId,
      count: inventory.length,
      data: inventory
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/:systemId/metadata
 * Get connector metadata
 */
router.get('/:systemId/metadata', async (req: Request, res: Response) => {
  try {
    const { systemId } = req.params;

    if (!isValidSystemId(systemId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid system ID: ${systemId}`,
        validSystems: ['squire', 'suiteCentral', 'quickbooks', 'shopify', 'woocommerce', 'square', 'salesforce', 'businesscentral', 'netsuite', 'stripe', 'xero']
      });
    }

    const connector = new MockConnectorAdapter(systemId);
    await connector.initialize();

    const metadata = connector.getMetadata();

    res.json({
      success: true,
      data: metadata
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/netsuite/env-credentials
 * Get NetSuite credentials from environment variables
 */
router.get('/netsuite/env-credentials', async (req: Request, res: Response) => {
  try {
    const credentials = {
      accountId: process.env.NETSUITE_ACCOUNT_ID || '',
      consumerKey: process.env.NETSUITE_CONSUMER_KEY || '',
      consumerSecret: process.env.NETSUITE_CONSUMER_SECRET || '',
      tokenId: process.env.NETSUITE_TOKEN_ID || '',
      tokenSecret: process.env.NETSUITE_TOKEN_SECRET || '',
      baseUrl: process.env.NETSUITE_ACCOUNT_ID
        ? `https://${process.env.NETSUITE_ACCOUNT_ID.replace('_', '-').toLowerCase()}.suitetalk.api.netsuite.com`
        : 'https://system.netsuite.com'
    };

    // Check if at least account ID is present
    if (!credentials.accountId) {
      return res.status(404).json({
        success: false,
        error: 'NetSuite credentials not found in environment variables',
        message: 'Please set NETSUITE_ACCOUNT_ID, NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET in .env file'
      });
    }

    res.json({
      success: true,
      credentials,
      source: 'environment'
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/fixtures/available-systems
 * List all available fixture-based systems
 */
router.get('/available-systems', async (req: Request, res: Response) => {
  try {
    const systems: SystemId[] = [
      'squire', 'quickbooks', 'shopify', 'woocommerce',
      'square', 'salesforce', 'businesscentral'
    ];

    const systemsInfo = await Promise.all(
      systems.map(async (systemId) => {
        try {
          const connector = new MockConnectorAdapter(systemId);
          await connector.initialize();
          const testResult = await connector.testConnection();

          return {
            systemId,
            status: 'available',
            ...(testResult.details as any)
          };
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          return {
            systemId,
            status: 'error',
            error: err.message
          };
        }
      })
    );

    res.json({
      success: true,
      count: systemsInfo.length,
      systems: systemsInfo
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

export default router;
