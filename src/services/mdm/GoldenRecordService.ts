import { injectable, inject } from 'inversify';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import { EntityMatchingService, EntityRecord, MatchCandidate } from './EntityMatchingService';
import { SurvivorshipRuleEngine, SurvivorshipResult } from './SurvivorshipRuleEngine';
import { MDMFeedbackService } from './MDMFeedbackService';
import { MDMRepository } from '../../database/repositories/MDMRepository';
import type { MDMGoldenRecordRow, MDMEntitySourceRow, MDMSyncRequestRow } from '../../database/types';

/**
 * Golden Record Service
 *
 * Core MDM orchestrator that creates and manages golden records.
 *
 * Features:
 * - Create golden records from matched entities
 * - Apply survivorship rules for conflict resolution
 * - Track source linkage
 * - Manual approval workflow for sync
 */

export interface GoldenRecord {
    id: string;
    entityType: 'vendor' | 'customer' | 'product';
    data: Record<string, unknown>;
    confidence: number;
    sources: EntitySource[];
    conflicts: SurvivorshipResult[];
    status: 'draft' | 'active' | 'pending_review' | 'archived';
    createdAt: Date;
    updatedAt: Date;
    approvedBy?: string;
    approvedAt?: Date;
}

export interface EntitySource {
    sourceSystem: string;
    sourceRecordId: string;
    sourceData: Record<string, unknown>;
    lastSyncedAt: Date;
    syncStatus: 'synced' | 'pending' | 'failed' | 'manual_required';
}

export interface SyncRequest {
    id: string;
    goldenRecordId: string;
    targetSystems: string[];
    requestedBy: string;
    status: 'pending' | 'approved' | 'rejected' | 'completed';
    createdAt: Date;
    reviewedBy?: string;
    reviewedAt?: Date;
}

@injectable()
export class GoldenRecordService {
    private logger: Logger;
    private entityMatcher: EntityMatchingService;
    private survivorshipEngine: SurvivorshipRuleEngine;
    private feedbackService: MDMFeedbackService;
    private mdmRepository: MDMRepository;

    constructor(
        @inject(TYPES.Logger) logger: Logger,
        @inject(TYPES.EntityMatchingService) entityMatcher: EntityMatchingService,
        @inject(TYPES.SurvivorshipRuleEngine) survivorshipEngine: SurvivorshipRuleEngine,
        @inject(TYPES.MDMFeedbackService) feedbackService: MDMFeedbackService,
        @inject(TYPES.MDMRepository) mdmRepository: MDMRepository
    ) {
        this.logger = logger;
        this.entityMatcher = entityMatcher;
        this.survivorshipEngine = survivorshipEngine;
        this.feedbackService = feedbackService;
        this.mdmRepository = mdmRepository;
        this.logger.info('[GoldenRecord] Service initialized');
    }

    /**
     * Create a golden record from matched entities
     */
    async createGoldenRecord(match: MatchCandidate): Promise<GoldenRecord> {
        const entities = [
            { sourceSystem: match.entityA.sourceSystem, data: match.entityA.data as Record<string, unknown>, updatedAt: match.entityA.lastUpdated },
            { sourceSystem: match.entityB.sourceSystem, data: match.entityB.data as Record<string, unknown>, updatedAt: match.entityB.lastUpdated }
        ];

        await this.survivorshipEngine.ensureInitialized();
        const { mergedData, conflicts } = this.survivorshipEngine.mergeEntities(
            match.entityA.entityType,
            entities
        );

        const id = this.generateId();
        const now = new Date();
        const status = conflicts.length > 0 ? 'pending_review' : 'active';

        const sources = [
            {
                source_system: match.entityA.sourceSystem,
                source_record_id: match.entityA.id,
                source_data: match.entityA.data as Record<string, unknown>,
                last_synced_at: now,
                sync_status: 'synced' as const,
                golden_record_id: id,
            },
            {
                source_system: match.entityB.sourceSystem,
                source_record_id: match.entityB.id,
                source_data: match.entityB.data as Record<string, unknown>,
                last_synced_at: now,
                sync_status: 'synced' as const,
                golden_record_id: id,
            }
        ];

        const grRow = await this.mdmRepository.createGoldenRecordWithSources(
            {
                id,
                entity_type: match.entityA.entityType,
                data: mergedData,
                confidence: match.matchScore,
                conflicts: conflicts as any,
                conflict_count: conflicts.length,
                status,
                approved_by: null,
                approved_at: null,
            },
            sources
        );

        // Best-effort feedback write — primary record already committed
        try {
            await this.recordConflicts(conflicts);
        } catch (err) {
            this.logger.error('[GoldenRecord] Feedback write failed (non-blocking)', err);
        }

        // Use returned row; only fetch sources (not included in insert return)
        const sourceRows = await this.mdmRepository.findSourcesByGoldenRecordId(id);
        const goldenRecord = this.rowToGoldenRecord(grRow, sourceRows);

        this.logger.info('[GoldenRecord] Created', {
            id: goldenRecord.id,
            entityType: goldenRecord.entityType,
            conflictCount: conflicts.length,
            status: goldenRecord.status
        });

        return goldenRecord;
    }

    /**
     * Create golden record from multiple entities
     */
    async createFromEntities(entities: EntityRecord[]): Promise<GoldenRecord> {
        if (entities.length === 0) {
            throw new Error('At least one entity required');
        }

        const entityType = entities[0].entityType;
        const entityData = entities.map(e => ({
            sourceSystem: e.sourceSystem,
            data: e.data as Record<string, unknown>,
            updatedAt: e.lastUpdated
        }));

        await this.survivorshipEngine.ensureInitialized();
        const { mergedData, conflicts } = this.survivorshipEngine.mergeEntities(entityType, entityData);

        // Calculate average confidence
        const matches = await this.entityMatcher.findMatches(entities[0], entities.slice(1), 0.5);
        const avgConfidence = matches.length > 0
            ? matches.reduce((sum, m) => sum + m.matchScore, 0) / matches.length
            : 1;

        const id = this.generateId();
        const now = new Date();
        const status = conflicts.length > 0 ? 'pending_review' : 'active';

        const sources = entities.map(e => ({
            source_system: e.sourceSystem,
            source_record_id: e.id,
            source_data: e.data as Record<string, unknown>,
            last_synced_at: now,
            sync_status: 'synced' as const,
            golden_record_id: id,
        }));

        const grRow = await this.mdmRepository.createGoldenRecordWithSources(
            {
                id,
                entity_type: entityType,
                data: mergedData,
                confidence: avgConfidence,
                conflicts: conflicts as any,
                conflict_count: conflicts.length,
                status,
                approved_by: null,
                approved_at: null,
            },
            sources
        );

        // Best-effort feedback write — primary record already committed
        try {
            await this.recordConflicts(conflicts);
        } catch (err) {
            this.logger.error('[GoldenRecord] Feedback write failed (non-blocking)', err);
        }

        // Use returned row; only fetch sources (not included in insert return)
        const sourceRows = await this.mdmRepository.findSourcesByGoldenRecordId(id);
        const goldenRecord = this.rowToGoldenRecord(grRow, sourceRows);

        this.logger.info('[GoldenRecord] Created from entities', {
            id: goldenRecord.id,
            sourceCount: entities.length
        });

        return goldenRecord;
    }

    /**
     * Get a golden record by ID
     */
    async getGoldenRecord(id: string): Promise<GoldenRecord | undefined> {
        const row = await this.mdmRepository.findGoldenRecordById(id);
        if (!row) return undefined;
        const sources = await this.mdmRepository.findSourcesByGoldenRecordId(id);
        return this.rowToGoldenRecord(row, sources);
    }

    /**
     * List all golden records with optional filters
     */
    async listGoldenRecords(filters?: {
        entityType?: string;
        status?: string;
        hasConflicts?: boolean;
    }): Promise<GoldenRecord[]> {
        const rows = await this.mdmRepository.listGoldenRecords(filters);
        if (rows.length === 0) return [];

        // Batch-load all sources in a single query to avoid N+1
        const sourcesMap = await this.mdmRepository.findSourcesByGoldenRecordIds(
            rows.map(r => r.id)
        );

        return rows.map(row =>
            this.rowToGoldenRecord(row, sourcesMap.get(row.id) || [])
        );
    }

    /**
     * Update a golden record
     */
    async updateGoldenRecord(id: string, updates: Partial<Pick<GoldenRecord, 'data' | 'status'>>): Promise<GoldenRecord | null> {
        const existing = await this.mdmRepository.findGoldenRecordById(id);
        if (!existing) return null;

        const dbUpdates: Record<string, unknown> = {};
        if (updates.data) {
            const currentData = existing.data as Record<string, unknown>;
            dbUpdates.data = { ...currentData, ...updates.data };
        }
        if (updates.status) {
            dbUpdates.status = updates.status;
        }

        const updatedRow = await this.mdmRepository.updateGoldenRecord(id, dbUpdates as any);
        const sources = await this.mdmRepository.findSourcesByGoldenRecordId(id);

        this.logger.info('[GoldenRecord] Updated', { id });
        return this.rowToGoldenRecord(updatedRow, sources);
    }

    /**
     * Resolve a conflict for a golden record
     */
    async resolveConflict(
        goldenRecordId: string,
        fieldName: string,
        selectedValue: unknown,
        resolvedBy: string
    ): Promise<boolean> {
        const row = await this.mdmRepository.findGoldenRecordById(goldenRecordId);
        if (!row) return false;

        const conflicts = row.conflicts as SurvivorshipResult[];
        const conflict = conflicts.find(c => c.field === fieldName);
        if (!conflict) return false;

        // Update the data with resolved value
        const data = row.data as Record<string, unknown>;
        data[fieldName] = selectedValue;

        // Remove from conflicts list
        const updatedConflicts = conflicts.filter(c => c.field !== fieldName);
        const newStatus = updatedConflicts.length === 0 && row.status === 'pending_review'
            ? 'active'
            : row.status;

        await this.mdmRepository.updateGoldenRecord(goldenRecordId, {
            data: data as any,
            conflicts: updatedConflicts as any,
            conflict_count: updatedConflicts.length,
            status: newStatus,
        });

        // Best-effort feedback write — primary record already committed
        try {
            await this.recordResolution(conflict, selectedValue, 'manual');
        } catch (err) {
            this.logger.error('[GoldenRecord] Resolution feedback write failed (non-blocking)', err);
        }

        this.logger.info('[GoldenRecord] Conflict resolved', {
            id: goldenRecordId,
            field: fieldName,
            resolvedBy
        });

        return true;
    }

    /**
     * Request to sync golden record back to source systems (requires approval)
     */
    async requestSync(goldenRecordId: string, targetSystems: string[], requestedBy: string): Promise<SyncRequest | null> {
        // Verify the golden record exists
        const record = await this.mdmRepository.findGoldenRecordById(goldenRecordId);
        if (!record) {
            return null;
        }

        const requestId = `sync-${randomUUID()}`;

        const row = await this.mdmRepository.createSyncRequest({
            id: requestId,
            golden_record_id: goldenRecordId,
            target_systems: targetSystems as any,
            requested_by: requestedBy,
            status: 'pending',
            reviewed_by: null,
            reviewed_at: null,
        });

        this.logger.info('[GoldenRecord] Sync requested', {
            requestId,
            goldenRecordId,
            targetSystems
        });

        return this.rowToSyncRequest(row);
    }

    /**
     * Approve a sync request
     */
    async approveSyncRequest(requestId: string, approvedBy: string): Promise<SyncRequest | null> {
        // Atomic: UPDATE ... WHERE status = 'pending' — prevents concurrent double-approval
        const row = await this.mdmRepository.approveSyncRequest(requestId, approvedBy, new Date());
        if (!row) return null;

        this.logger.info('[GoldenRecord] Sync approved', { requestId, approvedBy });
        return this.rowToSyncRequest(row);
    }

    /**
     * Get pending sync requests
     */
    async getPendingSyncRequests(): Promise<SyncRequest[]> {
        const rows = await this.mdmRepository.findPendingSyncRequests();
        return rows.map(r => this.rowToSyncRequest(r));
    }

    /**
     * Get statistics for MDM dashboard
     */
    async getStatistics(): Promise<{
        totalRecords: number;
        byEntityType: Record<string, number>;
        byStatus: Record<string, number>;
        conflictCount: number;
        pendingSyncs: number;
    }> {
        const records = await this.mdmRepository.listGoldenRecords();

        const byEntityType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        let conflictCount = 0;

        for (const record of records) {
            const entityType = record.entity_type;
            byEntityType[entityType] = (byEntityType[entityType] || 0) + 1;
            byStatus[record.status] = (byStatus[record.status] || 0) + 1;
            conflictCount += record.conflict_count;
        }

        const pendingSyncs = await this.mdmRepository.findPendingSyncRequests();

        return {
            totalRecords: records.length,
            byEntityType,
            byStatus,
            conflictCount,
            pendingSyncs: pendingSyncs.length
        };
    }

    /**
     * Generate unique ID using cryptographically secure random
     */
    private generateId(): string {
        return `gr-${randomUUID()}`;
    }

    /**
     * Convert database row + sources to GoldenRecord domain object
     */
    private rowToGoldenRecord(row: MDMGoldenRecordRow, sourceRows: MDMEntitySourceRow[]): GoldenRecord {
        return {
            id: row.id,
            entityType: row.entity_type as GoldenRecord['entityType'],
            data: row.data as Record<string, unknown>,
            confidence: row.confidence,
            sources: sourceRows.map(s => ({
                sourceSystem: s.source_system,
                sourceRecordId: s.source_record_id,
                sourceData: s.source_data as Record<string, unknown>,
                lastSyncedAt: s.last_synced_at instanceof Date ? s.last_synced_at : new Date(s.last_synced_at),
                syncStatus: s.sync_status as EntitySource['syncStatus'],
            })),
            conflicts: row.conflicts as SurvivorshipResult[],
            status: row.status as GoldenRecord['status'],
            createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
            ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
            ...(row.approved_at ? { approvedAt: row.approved_at instanceof Date ? row.approved_at : new Date(row.approved_at) } : {}),
        };
    }

    /**
     * Convert database row to SyncRequest domain object
     */
    private rowToSyncRequest(row: MDMSyncRequestRow): SyncRequest {
        return {
            id: row.id,
            goldenRecordId: row.golden_record_id,
            targetSystems: row.target_systems as string[],
            requestedBy: row.requested_by,
            status: row.status as SyncRequest['status'],
            createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
            ...(row.reviewed_at ? { reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at : new Date(row.reviewed_at) } : {}),
        };
    }

    /**
     * Record conflicts to feedback service
     */
    private async recordConflicts(conflicts: SurvivorshipResult[]): Promise<void> {
        const batchRecords: {
            fieldName: string;
            sourceSystem: string;
            targetSystem?: string;
            valueA: unknown;
            valueB: unknown;
            resolution: 'auto' | 'manual' | 'pending';
        }[] = [];

        for (const conflict of conflicts) {
            for (const alt of conflict.alternativeValues) {
                batchRecords.push({
                    fieldName: conflict.field,
                    sourceSystem: conflict.selectedSource,
                    targetSystem: alt.sourceSystem,
                    valueA: conflict.selectedValue,
                    valueB: alt.value,
                    resolution: 'pending'
                });
            }
        }

        if (batchRecords.length > 0) {
            await this.feedbackService.recordConflictBatch(batchRecords);
        }
    }

    /**
     * Record conflict resolution
     */
    private async recordResolution(conflict: SurvivorshipResult, selectedValue: unknown, type: 'auto' | 'manual'): Promise<void> {
        const winnerSource = conflict.selectedSource;

        for (const alt of conflict.alternativeValues) {
            await this.feedbackService.resolveConflict(
                conflict.field,
                winnerSource,
                alt.sourceSystem,
                type
            );
        }
    }
}
