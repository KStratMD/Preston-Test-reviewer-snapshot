import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { SurvivorshipRuleEngine } from '../../../../src/services/mdm/SurvivorshipRuleEngine';
import { MDMRepository } from '../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../src/database/types';

/**
 * SurvivorshipRuleEngine persistence integration tests.
 *
 * Uses a real MDMRepository + in-memory SQLite to verify that the engine's
 * write-through caching, ensureInitialized(), and restart simulation work
 * correctly end-to-end.
 */
describe('SurvivorshipRuleEngine — Persistence', () => {
    let db: Kysely<Database>;
    let sqlite: BetterSqlite3.Database;
    let repo: MDMRepository;

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

        // Create MDM tables (repo needs all to compile)
        await sql`
            CREATE TABLE mdm_golden_records (
                id TEXT PRIMARY KEY, entity_type TEXT NOT NULL,
                data TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 0,
                conflicts TEXT NOT NULL DEFAULT '[]', conflict_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft', approved_by TEXT, approved_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);
        await sql`
            CREATE TABLE mdm_entity_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
                source_system TEXT NOT NULL, source_record_id TEXT NOT NULL,
                source_data TEXT NOT NULL DEFAULT '{}', last_synced_at DATETIME NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `.execute(db);
        await sql`
            CREATE TABLE mdm_sync_requests (
                id TEXT PRIMARY KEY,
                golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
                target_systems TEXT NOT NULL DEFAULT '[]', requested_by TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at DATETIME,
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

        // Seed defaults
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

    afterAll(async () => {
        await db.destroy();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('ensureInitialized', () => {
        it('should load rules from DB on first call', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            await engine.ensureInitialized();
            const rules = await engine.getRules();

            expect(rules).toHaveLength(14);
            expect(rules.find(r => r.id === 'v-taxId')?.config?.sourcePriority).toEqual(['netsuite', 'bc']);
        });

        it('should be idempotent — only loads once', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            await engine.ensureInitialized();
            await engine.ensureInitialized(); // second call should be a no-op

            const rules = await engine.getRules();
            expect(rules).toHaveLength(14);
        });
    });

    describe('getRules', () => {
        it('should return persisted rules after init', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            const rules = await engine.getRules();
            expect(rules).toHaveLength(14);
        });

        it('should filter by entityType including wildcard', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            const customerRules = await engine.getRules('customer');
            expect(customerRules.length).toBeGreaterThanOrEqual(4); // 4 customer + 1 wildcard
            expect(customerRules.every(r => r.entityType === 'customer' || r.entityType === '*')).toBe(true);
        });
    });

    describe('setRule — write-through', () => {
        it('should persist a new rule to DB and cache', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            const customRule = {
                id: 'persist-test-1',
                entityType: 'vendor' as const,
                fieldName: 'website',
                strategy: 'most_complete' as const,
                config: { customFn: 'validateUrl' },
                priority: 5,
            };

            await engine.setRule(customRule);

            // Verify in cache
            const rules = await engine.getRules('vendor');
            expect(rules.find(r => r.id === 'persist-test-1')).toBeDefined();

            // Verify in DB
            const dbRow = await repo.findSurvivorshipRuleById('persist-test-1');
            expect(dbRow).not.toBeNull();
            expect(dbRow!.field_name).toBe('website');
        });
    });

    describe('removeRule — write-through', () => {
        it('should delete a user-created rule from DB and cache', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            // First create a user rule
            await engine.setRule({
                id: 'remove-test-1',
                entityType: 'customer',
                fieldName: 'fax',
                strategy: 'most_recent',
                priority: 3,
            });

            const result = await engine.removeRule('remove-test-1');
            expect(result).toBe('deleted');

            // Gone from DB
            const dbRow = await repo.findSurvivorshipRuleById('remove-test-1');
            expect(dbRow).toBeNull();
        });

        it('should return is_default for default rules', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);
            await engine.ensureInitialized();

            const result = await engine.removeRule('v-name');
            expect(result).toBe('is_default');
        });

        it('should return not_found for non-existent rules', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);
            await engine.ensureInitialized();

            const result = await engine.removeRule('nonexistent');
            expect(result).toBe('not_found');
        });
    });

    describe('applyRule uses persisted custom rule', () => {
        it('should apply a custom source_priority rule from DB (overriding default)', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            // Override the existing v-name default rule (same id) to source_priority
            await engine.setRule({
                id: 'v-name',
                entityType: 'vendor',
                fieldName: 'name',
                strategy: 'source_priority',
                config: { sourcePriority: ['bc'] },
                priority: 1,
            });

            const result = engine.applyRule('vendor', 'name', [
                { value: 'BC Name', sourceSystem: 'bc', updatedAt: new Date('2023-01-01') },
                { value: 'NS Name Is Longer', sourceSystem: 'netsuite', updatedAt: new Date('2024-01-01') },
            ]);

            // source_priority should pick 'bc' even though 'netsuite' is longer/newer
            expect(result.selectedValue).toBe('BC Name');
            expect(result.selectedSource).toBe('bc');
        });
    });

    describe('restart simulation', () => {
        it('should persist rules across engine instances sharing the same DB', async () => {
            // Engine A adds a custom rule
            const engineA = new SurvivorshipRuleEngine(mockLogger as any, repo);
            await engineA.setRule({
                id: 'restart-test',
                entityType: 'product',
                fieldName: 'barcode',
                strategy: 'source_priority',
                config: { sourcePriority: ['netsuite'] },
                priority: 1,
            });

            // Engine B — simulates restart (new instance, same DB)
            const engineB = new SurvivorshipRuleEngine(mockLogger as any, repo);
            const rules = await engineB.getRules('product');

            const barcodeRule = rules.find(r => r.id === 'restart-test');
            expect(barcodeRule).toBeDefined();
            expect(barcodeRule!.fieldName).toBe('barcode');
            expect(barcodeRule!.config?.sourcePriority).toEqual(['netsuite']);

            // Verify the rule is applied correctly in merge
            await engineB.ensureInitialized();
            const result = engineB.applyRule('product', 'barcode', [
                { value: 'NS-BARCODE', sourceSystem: 'netsuite', updatedAt: new Date() },
                { value: 'BC-BARCODE', sourceSystem: 'bc', updatedAt: new Date() },
            ]);
            expect(result.selectedValue).toBe('NS-BARCODE');
        });
    });

    describe('setRule preserves is_default', () => {
        it('should keep is_default=1 when updating a seeded default rule', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            // Update the seeded v-name default rule (strategy change)
            await engine.setRule({
                id: 'v-name',
                entityType: 'vendor',
                fieldName: 'name',
                strategy: 'source_priority',
                config: { sourcePriority: ['bc'] },
                priority: 1,
            });

            // Verify the DB row still has is_default=1
            const dbRow = await repo.findSurvivorshipRuleById('v-name');
            expect(dbRow).not.toBeNull();
            expect(dbRow!.is_default).toBe(1);
            expect(dbRow!.strategy).toBe('source_priority');

            // And it should still be protected from deletion
            const removeResult = await engine.removeRule('v-name');
            expect(removeResult).toBe('is_default');
        });

        it('should set is_default=0 for new user-created rules', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any, repo);

            await engine.setRule({
                id: 'user-custom-1',
                entityType: 'vendor',
                fieldName: 'website',
                strategy: 'most_complete',
                priority: 5,
            });

            const dbRow = await repo.findSurvivorshipRuleById('user-custom-1');
            expect(dbRow).not.toBeNull();
            expect(dbRow!.is_default).toBe(0);

            // Should be deletable
            const removeResult = await engine.removeRule('user-custom-1');
            expect(removeResult).toBe('deleted');
        });
    });

    describe('ensureInitialized retry on failure', () => {
        it('should retry DB load after transient failure', async () => {
            // Mock repo that fails on first 2 calls (ensureInitialized + internal getRules retry), succeeds on 3rd
            let callCount = 0;
            const brokenRepo = {
                listSurvivorshipRules: jest.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount <= 2) throw new Error('Transient DB failure');
                    return repo.listSurvivorshipRules();
                }),
                findSurvivorshipRuleById: repo.findSurvivorshipRuleById.bind(repo),
                upsertSurvivorshipRule: repo.upsertSurvivorshipRule.bind(repo),
                deleteSurvivorshipRule: repo.deleteSurvivorshipRule.bind(repo),
            };

            const engine = new SurvivorshipRuleEngine(mockLogger as any, brokenRepo as any);

            // First explicit call fails — should warn but NOT set initialized
            await engine.ensureInitialized();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                '[Survivorship] DB load failed, will retry on next call',
                expect.objectContaining({ error: 'Transient DB failure' })
            );

            // getRules() internally retries ensureInitialized (also fails), returns in-memory defaults
            const rulesAfterFailure = await engine.getRules();
            expect(rulesAfterFailure).toHaveLength(14);

            // Third attempt succeeds — should load from DB
            jest.clearAllMocks();
            await engine.ensureInitialized();
            const rulesAfterRetry = await engine.getRules();
            expect(rulesAfterRetry.length).toBeGreaterThanOrEqual(14);
            // Verify the list call happened (3rd = success)
            expect(callCount).toBe(3);
        });
    });

    describe('graceful fallback without repo', () => {
        it('should work with in-memory defaults when no repo is provided', async () => {
            const engine = new SurvivorshipRuleEngine(mockLogger as any);

            const rules = await engine.getRules();
            expect(rules).toHaveLength(14);

            // ensureInitialized should be a no-op
            await engine.ensureInitialized();
            expect(rules).toHaveLength(14);
        });
    });
});
