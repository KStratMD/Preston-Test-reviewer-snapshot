/**
 * SyncCentral Orchestrator Routes
 * Handles sync operations, conflicts, and AI-powered suggestions
 */
import * as express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SyncCentralOrchestrator, ConflictResolution } from '../services/sync/SyncCentralOrchestrator';
import type { SchemaRegistryService, SchemaField } from '../services/sync/SchemaRegistryService';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

const router = express.Router();

// Get all sync operations
router.get('/operations', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const filters = {
        status: req.query.status as string | undefined,
        sourceSystem: req.query.sourceSystem as string | undefined,
    };
    const operations = await orchestrator.getOperations(filters);
    res.json({ success: true, operations, count: operations.length });
}));

// Create sync operation
router.post('/operations', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const operation = await orchestrator.createOperation(req.body);
    res.status(201).json({ success: true, operation });
}));

// Get single operation
router.get('/operations/:id', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const operations = await orchestrator.getOperations();
    const operation = operations.find(op => op.id === req.params.id);
    if (!operation) {
        res.status(404).json({ success: false, error: 'Operation not found' });
        return;
    }
    res.json({ success: true, operation });
}));

// Execute sync operation
router.post('/operations/:id/execute', asyncHandler(async (req, res) => {
    try {
        const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
        const result = await orchestrator.executeSync(req.params.id);
        res.json({ success: true, result });
    } catch (error) {
        if (await handleApprovalQueueError(error, req, res, {
            operationType: 'connector_write',
            resourceType: 'sync_orchestrator.execute',
            resourceId: req.params.id,
        })) return;
        throw error;
    }
}));

// Get AI conflict suggestion
router.post('/conflicts/:conflictId/ai-suggest', asyncHandler(async (req, res) => {
    try {
        const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
        const suggestion = await orchestrator.getAIConflictSuggestion(req.body.conflict);
        res.json({ success: true, suggestion });
    } catch (error) {
        if (await handleApprovalQueueError(error, req, res, {
            operationType: 'ai_call',
            resourceType: 'sync_orchestrator.ai_conflict_suggest',
            resourceId: req.params.conflictId,
        })) return;
        throw error;
    }
}));

// Resolve conflict
router.post('/conflicts/:conflictId/resolve', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const resolution: ConflictResolution = {
        strategy: req.body.strategy,
        resolvedData: req.body.resolvedData,
        resolvedBy: req.body.resolvedBy || 'manual',
        resolvedAt: new Date(),
        reason: req.body.reason,
    };
    await orchestrator.resolveConflict(req.body.operationId, req.params.conflictId, resolution);
    res.json({ success: true, message: 'Conflict resolved' });
}));

// Get anomaly alerts
router.get('/alerts', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const operationId = req.query.operationId as string | undefined;
    const alerts = await orchestrator.getAnomalyAlerts(operationId);
    res.json({ success: true, alerts, count: alerts.length });
}));

// Get sync statistics
router.get('/statistics', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const statistics = await orchestrator.getStatistics();
    res.json({ success: true, statistics });
}));

// Get dashboard data (operations + stats + alerts + schemas)
router.get('/dashboard', asyncHandler(async (req, res) => {
    const orchestrator = await container.getAsync<SyncCentralOrchestrator>(TYPES.SyncCentralOrchestrator);
    const schemaRegistry = container.get<SchemaRegistryService>(TYPES.SchemaRegistryService);
    const [operations, statistics, alerts] = await Promise.all([
        orchestrator.getOperations(),
        orchestrator.getStatistics(),
        orchestrator.getAnomalyAlerts(),
    ]);
    const registeredSchemas = schemaRegistry.getRegisteredSchemas();
    res.json({
        success: true,
        dashboard: {
            operations: operations.slice(0, 10),
            statistics,
            recentAlerts: alerts.slice(0, 5),
            registeredSchemas,
        },
    });
}));

// --- Schema Management Endpoints ---

function validateSchemaFields(fields: unknown): string | null {
    if (!Array.isArray(fields) || fields.length === 0) {
        return 'fields must be a non-empty array';
    }
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (!f || typeof f !== 'object') {
            return `fields[${i}] must be an object`;
        }
        if (typeof f.name !== 'string' || !f.name) {
            return `fields[${i}].name must be a non-empty string`;
        }
        if (typeof f.type !== 'string' || !f.type) {
            return `fields[${i}].type must be a non-empty string`;
        }
        if (typeof f.required !== 'boolean') {
            return `fields[${i}].required must be a boolean`;
        }
    }
    const seen = new Set<string>();
    for (const f of fields) {
        if (seen.has(f.name)) {
            return `duplicate field name "${f.name}"`;
        }
        seen.add(f.name);
    }
    return null;
}

/**
 * Strip internal-only metadata (e.g. `inferred`) from caller-supplied schema
 * fields. `inferred` is a server-set provenance marker on `SchemaField` that
 * indicates a field came from sample-based inference (set in
 * `SyncCentralOrchestrator.inferSchemaFieldsFromRecords`). It is internal
 * audit/transparency metadata; accepting it from external callers would
 * corrupt the provenance trail and mislead any downstream code (dashboards,
 * audit logs, future severity logic) that consumes it.
 */
function sanitizeSchemaFields(fields: unknown[]): SchemaField[] {
    return fields.map((f) => {
        const raw = f as Record<string, unknown>;
        const sanitized: SchemaField = {
            name: raw.name as string,
            type: raw.type as string,
            required: raw.required as boolean,
        };
        if (Array.isArray(raw.enumValues)) sanitized.enumValues = raw.enumValues as string[];
        if (typeof raw.maxLength === 'number') sanitized.maxLength = raw.maxLength;
        if (typeof raw.format === 'string') sanitized.format = raw.format;
        return sanitized;
    });
}

// Register a schema
router.post('/schemas', asyncHandler(async (req, res) => {
    const { system, objectType, schema } = req.body;
    if (!system || typeof system !== 'string') {
        res.status(400).json({ success: false, error: 'system is required and must be a non-empty string' });
        return;
    }
    if (!objectType || typeof objectType !== 'string') {
        res.status(400).json({ success: false, error: 'objectType is required and must be a non-empty string' });
        return;
    }
    if (!schema || !schema.fields) {
        res.status(400).json({ success: false, error: 'schema with fields is required' });
        return;
    }
    const fieldError = validateSchemaFields(schema.fields);
    if (fieldError) {
        res.status(400).json({ success: false, error: fieldError });
        return;
    }
    const schemaRegistry = container.get<SchemaRegistryService>(TYPES.SchemaRegistryService);
    const hash = schemaRegistry.registerSchema(system, objectType, {
        system,
        objectType,
        version: (typeof schema.version === 'string' && schema.version) ? schema.version : '1.0.0',
        fields: sanitizeSchemaFields(schema.fields),
        lastUpdated: new Date(),
    });
    res.status(201).json({ success: true, hash });
}));

// List registered schemas
router.get('/schemas', asyncHandler(async (_req, res) => {
    const schemaRegistry = container.get<SchemaRegistryService>(TYPES.SchemaRegistryService);
    const schemas = schemaRegistry.getRegisteredSchemas();
    res.json({ success: true, schemas, count: schemas.length });
}));

// Validate fields against registered schema
router.post('/schemas/validate', asyncHandler(async (req, res) => {
    const { system, objectType, fields } = req.body;
    if (!system || typeof system !== 'string') {
        res.status(400).json({ success: false, error: 'system is required and must be a non-empty string' });
        return;
    }
    if (!objectType || typeof objectType !== 'string') {
        res.status(400).json({ success: false, error: 'objectType is required and must be a non-empty string' });
        return;
    }
    const fieldError = validateSchemaFields(fields);
    if (fieldError) {
        res.status(400).json({ success: false, error: fieldError });
        return;
    }
    const schemaRegistry = container.get<SchemaRegistryService>(TYPES.SchemaRegistryService);
    const validation = schemaRegistry.validateSchema(system, objectType, sanitizeSchemaFields(fields));
    res.json({ success: true, validation });
}));

// Clear a registered schema
router.delete('/schemas/:system/:objectType', asyncHandler(async (req, res) => {
    const { system, objectType } = req.params;
    if (!system || !objectType) {
        res.status(400).json({ success: false, error: 'system and objectType are required' });
        return;
    }
    const schemaRegistry = container.get<SchemaRegistryService>(TYPES.SchemaRegistryService);
    const deleted = schemaRegistry.clearSchema(system, objectType);
    if (!deleted) {
        res.status(404).json({ success: false, error: 'Schema not found' });
        return;
    }
    res.json({ success: true, message: 'Schema cleared' });
}));

export { router as syncOrchestratorRouter };
