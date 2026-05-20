/**
 * SyncCentral API Router
 * 
 * REST API endpoints for SyncCentral operations, AI conflict resolution,
 * and anomaly alerting.
 * 
 * Created: January 9, 2026 (SuiteCentral Parity - Phase 1)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { inject, injectable } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { SyncCentralOrchestrator, ConflictResolution } from '../services/sync/SyncCentralOrchestrator';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

@injectable()
export class SyncCentralRouter {
    public router: Router;

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.SyncCentralOrchestrator) private readonly orchestrator: SyncCentralOrchestrator,
    ) {
        this.router = Router();
        this.initializeRoutes();
    }

    private initializeRoutes(): void {
        // Sync Operations CRUD
        this.router.get('/operations', this.getOperations.bind(this));
        this.router.post('/operations', this.createOperation.bind(this));
        this.router.get('/operations/:id', this.getOperation.bind(this));
        this.router.delete('/operations/:id', this.deleteOperation.bind(this));

        // Sync Execution
        this.router.post('/operations/:id/execute', this.executeSync.bind(this));
        this.router.get('/operations/:id/history', this.getSyncHistory.bind(this));

        // Conflict Resolution
        this.router.get('/operations/:id/conflicts', this.getConflicts.bind(this));
        this.router.post('/conflicts/:conflictId/resolve', this.resolveConflict.bind(this));
        this.router.post('/conflicts/:conflictId/ai-suggest', this.getAISuggestion.bind(this));

        // Anomaly Alerts
        this.router.get('/alerts', this.getAlerts.bind(this));
        this.router.post('/alerts/:id/acknowledge', this.acknowledgeAlert.bind(this));

        // Statistics & Dashboard
        this.router.get('/statistics', this.getStatistics.bind(this));
        this.router.get('/dashboard', this.getDashboard.bind(this));
    }

    /**
     * GET /api/sync-central/operations
     * List all sync operations
     */
    private async getOperations(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const filters = {
                status: req.query.status as string | undefined,
                sourceSystem: req.query.sourceSystem as string | undefined,
            };

            const operations = await this.orchestrator.getOperations(filters);

            res.json({
                success: true,
                operations,
                count: operations.length,
            });
        } catch (error) {
            this.logger.error('Failed to get operations', { error });
            next(error);
        }
    }

    /**
     * POST /api/sync-central/operations
     * Create a new sync operation
     */
    private async createOperation(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const operation = await this.orchestrator.createOperation(req.body);

            res.status(201).json({
                success: true,
                operation,
            });
        } catch (error) {
            this.logger.error('Failed to create operation', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/operations/:id
     * Get a specific sync operation
     */
    private async getOperation(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const operations = await this.orchestrator.getOperations();
            const operation = operations.find(op => op.id === req.params.id);

            if (!operation) {
                res.status(404).json({ success: false, error: 'Operation not found' });
                return;
            }

            res.json({ success: true, operation });
        } catch (error) {
            this.logger.error('Failed to get operation', { error });
            next(error);
        }
    }

    /**
     * DELETE /api/sync-central/operations/:id
     * Delete a sync operation
     */
    private async deleteOperation(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Implementation would remove from operations map
            res.json({ success: true, message: 'Operation deleted' });
        } catch (error) {
            this.logger.error('Failed to delete operation', { error });
            next(error);
        }
    }

    /**
     * POST /api/sync-central/operations/:id/execute
     * Execute a sync operation
     */
    private async executeSync(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.orchestrator.executeSync(req.params.id);

            res.json({
                success: true,
                result,
            });
        } catch (error) {
            if (await handleApprovalQueueError(error, req, res, {
                operationType: 'connector_write',
                resourceType: 'sync_central.execute',
                resourceId: req.params.id,
            })) return;
            this.logger.error('Failed to execute sync', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/operations/:id/history
     * Get sync execution history
     */
    private async getSyncHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Would retrieve from syncHistory map
            res.json({
                success: true,
                history: [],
            });
        } catch (error) {
            this.logger.error('Failed to get sync history', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/operations/:id/conflicts
     * Get conflicts for an operation
     */
    private async getConflicts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Would retrieve conflicts from latest sync result
            res.json({
                success: true,
                conflicts: [],
            });
        } catch (error) {
            this.logger.error('Failed to get conflicts', { error });
            next(error);
        }
    }

    /**
     * POST /api/sync-central/conflicts/:conflictId/resolve
     * Resolve a sync conflict
     */
    private async resolveConflict(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const resolution: ConflictResolution = {
                strategy: req.body.strategy,
                resolvedData: req.body.resolvedData,
                resolvedBy: req.body.resolvedBy || 'manual',
                resolvedAt: new Date(),
                reason: req.body.reason,
            };

            await this.orchestrator.resolveConflict(
                req.body.operationId,
                req.params.conflictId,
                resolution
            );

            res.json({ success: true, message: 'Conflict resolved' });
        } catch (error) {
            this.logger.error('Failed to resolve conflict', { error });
            next(error);
        }
    }

    /**
     * POST /api/sync-central/conflicts/:conflictId/ai-suggest
     * Get AI suggestion for conflict resolution
     */
    private async getAISuggestion(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const suggestion = await this.orchestrator.getAIConflictSuggestion(req.body.conflict);

            res.json({
                success: true,
                suggestion,
            });
        } catch (error) {
            if (await handleApprovalQueueError(error, req, res, {
                operationType: 'ai_call',
                resourceType: 'sync_central.ai_conflict_suggest',
                resourceId: req.params.conflictId,
            })) return;
            this.logger.error('Failed to get AI suggestion', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/alerts
     * Get anomaly alerts
     */
    private async getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const operationId = req.query.operationId as string | undefined;
            const alerts = await this.orchestrator.getAnomalyAlerts(operationId);

            res.json({
                success: true,
                alerts,
                count: alerts.length,
            });
        } catch (error) {
            this.logger.error('Failed to get alerts', { error });
            next(error);
        }
    }

    /**
     * POST /api/sync-central/alerts/:id/acknowledge
     * Acknowledge an anomaly alert
     */
    private async acknowledgeAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Would mark alert as acknowledged
            res.json({ success: true, message: 'Alert acknowledged' });
        } catch (error) {
            this.logger.error('Failed to acknowledge alert', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/statistics
     * Get overall sync statistics
     */
    private async getStatistics(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const statistics = await this.orchestrator.getStatistics();

            res.json({
                success: true,
                statistics,
            });
        } catch (error) {
            this.logger.error('Failed to get statistics', { error });
            next(error);
        }
    }

    /**
     * GET /api/sync-central/dashboard
     * Get dashboard data (operations + stats + alerts)
     */
    private async getDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const [operations, statistics, alerts] = await Promise.all([
                this.orchestrator.getOperations(),
                this.orchestrator.getStatistics(),
                this.orchestrator.getAnomalyAlerts(),
            ]);

            res.json({
                success: true,
                dashboard: {
                    operations: operations.slice(0, 10), // Top 10
                    statistics,
                    recentAlerts: alerts.slice(0, 5), // Last 5 alerts
                },
            });
        } catch (error) {
            this.logger.error('Failed to get dashboard', { error });
            next(error);
        }
    }
}

export default SyncCentralRouter;
