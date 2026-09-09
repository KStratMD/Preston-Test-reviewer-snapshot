import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { MDMRepository } from '../../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../../src/database/types';

describe('MDMRepository — Conflict Persistence', () => {
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

    const fakeDatabaseService = { getDatabase: () => db } as any;
    repo = new MDMRepository(fakeDatabaseService);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM mdm_conflict_history`.execute(db);
    await sql`DELETE FROM mdm_conflict_stats`.execute(db);
  });

  it('recordConflictAtomic inserts a new stat row and a history row', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', {
      valueA: 'a@acme.com',
      valueB: 'contact@acme.com',
    });

    const stats = await repo.listConflictStats();
    const history = await repo.listConflictHistory({}, { offset: 0, limit: 10 });

    expect(stats).toHaveLength(1);
    expect(stats[0].field_name).toBe('email');
    expect(stats[0].conflict_count).toBe(1);
    expect(stats[0].resolution_count).toBe(0);
    expect(history).toHaveLength(1);
    expect(history[0].resolution).toBe('pending');
  });

  it('recordConflictAtomic performs atomic increment for existing key', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: 'a', valueB: 'b' });
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: 'c', valueB: 'd' });

    const stats = await repo.listConflictStats({ fieldName: 'email' });
    expect(stats).toHaveLength(1);
    expect(stats[0].conflict_count).toBe(2);
  });

  it('recordConflictAtomic increments auto resolution counters for auto resolution', async () => {
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'auto', { valueA: '1', valueB: '2' });

    const [stat] = await repo.listConflictStats({ fieldName: 'phone' });
    expect(stat.resolution_count).toBe(1);
    expect(stat.auto_resolution_count).toBe(1);
    expect(stat.manual_resolution_count).toBe(0);
  });

  it('recordConflictAtomic does not increment resolution_count for pending', async () => {
    await repo.recordConflictAtomic('name', 'netsuite', 'bc', 'pending', { valueA: 'A', valueB: 'B' });

    const [stat] = await repo.listConflictStats({ fieldName: 'name' });
    expect(stat.resolution_count).toBe(0);
    expect(stat.auto_resolution_count).toBe(0);
    expect(stat.manual_resolution_count).toBe(0);
  });

  it('concurrent recordConflictAtomic calls preserve both increments', async () => {
    await Promise.all([
      repo.recordConflictAtomic('address', 'netsuite', 'bc', 'pending', { valueA: 'A', valueB: 'B' }),
      repo.recordConflictAtomic('address', 'netsuite', 'bc', 'pending', { valueA: 'C', valueB: 'D' }),
    ]);

    const [stat] = await repo.listConflictStats({ fieldName: 'address' });
    expect(stat.conflict_count).toBe(2);
  });

  it('resolveConflictAtomic increments resolution counters', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: 'a', valueB: 'b' });

    const updated = await repo.resolveConflictAtomic('email', 'netsuite', 'bc', 'manual');
    expect(updated).toBe(true);

    const [stat] = await repo.listConflictStats({ fieldName: 'email' });
    expect(stat.resolution_count).toBe(1);
    expect(stat.manual_resolution_count).toBe(1);
    expect(stat.auto_resolution_count).toBe(0);
  });

  it('resolveConflictAtomic returns false when stat key does not exist', async () => {
    const updated = await repo.resolveConflictAtomic('missing', 'netsuite', 'bc', 'manual');
    expect(updated).toBe(false);
  });

  it('listConflictStats returns rows ordered by conflict_count desc', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '3', valueB: '4' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });

    const stats = await repo.listConflictStats();
    expect(stats[0].field_name).toBe('email');
    expect(stats[0].conflict_count).toBeGreaterThan(stats[1].conflict_count);
  });

  it('listConflictStats supports fieldName filtering', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });

    const stats = await repo.listConflictStats({ fieldName: 'phone' });
    expect(stats).toHaveLength(1);
    expect(stats[0].field_name).toBe('phone');
  });

  it('listConflictStats supports sourceSystem filtering', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('email', 'hubspot', 'bc', 'pending', { valueA: '1', valueB: '2' });

    const stats = await repo.listConflictStats({ sourceSystem: 'hubspot' });
    expect(stats).toHaveLength(1);
    expect(stats[0].source_system).toBe('hubspot');
  });

  it('deleteAllConflictStats clears all stat rows', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.deleteAllConflictStats();

    const stats = await repo.listConflictStats();
    expect(stats).toHaveLength(0);
  });

  it('recordConflictBatch writes all rows in one transaction', async () => {
    await repo.recordConflictBatch([
      {
        fieldName: 'email',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: 'a@acme.com',
        valueB: 'contact@acme.com',
        resolution: 'pending',
      },
      {
        fieldName: 'email',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: 'a2@acme.com',
        valueB: 'contact2@acme.com',
        resolution: 'manual',
      },
      {
        fieldName: 'phone',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: '111',
        valueB: '222',
        resolution: 'auto',
      },
    ]);

    const stats = await repo.listConflictStats();
    const totalHistory = await repo.countConflictHistory();

    expect(stats).toHaveLength(2);
    expect(totalHistory).toBe(3);
  });

  it('recordConflictBatch with empty array is a no-op', async () => {
    await repo.recordConflictBatch([]);

    expect(await repo.listConflictStats()).toHaveLength(0);
    expect(await repo.countConflictHistory()).toBe(0);
  });

  it('listConflictHistory returns rows ordered by created_at desc', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'pending', { valueA: '3', valueB: '4' });

    await sql`UPDATE mdm_conflict_history SET created_at = '2020-01-01 00:00:00' WHERE field_name = 'email'`.execute(db);
    await sql`UPDATE mdm_conflict_history SET created_at = '2021-01-01 00:00:00' WHERE field_name = 'phone'`.execute(db);

    const history = await repo.listConflictHistory({}, { offset: 0, limit: 10 });
    expect(history).toHaveLength(2);
    expect(history[0].field_name).toBe('phone');
  });

  it('listConflictHistory supports pagination', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'pending', { valueA: '3', valueB: '4' });
    await repo.recordConflictAtomic('address', 'netsuite', 'bc', 'pending', { valueA: '5', valueB: '6' });

    const page = await repo.listConflictHistory({}, { offset: 1, limit: 1 });
    expect(page).toHaveLength(1);
  });

  it('countConflictHistory returns total with filters', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'manual', { valueA: '3', valueB: '4' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'auto', { valueA: '5', valueB: '6' });

    const emailCount = await repo.countConflictHistory({ fieldName: 'email' });
    const manualCount = await repo.countConflictHistory({ resolution: 'manual' });

    expect(emailCount).toBe(2);
    expect(manualCount).toBe(1);
  });

  it('purgeOldHistory deletes records older than retention period', async () => {
    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA: '1', valueB: '2' });
    await repo.recordConflictAtomic('phone', 'netsuite', 'bc', 'pending', { valueA: '3', valueB: '4' });

    await sql`UPDATE mdm_conflict_history SET created_at = '2000-01-01 00:00:00' WHERE field_name = 'email'`.execute(db);
    const deleted = await repo.purgeOldHistory(30);

    expect(deleted).toBe(1);
    expect(await repo.countConflictHistory()).toBe(1);
  });

  it('JSON values roundtrip through history serialization/deserialization', async () => {
    const valueA = { email: 'a@acme.com', aliases: ['x', 'y'], nested: { active: true } };
    const valueB = { email: 'b@acme.com', aliases: ['z'], nested: { active: false } };

    await repo.recordConflictAtomic('email', 'netsuite', 'bc', 'pending', { valueA, valueB });
    const history = await repo.listConflictHistory({ fieldName: 'email' }, { offset: 0, limit: 1 });

    expect(history[0].value_a).toEqual(valueA);
    expect(history[0].value_b).toEqual(valueB);
  });
});
