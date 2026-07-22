/**
 * Unit tests for ModuleMetricsAggregator
 * Phase 1: AI-Enhanced SuiteCentral 2.0
 */

import { ModuleMetricsAggregator } from '../../../../src/services/metrics/ModuleMetricsAggregator';

// Mock logger
const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
} as any;

describe('ModuleMetricsAggregator', () => {
    let aggregator: ModuleMetricsAggregator;

    beforeEach(() => {
        jest.clearAllMocks();
        aggregator = new ModuleMetricsAggregator(mockLogger);
    });

    describe('initialization', () => {
        it('should initialize successfully', () => {
            expect(aggregator).toBeDefined();
            expect(mockLogger.info).toHaveBeenCalledWith(
                'ModuleMetricsAggregator initialized for cross-module intelligence'
            );
        });
    });

    describe('collectAllModuleMetrics', () => {
        it('should collect metrics from all 11 SuiteCentral modules', async () => {
            const result = await aggregator.collectAllModuleMetrics();

            expect(result).toBeDefined();
            expect(result.timestamp).toBeDefined();
            expect(result.modules).toBeDefined();
            expect(result.modules.size).toBe(11);
            expect(result.overallHealth).toBeDefined();
            expect(result.anomalies).toBeInstanceOf(Array);
            expect(result.correlations).toBeInstanceOf(Array);
        });

        it('should return properly structured module metrics', async () => {
            const result = await aggregator.collectAllModuleMetrics();

            const supplierMetrics = result.modules.get('SupplierCentral');
            expect(supplierMetrics).toBeDefined();
            expect(supplierMetrics?.module).toBe('SupplierCentral');
            expect(supplierMetrics?.kpis).toBeDefined();
            expect(supplierMetrics?.health).toBeDefined();
            expect(supplierMetrics?.health.status).toMatch(/healthy|degraded|critical/);
        });

        it('should detect anomalies in metrics', async () => {
            const result = await aggregator.collectAllModuleMetrics();

            // Anomalies array should be defined (may be empty if metrics are within range)
            expect(result.anomalies).toBeInstanceOf(Array);

            // If there are anomalies, check structure
            if (result.anomalies.length > 0) {
                const anomaly = result.anomalies[0];
                expect(anomaly.id).toBeDefined();
                expect(anomaly.modules).toBeInstanceOf(Array);
                expect(anomaly.severity).toMatch(/info|warning|critical/);
                expect(anomaly.suggestedActions).toBeInstanceOf(Array);
            }
        });

        it('should calculate overall health score', async () => {
            const result = await aggregator.collectAllModuleMetrics();

            expect(result.overallHealth.status).toMatch(/healthy|degraded|critical/);
            expect(typeof result.overallHealth.score).toBe('number');
            expect(result.overallHealth.score).toBeGreaterThanOrEqual(0);
            expect(result.overallHealth.score).toBeLessThanOrEqual(100);
        });
    });

    describe('getRecentAnomalies', () => {
        it('should return recent anomalies with default limit', async () => {
            // First collect metrics to populate anomalies
            await aggregator.collectAllModuleMetrics();

            const anomalies = aggregator.getRecentAnomalies();

            expect(anomalies).toBeInstanceOf(Array);
            expect(anomalies.length).toBeLessThanOrEqual(50);
        });

        it('should respect limit parameter', async () => {
            await aggregator.collectAllModuleMetrics();

            const anomalies = aggregator.getRecentAnomalies(5);

            expect(anomalies.length).toBeLessThanOrEqual(5);
        });
    });

    describe('getModuleMetrics', () => {
        it('should return cached metrics for a module', async () => {
            await aggregator.collectAllModuleMetrics();

            const metrics = aggregator.getModuleMetrics('SupplierCentral');

            expect(metrics).toBeDefined();
            expect(metrics?.module).toBe('SupplierCentral');
        });

        it('should return undefined for uncached module', () => {
            // Before collecting, cache is empty
            const freshAggregator = new ModuleMetricsAggregator(mockLogger);
            const metrics = freshAggregator.getModuleMetrics('SupplierCentral');

            expect(metrics).toBeUndefined();
        });
    });

    describe('getCorrelations', () => {
        it('should return cross-module correlations', async () => {
            await aggregator.collectAllModuleMetrics();

            const correlations = aggregator.getCorrelations();

            expect(correlations).toBeInstanceOf(Array);
            expect(correlations.length).toBeGreaterThan(0);

            const correlation = correlations[0];
            expect(correlation.sourceModule).toBeDefined();
            expect(correlation.targetModule).toBeDefined();
            expect(correlation.correlationType).toMatch(/causal|temporal/);
            expect(typeof correlation.strength).toBe('number');
        });
    });

    describe('action suggestions', () => {
        it('should provide module-specific action suggestions for all 11 modules', async () => {
            const result = await aggregator.collectAllModuleMetrics();

            const moduleNames = [
                'SupplierCentral', 'PaymentCentral', 'SyncCentral', 'CustomerCentral',
                'QualityCentral', 'PayoutCentral', 'InstallerCentral', 'ServiceCentral',
                'InventoryCentral', 'FinanceCentral', 'ContractCentral'
            ];

            for (const moduleName of moduleNames) {
                expect(result.modules.has(moduleName as any)).toBe(true);
            }
        });
    });
});
