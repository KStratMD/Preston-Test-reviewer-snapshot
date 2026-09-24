/**
 * Fixture-provenance tests for the ai-proxy Phase 2 + Metrics/NLQ routers.
 *
 * PR2 removed every credential-less loopback call from these routers; their
 * responses are now fixture-only. This suite proves the flip side: every
 * response that carries fixture data says so explicitly via `dataSource`,
 * and every response that carries no fixture data (errors, 404s) does not.
 */

import express from 'express';
import request from 'supertest';
import { createPhase2Router } from '../../../src/routes/ai-proxy/Phase2Router';
import { createMetricsNLQRouter } from '../../../src/routes/ai-proxy/MetricsNLQRouter';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import type { SyncCentralHealthPredictor, SyncHealthPrediction, SyncHealthPredictionResponse } from '../../../src/services/ai/SyncCentralHealthPredictor';
import type {
    SupplierRiskScoringService,
    SupplierRiskProfile,
    SupplierRiskSummaryResponse,
} from '../../../src/services/ai/SupplierRiskScoringService';
import type { ModuleMetricsAggregator, AggregatedMetrics, ModuleMetrics } from '../../../src/services/metrics/ModuleMetricsAggregator';

function makeApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/api/ai/proxy', createPhase2Router());
    app.use('/api/ai/proxy', createMetricsNLQRouter());
    return app;
}

function buildHealthPredictorDouble(): Pick<SyncCentralHealthPredictor, 'getAllPredictions' | 'getPrediction'> {
    const prediction: SyncHealthPrediction = {
        integrationId: 'int-001',
        integrationName: 'Test Integration',
        connectorType: 'test-connector',
        failureProbability: 0.1,
        riskLevel: 'low',
        currentHealth: { successRate: 99, avgLatencyMs: 10, errorRate: 0.1 },
        earlyWarnings: [],
        recommendedActions: [],
        confidence: 0.9,
        analysisTimestamp: new Date().toISOString(),
    };

    const allPredictions: SyncHealthPredictionResponse = {
        success: true,
        timestamp: new Date().toISOString(),
        overallHealth: { status: 'healthy', score: 100, integrationsAtRisk: 0, totalIntegrations: 1 },
        predictions: [prediction],
        systemAlerts: [],
    };

    return {
        getAllPredictions: jest.fn().mockResolvedValue(allPredictions),
        getPrediction: jest.fn().mockImplementation(async (id: string) =>
            id === 'int-001' ? prediction : null,
        ),
    };
}

function buildRiskScoringDouble(): Pick<
    SupplierRiskScoringService,
    'getRiskSummary' | 'getSupplierRisk' | 'getSupplierRiskHistory' | 'recalculateRisk'
> {
    const profile: SupplierRiskProfile = {
        supplierId: 'sup-001',
        supplierName: 'Test Supplier',
        category: 'general',
        overallRiskScore: 23,
        riskLevel: 'low',
        riskTrend: 'improving',
        factors: [],
        recentAlerts: [],
        recommendations: [],
        lastAssessment: new Date().toISOString(),
        nextAssessmentDue: new Date().toISOString(),
    };

    const summary: SupplierRiskSummaryResponse = {
        success: true,
        timestamp: new Date().toISOString(),
        summary: {
            totalSuppliers: 1,
            byRiskLevel: { low: 1, medium: 0, high: 0, critical: 0 },
            averageScore: 23,
            suppliersRequiringAttention: 0,
        },
        topRisks: [profile],
        recentAlerts: [],
    };

    return {
        getRiskSummary: jest.fn().mockResolvedValue(summary),
        getSupplierRisk: jest.fn().mockImplementation(async (id: string) =>
            id === 'sup-001' ? profile : null,
        ),
        getSupplierRiskHistory: jest.fn().mockImplementation(async (id: string) =>
            id === 'sup-001'
                ? [{ timestamp: new Date().toISOString(), overallScore: 23, riskLevel: 'low', factors: {}, triggeredAlerts: [] }]
                : [],
        ),
        recalculateRisk: jest.fn().mockImplementation(async (id: string) =>
            id === 'sup-001' ? profile : null,
        ),
    };
}

function buildMetricsAggregatorDouble(): Pick<
    ModuleMetricsAggregator,
    'collectAllModuleMetrics' | 'getRecentAnomalies' | 'getModuleMetrics'
> {
    const moduleMetrics: ModuleMetrics = {
        module: 'SyncCentral',
        timestamp: new Date().toISOString(),
        kpis: { apiSuccessRate: 99.8 },
        health: { status: 'healthy', score: 100, lastUpdated: new Date().toISOString(), issues: [] },
        trends: [],
    };

    const aggregated: AggregatedMetrics = {
        timestamp: new Date().toISOString(),
        modules: new Map([['SyncCentral', moduleMetrics]]),
        overallHealth: { status: 'healthy', score: 100, lastUpdated: new Date().toISOString(), issues: [] },
        anomalies: [],
        correlations: [],
    };

    return {
        collectAllModuleMetrics: jest.fn().mockResolvedValue(aggregated),
        getRecentAnomalies: jest.fn().mockReturnValue([]),
        getModuleMetrics: jest.fn().mockImplementation(() => moduleMetrics),
    };
}

describe('ai-proxy fixture provenance', () => {
    let app: express.Express;

    beforeEach(() => {
        container.snapshot();
        container.rebind<SyncCentralHealthPredictor>(TYPES.SyncCentralHealthPredictor)
            .toConstantValue(buildHealthPredictorDouble() as unknown as SyncCentralHealthPredictor);
        container.rebind<SupplierRiskScoringService>(TYPES.SupplierRiskScoringService)
            .toConstantValue(buildRiskScoringDouble() as unknown as SupplierRiskScoringService);
        container.rebind<ModuleMetricsAggregator>(TYPES.ModuleMetricsAggregator)
            .toConstantValue(buildMetricsAggregatorDouble() as unknown as ModuleMetricsAggregator);
        app = makeApp();
    });

    afterEach(() => {
        container.restore();
    });

    it('marks the spreadable Phase 2 responses as fixture data', async () => {
        expect((await request(app).get('/api/ai/proxy/sync/health-prediction')).body.dataSource)
            .toBe('fixture');

        expect((await request(app).get('/api/ai/proxy/suppliers/risk-scores')).body.dataSource)
            .toBe('fixture');
    });

    it('marks the wrapped Phase 2 responses as fixture data', async () => {
        for (const path of [
            '/api/ai/proxy/sync/health-prediction/int-001',
            '/api/ai/proxy/suppliers/sup-001/risk-score',
            '/api/ai/proxy/suppliers/sup-001/risk-history',
        ]) {
            expect((await request(app).get(path)).body.dataSource).toBe('fixture');
        }

        expect(
            (await request(app).post('/api/ai/proxy/suppliers/sup-001/recalculate')).body.dataSource,
        ).toBe('fixture');
    });

    it('marks the MetricsNLQ responses as fixture data', async () => {
        expect(
            (await request(app).get('/api/ai/proxy/metrics/cross-module')).body.dataSource,
        ).toBe('fixture');

        expect((await request(app).get('/api/ai/proxy/anomalies')).body.dataSource).toBe('fixture');

        expect(
            (await request(app).get('/api/ai/proxy/module/SyncCentral/metrics')).body.dataSource,
        ).toBe('fixture');
    });

    it('does not mark a 400 invalid-module response', async () => {
        const invalidModule = await request(app).get('/api/ai/proxy/module/not-a-module/metrics');
        expect(invalidModule.status).toBe(400);
        expect(invalidModule.body).not.toHaveProperty('dataSource');
    });

    it('marks the fresh-collect module-metrics branch as fixture data', async () => {
        // The cached branch and the fresh-collect branch are two DIFFERENT
        // res.json call sites, each with its own provenance marker. The default
        // double always returns metrics, so without this miss the fresh branch
        // is never entered and its marker is untested.
        const aggregator = container.get<ModuleMetricsAggregator>(TYPES.ModuleMetricsAggregator);
        (aggregator.getModuleMetrics as unknown as jest.Mock).mockReturnValueOnce(undefined);

        const response = await request(app).get('/api/ai/proxy/module/SyncCentral/metrics');

        // Proves the fresh-collect branch really ran; without it the assertion
        // below would pass on the cached branch and prove nothing.
        expect(aggregator.collectAllModuleMetrics).toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(response.body.dataSource).toBe('fixture');
    });

    it('does not mark the 404 module-not-found response', async () => {
        // Cache miss AND fresh-collect miss: the route's own 404 branch, which
        // carries no fixture data and so must carry no provenance marker.
        const aggregator = container.get<ModuleMetricsAggregator>(TYPES.ModuleMetricsAggregator);
        (aggregator.getModuleMetrics as unknown as jest.Mock).mockReturnValue(undefined);

        const response = await request(app).get('/api/ai/proxy/module/SyncCentral/metrics');

        expect(response.status).toBe(404);
        expect(response.body).not.toHaveProperty('dataSource');
    });

    it('does not mark a 404 supplier-not-found response', async () => {
        const missingSupplier = await request(app).get('/api/ai/proxy/suppliers/not-found/risk-score');
        expect(missingSupplier.status).toBe(404);
        expect(missingSupplier.body).not.toHaveProperty('dataSource');
    });
});
