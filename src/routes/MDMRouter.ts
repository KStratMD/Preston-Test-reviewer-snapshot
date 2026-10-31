import { Router, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { GoldenRecordService } from '../services/mdm/GoldenRecordService';
import { EntityMatchingService, EntityRecord } from '../services/mdm/EntityMatchingService';
import { SurvivorshipRuleEngine, SurvivorshipRule } from '../services/mdm/SurvivorshipRuleEngine';
import { Logger } from '../utils/Logger';

const router = Router();

// Lazy service initialization
let goldenRecordService: GoldenRecordService;
let entityMatcher: EntityMatchingService;
let survivorshipEngine: SurvivorshipRuleEngine;
let logger: Logger;

function getServices() {
    if (!goldenRecordService) {
        goldenRecordService = container.get<GoldenRecordService>(TYPES.GoldenRecordService);
        entityMatcher = container.get<EntityMatchingService>(TYPES.EntityMatchingService);
        survivorshipEngine = container.get<SurvivorshipRuleEngine>(TYPES.SurvivorshipRuleEngine);
        logger = container.get<Logger>(TYPES.Logger);
    }
    return { goldenRecordService, entityMatcher, survivorshipEngine, logger };
}

/**
 * Check if user has required MDM write permission
 * Returns true if user has mdm:write, mdm:admin, or wildcard (*) permission
 */
function hasWritePermission(req: Request): boolean {
    const permissions = req.user?.permissions || [];
    return permissions.some(p =>
        p === 'mdm:write' ||
        p === 'mdm:admin' ||
        p === 'admin' ||
        p === '*'
    );
}

/**
 * GET /api/mdm/entities - List golden records
 */
router.get('/entities', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const { entityType, status, hasConflicts } = req.query;

        const records = await goldenRecordService.listGoldenRecords({
            entityType: entityType as string,
            status: status as string,
            hasConflicts: hasConflicts === 'true' ? true : hasConflicts === 'false' ? false : undefined
        });

        res.json({
            success: true,
            count: records.length,
            records
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/entities/:id - Get golden record by ID
 */
router.get('/entities/:id', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const record = await goldenRecordService.getGoldenRecord(req.params.id);

        if (!record) {
            return res.status(404).json({ success: false, error: 'Record not found' });
        }

        res.json({ success: true, record });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/entities/:id/sources - Get linked source records
 */
router.get('/entities/:id/sources', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const record = await goldenRecordService.getGoldenRecord(req.params.id);

        if (!record) {
            return res.status(404).json({ success: false, error: 'Record not found' });
        }

        res.json({ success: true, sources: record.sources });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/match - Find matches for entity
 */
router.post('/match', async (req: Request, res: Response) => {
    try {
        const { entityMatcher } = getServices();
        const { entity, candidates, threshold } = req.body;

        if (!entity || !candidates) {
            return res.status(400).json({ success: false, error: 'entity and candidates required' });
        }

        const matches = await entityMatcher.findMatches(
            entity as EntityRecord,
            candidates as EntityRecord[],
            threshold || 0.7
        );

        res.json({
            success: true,
            matchCount: matches.length,
            matches
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/merge - Merge entities into golden record
 */
router.post('/merge', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const { entities } = req.body;

        if (!entities || !Array.isArray(entities) || entities.length === 0) {
            return res.status(400).json({ success: false, error: 'entities array required' });
        }

        const goldenRecord = await goldenRecordService.createFromEntities(entities as EntityRecord[]);

        res.json({
            success: true,
            goldenRecord
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/conflicts - List unresolved conflicts
 */
router.get('/conflicts', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const records = await goldenRecordService.listGoldenRecords({ hasConflicts: true });

        const conflicts = records.flatMap(r =>
            r.conflicts.map(c => ({
                goldenRecordId: r.id,
                entityType: r.entityType,
                ...c
            }))
        );

        res.json({
            success: true,
            count: conflicts.length,
            conflicts
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/conflicts/:id/resolve - Resolve a conflict
 * Requires mdm:write or admin permission
 */
router.post('/conflicts/:id/resolve', async (req: Request, res: Response) => {
    try {
        // Authorization check - requires mdm:write or admin permission
        if (!hasWritePermission(req)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions. Requires mdm:write or admin permission.'
            });
        }

        const { goldenRecordService } = getServices();
        const { fieldName, selectedValue, resolvedBy } = req.body;

        if (!fieldName || selectedValue === undefined || !resolvedBy) {
            return res.status(400).json({
                success: false,
                error: 'fieldName, selectedValue, and resolvedBy required'
            });
        }

        const resolved = await goldenRecordService.resolveConflict(
            req.params.id,
            fieldName,
            selectedValue,
            resolvedBy
        );

        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Record or conflict not found' });
        }

        res.json({ success: true, message: 'Conflict resolved' });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/rules - Get survivorship rules
 */
router.get('/rules', async (req: Request, res: Response) => {
    try {
        const { survivorshipEngine } = getServices();
        const { entityType } = req.query;

        const rules = await survivorshipEngine.getRules(entityType as string);

        res.json({
            success: true,
            count: rules.length,
            rules
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * PUT /api/mdm/rules - Update survivorship rules
 */
router.put('/rules', async (req: Request, res: Response) => {
    try {
        if (!hasWritePermission(req)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions. Requires mdm:write or admin permission.'
            });
        }

        const { survivorshipEngine } = getServices();
        const { rule } = req.body;

        if (!rule || !rule.id) {
            return res.status(400).json({ success: false, error: 'rule with id required' });
        }

        await survivorshipEngine.setRule(rule as SurvivorshipRule);

        res.json({ success: true, message: 'Rule updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * DELETE /api/mdm/rules/:id - Delete a survivorship rule
 * Requires mdm:write or admin permission. Cannot delete default rules.
 */
router.delete('/rules/:id', async (req: Request, res: Response) => {
    try {
        if (!hasWritePermission(req)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions. Requires mdm:write or admin permission.'
            });
        }

        const { survivorshipEngine } = getServices();
        const result = await survivorshipEngine.removeRule(req.params.id);

        if (result === 'not_found') {
            return res.status(404).json({ success: false, error: 'Rule not found' });
        }
        if (result === 'is_default') {
            return res.status(409).json({ success: false, error: 'Cannot delete default rule' });
        }

        res.json({ success: true, message: 'Rule removed' });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/sync/:id - Request sync to sources (requires approval)
 */
router.post('/sync/:id', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService, logger } = getServices();
        const { targetSystems, requestedBy } = req.body;

        if (!targetSystems || !requestedBy) {
            return res.status(400).json({
                success: false,
                error: 'targetSystems and requestedBy required'
            });
        }

        const request = await goldenRecordService.requestSync(
            req.params.id,
            targetSystems,
            requestedBy
        );

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Golden record not found'
            });
        }

        logger.info('[MDM API] Sync requested', { goldenRecordId: req.params.id });

        res.json({
            success: true,
            message: 'Sync request created - awaiting approval',
            request
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/sync/pending - Get pending sync requests
 */
router.get('/sync/pending', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const requests = await goldenRecordService.getPendingSyncRequests();

        res.json({
            success: true,
            count: requests.length,
            requests
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/sync/:requestId/approve - Approve a sync request
 */
router.post('/sync/:requestId/approve', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService, logger } = getServices();
        const { approvedBy } = req.body;

        if (!approvedBy) {
            return res.status(400).json({
                success: false,
                error: 'approvedBy required'
            });
        }

        const request = await goldenRecordService.approveSyncRequest(
            req.params.requestId,
            approvedBy
        );

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Sync request not found or not pending'
            });
        }

        logger.info('[MDM API] Sync request approved', { requestId: req.params.requestId, approvedBy });

        res.json({
            success: true,
            message: 'Sync request approved',
            request
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/statistics - Get MDM statistics
 */
router.get('/statistics', async (req: Request, res: Response) => {
    try {
        const { goldenRecordService } = getServices();
        const stats = await goldenRecordService.getStatistics();

        res.json({
            success: true,
            statistics: stats
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// ============================================================
// Feedback Loop Endpoints (AIFieldMappingService integration)
// ============================================================

import { MDMFeedbackService } from '../services/mdm/MDMFeedbackService';
let feedbackService: MDMFeedbackService;

function getFeedbackService(): MDMFeedbackService {
    if (!feedbackService) {
        feedbackService = container.get<MDMFeedbackService>(TYPES.MDMFeedbackService);
    }
    return feedbackService;
}

/**
 * GET /api/mdm/feedback/patterns - Get detected conflict patterns
 * Used by AIFieldMappingService to improve mapping suggestions
 */
router.get('/feedback/patterns', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const patterns = await service.analyzeConflictPatterns();

        res.json({
            success: true,
            count: patterns.length,
            patterns
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/feedback/adjustments - Get quality adjustments for field mappings
 * Returns confidence adjustments based on conflict history
 */
router.get('/feedback/adjustments', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const { sourceSystem, targetSystem } = req.query;

        const adjustments = await service.getMappingQualityAdjustments(
            sourceSystem as string,
            targetSystem as string
        );

        res.json({
            success: true,
            count: adjustments.length,
            adjustments
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/feedback/top-conflicts - Get most frequently conflicting fields
 */
router.get('/feedback/top-conflicts', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const limit = parseInt(req.query.limit as string) || 10;

        const topConflicts = await service.getTopConflictingFields(limit);

        res.json({
            success: true,
            count: topConflicts.length,
            fields: topConflicts
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/feedback/statistics - Get feedback service statistics
 */
router.get('/feedback/statistics', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const stats = await service.getStatistics();

        res.json({
            success: true,
            statistics: stats
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/feedback/history - Get paginated conflict history
 */
router.get('/feedback/history', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const offset = parseInt(req.query.offset as string, 10);
        const limit = parseInt(req.query.limit as string, 10);
        const { fieldName, sourceSystem, resolution } = req.query;

        const history = await service.getConflictHistory(
            {
                fieldName: fieldName as string | undefined,
                sourceSystem: sourceSystem as string | undefined,
                resolution: resolution as 'auto' | 'manual' | 'pending' | undefined
            },
            {
                offset: Number.isFinite(offset) ? offset : 0,
                limit: Number.isFinite(limit) ? limit : 50
            }
        );

        res.json({
            success: true,
            records: history.records,
            total: history.total,
            offset: history.offset,
            limit: history.limit
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * GET /api/mdm/feedback/stats/:fieldName - Get detailed stats for a specific field
 */
router.get('/feedback/stats/:fieldName', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const stats = await service.getFieldStats(req.params.fieldName);

        res.json({
            success: true,
            fieldName: req.params.fieldName,
            count: stats.length,
            stats
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

/**
 * POST /api/mdm/feedback/record - Manually record a conflict for testing
 */
router.post('/feedback/record', async (req: Request, res: Response) => {
    try {
        const service = getFeedbackService();
        const { fieldName, sourceSystem, targetSystem, valueA, valueB, resolution } = req.body;

        if (!fieldName || !sourceSystem || !targetSystem) {
            return res.status(400).json({
                success: false,
                error: 'fieldName, sourceSystem, and targetSystem required'
            });
        }

        await service.recordConflict(
            fieldName,
            sourceSystem,
            targetSystem,
            valueA,
            valueB,
            resolution || 'pending'
        );

        res.json({
            success: true,
            message: 'Conflict recorded'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

export default router;
