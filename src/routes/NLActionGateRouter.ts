import { Router, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { NLActionGateService, ActionCapacityExceededError } from '../services/ai/NLActionGateService';
import { Logger } from '../utils/Logger';
import type { IdentityContext } from '../services/governance/identityContext';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import { verifiedTenantId, verifiedUserId } from './utils/verifiedIdentity';

const router = Router();

// PR 6 R2 (Codex BM-2): the NLActionGateService binding became async because
// its FinanceCentralOperatorService transitively depends on the async-bound
// DatabaseService. Sync `.get` on a cold container would yield an unresolved
// Promise. Resolve once via `getAsync` and cache the in-flight Promise so
// concurrent cold-start requests await the SAME resolution (PR 6 R3 / Copilot
// R3) — without this, two simultaneous requests could each see `=== null`
// and each call getAsync, potentially running the async factory twice
// (Inversify singleton scope makes this idempotent in practice, but caching
// the Promise avoids double-factory-invocation altogether).
let nlActionGateServicePromise: Promise<NLActionGateService> | null = null;
let logger: Logger | null = null;

function getService(): Promise<NLActionGateService> {
    if (!nlActionGateServicePromise) {
        const p = container.getAsync<NLActionGateService>(TYPES.NLActionGateService);
        // PR 6 R4 (Copilot): if the resolution rejects (transient DB init
        // failure during cold start), clear the cached Promise so the next
        // request can retry instead of being stuck on the cached rejection.
        // Side-effect-only catch — the caller still sees the rejection.
        p.catch(() => {
            if (nlActionGateServicePromise === p) {
                nlActionGateServicePromise = null;
            }
        });
        nlActionGateServicePromise = p;
    }
    return nlActionGateServicePromise;
}

function getLogger(): Logger {
    if (!logger) {
        logger = container.get<Logger>(TYPES.Logger);
    }
    return logger;
}

/**
 * F4: verified JWT identity only — the mount (mountNlActionGateRoutes) runs
 * authMiddleware + the tenant-lifecycle kill switch, so a missing user here
 * is type-level defense (reachable only when the router is mounted without
 * its middleware, e.g. handler-only tests).
 *
 * PR3 follow-up: composed from the shared strict helpers, which reject the
 * retired `__system__` sentinel in each claim they read. `authMiddleware`
 * verifies a JWT's SIGNATURE, not its claims, so before this a token minted by
 * any holder of JWT_SECRET could claim the sentinel and reach
 * `executeAction` (operationType 'connector_write') or stamp itself as
 * `approvedBy`. The two claims stay INDEPENDENT — a sentinel user id degrades
 * to `undefined`, which the write handlers below already refuse, while
 * tenant-only reads keep working off a real tenant claim.
 */
interface OperatorIdentity { tenantId: string; userId: string | undefined }
function jwtOperatorIdentity(req: Request): OperatorIdentity | null {
    const tenantId = verifiedTenantId(req);
    if (tenantId === null) return null;
    return { tenantId, userId: verifiedUserId(req) ?? undefined };
}

/**
 * POST /api/nl-action-gate/parse
 * Parse natural language input into structured intent
 */
router.post('/parse', async (req: Request, res: Response) => {
    try {
        const { input } = req.body;

        if (!input || typeof input !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Input is required and must be a string'
            });
        }

        const service = await getService();
        const intent = await service.parseIntentSmart(input);

        if (!intent) {
            return res.status(422).json({
                success: false,
                error: 'Could not parse intent from input',
                input,
                suggestions: [
                    'Try: "Refund this customer $50.00"',
                    'Try: "Create purchase order for Acme Corp"',
                    'Try: "Update inventory for Widget A to 100"'
                ]
            });
        }

        return res.json({
            success: true,
            intent
        });
    } catch (error) {
        getLogger().error('[NLActionGate] Parse error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to parse intent'
        });
    }
});

/**
 * POST /api/nl-action-gate/propose
 * Parse intent and propose an action for approval
 */
router.post('/propose', async (req: Request, res: Response) => {
    try {
        const { input } = req.body;

        if (!input || typeof input !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Input is required and must be a string'
            });
        }

        // F4: stamp the verified caller tenant on the proposal.
        const identity = jwtOperatorIdentity(req);
        if (identity === null) {
            return res.status(401).json({ success: false, error: 'identity_required' });
        }

        const service = await getService();
        const intent = await service.parseIntentSmart(input);

        if (!intent) {
            return res.status(422).json({
                success: false,
                error: 'Could not parse intent from input'
            });
        }

        const proposedAction = service.proposeAction(intent, identity.tenantId);

        return res.json({
            success: true,
            proposedAction,
            message: proposedAction.requiresApproval
                ? 'Action requires human approval before execution'
                : 'Action is low-risk and ready for execution'
        });
    } catch (error) {
        // instanceof-discriminate so a capacity refusal (client-recoverable
        // 429) doesn't masquerade as an infra failure (500).
        if (error instanceof ActionCapacityExceededError) {
            return res.status(429).json({
                success: false,
                error: 'capacity_exceeded',
                message: 'Too many approved actions awaiting execution — execute or let them expire before proposing more.'
            });
        }
        getLogger().error('[NLActionGate] Propose error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to propose action'
        });
    }
});

/**
 * POST /api/nl-action-gate/actions/:id/approve
 * Approve a pending action
 */
router.post('/actions/:id/approve', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        // F4: attribution comes from the VERIFIED JWT identity only. The
        // legacy body `userId` is ignored — an authenticated caller could
        // otherwise forge another operator's approval.
        const identity = jwtOperatorIdentity(req);
        if (identity === null || identity.userId === undefined) {
            return res.status(401).json({ success: false, error: 'identity_required' });
        }

        const service = await getService();
        const action = service.approveAction(id, identity.userId, identity.tenantId);

        if (!action) {
            return res.status(404).json({
                success: false,
                error: 'Action not found'
            });
        }

        if (action.status === 'expired') {
            return res.status(410).json({
                success: false,
                error: 'Action has expired',
                action
            });
        }

        return res.json({
            success: true,
            action,
            message: 'Action approved. Ready for execution.'
        });
    } catch (error) {
        getLogger().error('[NLActionGate] Approve error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to approve action'
        });
    }
});

/**
 * POST /api/nl-action-gate/actions/:id/reject
 * Reject a pending action
 */
router.post('/actions/:id/reject', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const identity = jwtOperatorIdentity(req);
        if (identity === null) {
            return res.status(401).json({ success: false, error: 'identity_required' });
        }

        const service = await getService();
        const action = service.rejectAction(id, identity.tenantId, reason);

        if (!action) {
            return res.status(404).json({
                success: false,
                error: 'Action not found'
            });
        }

        return res.json({
            success: true,
            action,
            message: 'Action rejected.'
        });
    } catch (error) {
        getLogger().error('[NLActionGate] Reject error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to reject action'
        });
    }
});

/**
 * POST /api/nl-action-gate/actions/:id/execute
 * Execute an approved action
 */
router.post('/actions/:id/execute', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // F4: execution requires a full verified identity — the service
        // tenant-matches the action against ctx (cross-tenant = not_found).
        const identity = jwtOperatorIdentity(req);
        if (identity === null || identity.userId === undefined) {
            return res.status(401).json({ success: false, error: 'identity_required' });
        }

        const service = await getService();
        const ctx: IdentityContext = { tenantId: identity.tenantId, userId: identity.userId };
        const result = await service.executeAction(id, ctx);

        if (!result.success) {
            const statusMap: Record<string, number> = {
                not_found: 404,
                not_approved: 409,
                not_implemented: 501,
                validation_error: 400,
                dispatch_error: 502,
            };
            const statusCode = statusMap[result.errorCode || ''] || 400;
            return res.status(statusCode).json({
                success: false,
                error: result.error,
                errorCode: result.errorCode,
                proposedAction: result.proposedAction
            });
        }

        return res.json({
            success: true,
            result,
            message: 'Action executed successfully'
        });
    } catch (error) {
        if (await handleApprovalQueueError(error, req, res, {
            operationType: 'connector_write',
            resourceType: 'nl_action_gate.execute',
            resourceId: req.params.id,
        })) return;
        getLogger().error('[NLActionGate] Execute error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to execute action'
        });
    }
});

/**
 * GET /api/nl-action-gate/pending
 * Get all pending actions awaiting approval
 */
router.get('/pending', async (req: Request, res: Response) => {
    try {
        const identity = jwtOperatorIdentity(req);
        if (identity === null) {
            return res.status(401).json({ success: false, error: 'identity_required' });
        }

        const service = await getService();
        const pendingActions = service.getPendingActions(identity.tenantId);

        return res.json({
            success: true,
            count: pendingActions.length,
            actions: pendingActions
        });
    } catch (error) {
        getLogger().error('[NLActionGate] Pending error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get pending actions'
        });
    }
});

export default router;
