/**
 * HubSpot CRM Routes
 *
 * REST API endpoints for HubSpot CRM integration.
 * Created: January 8, 2026 (Phase 3 - SuiteCentral Parity)
 */

import { Router, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { HubSpotConnector } from '../connectors/HubSpotConnector';
import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import { getCount, buildPagination, parsePagination } from './paginationHelpers';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import { guardedWrite } from '../governance/sourceOfTruth/guardedWrite';
import type { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import { extractIdentityContext } from '../services/governance/identityContext';
import { extractOperatorOverride } from '../services/governance/operatorOverride';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../services/governance/ApprovalQueueService';

const router = Router();

// Track initialization state
let connectorInitialized = false;

// Get connector and logger from DI container
const getConnector = (): IConnector => {
  return container.get<IConnector>(TYPES.HubSpotConnector);
};

const getLogger = (): Logger => {
  return container.get<Logger>(TYPES.Logger);
};

// OwnershipResolver + ApprovalQueueService are bound via `toDynamicValue(async)`
// in inversify.config.ts (their transitive deps include the async-bound
// DatabaseService — see [[feedback-inversify-async-databaseservice-cascade]]),
// so the resolvers MUST be async. Copilot R1 (PR 13b) cluster-A6 finding:
// the prior sync `container.get(...)` calls returned an unresolved Promise on
// cold-start, which would have crashed every HubSpot guarded write with
// "validateWrite is not a function" the moment a route was first hit.
//
// AuditService stays sync — its toDynamicValue factory is synchronous and
// depends only on sync-bound services (Logger, AuditLogRepository,
// OutboundGovernanceService); see inversify.config.ts:780-787.
const getOwnershipResolver = (): Promise<OwnershipResolver> =>
  container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);

const getAuditService = (): AuditService =>
  container.get<AuditService>(TYPES.AuditService);

const getApprovalQueueService = (): Promise<ApprovalQueueService> =>
  container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);

/**
 * Resolve the trio of governance services that every guardedWrite call needs.
 * `OwnershipResolver` and `ApprovalQueueService` are async-bound so this
 * helper batches the two awaits behind a single tuple destructure for callers.
 */
async function getGuardedWriteDeps(): Promise<{
  ownershipResolver: OwnershipResolver;
  auditService: AuditService;
  approvalQueueService: ApprovalQueueService;
}> {
  const [ownershipResolver, approvalQueueService] = await Promise.all([
    getOwnershipResolver(),
    getApprovalQueueService(),
  ]);
  return {
    ownershipResolver,
    auditService: getAuditService(),
    approvalQueueService,
  };
}

/**
 * Ensure connector is initialized before use.
 * Uses demo mode if no credentials are configured.
 */
const ensureInitialized = async (connector: IConnector): Promise<void> => {
  if (connectorInitialized) return;

  const logger = getLogger();
  logger.info('Initializing HubSpot connector for API routes');

  // Initialize with demo config - connector will detect demo mode automatically
  await connector.initialize({
    type: 'api_key',
    credentials: {
      apiKey: process.env.HUBSPOT_API_KEY || 'demo_key',
    },
  });

  connectorInitialized = true;
};

/**
 * GET /api/hubspot/contacts
 * List contacts with optional filters
 */
router.get('/contacts', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { email, company, lifecyclestage } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (email) filters.email = email;
    if (company) filters.company = company;
    if (lifecyclestage) filters.lifecyclestage = lifecyclestage;

    const contacts = await connector.list('contacts', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'contacts', filters);
    res.json({
      contacts,
      pagination: buildPagination(page, pageSize, contacts.length, count),
    });
  } catch (error) {
    logger.error('Error fetching HubSpot contacts', { error });
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

/**
 * GET /api/hubspot/contacts/:id
 * Get contact by ID
 */
router.get('/contacts/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const contact = await connector.read('contacts', req.params.id);

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(contact);
  } catch (error) {
    logger.error('Error fetching HubSpot contact', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

/**
 * POST /api/hubspot/contacts
 * Create a new contact
 */
router.post('/contacts', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const contact = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'contact',
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'create',
        },
        do: () => connector.create('contacts', { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.status(201).json(contact);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      resourceId: 'new',
    })) return;
    logger.error('Error creating HubSpot contact', { error });
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

/**
 * PATCH /api/hubspot/contacts/:id
 * Update a contact
 */
router.patch('/contacts/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const contact = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'contact',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'update',
        },
        do: () => connector.update('contacts', req.params.id, { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.json(contact);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      resourceId: req.params.id,
    })) return;
    logger.error('Error updating HubSpot contact', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

/**
 * DELETE /api/hubspot/contacts/:id
 * Delete a contact
 */
router.delete('/contacts/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const success = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'contact',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'delete',
        },
        do: () => connector.delete('contacts', req.params.id),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    if (success) {
      res.json({ success: true, message: 'Contact deleted successfully' });
    } else {
      res.status(404).json({ error: 'Contact not found' });
    }
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.contact',
      resourceId: req.params.id,
    })) return;
    logger.error('Error deleting HubSpot contact', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

/**
 * GET /api/hubspot/companies
 * List companies with optional filters
 */
router.get('/companies', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { name, industry, domain } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (name) filters.name = name;
    if (industry) filters.industry = industry;
    if (domain) filters.domain = domain;

    const companies = await connector.list('companies', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'companies', filters);
    res.json({
      companies,
      pagination: buildPagination(page, pageSize, companies.length, count),
    });
  } catch (error) {
    logger.error('Error fetching HubSpot companies', { error });
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

/**
 * GET /api/hubspot/companies/:id
 * Get company by ID
 */
router.get('/companies/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const company = await connector.read('companies', req.params.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(company);
  } catch (error) {
    logger.error('Error fetching HubSpot company', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

/**
 * POST /api/hubspot/companies
 * Create a new company
 */
router.post('/companies', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const company = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'customer',
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'create',
        },
        do: () => connector.create('companies', { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.status(201).json(company);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.company',
      resourceId: 'new',
    })) return;
    logger.error('Error creating HubSpot company', { error });
    res.status(500).json({ error: 'Failed to create company' });
  }
});

/**
 * PATCH /api/hubspot/companies/:id
 * Update a company
 */
router.patch('/companies/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const company = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'customer',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'update',
        },
        do: () => connector.update('companies', req.params.id, { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.json(company);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.company',
      resourceId: req.params.id,
    })) return;
    logger.error('Error updating HubSpot company', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to update company' });
  }
});

/**
 * DELETE /api/hubspot/companies/:id
 * Delete a company
 */
router.delete('/companies/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const success = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'customer',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'delete',
        },
        do: () => connector.delete('companies', req.params.id),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    if (success) {
      res.json({ success: true, message: 'Company deleted successfully' });
    } else {
      res.status(404).json({ error: 'Company not found' });
    }
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.company',
      resourceId: req.params.id,
    })) return;
    logger.error('Error deleting HubSpot company', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

/**
 * GET /api/hubspot/deals
 * List deals with optional filters
 */
router.get('/deals', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { dealstage, pipeline } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (dealstage) filters.dealstage = dealstage;
    if (pipeline) filters.pipeline = pipeline;

    const deals = await connector.list('deals', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'deals', filters);
    res.json({
      deals,
      pagination: buildPagination(page, pageSize, deals.length, count),
    });
  } catch (error) {
    logger.error('Error fetching HubSpot deals', { error });
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

/**
 * GET /api/hubspot/deals/:id
 * Get deal by ID
 */
router.get('/deals/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const deal = await connector.read('deals', req.params.id);

    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    res.json(deal);
  } catch (error) {
    logger.error('Error fetching HubSpot deal', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

/**
 * POST /api/hubspot/deals
 * Create a new deal
 */
router.post('/deals', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const deal = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'deal',
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'create',
        },
        do: () => connector.create('deals', { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.status(201).json(deal);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.deal',
      resourceId: 'new',
    })) return;
    logger.error('Error creating HubSpot deal', { error });
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

/**
 * PATCH /api/hubspot/deals/:id
 * Update a deal
 */
router.patch('/deals/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const deal = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'deal',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'update',
        },
        do: () => connector.update('deals', req.params.id, { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.json(deal);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.deal',
      resourceId: req.params.id,
    })) return;
    logger.error('Error updating HubSpot deal', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

/**
 * DELETE /api/hubspot/deals/:id
 * Delete a deal
 */
router.delete('/deals/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const success = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'deal',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'delete',
        },
        do: () => connector.delete('deals', req.params.id),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    if (success) {
      res.json({ success: true, message: 'Deal deleted successfully' });
    } else {
      res.status(404).json({ error: 'Deal not found' });
    }
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.deal',
      resourceId: req.params.id,
    })) return;
    logger.error('Error deleting HubSpot deal', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

/**
 * GET /api/hubspot/tickets
 * List tickets with optional filters
 */
router.get('/tickets', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { hs_pipeline, hs_pipeline_stage, hs_ticket_priority } = req.query;
    const { page, pageSize, offset } = parsePagination(
      req.query.page as string | undefined,
      req.query.pageSize as string | undefined,
    );

    const filters: Record<string, unknown> = {};
    if (hs_pipeline) filters.hs_pipeline = hs_pipeline;
    if (hs_pipeline_stage) filters.hs_pipeline_stage = hs_pipeline_stage;
    if (hs_ticket_priority) filters.hs_ticket_priority = hs_ticket_priority;

    const tickets = await connector.list('tickets', {
      filters,
      limit: pageSize,
      offset,
    });

    const count = getCount(connector, 'tickets', filters);
    res.json({
      tickets,
      pagination: buildPagination(page, pageSize, tickets.length, count),
    });
  } catch (error) {
    logger.error('Error fetching HubSpot tickets', { error });
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

/**
 * GET /api/hubspot/tickets/:id
 * Get ticket by ID
 */
router.get('/tickets/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const ticket = await connector.read('tickets', req.params.id);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(ticket);
  } catch (error) {
    logger.error('Error fetching HubSpot ticket', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

/**
 * POST /api/hubspot/tickets
 * Create a new ticket
 */
router.post('/tickets', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const ticket = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'ticket',
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'create',
        },
        do: () => connector.create('tickets', { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.status(201).json(ticket);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.ticket',
      resourceId: 'new',
    })) return;
    logger.error('Error creating HubSpot ticket', { error });
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

/**
 * PATCH /api/hubspot/tickets/:id
 * Update a ticket
 */
router.patch('/tickets/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const ticket = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'ticket',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'update',
        },
        do: () => connector.update('tickets', req.params.id, { fields: req.body }),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    res.json(ticket);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.ticket',
      resourceId: req.params.id,
    })) return;
    logger.error('Error updating HubSpot ticket', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

/**
 * DELETE /api/hubspot/tickets/:id
 * Delete a ticket
 */
router.delete('/tickets/:id', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const success = await guardedWrite(
      {
        context: {
          tenantId: extractIdentityContext(req).tenantId,
          callerSystem: 'operator_action',
          targetSystem: 'hubspot',
          entity: 'ticket',
          recordId: req.params.id,
          correlationId: (req.headers['x-correlation-id'] as string) ?? `cor-${Date.now()}`,
          requesterUserId: extractIdentityContext(req).userId,
          operation: 'delete',
        },
        do: () => connector.delete('tickets', req.params.id),
        override: extractOperatorOverride(req),
      },
      await getGuardedWriteDeps(),
    );

    if (success) {
      res.json({ success: true, message: 'Ticket deleted successfully' });
    } else {
      res.status(404).json({ error: 'Ticket not found' });
    }
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'hubspot.ticket',
      resourceId: req.params.id,
    })) return;
    logger.error('Error deleting HubSpot ticket', { error, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
});

/**
 * GET /api/hubspot/pipelines/deals
 * Get deal pipeline stages
 */
router.get('/pipelines/deals', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const stages = 'getPipelineStages' in connector
      ? await (connector as HubSpotConnector).getPipelineStages('deals')
      : [];
    res.json({ stages });
  } catch (error) {
    logger.error('Error fetching deal pipeline stages', { error });
    res.status(500).json({ error: 'Failed to fetch pipeline stages' });
  }
});

/**
 * GET /api/hubspot/pipelines/tickets
 * Get ticket pipeline stages
 */
router.get('/pipelines/tickets', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const stages = 'getPipelineStages' in connector
      ? await (connector as HubSpotConnector).getPipelineStages('tickets')
      : [];
    res.json({ stages });
  } catch (error) {
    logger.error('Error fetching ticket pipeline stages', { error });
    res.status(500).json({ error: 'Failed to fetch pipeline stages' });
  }
});

/**
 * POST /api/hubspot/search/:entityType
 * Search for records
 */
router.post('/search/:entityType', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);
    const { entityType } = req.params;
    const { filters, operator = 'AND' } = req.body;
    const rawLimit = Number(req.body.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 100;
    const rawOffset = Number(req.body.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

    const results = await connector.search(entityType, {
      filters: filters || {},
      operator,
      limit,
      offset,
    });

    const count = getCount(connector, entityType, filters || {}, operator);
    res.json({
      results,
      total: count !== -1 ? count : null,
      totalKnown: count !== -1,
      hasMore: count !== -1 ? offset + results.length < count : results.length === limit,
    });
  } catch (error) {
    logger.error('Error searching HubSpot', { error, entityType: req.params.entityType });
    res.status(500).json({ error: 'Failed to search' });
  }
});

/**
 * GET /api/hubspot/statistics
 * Get CRM statistics for dashboard
 */
router.get('/statistics', async (req: Request, res: Response) => {
  const logger = getLogger();
  try {
    const connector = getConnector();
    await ensureInitialized(connector);

    const contactCount = getCount(connector, 'contacts');
    const companyCount = getCount(connector, 'companies');
    const dealCount = getCount(connector, 'deals');
    const ticketCount = getCount(connector, 'tickets');

    // Only list entities whose counts are unknown — avoid unnecessary API calls.
    // NOTE: Real connectors return a single API page from list(), so fallback
    // totals may undercount large datasets. Accurate real-API totals require
    // connector-layer changes to surface API pagination metadata (future PR).
    const [contactsFallback, companiesFallback, dealsFallback, ticketsFallback] = await Promise.all([
      contactCount === -1 ? connector.list('contacts') : Promise.resolve(null),
      companyCount === -1 ? connector.list('companies') : Promise.resolve(null),
      dealCount === -1 ? connector.list('deals') : Promise.resolve(null),
      ticketCount === -1 ? connector.list('tickets') : Promise.resolve(null),
    ]);

    res.json({
      totalContacts: contactCount !== -1 ? contactCount : contactsFallback!.length,
      totalCompanies: companyCount !== -1 ? companyCount : companiesFallback!.length,
      totalDeals: dealCount !== -1 ? dealCount : dealsFallback!.length,
      totalTickets: ticketCount !== -1 ? ticketCount : ticketsFallback!.length,
    });
  } catch (error) {
    logger.error('Error fetching HubSpot statistics', { error });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/hubspot/dashboard
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

    const contactCount = getCount(connector, 'contacts');
    const companyCount = getCount(connector, 'companies');
    const dealCount = getCount(connector, 'deals');
    const ticketCount = getCount(connector, 'tickets');

    // Only fetch unpaginated lists for entities whose counts are unknown
    const [contacts, companies, deals, tickets, contactsFb, companiesFb, dealsFb, ticketsFb] = await Promise.all([
      connector.list('contacts', { limit: pageSize, offset }),
      connector.list('companies', { limit: pageSize, offset }),
      connector.list('deals', { limit: pageSize, offset }),
      connector.list('tickets', { limit: pageSize, offset }),
      contactCount === -1 ? connector.list('contacts') : Promise.resolve(null),
      companyCount === -1 ? connector.list('companies') : Promise.resolve(null),
      dealCount === -1 ? connector.list('deals') : Promise.resolve(null),
      ticketCount === -1 ? connector.list('tickets') : Promise.resolve(null),
    ]);

    const statistics = {
      totalContacts: contactCount !== -1 ? contactCount : contactsFb!.length,
      totalCompanies: companyCount !== -1 ? companyCount : companiesFb!.length,
      totalDeals: dealCount !== -1 ? dealCount : dealsFb!.length,
      totalTickets: ticketCount !== -1 ? ticketCount : ticketsFb!.length,
    };

    // getPipelineStages is HubSpot-specific; not available when wrapped by DemoConnectorDecorator
    const dealStages = 'getPipelineStages' in connector
      ? await (connector as HubSpotConnector).getPipelineStages('deals')
      : [];

    res.json({
      statistics,
      recentContacts: contacts,
      recentCompanies: companies,
      recentDeals: deals,
      openTickets: tickets,
      dealStages,
      contactsPagination: buildPagination(page, pageSize, contacts.length, contactCount),
      companiesPagination: buildPagination(page, pageSize, companies.length, companyCount),
      dealsPagination: buildPagination(page, pageSize, deals.length, dealCount),
      ticketsPagination: buildPagination(page, pageSize, tickets.length, ticketCount),
    });
  } catch (error) {
    logger.error('Error fetching HubSpot dashboard', { error });
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/**
 * GET /api/hubspot/health
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
      connector: 'hubspot',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('HubSpot health check failed', { error });
    res.status(503).json({
      status: 'unhealthy',
      connector: 'hubspot',
      error: 'Health check failed',
    });
  }
});

export const hubSpotRouter = router;
