import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { MDMRepository } from '../../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../../src/database/types';

/**
 * MDMRepository survivorship rules tests using in-memory SQLite.
 * Validates CRUD, JSON roundtrip, upsert, is_default guard, priority ordering, and seed data.
 */
describe('MDMRepository — Survivorship Rules', () => {
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

        // Create the survivorship rules table
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

        // Also create the other MDM tables (repo constructor requires them for type safety)
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

        const fakeDatabaseService = { getDatabase: () => db } as any;
        repo = new MDMRepository(fakeDatabaseService);
    });

    afterAll(async () => {
        await db.destroy();
    });

    beforeEach(async () => {
        await sql`DELETE FROM mdm_survivorship_rules`.execute(db);
    });

    // ── Seed helper ─────────────────────────────────────────────

    async function seedDefaults(): Promise<void> {
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
    }

    // ── List ────────────────────────────────────────────────────

    describe('listSurvivorshipRules', () => {
        it('should return all rules ordered by priority ASC', async () => {
            await seedDefaults();
            const rules = await repo.listSurvivorshipRules();
            expect(rules).toHaveLength(14);
            // First rules should have lowest priority
            expect(rules[0].priority).toBeLessThanOrEqual(rules[rules.length - 1].priority);
        });

        it('should filter by entityType and include wildcards', async () => {
            await seedDefaults();
            const vendorRules = await repo.listSurvivorshipRules('vendor');
            // 5 vendor rules + 1 wildcard default
            expect(vendorRules).toHaveLength(6);
            expect(vendorRules.every(r => r.entity_type === 'vendor' || r.entity_type === '*')).toBe(true);
        });

        it('should return empty array when no rules exist', async () => {
            const rules = await repo.listSurvivorshipRules();
            expect(rules).toEqual([]);
        });
    });

    // ── Find by ID ──────────────────────────────────────────────

    describe('findSurvivorshipRuleById', () => {
        it('should return null for non-existent ID', async () => {
            const result = await repo.findSurvivorshipRuleById('nonexistent');
            expect(result).toBeNull();
        });

        it('should find an existing rule with parsed JSON config', async () => {
            await seedDefaults();
            const found = await repo.findSurvivorshipRuleById('v-taxId');
            expect(found).not.toBeNull();
            expect(found!.entity_type).toBe('vendor');
            expect(found!.strategy).toBe('source_priority');
            expect((found!.config as any).sourcePriority).toEqual(['netsuite', 'bc']);
        });
    });

    // ── Upsert ──────────────────────────────────────────────────

    describe('upsertSurvivorshipRule', () => {
        it('should insert a new rule', async () => {
            const row = await repo.upsertSurvivorshipRule({
                id: 'custom-1',
                entity_type: 'vendor',
                field_name: 'website',
                strategy: 'most_complete',
                config: { customFn: 'validateUrl' },
                priority: 5,
                is_default: 0,
            });

            expect(row.id).toBe('custom-1');
            expect(row.field_name).toBe('website');
            expect((row.config as any).customFn).toBe('validateUrl');
        });

        it('should update an existing rule atomically (same id)', async () => {
            await repo.upsertSurvivorshipRule({
                id: 'upsert-test',
                entity_type: 'vendor',
                field_name: 'name',
                strategy: 'most_complete',
                config: {},
                priority: 1,
                is_default: 0,
            });

            const updated = await repo.upsertSurvivorshipRule({
                id: 'upsert-test',
                entity_type: 'vendor',
                field_name: 'name',
                strategy: 'most_recent',
                config: { sourcePriority: ['bc'] },
                priority: 2,
                is_default: 0,
            });

            expect(updated.strategy).toBe('most_recent');
            expect(updated.priority).toBe(2);
            expect((updated.config as any).sourcePriority).toEqual(['bc']);

            // Verify only one row exists
            const all = await repo.listSurvivorshipRules();
            expect(all).toHaveLength(1);
        });

        it('should preserve is_default when caller passes existing value', async () => {
            // Seed defaults first
            await seedDefaults();

            // Upsert v-name (seeded with is_default=1) with is_default=1 preserved
            const updated = await repo.upsertSurvivorshipRule({
                id: 'v-name',
                entity_type: 'vendor',
                field_name: 'name',
                strategy: 'source_priority',
                config: { sourcePriority: ['bc'] },
                priority: 1,
                is_default: 1, // caller preserves the flag
            });

            expect(updated.strategy).toBe('source_priority');
            expect(updated.is_default).toBe(1);

            // Should still be protected from deletion
            const deleted = await repo.deleteSurvivorshipRule('v-name');
            expect(deleted).toBe(false);
        });
    });

    // ── Delete ──────────────────────────────────────────────────

    describe('deleteSurvivorshipRule', () => {
        it('should delete a user-created rule', async () => {
            await repo.upsertSurvivorshipRule({
                id: 'del-test',
                entity_type: 'customer',
                field_name: 'phone',
                strategy: 'most_recent',
                config: {},
                priority: 3,
                is_default: 0,
            });

            const deleted = await repo.deleteSurvivorshipRule('del-test');
            expect(deleted).toBe(true);

            const found = await repo.findSurvivorshipRuleById('del-test');
            expect(found).toBeNull();
        });

        it('should return false for non-existent rule', async () => {
            const deleted = await repo.deleteSurvivorshipRule('nonexistent');
            expect(deleted).toBe(false);
        });

        it('should reject deletion of default rules (is_default guard)', async () => {
            await seedDefaults();

            const deleted = await repo.deleteSurvivorshipRule('v-name');
            expect(deleted).toBe(false);

            // Rule should still exist
            const found = await repo.findSurvivorshipRuleById('v-name');
            expect(found).not.toBeNull();
        });
    });

    // ── JSON config roundtrip ───────────────────────────────────

    describe('JSON config roundtrip', () => {
        it('should roundtrip complex config with arrays and nested objects', async () => {
            const complexConfig = {
                sourcePriority: ['netsuite', 'bc', 'hubspot'],
                customFn: 'mergeAddresses',
                threshold: 0.85,
            };

            const row = await repo.upsertSurvivorshipRule({
                id: 'json-test',
                entity_type: 'vendor',
                field_name: 'address',
                strategy: 'custom',
                config: complexConfig,
                priority: 1,
                is_default: 0,
            });

            expect(row.config).toEqual(complexConfig);

            const found = await repo.findSurvivorshipRuleById('json-test');
            expect(found!.config).toEqual(complexConfig);
        });

        it('should roundtrip empty config', async () => {
            const row = await repo.upsertSurvivorshipRule({
                id: 'empty-config',
                entity_type: 'customer',
                field_name: 'name',
                strategy: 'most_complete',
                config: {},
                priority: 1,
                is_default: 0,
            });

            expect(row.config).toEqual({});
        });
    });

    // ── Priority ordering ───────────────────────────────────────

    describe('priority ordering', () => {
        it('should return rules sorted by priority ASC', async () => {
            await repo.upsertSurvivorshipRule({
                id: 'pri-high', entity_type: 'vendor', field_name: 'a',
                strategy: 'most_recent', config: {}, priority: 10, is_default: 0,
            });
            await repo.upsertSurvivorshipRule({
                id: 'pri-low', entity_type: 'vendor', field_name: 'b',
                strategy: 'most_recent', config: {}, priority: 1, is_default: 0,
            });
            await repo.upsertSurvivorshipRule({
                id: 'pri-mid', entity_type: 'vendor', field_name: 'c',
                strategy: 'most_recent', config: {}, priority: 5, is_default: 0,
            });

            const rules = await repo.listSurvivorshipRules();
            expect(rules[0].id).toBe('pri-low');
            expect(rules[1].id).toBe('pri-mid');
            expect(rules[2].id).toBe('pri-high');
        });
    });

    // ── Seed data assertions ────────────────────────────────────

    describe('seed data', () => {
        it('should have exactly 14 default rules with is_default=1', async () => {
            await seedDefaults();
            const rules = await repo.listSurvivorshipRules();
            expect(rules).toHaveLength(14);
            expect(rules.every(r => r.is_default === 1)).toBe(true);
        });

        it('seed should be idempotent (INSERT OR IGNORE)', async () => {
            await seedDefaults();
            await seedDefaults(); // second run
            const rules = await repo.listSurvivorshipRules();
            expect(rules).toHaveLength(14);
        });
    });
});
