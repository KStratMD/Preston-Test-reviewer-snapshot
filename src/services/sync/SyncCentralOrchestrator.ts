/**
 * SyncCentral Orchestrator Service
 * 
 * Coordinates sync operations between systems with AI-powered conflict resolution,
 * anomaly detection, and intelligent retry strategies.
 * 
 * Created: January 9, 2026 (SuiteCentral Parity - Phase 1)
 */

import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { ConnectorManager } from '../integration/ConnectorManager';
import type { IConnector, SearchCriteria } from '../../interfaces/IConnector';
import type { DataRecord as BaseDataRecord } from '../../types';
import type { SchemaRegistryService, SchemaField, SchemaValidationResult } from './SchemaRegistryService';

// Extended DataRecord with explicit fields property for sync operations
export interface SyncDataRecord extends BaseDataRecord {
    fields?: Record<string, unknown>;
}

// Type alias for local use (uses our extended interface)
type DataRecord = SyncDataRecord;

// Sync operation types
export interface SyncOperation {
    id: string;
    name: string;
    sourceSystem: string;
    targetSystem: string;
    entityType: string;
    direction: 'source-to-target' | 'target-to-source' | 'bidirectional';
    fieldMappings: FieldMapping[];
    schedule?: SyncSchedule;
    filters?: SearchCriteria;
    conflictResolution: ConflictResolutionStrategy;
    status: 'active' | 'paused' | 'error' | 'pending';
    lastSyncAt?: Date;
    nextSyncAt?: Date;
    metadata: {
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        totalSyncs: number;
        successfulSyncs: number;
        failedSyncs: number;
    };
}

export interface FieldMapping {
    sourceField: string;
    targetField: string;
    transformation?: 'none' | 'uppercase' | 'lowercase' | 'date' | 'number' | 'custom';
    customTransform?: string; // JavaScript expression for custom transforms
    required: boolean;
    defaultValue?: unknown;
}

export interface SyncSchedule {
    type: 'interval' | 'cron' | 'realtime' | 'manual';
    intervalMinutes?: number;
    cronExpression?: string;
    timezone?: string;
}

export type ConflictResolutionStrategy =
    | 'source-wins'
    | 'target-wins'
    | 'newest-wins'
    | 'manual'
    | 'ai-resolve';

export interface SyncResult {
    operationId: string;
    startedAt: Date;
    completedAt: Date;
    status: 'success' | 'partial' | 'failed';
    recordsProcessed: number;
    recordsCreated: number;
    recordsUpdated: number;
    recordsSkipped: number;
    recordsFailed: number;
    conflicts: SyncConflict[];
    errors: SyncError[];
    aiInsights?: AIInsight[];
    schemaValidation?: SchemaValidationResult;
}

export interface SyncConflict {
    id: string;
    recordId: string;
    sourceData: DataRecord;
    targetData: DataRecord;
    conflictType: 'update-conflict' | 'delete-conflict' | 'create-conflict';
    conflictingFields: string[];
    resolution?: ConflictResolution;
    aiSuggestion?: AIConflictSuggestion;
}

export interface ConflictResolution {
    strategy: ConflictResolutionStrategy;
    resolvedData: DataRecord;
    resolvedBy: 'auto' | 'manual' | 'ai';
    resolvedAt: Date;
    reason?: string;
}

export interface AIConflictSuggestion {
    confidence: number; // 0-1
    suggestedResolution: DataRecord;
    reasoning: string;
    fieldAnalysis: {
        field: string;
        sourceValue: unknown;
        targetValue: unknown;
        recommendation: 'use-source' | 'use-target' | 'merge';
        confidence: number;
    }[];
}

export interface AIInsight {
    type: 'anomaly' | 'pattern' | 'optimization' | 'warning';
    severity: 'info' | 'warning' | 'critical';
    message: string;
    details?: Record<string, unknown>;
    suggestedAction?: string;
}

export interface SyncError {
    recordId?: string;
    errorCode: string;
    message: string;
    retryable: boolean;
    retryCount: number;
    maxRetries: number;
}

// Anomaly detection types
export interface AnomalyAlert {
    id: string;
    operationId: string;
    type: 'volume-spike' | 'volume-drop' | 'error-rate' | 'latency' | 'data-quality' | 'duration-spike';
    severity: 'info' | 'warning' | 'critical';
    message: string;
    detectedAt: Date;
    currentValue: number;
    expectedValue: number;
    threshold: number;
    acknowledged: boolean;
}

/**
 * SyncCentralOrchestrator - Coordinates sync operations with AI enhancements
 */
@injectable()
export class SyncCentralOrchestrator {
    private operations = new Map<string, SyncOperation>();
    private syncHistory = new Map<string, SyncResult[]>();
    private anomalyAlerts = new Map<string, AnomalyAlert[]>();
    private runningOperations = new Set<string>();

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.ConnectorManager) private readonly connectorManager: ConnectorManager,
        @inject(TYPES.SchemaRegistryService) @optional() private readonly schemaRegistry?: SchemaRegistryService,
    ) {
        this.initializeDemoOperations();
        this.logger.info('SyncCentralOrchestrator initialized');
    }

    /**
     * Create a new sync operation
     */
    async createOperation(config: Omit<SyncOperation, 'id' | 'status' | 'metadata'>): Promise<SyncOperation> {
        const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

        const operation: SyncOperation = {
            ...config,
            id,
            status: 'pending',
            metadata: {
                createdAt: new Date(),
                updatedAt: new Date(),
                createdBy: 'system',
                totalSyncs: 0,
                successfulSyncs: 0,
                failedSyncs: 0,
            },
        };

        this.operations.set(id, operation);
        this.logger.info(`Created sync operation: ${operation.name}`, { operationId: id });

        return operation;
    }

    /**
     * Get all sync operations
     */
    async getOperations(filters?: { status?: string; sourceSystem?: string }): Promise<SyncOperation[]> {
        let ops = Array.from(this.operations.values());

        if (filters?.status) {
            ops = ops.filter(op => op.status === filters.status);
        }
        if (filters?.sourceSystem) {
            ops = ops.filter(op => op.sourceSystem === filters.sourceSystem);
        }

        return ops;
    }

    /**
     * Execute a sync operation
     */
    async executeSync(operationId: string): Promise<SyncResult> {
        const operation = this.operations.get(operationId);
        if (!operation) {
            throw new Error(`Sync operation not found: ${operationId}`);
        }

        if (this.runningOperations.has(operationId)) {
            throw new Error(`Sync operation already running: ${operationId}`);
        }

        this.runningOperations.add(operationId);
        const startedAt = new Date();

        this.logger.info(`Starting sync operation: ${operation.name}`, { operationId });

        try {
            // Get source and target connectors
            const sourceConnector = await this.connectorManager.getConnector(
                operation.sourceSystem,
                `${operation.sourceSystem}_${operationId}`
            );
            const targetConnector = await this.connectorManager.getConnector(
                operation.targetSystem,
                `${operation.targetSystem}_${operationId}`
            );

            // Fetch source records
            const sourceRecords = await this.fetchSourceRecords(sourceConnector, operation);

            // --- Schema drift check ---
            let schemaValidation: SchemaValidationResult | undefined;
            if (this.schemaRegistry) {
                const inferredFields = this.inferSchemaFieldsFromRecords(sourceRecords);
                if (inferredFields.length > 0) {
                    const validation = this.schemaRegistry.validateSchema(
                        operation.sourceSystem, operation.entityType, inferredFields
                    );
                    schemaValidation = validation;
                    if (validation.shouldBlockSync) {
                        const blockedResult: SyncResult = {
                            operationId,
                            startedAt,
                            completedAt: new Date(),
                            status: 'failed',
                            recordsProcessed: 0,
                            recordsCreated: 0,
                            recordsUpdated: 0,
                            recordsSkipped: sourceRecords.length,
                            recordsFailed: 0,
                            conflicts: [],
                            errors: [{
                                errorCode: 'SCHEMA_DRIFT_BLOCKED',
                                message: validation.alertMessage || 'Sync blocked due to critical schema drift',
                                retryable: false,
                                retryCount: 0,
                                maxRetries: 0,
                            }],
                            schemaValidation: validation,
                        };
                        operation.status = 'error';
                        operation.lastSyncAt = new Date();
                        operation.metadata.failedSyncs++;
                        operation.metadata.totalSyncs++;
                        operation.metadata.updatedAt = new Date();
                        const history = this.syncHistory.get(operationId) || [];
                        history.push(blockedResult);
                        this.syncHistory.set(operationId, history.slice(-100));
                        this.logger.warn(`Sync blocked by schema drift: ${operation.name}`, {
                            operationId, driftCount: validation.drifts.length, alertMessage: validation.alertMessage,
                        });
                        return blockedResult;
                    }
                    if (!validation.isValid) {
                        this.logger.warn('Schema drift detected but sync allowed', {
                            system: operation.sourceSystem, entityType: operation.entityType,
                            driftCount: validation.drifts.length,
                        });
                    }
                }
            }
            // --- End schema drift check ---

            // Process each record
            const result = await this.processRecords(
                sourceRecords,
                targetConnector,
                operation
            );

            // Check for anomalies
            await this.detectAnomalies(operationId, result);

            // Update operation metadata based on actual result status
            operation.lastSyncAt = new Date();
            operation.metadata.totalSyncs++;
            operation.metadata.updatedAt = new Date();

            // Only increment successfulSyncs if fully successful, track partial/failed appropriately
            if (result.status === 'success') {
                operation.metadata.successfulSyncs++;
                operation.status = 'active';
            } else if (result.status === 'partial') {
                // Partial success - some records failed but sync completed
                operation.metadata.successfulSyncs++; // Count as successful but log warning
                operation.status = 'active';
                this.logger.warn(`Sync operation completed with partial success: ${operation.name}`, {
                    operationId,
                    recordsFailed: result.recordsFailed,
                    recordsProcessed: result.recordsProcessed,
                });
            } else {
                // Failed - all records failed
                operation.metadata.failedSyncs++;
                operation.status = 'error';
            }

            // Store result in history
            const history = this.syncHistory.get(operationId) || [];
            history.push(result);
            this.syncHistory.set(operationId, history.slice(-100)); // Keep last 100

            // Attach schema validation metadata if available
            if (schemaValidation) {
                result.schemaValidation = schemaValidation;
            }

            this.logger.info(`Sync operation completed: ${operation.name}`, {
                operationId,
                recordsProcessed: result.recordsProcessed,
                duration: result.completedAt.getTime() - result.startedAt.getTime(),
            });

            return result;
        } catch (error) {
            operation.status = 'error';
            operation.metadata.failedSyncs++;
            operation.metadata.totalSyncs++;
            operation.metadata.updatedAt = new Date();
            operation.lastSyncAt = new Date();

            const errorResult: SyncResult = {
                operationId,
                startedAt,
                completedAt: new Date(),
                status: 'failed',
                recordsProcessed: 0,
                recordsCreated: 0,
                recordsUpdated: 0,
                recordsSkipped: 0,
                recordsFailed: 0,
                conflicts: [],
                errors: [{
                    errorCode: 'SYNC_FAILED',
                    message: error instanceof Error ? error.message : 'Unknown error',
                    retryable: true,
                    retryCount: 0,
                    maxRetries: 3,
                }],
            };

            const history = this.syncHistory.get(operationId) || [];
            history.push(errorResult);
            this.syncHistory.set(operationId, history.slice(-100));

            this.logger.error(`Sync operation failed: ${operation.name}`, {
                operationId,
                error: error instanceof Error ? error.message : String(error)
            });

            return errorResult;
        } finally {
            this.runningOperations.delete(operationId);
        }
    }

    /**
     * Resolve a sync conflict
     */
    async resolveConflict(
        operationId: string,
        conflictId: string,
        resolution: ConflictResolution
    ): Promise<void> {
        const history = this.syncHistory.get(operationId);
        if (!history?.length) {
            throw new Error(`No sync history found for operation: ${operationId}`);
        }

        const latestResult = history[history.length - 1];
        const conflict = latestResult.conflicts.find(c => c.id === conflictId);

        if (!conflict) {
            throw new Error(`Conflict not found: ${conflictId}`);
        }

        conflict.resolution = resolution;
        this.logger.info(`Conflict resolved: ${conflictId}`, { resolution: resolution.strategy });
    }

    /**
     * Get AI suggestion for conflict resolution
     */
    async getAIConflictSuggestion(conflict: SyncConflict): Promise<AIConflictSuggestion> {
        // AI-powered conflict resolution logic
        const fieldAnalysis = conflict.conflictingFields.map(field => {
            const sourceValue = conflict.sourceData.fields?.[field];
            const targetValue = conflict.targetData.fields?.[field];

            // Simple heuristics - in production, use ML model
            let recommendation: 'use-source' | 'use-target' | 'merge' = 'use-source';
            let confidence = 0.7;

            // Prefer non-null values
            if (sourceValue === null || sourceValue === undefined) {
                recommendation = 'use-target';
                confidence = 0.9;
            } else if (targetValue === null || targetValue === undefined) {
                recommendation = 'use-source';
                confidence = 0.9;
            }
            // Prefer newer timestamps
            else if (field.includes('date') || field.includes('time')) {
                const sourceDate = new Date(String(sourceValue)).getTime();
                const targetDate = new Date(String(targetValue)).getTime();
                recommendation = sourceDate > targetDate ? 'use-source' : 'use-target';
                confidence = 0.85;
            }
            // For strings, prefer longer (more complete) values
            else if (typeof sourceValue === 'string' && typeof targetValue === 'string') {
                recommendation = sourceValue.length >= targetValue.length ? 'use-source' : 'use-target';
                confidence = 0.65;
            }

            return { field, sourceValue, targetValue, recommendation, confidence };
        });

        // Build suggested resolution
        const suggestedData: DataRecord = {
            id: conflict.sourceData.id,
            fields: { ...(conflict.targetData.fields || {}) },
        };

        fieldAnalysis.forEach(analysis => {
            if (suggestedData.fields) {
                if (analysis.recommendation === 'use-source') {
                    suggestedData.fields[analysis.field] = analysis.sourceValue;
                } else if (analysis.recommendation === 'use-target') {
                    // Target value already present from spread
                } else if (typeof analysis.sourceValue === 'string' &&
                    typeof analysis.targetValue === 'string') {
                    // Merge case
                    suggestedData.fields[analysis.field] =
                        `${analysis.sourceValue} | ${analysis.targetValue}`;
                }
            }
        });

        const avgConfidence = fieldAnalysis.reduce((sum, a) => sum + a.confidence, 0) / fieldAnalysis.length;

        return {
            confidence: avgConfidence,
            suggestedResolution: suggestedData,
            reasoning: `AI analyzed ${fieldAnalysis.length} conflicting fields. ` +
                `Recommendation based on data completeness and recency patterns.`,
            fieldAnalysis,
        };
    }

    /**
     * Get anomaly alerts for an operation
     */
    async getAnomalyAlerts(operationId?: string): Promise<AnomalyAlert[]> {
        if (operationId) {
            return this.anomalyAlerts.get(operationId) || [];
        }

        const allAlerts: AnomalyAlert[] = [];
        this.anomalyAlerts.forEach(alerts => allAlerts.push(...alerts));
        return allAlerts.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
    }

    /**
     * Get sync statistics
     */
    async getStatistics(): Promise<{
        totalOperations: number;
        activeOperations: number;
        pausedOperations: number;
        errorOperations: number;
        totalSyncsToday: number;
        successRate: number;
        averageSyncDuration: number;
        activeAnomalies: number;
    }> {
        const ops = Array.from(this.operations.values());
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let totalSyncsToday = 0;
        let successfulSyncs = 0;
        let totalDuration = 0;
        let durationCount = 0;

        this.syncHistory.forEach(history => {
            history.forEach(result => {
                if (result.startedAt >= today) {
                    totalSyncsToday++;
                    if (result.status === 'success') successfulSyncs++;
                    totalDuration += result.completedAt.getTime() - result.startedAt.getTime();
                    durationCount++;
                }
            });
        });

        let activeAnomalies = 0;
        this.anomalyAlerts.forEach(alerts => {
            activeAnomalies += alerts.filter(a => !a.acknowledged).length;
        });

        return {
            totalOperations: ops.length,
            activeOperations: ops.filter(op => op.status === 'active').length,
            pausedOperations: ops.filter(op => op.status === 'paused').length,
            errorOperations: ops.filter(op => op.status === 'error').length,
            totalSyncsToday,
            successRate: totalSyncsToday > 0 ? (successfulSyncs / totalSyncsToday) * 100 : 100,
            averageSyncDuration: durationCount > 0 ? totalDuration / durationCount : 0,
            activeAnomalies,
        };
    }

    // Private methods

    private async fetchSourceRecords(
        connector: IConnector,
        operation: SyncOperation
    ): Promise<DataRecord[]> {
        if (operation.filters) {
            return connector.search(operation.entityType, operation.filters);
        }
        return connector.list(operation.entityType, { limit: 1000 });
    }

    private async processRecords(
        sourceRecords: DataRecord[],
        targetConnector: IConnector,
        operation: SyncOperation
    ): Promise<SyncResult> {
        const startedAt = new Date();
        let created = 0;
        let updated = 0;
        let skipped = 0;
        let failed = 0;
        const conflicts: SyncConflict[] = [];
        const errors: SyncError[] = [];

        for (const sourceRecord of sourceRecords) {
            try {
                // Transform fields
                const transformedRecord = this.transformRecord(sourceRecord, operation.fieldMappings);

                // Check if record exists in target
                const existingRecord = await targetConnector.read(
                    operation.entityType,
                    sourceRecord.id
                );

                if (existingRecord) {
                    // Check for conflicts
                    const conflictingFields = this.detectConflictingFields(
                        transformedRecord,
                        existingRecord
                    );

                    if (conflictingFields.length > 0) {
                        const conflict: SyncConflict = {
                            id: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
                            recordId: sourceRecord.id,
                            sourceData: transformedRecord,
                            targetData: existingRecord,
                            conflictType: 'update-conflict',
                            conflictingFields,
                        };

                        // Auto-resolve if configured
                        if (operation.conflictResolution === 'ai-resolve') {
                            conflict.aiSuggestion = await this.getAIConflictSuggestion(conflict);
                            if (conflict.aiSuggestion.confidence >= 0.8) {
                                await targetConnector.update(
                                    operation.entityType,
                                    sourceRecord.id,
                                    conflict.aiSuggestion.suggestedResolution
                                );
                                updated++;
                                continue;
                            }
                        } else if (operation.conflictResolution === 'source-wins') {
                            await targetConnector.update(
                                operation.entityType,
                                sourceRecord.id,
                                transformedRecord
                            );
                            updated++;
                            continue;
                        }

                        conflicts.push(conflict);
                        skipped++;
                    } else {
                        await targetConnector.update(
                            operation.entityType,
                            sourceRecord.id,
                            transformedRecord
                        );
                        updated++;
                    }
                } else {
                    await targetConnector.create(operation.entityType, transformedRecord);
                    created++;
                }
            } catch (error) {
                failed++;
                errors.push({
                    recordId: sourceRecord.id,
                    errorCode: 'RECORD_SYNC_FAILED',
                    message: error instanceof Error ? error.message : 'Unknown error',
                    retryable: true,
                    retryCount: 0,
                    maxRetries: 3,
                });
            }
        }

        return {
            operationId: operation.id,
            startedAt,
            completedAt: new Date(),
            status: failed > 0 ? (failed === sourceRecords.length ? 'failed' : 'partial') : 'success',
            recordsProcessed: sourceRecords.length,
            recordsCreated: created,
            recordsUpdated: updated,
            recordsSkipped: skipped,
            recordsFailed: failed,
            conflicts,
            errors,
        };
    }

    private transformRecord(record: DataRecord, mappings: FieldMapping[]): DataRecord {
        const transformed: DataRecord = {
            id: record.id,
            externalId: record.externalId,
            fields: {},
        };

        for (const mapping of mappings) {
            let value = record.fields?.[mapping.sourceField] ?? mapping.defaultValue;

            if (value !== undefined && mapping.transformation) {
                switch (mapping.transformation) {
                    case 'uppercase':
                        value = String(value).toUpperCase();
                        break;
                    case 'lowercase':
                        value = String(value).toLowerCase();
                        break;
                    case 'date':
                        value = new Date(String(value)).toISOString();
                        break;
                    case 'number':
                        value = Number(value);
                        break;
                }
            }

            if (transformed.fields) {
                transformed.fields[mapping.targetField] = value;
            }
        }

        return transformed;
    }

    private detectConflictingFields(source: DataRecord, target: DataRecord): string[] {
        const conflicts: string[] = [];

        if (source.fields && target.fields) {
            for (const [key, sourceValue] of Object.entries(source.fields)) {
                const targetValue = target.fields[key];
                if (targetValue !== undefined &&
                    JSON.stringify(sourceValue) !== JSON.stringify(targetValue)) {
                    conflicts.push(key);
                }
            }
        }

        return conflicts;
    }

    private async detectAnomalies(operationId: string, result: SyncResult): Promise<void> {
        const alerts: AnomalyAlert[] = [];
        const history = this.syncHistory.get(operationId) || [];

        // Skip if not enough history
        if (history.length < 5) return;

        const recentResults = history.slice(-10);
        const avgRecords = recentResults.reduce((sum, r) => sum + r.recordsProcessed, 0) / recentResults.length;
        const avgDuration = recentResults.reduce((sum, r) =>
            sum + (r.completedAt.getTime() - r.startedAt.getTime()), 0) / recentResults.length;

        // Check for volume spike
        if (result.recordsProcessed > avgRecords * 2) {
            alerts.push({
                id: `alert_${Date.now()}`,
                operationId,
                type: 'volume-spike',
                severity: 'warning',
                message: `Unusual volume spike: ${result.recordsProcessed} records (avg: ${Math.round(avgRecords)})`,
                detectedAt: new Date(),
                currentValue: result.recordsProcessed,
                expectedValue: avgRecords,
                threshold: avgRecords * 2,
                acknowledged: false,
            });
        }

        // Check for duration spike (sync taking unusually long)
        const currentDuration = result.completedAt.getTime() - result.startedAt.getTime();
        if (currentDuration > avgDuration * 3 && avgDuration > 1000) {
            alerts.push({
                id: `alert_${Date.now() + 2}`,
                operationId,
                type: 'duration-spike',
                severity: 'warning',
                message: `Sync duration spike: ${Math.round(currentDuration / 1000)}s (avg: ${Math.round(avgDuration / 1000)}s)`,
                detectedAt: new Date(),
                currentValue: currentDuration,
                expectedValue: avgDuration,
                threshold: avgDuration * 3,
                acknowledged: false,
            });
        }

        // Check for high error rate
        const errorRate = result.recordsFailed / result.recordsProcessed;
        if (errorRate > 0.1 && result.recordsProcessed > 10) {
            alerts.push({
                id: `alert_${Date.now() + 1}`,
                operationId,
                type: 'error-rate',
                severity: errorRate > 0.25 ? 'critical' : 'warning',
                message: `High error rate: ${(errorRate * 100).toFixed(1)}% of records failed`,
                detectedAt: new Date(),
                currentValue: errorRate,
                expectedValue: 0.05,
                threshold: 0.1,
                acknowledged: false,
            });
        }

        if (alerts.length > 0) {
            const existing = this.anomalyAlerts.get(operationId) || [];
            this.anomalyAlerts.set(operationId, [...existing, ...alerts].slice(-50));
        }
    }

    /**
     * Infer the type of a single field value with edge-case handling
     */
    private inferFieldType(value: unknown): string {
        if (value === null || value === undefined) return 'unknown';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
        if (value instanceof Date) return 'date';
        if (typeof value === 'string') {
            if (/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(value)) return 'date';
            return 'string';
        }
        if (Array.isArray(value)) return 'array';
        if (typeof value === 'object') return 'object';
        return 'string';
    }

    /**
     * Infer schema fields from a union of all records (sampled to 100 max)
     */
    private inferSchemaFieldsFromRecords(records: DataRecord[]): SchemaField[] {
        if (records.length === 0) return [];

        const SAMPLE_SIZE = 100;
        // 95% non-null confidence threshold so a few sparse/null records don't flip
        // 'required' to false (noise), but genuine regressions where a meaningful
        // fraction of records are missing the field still produce a drift signal.
        const REQUIRED_CONFIDENCE_THRESHOLD = 0.95;
        let sample = records;
        if (records.length > SAMPLE_SIZE) {
            const step = Math.floor(records.length / SAMPLE_SIZE);
            sample = [];
            for (let i = 0; i < records.length && sample.length < SAMPLE_SIZE; i += step) {
                sample.push(records[i]);
            }
            // Always include last record to reduce positional bias, without exceeding SAMPLE_SIZE
            const lastRecord = records[records.length - 1];
            if (sample[sample.length - 1] !== lastRecord) {
                if (sample.length < SAMPLE_SIZE) {
                    sample.push(lastRecord);
                } else {
                    sample[sample.length - 1] = lastRecord;
                }
            }
        }

        const fieldStats = new Map<string, { typeCounts: Map<string, number>; nonNullCount: number }>();
        for (const record of sample) {
            if (!record.fields) continue;
            for (const [key, value] of Object.entries(record.fields)) {
                let stats = fieldStats.get(key);
                if (!stats) {
                    stats = { typeCounts: new Map(), nonNullCount: 0 };
                    fieldStats.set(key, stats);
                }
                if (value !== null && value !== undefined) {
                    stats.nonNullCount++;
                    const t = this.inferFieldType(value);
                    stats.typeCounts.set(t, (stats.typeCounts.get(t) || 0) + 1);
                }
            }
        }

        const schemaFields: SchemaField[] = [];
        for (const [name, stats] of fieldStats) {
            // Numeric promotion: any presence of 'number' wins over 'integer'
            const observedTypes = new Set(stats.typeCounts.keys());
            let bestType: string;
            if (observedTypes.has('number') && observedTypes.has('integer')) {
                bestType = 'number';
            } else {
                bestType = 'string';
                let bestCount = 0;
                for (const [t, count] of stats.typeCounts) {
                    if (count > bestCount) { bestType = t; bestCount = count; }
                }
            }
            const required = sample.length > 0
                && (stats.nonNullCount / sample.length) >= REQUIRED_CONFIDENCE_THRESHOLD;
            schemaFields.push({ name, type: bestType, required, inferred: true });
        }
        return schemaFields;
    }

    private initializeDemoOperations(): void {
        // Create demo sync operations
        const demoOps: Omit<SyncOperation, 'id' | 'status' | 'metadata'>[] = [
            {
                name: 'HubSpot → NetSuite Contacts',
                sourceSystem: 'hubspot',
                targetSystem: 'netsuite',
                entityType: 'contacts',
                direction: 'source-to-target',
                conflictResolution: 'ai-resolve',
                fieldMappings: [
                    { sourceField: 'firstname', targetField: 'firstName', required: true, transformation: 'none' },
                    { sourceField: 'lastname', targetField: 'lastName', required: true, transformation: 'none' },
                    { sourceField: 'email', targetField: 'email', required: true, transformation: 'lowercase' },
                    { sourceField: 'phone', targetField: 'phone', required: false, transformation: 'none' },
                    { sourceField: 'company', targetField: 'companyName', required: false, transformation: 'none' },
                ],
                schedule: { type: 'interval', intervalMinutes: 15 },
            },
            {
                name: 'Shopify Orders → NetSuite Sales Orders',
                sourceSystem: 'shopify',
                targetSystem: 'netsuite',
                entityType: 'orders',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [
                    { sourceField: 'order_number', targetField: 'tranId', required: true, transformation: 'none' },
                    { sourceField: 'total_price', targetField: 'total', required: true, transformation: 'number' },
                    { sourceField: 'created_at', targetField: 'tranDate', required: true, transformation: 'date' },
                ],
                schedule: { type: 'realtime' },
            },
            {
                name: 'ShipStation Tracking → NetSuite',
                sourceSystem: 'shipstation',
                targetSystem: 'netsuite',
                entityType: 'shipments',
                direction: 'source-to-target',
                conflictResolution: 'source-wins',
                fieldMappings: [
                    { sourceField: 'trackingNumber', targetField: 'trackingNumber', required: true, transformation: 'none' },
                    { sourceField: 'shipDate', targetField: 'shipDate', required: true, transformation: 'date' },
                    { sourceField: 'carrierCode', targetField: 'carrier', required: false, transformation: 'uppercase' },
                ],
                schedule: { type: 'interval', intervalMinutes: 30 },
            },
        ];

        demoOps.forEach(config => {
            const id = `demo_${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
            this.operations.set(id, {
                ...config,
                id,
                status: 'active',
                lastSyncAt: new Date(Date.now() - Math.random() * 3600000),
                metadata: {
                    createdAt: new Date(Date.now() - 86400000 * 7),
                    updatedAt: new Date(),
                    createdBy: 'demo',
                    totalSyncs: Math.floor(Math.random() * 500) + 100,
                    successfulSyncs: Math.floor(Math.random() * 490) + 95,
                    failedSyncs: Math.floor(Math.random() * 10),
                },
            });
        });

        this.logger.debug(`Initialized ${this.operations.size} demo sync operations`);
    }
}

export default SyncCentralOrchestrator;
