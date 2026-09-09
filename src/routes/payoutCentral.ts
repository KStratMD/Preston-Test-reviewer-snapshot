import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { PayoutCentralService, PayoutCalculationRequest, PayoutExecutionRequest } from '../services/PayoutCentralService';

const router = express.Router();

/**
 * Get PayoutCentralService from DI container
 */
function getService(): PayoutCentralService {
    return container.get<PayoutCentralService>(TYPES.PayoutCentralService);
}

/**
 * PayoutCentral Dashboard API
 * Affiliate/partner payouts via PayPal, PayQuicker, and other wallets
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
    const service = getService();
    const dashboard = await service.getDashboardMetrics();
    res.json(dashboard);
}));

/**
 * Get commission records from NetSuite for a period
 *
 * GET /api/payout-central/commissions?periodId=2024-01
 */
router.get('/commissions', asyncHandler(async (req, res) => {
    const service = getService();
    const { periodId } = req.query;

    if (!periodId || typeof periodId !== 'string') {
        // Default to current month
        const now = new Date();
        const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const commissions = await service.fetchNetSuiteCommissions(defaultPeriod);
        res.json({
            periodId: defaultPeriod,
            totalRecords: commissions.length,
            totalAmount: commissions.reduce((sum, c) => sum + c.commissionAmount, 0),
            commissions
        });
        return;
    }

    const commissions = await service.fetchNetSuiteCommissions(periodId);
    res.json({
        periodId,
        totalRecords: commissions.length,
        totalAmount: commissions.reduce((sum, c) => sum + c.commissionAmount, 0),
        commissions
    });
}));

/**
 * Get available commission periods
 *
 * GET /api/payout-central/periods
 */
router.get('/periods', asyncHandler(async (req, res) => {
    const service = getService();
    const periods = await service.getCommissionPeriods();
    res.json({ periods });
}));

/**
 * Calculate payout for an affiliate
 *
 * POST /api/payout-central/calculate
 */
router.post('/calculate', asyncHandler(async (req, res) => {
    const service = getService();
    const { affiliateId, periodId, includeWithholding, paymentMethod } = req.body;

    // Validate required fields
    if (!affiliateId) {
        res.status(400).json({ error: 'Missing affiliateId in request body' });
        return;
    }

    if (!periodId) {
        res.status(400).json({ error: 'Missing periodId in request body' });
        return;
    }

    const request: PayoutCalculationRequest = {
        affiliateId,
        periodId,
        includeWithholding: includeWithholding !== false, // Default true
        paymentMethod: paymentMethod || 'paypal'
    };

    const calculation = await service.calculatePayout(request);
    res.json(calculation);
}));

/**
 * Execute a payout via PayPal or PayQuicker
 *
 * POST /api/payout-central/process
 */
router.post('/process', asyncHandler(async (req, res) => {
    const service = getService();
    const { affiliateId, amount, paymentMethod, paymentDetails, reference } = req.body;

    // Validate required fields
    if (!affiliateId) {
        res.status(400).json({ error: 'Missing affiliateId in request body' });
        return;
    }

    if (!amount || typeof amount !== 'number' || amount <= 0) {
        res.status(400).json({ error: 'Amount must be a positive number' });
        return;
    }

    if (!paymentMethod) {
        res.status(400).json({
            error: 'Missing paymentMethod',
            allowed: ['paypal', 'payquicker', 'ach', 'check']
        });
        return;
    }

    if (!paymentDetails) {
        res.status(400).json({ error: 'Missing paymentDetails in request body' });
        return;
    }

    const request: PayoutExecutionRequest = {
        affiliateId,
        amount,
        paymentMethod,
        paymentDetails,
        reference
    };

    const result = await service.executePayout(request);

    if (!result.success) {
        res.status(400).json(result);
        return;
    }

    res.json(result);
}));

/**
 * Get payout history for an affiliate
 *
 * GET /api/payout-central/history/:affiliateId
 */
router.get('/history/:affiliateId', asyncHandler(async (req, res) => {
    const service = getService();
    const { affiliateId } = req.params;

    const history = await service.getPayoutHistory(affiliateId);
    res.json({
        affiliateId,
        totalPayouts: history.length,
        totalAmount: history.reduce((sum, p) => sum + p.amount, 0),
        payouts: history
    });
}));

/**
 * Generate 1099 stub for tax reporting
 *
 * GET /api/payout-central/1099/:affiliateId?taxYear=2024
 */
router.get('/1099/:affiliateId', asyncHandler(async (req, res) => {
    const service = getService();
    const { affiliateId } = req.params;
    const { taxYear } = req.query;

    const year = taxYear ? parseInt(taxYear as string, 10) : new Date().getFullYear();

    try {
        const stub = await service.generate1099Stub(affiliateId, year);
        res.json(stub);
    } catch (error) {
        res.status(404).json({
            error: error instanceof Error ? error.message : 'Failed to generate 1099 stub'
        });
    }
}));

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'payout-central' });
});

export { router as payoutCentralRouter };
