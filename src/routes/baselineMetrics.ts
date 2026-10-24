/**
 * Baseline Metrics API Routes
 * Week 0 Implementation - Performance, accuracy, and cost baseline tracking
 * Gemini Enhancement: Measurement infrastructure before major refactoring
 */

import { Router, Request, Response } from 'express';
import { BaselineMetricsService } from '../services/baselines/BaselineMetricsService';
import { logger } from '../utils/Logger';

const router = Router();
const baselineService = new BaselineMetricsService();

/**
 * GET /api/baselines/dashboard
 * Get baseline metrics dashboard data
 */
router.get('/dashboard', async (req: Request, res: Response) => {
    try {
        const dashboardData = baselineService.getDashboardData();

        res.json({
            success: true,
            data: dashboardData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error fetching baseline dashboard:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch baseline dashboard data'
        });
    }
});

/**
 * POST /api/baselines/initialize
 * Initialize baseline measurement system (Week 0 setup)
 */
router.post('/initialize', async (req: Request, res: Response) => {
    try {
        await baselineService.initializeBaselines();

        res.json({
            success: true,
            message: 'Baseline measurement system initialized successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error initializing baselines:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to initialize baseline system'
        });
    }
});

/**
 * GET /api/baselines/current
 * Get current baseline metrics
 */
router.get('/current', async (req: Request, res: Response) => {
    try {
        const currentBaseline = await baselineService.captureCurrentBaseline();

        res.json({
            success: true,
            data: currentBaseline,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error capturing current baseline:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to capture current baseline'
        });
    }
});

/**
 * GET /api/baselines/comparison
 * Compare current metrics against baseline
 */
router.get('/comparison', async (req: Request, res: Response) => {
    try {
        const comparison = await baselineService.compareToBaseline();

        res.json({
            success: true,
            data: comparison,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error comparing to baseline:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to compare metrics to baseline'
        });
    }
});

/**
 * GET /api/baselines/gates
 * Check gate status for phase transitions
 */
router.get('/gates', async (req: Request, res: Response) => {
    try {
        const comparison = await baselineService.compareToBaseline();

        res.json({
            success: true,
            data: {
                gateStatus: comparison.gateStatus,
                overallScore: comparison.overallScore,
                checks: comparison.gateStatus.checks
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Error checking gate status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check gate status'
        });
    }
});

export default router;