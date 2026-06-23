import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { MDMRepository } from '../../../../src/database/repositories/MDMRepository';
import type { Database } from '../../../../src/database/types';
import { MDMFeedbackService } from '../../../../src/services/mdm/MDMFeedbackService';

describe('MDM Conflict Persistence Integration', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;
  let repo: MDMRepository;
  let feedbackService: MDMFeedbackService;

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

  beforeEach(async () => {
    jest.clearAllMocks();
    await sql`DELETE FROM mdm_conflict_history`.execute(db);
    await sql`DELETE FROM mdm_conflict_stats`.execute(db);
    feedbackService = new MDMFeedbackService(mockLogger as any, repo);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('recordConflict persists stats and history atomically', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a@acme.com', 'contact@acme.com', 'pending');

    const stats = await repo.listConflictStats({ fieldName: 'email' });
    const history = await repo.listConflictHistory({ fieldName: 'email' }, { offset: 0, limit: 10 });

    expect(stats).toHaveLength(1);
    expect(stats[0].conflict_count).toBe(1);
    expect(history).toHaveLength(1);
    expect(history[0].resolution).toBe('pending');
  });

  it('resolveConflict updates DB resolution counters', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');
    await feedbackService.resolveConflict('email', 'netsuite', 'bc', 'manual');

    const [stat] = await repo.listConflictStats({ fieldName: 'email' });
    expect(stat.resolution_count).toBe(1);
    expect(stat.manual_resolution_count).toBe(1);
  });

  it('recordConflictBatch persists all events and aggregates stats', async () => {
    await feedbackService.recordConflictBatch([
      {
        fieldName: 'email',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: 'a',
        valueB: 'b',
        resolution: 'pending',
      },
      {
        fieldName: 'email',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: 'c',
        valueB: 'd',
        resolution: 'auto',
      },
      {
        fieldName: 'phone',
        sourceSystem: 'netsuite',
        targetSystem: 'bc',
        valueA: '111',
        valueB: '222',
        resolution: 'manual',
      },
    ]);

    const stats = await repo.listConflictStats();
    const totalHistory = await repo.countConflictHistory();
    expect(stats).toHaveLength(2);
    expect(totalHistory).toBe(3);
  });

  it('getFieldStats hydrates data from persisted DB state', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'auto');

    const freshService = new MDMFeedbackService(mockLogger as any, repo);
    const stats = await freshService.getFieldStats('email');

    expect(stats).toHaveLength(1);
    expect(stats[0].conflictCount).toBe(1);
    expect(stats[0].autoResolutionCount).toBe(1);
    expect(stats[0].autoResolutionRate).toBe(1);
  });

  it('getTopConflictingFields returns sorted entries after restart', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'c', 'd', 'pending');
    await feedbackService.recordConflict('phone', 'netsuite', 'bc', '1', '2', 'pending');

    const freshService = new MDMFeedbackService(mockLogger as any, repo);
    const top = await freshService.getTopConflictingFields(2);

    expect(top).toHaveLength(2);
    expect(top[0].fieldName).toBe('email');
    expect(top[0].conflictCount).toBeGreaterThan(top[1].conflictCount);
  });

  it('getStatistics returns aggregate counters with computed rates', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'auto');
    await feedbackService.recordConflict('phone', 'netsuite', 'bc', '1', '2', 'pending');
    await feedbackService.resolveConflict('phone', 'netsuite', 'bc', 'manual');

    const stats = await feedbackService.getStatistics();
    expect(stats.totalConflicts).toBe(2);
    expect(stats.resolvedConflicts).toBe(2);
    expect(stats.autoResolutionRate).toBe(0.5);
  });

  it('getConflictHistory returns paginated results', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');
    await feedbackService.recordConflict('phone', 'netsuite', 'bc', '1', '2', 'manual');
    await feedbackService.recordConflict('address', 'netsuite', 'bc', 'x', 'y', 'pending');

    const page = await feedbackService.getConflictHistory({}, { offset: 1, limit: 1 });
    expect(page.records).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
  });

  it('clearAll clears DB tables and cache state', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');
    await feedbackService.clearAll();

    expect(await repo.listConflictStats()).toHaveLength(0);
    expect(await repo.countConflictHistory()).toBe(0);

    const stats = await feedbackService.getStatistics();
    expect(stats.totalConflicts).toBe(0);
  });

  it('data persists across service instances (restart simulation)', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');

    const afterRestart = new MDMFeedbackService(mockLogger as any, repo);
    const stats = await afterRestart.getStatistics();
    expect(stats.totalConflicts).toBe(1);
  });

  it('graceful degradation works without repository', async () => {
    const inMemoryService = new MDMFeedbackService(mockLogger as any);
    await inMemoryService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending');
    await inMemoryService.resolveConflict('email', 'netsuite', 'bc', 'manual');

    const stats = await inMemoryService.getStatistics();
    const history = await inMemoryService.getConflictHistory({}, { offset: 0, limit: 10 });
    expect(stats.totalConflicts).toBe(1);
    expect(stats.resolvedConflicts).toBe(1);
    expect(history.total).toBe(1);
  });

  it('concurrent writes from two service instances preserve increments', async () => {
    const serviceA = new MDMFeedbackService(mockLogger as any, repo);
    const serviceB = new MDMFeedbackService(mockLogger as any, repo);

    await Promise.all([
      serviceA.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'pending'),
      serviceB.recordConflict('email', 'netsuite', 'bc', 'c', 'd', 'pending'),
    ]);

    const [stat] = await repo.listConflictStats({ fieldName: 'email' });
    expect(stat.conflict_count).toBe(2);
  });

  it('history filtering supports resolution and source filters', async () => {
    await feedbackService.recordConflict('email', 'netsuite', 'bc', 'a', 'b', 'manual');
    await feedbackService.recordConflict('phone', 'hubspot', 'bc', '1', '2', 'pending');

    const manualOnly = await feedbackService.getConflictHistory({ resolution: 'manual' }, { offset: 0, limit: 10 });
    const hubspotOnly = await feedbackService.getConflictHistory({ sourceSystem: 'hubspot' }, { offset: 0, limit: 10 });

    expect(manualOnly.total).toBe(1);
    expect(manualOnly.records[0].fieldName).toBe('email');
    expect(hubspotOnly.total).toBe(1);
    expect(hubspotOnly.records[0].fieldName).toBe('phone');
  });

  it('resolveConflict does not mutate cache when DB stat row is missing', async () => {
    // Resolve a field that was never recorded — DB returns false
    await feedbackService.resolveConflict('nonexistent', 'netsuite', 'bc', 'manual');

    const stats = await feedbackService.getStatistics();
    expect(stats.totalConflicts).toBe(0);
    expect(stats.resolvedConflicts).toBe(0);
  });
});
