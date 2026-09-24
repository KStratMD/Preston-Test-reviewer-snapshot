import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { GoldenRecordService } from '../../../../src/services/mdm/GoldenRecordService';
import { EntityMatchingService, EntityRecord } from '../../../../src/services/mdm/EntityMatchingService';
import { SurvivorshipRuleEngine } from '../../../../src/services/mdm/SurvivorshipRuleEngine';
import { MDMFeedbackService } from '../../../../src/services/mdm/MDMFeedbackService';
import { MDMRepository } from '../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../src/database/types';

/**
 * MDM Persistence Integration Tests
 *
 * End-to-end tests that exercise GoldenRecordService → MDMRepository → SQLite.
 * Validates that data persists correctly through the full stack.
 */
describe('MDM Persistence Integration', () => {
    let db: Kysely<Database>;
    let sqlite: BetterSqlite3.Database;
    let repo: MDMRepository;
    let service: GoldenRecordService;

    const mockLogger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    };

    beforeAll(async () => {
        sqlite = new BetterSqlite3(':memory:');
        sqlite.pragma('journal_mode = WAL');
        sqlite.pragma('foreign_keys = ON');

        db = new Kysely<Database>({
            dialect: new SqliteDialect({ database: sqlite }),
        });

        await sql`
            CREATE TABLE mdm_golden_records (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                data TEXT NOT NULL DEFAULT '{}',
                confidence REAL NOT NULL DEFAULT 0,
                conflicts TEXT NOT NULL DEFAULT '[]',
                conflict_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft',
                approved_by TEXT,
                approved_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);

        await sql`
            CREATE TABLE mdm_entity_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
                source_system TEXT NOT NULL,
                source_record_id TEXT NOT NULL,
                source_data TEXT NOT NULL DEFAULT '{}',
                last_synced_at DATETIME NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);

        await sql`
            CREATE TABLE mdm_sync_requests (
                id TEXT PRIMARY KEY,
                golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
                target_systems TEXT NOT NULL DEFAULT '[]',
                requested_by TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                reviewed_by TEXT,
                reviewed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);

        await sql`
            CREATE TABLE mdm_survivorship_rules (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL CHECK (entity_type IN ('vendor', 'customer', 'product', '*')),
                field_name TEXT NOT NULL,
                strategy TEXT NOT NULL CHECK (strategy IN ('source_priority', 'most_recent', 'most_complete', 'frequency', 'custom')),
                config TEXT NOT NULL DEFAULT '{}',
                priority INTEGER NOT NULL DEFAULT 1,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);

        await sql`
            CREATE TABLE mdm_conflict_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                field_name TEXT NOT NULL,
                source_system TEXT NOT NULL,
                target_system TEXT NOT NULL DEFAULT '',
                conflict_count INTEGER NOT NULL DEFAULT 0,
                resolution_count INTEGER NOT NULL DEFAULT 0,
                auto_resolution_count INTEGER NOT NULL DEFAULT 0,
                manual_resolution_count INTEGER NOT NULL DEFAULT 0,
                last_conflict_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                common_issues TEXT NOT NULL DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(field_name, source_system, target_system)
            )
        `.execute(db);

        await sql`
            CREATE TABLE mdm_conflict_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                field_name TEXT NOT NULL,
                source_a TEXT NOT NULL,
                source_b TEXT NOT NULL,
                value_a TEXT NOT NULL,
                value_b TEXT NOT NULL,
                resolution TEXT NOT NULL CHECK (resolution IN ('auto', 'manual', 'pending')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);

        // Seed default survivorship rules
        await sql`
            INSERT OR IGNORE INTO mdm_survivorship_rules (id, entity_type, field_name, strategy, config, priority, is_default) VALUES
                ('v-name',        'vendor',   'name',        'most_complete',   '{}',                                           1, 1),
                ('v-email',       'vendor',   'email',       'most_recent',     '{}',                                           2, 1),
                ('v-phone',       'vendor',   'phone',       'most_recent',     '{}',                                           2, 1),
                ('v-address',     'vendor',   'address',     'most_complete',   '{}',                                           3, 1),
                ('v-taxId',       'vendor',   'taxId',       'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
                ('c-name',        'customer', 'name',        'most_complete',   '{}',                                           1, 1),
                ('c-email',       'customer', 'email',       'most_recent',     '{}',                                           2, 1),
                ('c-phone',       'customer', 'phone',       'most_recent',     '{}',                                           2, 1),
                ('c-creditLimit', 'customer', 'creditLimit', 'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
                ('p-name',        'product',  'name',        'most_complete',   '{}',                                           1, 1),
                ('p-sku',         'product',  'sku',         'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
                ('p-price',       'product',  'price',       'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
                ('p-description', 'product',  'description', 'most_complete',   '{}',                                           2, 1),
                ('default',       '*',        '*',           'most_recent',     '{}',                                         999, 1)
        `.execute(db);

        const fakeDatabaseService = { getDatabase: () => db } as any;
        repo = new MDMRepository(fakeDatabaseService);
    });

    beforeEach(async () => {
        jest.clearAllMocks();

        // Clear tables between tests
        await sql`DELETE FROM mdm_sync_requests`.execute(db);
        await sql`DELETE FROM mdm_entity_sources`.execute(db);
        await sql`DELETE FROM mdm_golden_records`.execute(db);
        await sql`DELETE FROM mdm_conflict_history`.execute(db);
        await sql`DELETE FROM mdm_conflict_stats`.execute(db);

        // Clean user-created rules (keep defaults for consistency)
        await sql`DELETE FROM mdm_survivorship_rules WHERE is_default = 0`.execute(db);

        // Create fresh service for each test
        const entityMatcher = new EntityMatchingService(mockLogger as any, undefined, undefined);
        const survivorshipEngine = new SurvivorshipRuleEngine(mockLogger as any, repo);
        const feedbackService = new MDMFeedbackService(mockLogger as any);

        service = new GoldenRecordService(
            mockLogger as any, entityMatcher, survivorshipEngine, feedbackService, repo
        );
    });

    afterAll(async () => {
        await db.destroy();
    });

    describe('createFromEntities → retrieve flow', () => {
        it('should persist and retrieve a golden record with sources', async () => {
            const entities: EntityRecord[] = [{
                id: 'e1', entityType: 'vendor', sourceSystem: 'netsuite',
                data: { name: 'Test Vendor', email: 'test@vendor.com' },
                lastUpdated: new Date(),
            }];

            const created = await service.createFromEntities(entities);

            expect(created.id).toMatch(/^gr-/);
            expect(created.entityType).toBe('vendor');
            expect(created.data.name).toBe('Test Vendor');
            expect(created.sources).toHaveLength(1);
            expect(created.sources[0].sourceSystem).toBe('netsuite');
            expect(created.sources[0].sourceRecordId).toBe('e1');
        });

        it('should create golden record with conflicts from multiple entities', async () => {
            const entities: EntityRecord[] = [
                { id: 'e1', entityType: 'vendor', sourceSystem: 'netsuite',
                  data: { name: 'Acme Corp', email: 'a@acme.com' }, lastUpdated: new Date() },
                { id: 'e2', entityType: 'vendor', sourceSystem: 'bc',
                  data: { name: 'ACME Corporation', email: 'b@acme.com' }, lastUpdated: new Date() },
            ];

            const created = await service.createFromEntities(entities);

            expect(created.sources).toHaveLength(2);
            expect(created.conflicts.length).toBeGreaterThan(0);
            expect(created.status).toBe('pending_review');
        });
    });

    describe('getGoldenRecord retrieves persisted data', () => {
        it('should return undefined for non-existent ID', async () => {
            const result = await service.getGoldenRecord('gr-not-found');
            expect(result).toBeUndefined();
        });

        it('should retrieve a previously created record', async () => {
            const entities: EntityRecord[] = [{
                id: 'ret-1', entityType: 'customer', sourceSystem: 'test',
                data: { name: 'Retrieval Test' }, lastUpdated: new Date(),
            }];

            const created = await service.createFromEntities(entities);
            const retrieved = await service.getGoldenRecord(created.id);

            expect(retrieved).toBeDefined();
            expect(retrieved!.id).toBe(created.id);
            expect(retrieved!.data.name).toBe('Retrieval Test');
        });
    });

    describe('resolveConflict updates DB', () => {
        it('should resolve a conflict and update conflict_count', async () => {
            const entities: EntityRecord[] = [
                { id: 'c1', entityType: 'vendor', sourceSystem: 'netsuite',
                  data: { name: 'A', email: 'a@test.com' }, lastUpdated: new Date() },
                { id: 'c2', entityType: 'vendor', sourceSystem: 'bc',
                  data: { name: 'B', email: 'b@test.com' }, lastUpdated: new Date() },
            ];

            const created = await service.createFromEntities(entities);
            const conflictFields = created.conflicts.map(c => c.field);

            // Resolve first conflict
            const resolved = await service.resolveConflict(
                created.id, conflictFields[0], 'ResolvedValue', 'admin'
            );
            expect(resolved).toBe(true);

            // Verify in DB
            const after = await service.getGoldenRecord(created.id);
            expect(after!.data[conflictFields[0]]).toBe('ResolvedValue');
            expect(after!.conflicts.length).toBe(created.conflicts.length - 1);
        });

        it('should return false for non-existent field conflict', async () => {
            const entities: EntityRecord[] = [{
                id: 'nf-1', entityType: 'vendor', sourceSystem: 'ns',
                data: { name: 'Test' }, lastUpdated: new Date(),
            }];
            const created = await service.createFromEntities(entities);

            const resolved = await service.resolveConflict(
                created.id, 'nonexistent_field', 'val', 'admin'
            );
            expect(resolved).toBe(false);
        });

        it('should return false for non-existent record', async () => {
            const resolved = await service.resolveConflict(
                'gr-not-found', 'field', 'val', 'admin'
            );
            expect(resolved).toBe(false);
        });
    });

    describe('sync request lifecycle', () => {
        it('should create, list pending, and approve sync request', async () => {
            const entities: EntityRecord[] = [{
                id: 's1', entityType: 'vendor', sourceSystem: 'ns',
                data: { name: 'Sync Test' }, lastUpdated: new Date(),
            }];
            const created = await service.createFromEntities(entities);

            // Create sync request
            const syncReq = await service.requestSync(created.id, ['netsuite', 'bc'], 'user-1');
            expect(syncReq.status).toBe('pending');
            expect(syncReq.targetSystems).toEqual(['netsuite', 'bc']);

            // List pending
            const pending = await service.getPendingSyncRequests();
            expect(pending).toHaveLength(1);

            // Approve
            const approved = await service.approveSyncRequest(syncReq.id, 'admin');
            expect(approved).not.toBeNull();
            expect(approved!.status).toBe('approved');
            expect(approved!.reviewedBy).toBe('admin');

            // No more pending
            const pendingAfter = await service.getPendingSyncRequests();
            expect(pendingAfter).toHaveLength(0);
        });

        it('should return null when requesting sync for non-existent record', async () => {
            const result = await service.requestSync('gr-not-found', ['ns'], 'user');
            expect(result).toBeNull();
        });
    });

    describe('getStatistics', () => {
        it('should return aggregated statistics', async () => {
            const entities: EntityRecord[] = [{
                id: 'stat1', entityType: 'vendor', sourceSystem: 'ns',
                data: { name: 'Stats' }, lastUpdated: new Date(),
            }];
            await service.createFromEntities(entities);

            const stats = await service.getStatistics();
            expect(stats.totalRecords).toBe(1);
            expect(stats.byEntityType.vendor).toBe(1);
        });
    });

    describe('server restart simulation', () => {
        it('should read back data with a fresh service instance sharing the same DB', async () => {
            const entities: EntityRecord[] = [{
                id: 'persist-test', entityType: 'product', sourceSystem: 'ns',
                data: { sku: 'ABC-123', name: 'Widget' }, lastUpdated: new Date(),
            }];
            const created = await service.createFromEntities(entities);

            // Simulate restart: new service instance, same repo/DB
            const entityMatcher2 = new EntityMatchingService(mockLogger as any, undefined, undefined);
            const survivorshipEngine2 = new SurvivorshipRuleEngine(mockLogger as any, repo);
            const feedbackService2 = new MDMFeedbackService(mockLogger as any);
            const service2 = new GoldenRecordService(
                mockLogger as any, entityMatcher2, survivorshipEngine2, feedbackService2, repo
            );

            const retrieved = await service2.getGoldenRecord(created.id);
            expect(retrieved).toBeDefined();
            expect(retrieved!.data.sku).toBe('ABC-123');
            expect(retrieved!.sources).toHaveLength(1);
        });
    });

    describe('survivorship rules persistence', () => {
        it('should persist a custom survivorship rule and apply it after restart', async () => {
            // Engine A: override the existing v-name default (same id) to source_priority
            const engineA = new SurvivorshipRuleEngine(mockLogger as any, repo);
            await engineA.setRule({
                id: 'v-name',
                entityType: 'vendor',
                fieldName: 'name',
                strategy: 'source_priority',
                config: { sourcePriority: ['bc'] },
                priority: 1,
            });

            // Engine B: simulate restart — new instance, same DB
            const engineB = new SurvivorshipRuleEngine(mockLogger as any, repo);
            await engineB.ensureInitialized();

            // Apply the rule: source_priority should pick 'bc' over longer 'netsuite' name
            const result = engineB.applyRule('vendor', 'name', [
                { value: 'BC Vendor', sourceSystem: 'bc', updatedAt: new Date('2023-01-01') },
                { value: 'Netsuite Vendor Corp', sourceSystem: 'netsuite', updatedAt: new Date('2024-01-01') },
            ]);

            expect(result.selectedValue).toBe('BC Vendor');
            expect(result.selectedSource).toBe('bc');
        });

        it('should list survivorship rules from DB', async () => {
            const rules = await repo.listSurvivorshipRules();
            // All 14 defaults preserved (setRule preserves is_default status)
            expect(rules.length).toBeGreaterThanOrEqual(14);
            expect(rules.some(r => r.entity_type === 'vendor')).toBe(true);
        });
    });
});
