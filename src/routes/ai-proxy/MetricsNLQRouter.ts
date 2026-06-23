/**
 * Metrics & NLQ Router — Proxy Family
 *
 * Provides API endpoints for:
 * - Cross-module metrics aggregation
 * - Natural language query processing
 * - Anomaly detection
 * - Per-module metrics
 * - AI services health check
 *
 * Governance is enforced at the proxy router mount boundary via
 * createGovernanceMiddleware (audit-only for read endpoints).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { ModuleMetricsAggregator, VALID_MODULES, isValidModule } from '../../services/metrics/ModuleMetricsAggregator';
import { NLQueryOrchestrator, NLQueryRequest } from '../../services/ai/NLQueryOrchestrator';
import { NLQCapabilityRegistry } from '../../services/ai/NLQCapabilityRegistry';
import type { Logger } from '../../utils/Logger';

// Helper to get services with error handling
function getLogger(): Logger {
    return container.get<Logger>(TYPES.Logger);
}

function getMetricsAggregator(): ModuleMetricsAggregator {
    return container.get<ModuleMetricsAggregator>(TYPES.ModuleMetricsAggregator);
}

// PR 6 R2 (Codex BM-2): NLQueryOrchestrator is now async-bound because it
// transitively depends on NLActionGateService → FinanceCentralOperatorService
// → async DatabaseService. Resolve via getAsync.
async function getNLQueryOrchestrator(): Promise<NLQueryOrchestrator> {
    return container.getAsync<NLQueryOrchestrator>(TYPES.NLQueryOrchestrator);
}

export function createMetricsNLQRouter(): Router {
    const router = Router();

    /**
     * GET /api/ai/proxy/metrics/cross-module
     * Get aggregated metrics from all SuiteCentral modules
     */
    router.get('/metrics/cross-module', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const logger = getLogger();
            const aggregator = getMetricsAggregator();

            logger.info('Collecting cross-module metrics');

            const aggregatedMetrics = await aggregator.collectAllModuleMetrics();

            // Convert Map to object for JSON serialization
            const modulesObject: Record<string, unknown> = {};
            aggregatedMetrics.modules.forEach((metrics, module) => {
                modulesObject[module] = metrics;
            });

            res.json({
                success: true,
                timestamp: aggregatedMetrics.timestamp,
                overallHealth: aggregatedMetrics.overallHealth,
                modules: modulesObject,
                anomalies: aggregatedMetrics.anomalies.slice(0, 10), // Limit to recent 10
                correlations: aggregatedMetrics.correlations,
            });
        } catch (error) {
            next(error);
        }
    });

    /**
     * GET /api/ai/proxy/anomalies
     * Get recent anomalies across all modules
     */
    router.get('/anomalies', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const aggregator = getMetricsAggregator();

            // Validate limit parameter with bounds
            const DEFAULT_LIMIT = 50;
            const MAX_LIMIT = 1000;
            let limit = DEFAULT_LIMIT;
            if (typeof req.query.limit === 'string') {
                const parsed = Number.parseInt(req.query.limit, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    limit = Math.min(parsed, MAX_LIMIT);
                }
            }

            const anomalies = aggregator.getRecentAnomalies(limit);

            res.json({
                success: true,
                count: anomalies.length,
                anomalies,
            });
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST /api/ai/proxy/nlq
     * Process a natural language query
     */
    router.post('/nlq', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const logger = getLogger();
            const orchestrator = await getNLQueryOrchestrator();

            const { query, userId, sessionId, context } = req.body as NLQueryRequest;

            // Validate query is present
            if (!query) {
                return res.status(400).json({
                    success: false,
                    error: 'Query is required',
                });
            }

            // Validate query length to prevent performance issues
            const MAX_QUERY_LENGTH = 1000;
            if (query.length > MAX_QUERY_LENGTH) {
                return res.status(400).json({
                    success: false,
                    error: `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters. Try shortening your request, focusing on one topic at a time, or breaking it into multiple smaller queries.`,
                });
            }

            // Validate userId format if provided (ASCII alphanumeric, dash, underscore only - max 100 chars)
            // Note: Only ASCII supported. For international usernames, use ASCII-safe identifiers (e.g., user123)
            // or have clients translate usernames to internal IDs before API calls.
            const MAX_USERID_LENGTH = 100;
            const USERID_PATTERN = /^[\w-]+$/;
            let validatedUserId = 'anonymous';
            if (userId) {
                if (userId.length > MAX_USERID_LENGTH) {
                    return res.status(400).json({
                        success: false,
                        error: `UserId exceeds maximum length of ${MAX_USERID_LENGTH} characters`,
                    });
                }
                if (!USERID_PATTERN.test(userId)) {
                    return res.status(400).json({
                        success: false,
                        error: 'UserId must contain only alphanumeric characters, dashes, or underscores',
                    });
                }
                validatedUserId = userId;
            }

            logger.info('Processing NL query', { query: query.substring(0, 100), userId: validatedUserId });

            const response = await orchestrator.processQuery({
                query,
                userId: validatedUserId,
                sessionId,
                context,
            });

            res.json(response);
        } catch (error) {
            next(error);
        }
    });

    /**
     * GET /api/ai/proxy/nlq/capabilities
     * List all available NLQ capabilities
     */
    router.get('/nlq/capabilities', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const registry = container.get<NLQCapabilityRegistry>(TYPES.NLQCapabilityRegistry);

            const module = req.query.module as string | undefined;

            let capabilities;
            if (module) {
                if (!isValidModule(module)) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid module '${module}'. Valid modules: ${VALID_MODULES.join(', ')}`,
                    });
                }
                capabilities = registry.getModuleCapabilities(module);
            } else {
                capabilities = registry.getAllCapabilities();
            }

            res.json({
                success: true,
                count: capabilities.length,
                capabilities: capabilities.map(c => ({
                    id: c.id,
                    name: c.name,
                    module: c.module,
                    description: c.description,
                    queryPatterns: c.queryPatterns,
                    requiredPermissions: c.requiredPermissions,
                })),
            });
        } catch (error) {
            next(error);
        }
    });

    /**
     * GET /api/ai/proxy/module/:module/metrics
     * Get metrics for a specific module
     */
    router.get('/module/:module/metrics', async (req: Request, res: Response, next: NextFunction) => {
        try {
            const aggregator = getMetricsAggregator();
            const moduleName = req.params.module;

            // Validate module name
            if (!isValidModule(moduleName)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid module '${moduleName}'. Valid modules: ${VALID_MODULES.join(', ')}`,
                });
            }

            // Get cached metrics for the module
            const metrics = aggregator.getModuleMetrics(moduleName);

            if (!metrics) {
                // If no cached metrics, collect fresh
                await aggregator.collectAllModuleMetrics();
                const freshMetrics = aggregator.getModuleMetrics(moduleName);

                if (!freshMetrics) {
                    return res.status(404).json({
                        success: false,
                        error: `Module '${moduleName}' not found`,
                    });
                }

                return res.json({
                    success: true,
                    metrics: freshMetrics,
                });
            }

            res.json({
                success: true,
                metrics,
            });
        } catch (error) {
            next(error);
        }
    });

    /**
     * GET /api/ai/proxy/health
     * Get AI services health status
     */
    router.get('/health', async (req: Request, res: Response, next: NextFunction) => {
        try {
            res.json({
                success: true,
                status: 'healthy',
                services: {
                    moduleMetricsAggregator: 'active',
                    nlQueryOrchestrator: 'active',
                    nlqCapabilityRegistry: 'active',
                },
                version: '1.0.0-phase1',
                phase: 'AI-Enhanced SuiteCentral 2.0 - Phase 1',
            });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
