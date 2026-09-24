import 'reflect-metadata';
import { GoldenRecordService } from '../../../../src/services/mdm/GoldenRecordService';
import { EntityMatchingService, MatchCandidate, EntityRecord } from '../../../../src/services/mdm/EntityMatchingService';
import { SurvivorshipRuleEngine } from '../../../../src/services/mdm/SurvivorshipRuleEngine';
import { MDMFeedbackService } from '../../../../src/services/mdm/MDMFeedbackService';
import { MDMRepository } from '../../../../src/database/repositories/MDMRepository';
import { Logger } from '../../../../src/utils/Logger';

describe('GoldenRecordService', () => {
    let service: GoldenRecordService;
    let mockLogger: jest.Mocked<Logger>;
    let mockMatcher: jest.Mocked<EntityMatchingService>;
    let mockSurvivorship: jest.Mocked<SurvivorshipRuleEngine>;
    let mockFeedback: jest.Mocked<MDMFeedbackService>;
    let mockMDMRepository: jest.Mocked<MDMRepository>;

    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        } as any;

        mockMatcher = {
            findMatches: jest.fn(),
        } as any;

        mockSurvivorship = {
            mergeEntities: jest.fn(),
            ensureInitialized: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockFeedback = {
            recordConflict: jest.fn().mockResolvedValue(undefined),
            recordConflictBatch: jest.fn().mockResolvedValue(undefined),
            resolveConflict: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockMDMRepository = {
            createGoldenRecord: jest.fn(),
            findGoldenRecordById: jest.fn(),
            listGoldenRecords: jest.fn(),
            updateGoldenRecord: jest.fn(),
            createGoldenRecordWithSources: jest.fn(),
            findSourcesByGoldenRecordId: jest.fn(),
            findSourcesByGoldenRecordIds: jest.fn(),
            createSyncRequest: jest.fn(),
            findSyncRequestById: jest.fn(),
            findPendingSyncRequests: jest.fn(),
            updateSyncRequest: jest.fn(),
            approveSyncRequest: jest.fn(),
        } as any;

        service = new GoldenRecordService(mockLogger, mockMatcher, mockSurvivorship, mockFeedback, mockMDMRepository);
    });

    describe('createGoldenRecord', () => {
        it('should create a golden record from a match', async () => {
            const entityA: EntityRecord = { id: '1', sourceSystem: 'ns', entityType: 'vendor', data: { name: 'A' } };
            const entityB: EntityRecord = { id: '2', sourceSystem: 'sp', entityType: 'vendor', data: { name: 'B' } };

            const match: MatchCandidate = {
                entityA,
                entityB,
                matchScore: 0.9,
                fieldScores: {},
                confidence: 'high',
                suggestedAction: 'merge'
            };

            mockSurvivorship.mergeEntities.mockReturnValue({
                mergedData: { name: 'Merged' },
                conflicts: []
            });

            mockMDMRepository.createGoldenRecordWithSources.mockResolvedValue({
                id: 'gr-test', entity_type: 'vendor', data: { name: 'Merged' },
                confidence: 0.9, conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.findGoldenRecordById.mockResolvedValue({
                id: 'gr-test', entity_type: 'vendor', data: { name: 'Merged' },
                confidence: 0.9, conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.findSourcesByGoldenRecordId.mockResolvedValue([
                { id: 1, golden_record_id: 'gr-test', source_system: 'ns', source_record_id: '1',
                  source_data: { name: 'A' }, last_synced_at: new Date(), sync_status: 'synced', created_at: new Date() },
                { id: 2, golden_record_id: 'gr-test', source_system: 'sp', source_record_id: '2',
                  source_data: { name: 'B' }, last_synced_at: new Date(), sync_status: 'synced', created_at: new Date() },
            ] as any);

            const record = await service.createGoldenRecord(match);

            expect(record).toBeDefined();
            expect(record.data.name).toBe('Merged');
            expect(record.sources).toHaveLength(2);
            expect(record.status).toBe('active'); // No conflicts
            expect(mockMDMRepository.createGoldenRecordWithSources).toHaveBeenCalled();
        });

        it('should set status to pending_review if conflicts exist', async () => {
            const entityA: EntityRecord = { id: '1', sourceSystem: 'ns', entityType: 'vendor', data: { name: 'A' } };
            const entityB: EntityRecord = { id: '2', sourceSystem: 'sp', entityType: 'vendor', data: { name: 'B' } };

            const match: MatchCandidate = {
                entityA,
                entityB,
                matchScore: 0.9,
                fieldScores: {},
                confidence: 'high',
                suggestedAction: 'merge'
            };

            mockSurvivorship.mergeEntities.mockReturnValue({
                mergedData: { name: 'Merged' },
                conflicts: [{ field: 'name', selectedValue: 'A', selectedSource: 'ns', reason: 'r', alternativeValues: [], hasConflict: true }]
            });

            mockMDMRepository.createGoldenRecordWithSources.mockResolvedValue({
                id: 'gr-test', entity_type: 'vendor', data: { name: 'Merged' },
                confidence: 0.9, conflicts: [{ field: 'name' }], conflict_count: 1, status: 'pending_review',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.findGoldenRecordById.mockResolvedValue({
                id: 'gr-test', entity_type: 'vendor', data: { name: 'Merged' },
                confidence: 0.9, conflicts: [{ field: 'name', selectedValue: 'A', selectedSource: 'ns', reason: 'r', alternativeValues: [], hasConflict: true }],
                conflict_count: 1, status: 'pending_review',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.findSourcesByGoldenRecordId.mockResolvedValue([]);

            const record = await service.createGoldenRecord(match);

            expect(record.status).toBe('pending_review');
        });
    });

    describe('requestSync', () => {
        it('should create a sync request when record exists', async () => {
            mockMDMRepository.findGoldenRecordById.mockResolvedValue({
                id: 'gr-123', entity_type: 'vendor', data: {},
                confidence: 1, conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.createSyncRequest.mockResolvedValue({
                id: 'sync-test', golden_record_id: 'gr-123',
                target_systems: ['netsuite'], requested_by: 'user-1',
                status: 'pending', reviewed_by: null, reviewed_at: null,
                created_at: new Date(),
            } as any);

            const request = await service.requestSync('gr-123', ['netsuite'], 'user-1');
            expect(request.status).toBe('pending');
            expect(request.goldenRecordId).toBe('gr-123');
        });

        it('should return null when golden record does not exist', async () => {
            mockMDMRepository.findGoldenRecordById.mockResolvedValue(null);

            const result = await service.requestSync('gr-missing', ['netsuite'], 'user-1');
            expect(result).toBeNull();
        });
    });

    describe('best-effort feedback writes', () => {
        it('should return created record even when feedback write throws', async () => {
            const entityA: EntityRecord = { id: '1', sourceSystem: 'ns', entityType: 'vendor', data: { name: 'A' } };
            const entityB: EntityRecord = { id: '2', sourceSystem: 'sp', entityType: 'vendor', data: { name: 'B' } };

            const match: MatchCandidate = {
                entityA, entityB, matchScore: 0.9, fieldScores: {},
                confidence: 'high', suggestedAction: 'merge',
            };

            mockSurvivorship.mergeEntities.mockReturnValue({
                mergedData: { name: 'Merged' },
                conflicts: [{ field: 'name', selectedValue: 'A', selectedSource: 'ns', reason: 'r', alternativeValues: [{ value: 'B', sourceSystem: 'sp' }], hasConflict: true }],
            });

            mockMDMRepository.createGoldenRecordWithSources.mockResolvedValue({
                id: 'gr-test', entity_type: 'vendor', data: { name: 'Merged' },
                confidence: 0.9, conflicts: [{ field: 'name' }], conflict_count: 1, status: 'pending_review',
                approved_by: null, approved_at: null, created_at: new Date(), updated_at: new Date(),
            } as any);

            mockMDMRepository.findSourcesByGoldenRecordId.mockResolvedValue([]);

            // Make feedback throw — should not propagate
            mockFeedback.recordConflictBatch.mockRejectedValue(new Error('DB unavailable'));

            const record = await service.createGoldenRecord(match);

            expect(record).toBeDefined();
            expect(record.id).toBe('gr-test');
            expect(mockLogger.error).toHaveBeenCalledWith(
                '[GoldenRecord] Feedback write failed (non-blocking)',
                expect.any(Error),
            );
        });
    });
});
