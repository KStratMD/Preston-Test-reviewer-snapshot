/**
 * Phase 2 Router — Proxy Family
 *
 * SyncCentral Health Prediction + Supplier Risk Scoring.
 * Governance enforced at proxy mount boundary.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { logger } from '../../utils/Logger';
import { SyncCentralHealthPredictor } from '../../services/ai/SyncCentralHealthPredictor';
import { SupplierRiskScoringService } from '../../services/ai/SupplierRiskScoringService';

function getHealthPredictor(): SyncCentralHealthPredictor {
    try {
        return container.get<SyncCentralHealthPredictor>(TYPES.SyncCentralHealthPredictor);
    } catch (error) {
        logger.warn('DI failed for SyncCentralHealthPredictor, using direct instantiation', { error });
        return new SyncCentralHealthPredictor();
    }
}

function getRiskScoringService(): SupplierRiskScoringService {
    try {
        return container.get<SupplierRiskScoringService>(TYPES.SupplierRiskScoringService);
    } catch (error) {
        logger.warn('DI failed for SupplierRiskScoringService, using direct instantiation', { error });
        return new SupplierRiskScoringService();
    }
}

export function createPhase2Router(): Router {
    const router = Router();

    router.get('/sync/health-prediction', async (_req: Request, res: Response, next: NextFunction) => {
        try {
            const predictor = getHealthPredictor();
            res.json(await predictor.getAllPredictions());
        } catch (error) { next(error); }
    });

    router.get('/sync/health-prediction/:id', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const prediction = await getHealthPredictor().getPrediction(req.params.id);
            if (!prediction) { res.status(404).json({ success: false, error: 'Integration not found', integrationId: req.params.id }); return; }
            res.json({ success: true, prediction });
        } catch (error) { next(error); }
    });

    router.get('/suppliers/risk-scores', async (_req: Request, res: Response, next: NextFunction) => {
        try { res.json(await getRiskScoringService().getRiskSummary()); } catch (error) { next(error); }
    });

    router.get('/suppliers/:id/risk-score', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const profile = await getRiskScoringService().getSupplierRisk(req.params.id);
            if (!profile) { res.status(404).json({ success: false, error: 'Supplier not found', supplierId: req.params.id }); return; }
            res.json({ success: true, profile });
        } catch (error) { next(error); }
    });

    router.get('/suppliers/:id/risk-history', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const days = parseInt(req.query.days as string) || 30;
            const history = await getRiskScoringService().getSupplierRiskHistory(req.params.id, days);
            if (history.length === 0) { res.status(404).json({ success: false, error: 'No history found', supplierId: req.params.id }); return; }
            res.json({ success: true, supplierId: req.params.id, days, history });
        } catch (error) { next(error); }
    });

    router.post('/suppliers/:id/recalculate', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const profile = await getRiskScoringService().recalculateRisk(req.params.id);
            if (!profile) { res.status(404).json({ success: false, error: 'Supplier not found', supplierId: req.params.id }); return; }
            res.json({ success: true, message: 'Risk score recalculated', profile });
        } catch (error) { next(error); }
    });

    router.get('/phase2/health', async (_req: Request, res: Response) => {
        res.json({
            success: true, status: 'healthy',
            services: { syncCentralHealthPredictor: 'active', supplierRiskScoringService: 'active' },
            version: '2.0.0-phase2', phase: 'AI-Enhanced SuiteCentral 2.0 - Phase 2',
            capabilities: ['sync-health-prediction', 'supplier-risk-scoring', 'early-warning-detection', 'risk-history-tracking'],
        });
    });

    return router;
}
