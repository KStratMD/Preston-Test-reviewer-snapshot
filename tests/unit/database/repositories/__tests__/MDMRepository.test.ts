import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { MDMRepository } from '../../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../../src/database/types';

/**
 * MDMRepository unit tests using in-memory SQLite.
 * Validates CRUD, JSON roundtrip, filtering, transactions, and cascading deletes.
 */
describe('MDMRepository', () => {
    let db: Kysely<Database>;
    let sqlite: BetterSqlite3.Database;
    let repo: MDMRepository;

    beforeAll(async () => {
        sqlite = new BetterSqlite3(':memory:');
        sqlite.pragma('journal_mode = WAL');
        sqlite.pragma('foreign_keys = ON');

        db = new Kysely<Database>({
            dialect: new SqliteDialect({ database: sqlite }),
        });

        // Create tables
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

        // Wire up repository with a fake DatabaseService
        const fakeDatabaseService = { getDatabase: () => db } as any;
        repo = new MDMRepository(fakeDatabaseService);
    });

    afterAll(async () => {
        await db.destroy();
    });

    beforeEach(async () => {
        // Clear tables between tests (order matters for FK)
        await sql`DELETE FROM mdm_sync_requests`.execute(db);
        await sql`DELETE FROM mdm_entity_sources`.execute(db);
        await sql`DELETE FROM mdm_golden_records`.execute(db);
    });

    // ── Golden Record CRUD ─────────────────────────────────────────

    describe('createGoldenRecord', () => {
        it('should create and return a golden record with parsed JSON', async () => {
            const row = await repo.createGoldenRecord({
                id: 'gr-001',
                entity_type: 'vendor',
                data: { name: 'Acme', city: 'Portland' },
                confidence: 0.95,
                conflicts: [{ field: 'city', hasConflict: true }],
                conflict_count: 1,
                status: 'pending_review',
                approved_by: null,
                approved_at: null,
            });

            expect(row.id).toBe('gr-001');
            expect(row.entity_type).toBe('vendor');
            expect((row.data as any).name).toBe('Acme');
            expect((row.data as any).city).toBe('Portland');
            expect((row.conflicts as any[])[0].field).toBe('city');
            expect(row.conflict_count).toBe(1);
            expect(row.status).toBe('pending_review');
        });
    });

    describe('findGoldenRecordById', () => {
        it('should return null for non-existent ID', async () => {
            const result = await repo.findGoldenRecordById('gr-not-found');
            expect(result).toBeNull();
        });

        it('should find an existing record with parsed JSON', async () => {
            await repo.createGoldenRecord({
                id: 'gr-002',
                entity_type: 'customer',
                data: { email: 'test@example.com' },
                confidence: 0.88,
                conflicts: [],
                conflict_count: 0,
                status: 'active',
                approved_by: null,
                approved_at: null,
            });

            const found = await repo.findGoldenRecordById('gr-002');
            expect(found).not.toBeNull();
            expect(found!.entity_type).toBe('customer');
            expect((found!.data as any).email).toBe('test@example.com');
            expect(found!.conflicts).toEqual([]);
        });
    });

    describe('listGoldenRecords', () => {
        beforeEach(async () => {
            await repo.createGoldenRecord({
                id: 'gr-v1', entity_type: 'vendor', data: {}, confidence: 0.9,
                conflicts: [{ field: 'x' }], conflict_count: 1, status: 'pending_review',
                approved_by: null, approved_at: null,
            });
            await repo.createGoldenRecord({
                id: 'gr-c1', entity_type: 'customer', data: {}, confidence: 0.8,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });
            await repo.createGoldenRecord({
                id: 'gr-v2', entity_type: 'vendor', data: {}, confidence: 0.7,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });
        });

        it('should list all records without filters', async () => {
            const records = await repo.listGoldenRecords();
            expect(records).toHaveLength(3);
        });

        it('should filter by entityType', async () => {
            const records = await repo.listGoldenRecords({ entityType: 'vendor' });
            expect(records).toHaveLength(2);
        });

        it('should filter by status', async () => {
            const records = await repo.listGoldenRecords({ status: 'active' });
            expect(records).toHaveLength(2);
        });

        it('should filter by hasConflicts=true using conflict_count', async () => {
            const records = await repo.listGoldenRecords({ hasConflicts: true });
            expect(records).toHaveLength(1);
            expect(records[0].id).toBe('gr-v1');
        });

        it('should filter by hasConflicts=false', async () => {
            const records = await repo.listGoldenRecords({ hasConflicts: false });
            expect(records).toHaveLength(2);
        });
    });

    describe('updateGoldenRecord', () => {
        it('should update data and status', async () => {
            await repo.createGoldenRecord({
                id: 'gr-upd', entity_type: 'product', data: { sku: 'A1' }, confidence: 0.5,
                conflicts: [], conflict_count: 0, status: 'draft',
                approved_by: null, approved_at: null,
            });

            const updated = await repo.updateGoldenRecord('gr-upd', {
                data: { sku: 'A1-UPDATED' } as any,
                status: 'active',
            });

            expect(updated.status).toBe('active');
            expect((updated.data as any).sku).toBe('A1-UPDATED');
        });
    });

    // ── JSON roundtrip ─────────────────────────────────────────────

    describe('JSON roundtrip fidelity', () => {
        it('should roundtrip nested objects, arrays, and null values', async () => {
            const complexData = {
                name: 'Acme Corp',
                address: { street: '123 Main St', city: 'Portland', state: 'OR' },
                tags: ['premier', 'net-30'],
                notes: null,
                rating: 4.5,
            };
            const complexConflicts = [
                { field: 'name', selectedValue: 'Acme Corp', selectedSource: 'ns',
                  alternativeValues: [{ sourceSystem: 'bc', value: 'ACME' }], hasConflict: true },
            ];

            await repo.createGoldenRecord({
                id: 'gr-json', entity_type: 'vendor', data: complexData,
                confidence: 0.92, conflicts: complexConflicts,
                conflict_count: 1, status: 'pending_review',
                approved_by: null, approved_at: null,
            });

            const found = await repo.findGoldenRecordById('gr-json');
            expect(found).not.toBeNull();
            expect(found!.data).toEqual(complexData);
            expect(found!.conflicts).toEqual(complexConflicts);
        });
    });

    // ── Atomic createGoldenRecordWithSources ───────────────────────

    describe('createGoldenRecordWithSources', () => {
        it('should create golden record and sources atomically', async () => {
            const row = await repo.createGoldenRecordWithSources(
                {
                    id: 'gr-tx', entity_type: 'vendor', data: { name: 'TxTest' },
                    confidence: 0.9, conflicts: [], conflict_count: 0, status: 'active',
                    approved_by: null, approved_at: null,
                },
                [
                    {
                        golden_record_id: 'gr-tx', source_system: 'netsuite',
                        source_record_id: 'ns-001', source_data: { vendorId: 100 },
                        last_synced_at: new Date(), sync_status: 'synced',
                    },
                    {
                        golden_record_id: 'gr-tx', source_system: 'bc',
                        source_record_id: 'bc-001', source_data: { supplierId: 200 },
                        last_synced_at: new Date(), sync_status: 'synced',
                    },
                ]
            );

            expect(row.id).toBe('gr-tx');
            const sources = await repo.findSourcesByGoldenRecordId('gr-tx');
            expect(sources).toHaveLength(2);
            expect(sources[0].source_system).toBe('netsuite');
            expect((sources[0].source_data as any).vendorId).toBe(100);
        });
    });

    // ── Entity Sources ─────────────────────────────────────────────

    describe('findSourcesByGoldenRecordId', () => {
        it('should return empty array for record with no sources', async () => {
            await repo.createGoldenRecord({
                id: 'gr-nosrc', entity_type: 'vendor', data: {}, confidence: 1,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });

            const sources = await repo.findSourcesByGoldenRecordId('gr-nosrc');
            expect(sources).toEqual([]);
        });
    });

    // ── Sync Requests ──────────────────────────────────────────────

    describe('createSyncRequest', () => {
        it('should create and return a sync request with parsed JSON', async () => {
            await repo.createGoldenRecord({
                id: 'gr-sync', entity_type: 'vendor', data: {}, confidence: 1,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });

            const req = await repo.createSyncRequest({
                id: 'sync-001', golden_record_id: 'gr-sync',
                target_systems: ['netsuite', 'bc'] as any,
                requested_by: 'user-1', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });

            expect(req.id).toBe('sync-001');
            expect(req.target_systems).toEqual(['netsuite', 'bc']);
            expect(req.status).toBe('pending');
        });
    });

    describe('findPendingSyncRequests', () => {
        it('should return only pending requests', async () => {
            await repo.createGoldenRecord({
                id: 'gr-pend', entity_type: 'vendor', data: {}, confidence: 1,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });

            await repo.createSyncRequest({
                id: 'sync-p1', golden_record_id: 'gr-pend',
                target_systems: ['ns'] as any,
                requested_by: 'user', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });
            await repo.createSyncRequest({
                id: 'sync-a1', golden_record_id: 'gr-pend',
                target_systems: ['bc'] as any,
                requested_by: 'user', status: 'approved',
                reviewed_by: 'admin', reviewed_at: new Date(),
            });

            const pending = await repo.findPendingSyncRequests();
            expect(pending).toHaveLength(1);
            expect(pending[0].id).toBe('sync-p1');
        });
    });

    describe('updateSyncRequest', () => {
        it('should update status and reviewed fields', async () => {
            await repo.createGoldenRecord({
                id: 'gr-updsync', entity_type: 'vendor', data: {}, confidence: 1,
                conflicts: [], conflict_count: 0, status: 'active',
                approved_by: null, approved_at: null,
            });

            await repo.createSyncRequest({
                id: 'sync-upd', golden_record_id: 'gr-updsync',
                target_systems: ['ns'] as any,
                requested_by: 'user', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });

            const updated = await repo.updateSyncRequest('sync-upd', {
                status: 'approved',
                reviewed_by: 'admin-1',
                reviewed_at: new Date(),
            });

            expect(updated.status).toBe('approved');
            expect(updated.reviewed_by).toBe('admin-1');
        });
    });

    describe('findSyncRequestById', () => {
        it('should return null for non-existent ID', async () => {
            const result = await repo.findSyncRequestById('sync-missing');
            expect(result).toBeNull();
        });
    });

    // ── Atomic approval ────────────────────────────────────────────

    describe('approveSyncRequest (atomic)', () => {
        it('should approve a pending request and return the updated row', async () => {
            await repo.createGoldenRecordWithSources(
                {
                    id: 'gr-atomic', entity_type: 'vendor', data: {}, confidence: 1,
                    conflicts: [], conflict_count: 0, status: 'active',
                    approved_by: null, approved_at: null,
                },
                []
            );
            await repo.createSyncRequest({
                id: 'sync-atomic', golden_record_id: 'gr-atomic',
                target_systems: ['ns'] as any,
                requested_by: 'user', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });

            const result = await repo.approveSyncRequest('sync-atomic', 'admin-1', new Date());
            expect(result).not.toBeNull();
            expect(result!.status).toBe('approved');
            expect(result!.reviewed_by).toBe('admin-1');
        });

        it('should return null on second approval attempt (idempotent guard)', async () => {
            await repo.createGoldenRecordWithSources(
                {
                    id: 'gr-race', entity_type: 'vendor', data: {}, confidence: 1,
                    conflicts: [], conflict_count: 0, status: 'active',
                    approved_by: null, approved_at: null,
                },
                []
            );
            await repo.createSyncRequest({
                id: 'sync-race', golden_record_id: 'gr-race',
                target_systems: ['ns'] as any,
                requested_by: 'user', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });

            // First approval succeeds
            const first = await repo.approveSyncRequest('sync-race', 'admin-1', new Date());
            expect(first).not.toBeNull();
            expect(first!.status).toBe('approved');

            // Second approval returns null (already approved)
            const second = await repo.approveSyncRequest('sync-race', 'admin-2', new Date());
            expect(second).toBeNull();
        });

        it('should return null for non-existent sync request', async () => {
            const result = await repo.approveSyncRequest('sync-missing', 'admin', new Date());
            expect(result).toBeNull();
        });
    });

    // ── Cascading delete ───────────────────────────────────────────

    describe('cascading delete', () => {
        it('should delete sources and sync requests when golden record is deleted', async () => {
            await repo.createGoldenRecordWithSources(
                {
                    id: 'gr-del', entity_type: 'vendor', data: {}, confidence: 1,
                    conflicts: [], conflict_count: 0, status: 'active',
                    approved_by: null, approved_at: null,
                },
                [{
                    golden_record_id: 'gr-del', source_system: 'ns',
                    source_record_id: 'ns-del', source_data: {},
                    last_synced_at: new Date(), sync_status: 'synced',
                }]
            );

            await repo.createSyncRequest({
                id: 'sync-del', golden_record_id: 'gr-del',
                target_systems: ['ns'] as any,
                requested_by: 'user', status: 'pending',
                reviewed_by: null, reviewed_at: null,
            });

            // Verify they exist
            expect(await repo.findSourcesByGoldenRecordId('gr-del')).toHaveLength(1);
            expect(await repo.findSyncRequestById('sync-del')).not.toBeNull();

            // Delete the golden record directly
            await db.deleteFrom('mdm_golden_records').where('id', '=', 'gr-del').execute();

            // Cascading delete should remove children
            expect(await repo.findSourcesByGoldenRecordId('gr-del')).toHaveLength(0);
            expect(await repo.findSyncRequestById('sync-del')).toBeNull();
        });
    });
});
