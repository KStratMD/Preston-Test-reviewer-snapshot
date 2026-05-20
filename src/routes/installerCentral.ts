import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { InstallerCentralService, InstallerProximityRequest, JobAssignmentRequest, NetSuiteSalesOrderLinkRequest } from '../services/InstallerCentralService';

const router = express.Router();

/**
 * Get InstallerCentralService from DI container
 */
function getService(): InstallerCentralService {
    return container.get<InstallerCentralService>(TYPES.InstallerCentralService);
}

/**
 * InstallerCentral Dashboard API
 * Installer network management, proximity scheduling, ratings
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
    const service = getService();
    const dashboard = await service.getDashboardMetrics();
    res.json(dashboard);
}));

/**
 * Find matching installers for a job location using proximity algorithm
 * Uses Haversine formula for distance calculation
 *
 * POST /api/installer-central/match
 * Body: InstallerProximityRequest
 */
router.post('/match', asyncHandler(async (req, res) => {
    const service = getService();
    const request: InstallerProximityRequest = req.body;

    // Validate required fields
    if (!request.jobLocation) {
        res.status(400).json({
            error: 'Missing jobLocation in request body',
            required: ['jobLocation.jobId', 'jobLocation.latitude', 'jobLocation.longitude', 'jobLocation.address']
        });
        return;
    }

    if (!request.jobLocation.latitude || !request.jobLocation.longitude) {
        res.status(400).json({
            error: 'Missing latitude or longitude in jobLocation',
            provided: { latitude: request.jobLocation.latitude, longitude: request.jobLocation.longitude }
        });
        return;
    }

    const result = await service.findNearestInstallers(request);
    res.json(result);
}));

/**
 * Get installer availability details
 *
 * GET /api/installer-central/installers/:id/availability
 */
router.get('/installers/:id/availability', asyncHandler(async (req, res) => {
    const service = getService();
    const { id } = req.params;

    const availability = await service.getInstallerAvailability(id);

    if (!availability) {
        res.status(404).json({ error: `Installer ${id} not found` });
        return;
    }

    res.json(availability);
}));

/**
 * Get all installer locations with coordinates
 *
 * GET /api/installer-central/installers/locations
 */
router.get('/installers/locations', asyncHandler(async (req, res) => {
    const service = getService();
    const locations = service.getInstallerLocations();
    res.json({
        totalInstallers: locations.length,
        locations
    });
}));

/**
 * Assign an installer to a job
 *
 * POST /api/installer-central/assign/:jobId
 */
router.post('/assign/:jobId', asyncHandler(async (req, res) => {
    const service = getService();
    const { jobId } = req.params;
    const { installerId, scheduledDate, estimatedHours, notes } = req.body;

    // Validate required fields
    if (!installerId) {
        res.status(400).json({ error: 'Missing installerId in request body' });
        return;
    }

    if (!scheduledDate) {
        res.status(400).json({ error: 'Missing scheduledDate in request body' });
        return;
    }

    const request: JobAssignmentRequest = {
        jobId,
        installerId,
        scheduledDate,
        estimatedHours: estimatedHours || 8,
        notes
    };

    const result = await service.assignInstallerToJob(request);

    if (!result.success) {
        res.status(400).json(result);
        return;
    }

    res.json(result);
}));

/**
 * Link a job to a NetSuite Sales Order
 *
 * POST /api/installer-central/netsuite/link-so
 */
router.post('/netsuite/link-so', asyncHandler(async (req, res) => {
    const service = getService();
    const { jobId, installerId, netSuiteSalesOrderId, customerNetSuiteId, projectValue, commissionRate } = req.body;

    // Validate required fields
    if (!jobId || !installerId || !netSuiteSalesOrderId) {
        res.status(400).json({
            error: 'Missing required fields',
            required: ['jobId', 'installerId', 'netSuiteSalesOrderId'],
            provided: { jobId, installerId, netSuiteSalesOrderId }
        });
        return;
    }

    const request: NetSuiteSalesOrderLinkRequest = {
        jobId,
        installerId,
        netSuiteSalesOrderId,
        customerNetSuiteId,
        projectValue: projectValue || 0,
        commissionRate: commissionRate || 0.1
    };

    const result = await service.linkToNetSuiteSalesOrder(request);

    if (!result.success) {
        res.status(400).json(result);
        return;
    }

    res.json(result);
}));

/**
 * Calculate distance between two coordinates
 * Utility endpoint for testing Haversine formula
 *
 * GET /api/installer-central/distance?lat1=...&lon1=...&lat2=...&lon2=...
 */
router.get('/distance', asyncHandler(async (req, res) => {
    const service = getService();
    const { lat1, lon1, lat2, lon2 } = req.query;

    if (!lat1 || !lon1 || !lat2 || !lon2) {
        res.status(400).json({
            error: 'Missing coordinates',
            required: ['lat1', 'lon1', 'lat2', 'lon2']
        });
        return;
    }

    const distance = service.calculateHaversineDistance(
        parseFloat(lat1 as string),
        parseFloat(lon1 as string),
        parseFloat(lat2 as string),
        parseFloat(lon2 as string)
    );

    res.json({
        from: { latitude: parseFloat(lat1 as string), longitude: parseFloat(lon1 as string) },
        to: { latitude: parseFloat(lat2 as string), longitude: parseFloat(lon2 as string) },
        distanceMiles: Math.round(distance * 100) / 100,
        distanceKm: Math.round(distance * 1.60934 * 100) / 100
    });
}));

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'installer-central' });
});

export { router as installerCentralRouter };
