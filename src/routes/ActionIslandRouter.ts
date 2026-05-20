/**
 * Action Island Router
 * 
 * API endpoints for executing cross-system actions from the Context Sidecar.
 * These endpoints trigger workflows in external systems like DocuSign, Jira, etc.
 * 
 * Base path: /api/actions
 */

import { Router, Request, Response } from 'express';
import { getActionIslandService, ActionContext } from '../services/embedded/ActionIslandService';
import { logger } from '../utils/Logger';

export const actionIslandRouter = Router();

/**
 * Extract action context from request
 */
function extractContext(req: Request): ActionContext {
    return {
        system: req.body.system || req.query.system || 'UNKNOWN',
        recordType: req.body.recordType || req.query.recordType || '',
        recordId: req.body.recordId || req.query.recordId || '',
        entityName: req.body.entityName || req.query.entityName,
        userId: req.body.userId || req.headers['x-user-id'] as string
    };
}

/**
 * POST /api/actions/request-w9
 * Request W-9 form from vendor via DocuSign
 */
actionIslandRouter.post('/request-w9', async (req: Request, res: Response) => {
    const { vendorId, vendorEmail } = req.body;

    if (!vendorId) {
        return res.status(400).json({ error: 'vendorId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.requestW9(vendorId, vendorEmail, extractContext(req));

        logger.info('[ActionIsland API] W-9 request completed', { vendorId, result: result.success });
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] W-9 request failed', { error, vendorId });
        return res.status(500).json({
            success: false,
            error: 'Failed to request W-9',
            message: (error as Error).message
        });
    }
});

/**
 * POST /api/actions/check-inventory
 * Check inventory levels in Shopify/InventoryCentral
 */
actionIslandRouter.post('/check-inventory', async (req: Request, res: Response) => {
    const { itemId } = req.body;

    if (!itemId) {
        return res.status(400).json({ error: 'itemId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.checkInventory(itemId, extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Inventory check failed', { error, itemId });
        return res.status(500).json({
            success: false,
            error: 'Failed to check inventory'
        });
    }
});

/**
 * POST /api/actions/create-dispute
 * Create dispute ticket in Jira
 */
actionIslandRouter.post('/create-dispute', async (req: Request, res: Response) => {
    const { invoiceId, reason } = req.body;

    if (!invoiceId) {
        return res.status(400).json({ error: 'invoiceId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.createDisputeTicket(invoiceId, reason || 'No reason provided', extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Dispute creation failed', { error, invoiceId });
        return res.status(500).json({
            success: false,
            error: 'Failed to create dispute ticket'
        });
    }
});

/**
 * POST /api/actions/pause-payments
 * Pause payments for a vendor
 */
actionIslandRouter.post('/pause-payments', async (req: Request, res: Response) => {
    const { vendorId, reason } = req.body;

    if (!vendorId) {
        return res.status(400).json({ error: 'vendorId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.pausePayments(vendorId, reason || '', extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Pause payments failed', { error, vendorId });
        return res.status(500).json({
            success: false,
            error: 'Failed to pause payments'
        });
    }
});

/**
 * POST /api/actions/resume-payments
 * Resume payments for a vendor
 */
actionIslandRouter.post('/resume-payments', async (req: Request, res: Response) => {
    const { vendorId } = req.body;

    if (!vendorId) {
        return res.status(400).json({ error: 'vendorId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.resumePayments(vendorId, extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Resume payments failed', { error, vendorId });
        return res.status(500).json({
            success: false,
            error: 'Failed to resume payments'
        });
    }
});

/**
 * POST /api/actions/send-reminder
 * Send payment reminder email
 */
actionIslandRouter.post('/send-reminder', async (req: Request, res: Response) => {
    const { invoiceId } = req.body;

    if (!invoiceId) {
        return res.status(400).json({ error: 'invoiceId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.sendPaymentReminder(invoiceId, extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Send reminder failed', { error, invoiceId });
        return res.status(500).json({
            success: false,
            error: 'Failed to send reminder'
        });
    }
});

/**
 * POST /api/actions/escalate-csm
 * Escalate to Customer Success Manager
 */
actionIslandRouter.post('/escalate-csm', async (req: Request, res: Response) => {
    const { customerId, reason } = req.body;

    if (!customerId) {
        return res.status(400).json({ error: 'customerId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.escalateToCSM(customerId, reason || '', extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Escalate CSM failed', { error, customerId });
        return res.status(500).json({
            success: false,
            error: 'Failed to escalate to CSM'
        });
    }
});

/**
 * POST /api/actions/track-shipment
 * Track shipment status
 */
actionIslandRouter.post('/track-shipment', async (req: Request, res: Response) => {
    const { poId } = req.body;

    if (!poId) {
        return res.status(400).json({ error: 'poId is required' });
    }

    try {
        const service = getActionIslandService();
        const result = await service.trackShipment(poId, extractContext(req));
        return res.json(result);
    } catch (error) {
        logger.error('[ActionIsland API] Track shipment failed', { error, poId });
        return res.status(500).json({
            success: false,
            error: 'Failed to track shipment'
        });
    }
});

/**
 * GET /api/actions/health
 * Health check for action island service
 */
actionIslandRouter.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        service: 'ActionIslandService',
        availableActions: [
            'request-w9',
            'check-inventory',
            'create-dispute',
            'pause-payments',
            'resume-payments',
            'send-reminder',
            'escalate-csm',
            'track-shipment'
        ],
        timestamp: new Date().toISOString()
    });
});
