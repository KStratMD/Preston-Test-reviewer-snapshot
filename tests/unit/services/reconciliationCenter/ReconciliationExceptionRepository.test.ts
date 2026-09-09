import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import {
  ReconciliationExceptionRepository,
  ReconciliationExceptionNotFoundError,
} from '../../../../src/services/reconciliationCenter/ReconciliationExceptionRepository';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

function makeRepo(db: Kysely<Database>): ReconciliationExceptionRepository {
  return new ReconciliationExceptionRepository({
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as never);
}

describe('ReconciliationExceptionRepository', () => {
  let db: Kysely<Database>;
  let repo: ReconciliationExceptionRepository;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = makeRepo(db);
  });

  afterEach(async () => { await db.destroy(); });

  it('createException writes a rex_ row with tenant attribution and defaults', async () => {
    const id = await repo.createException({
      tenantId: 't1',
      sourceSystem: 'stripe',
      targetSystem: 'business_central',
      sourceRecordId: 'txn_1',
      exceptionType: 'amount_mismatch',
      severity: 'high',
      amountDelta: 5,
      description: 'fee diff',
      suggestedAction: 'review',
    });

    expect(id).toMatch(/^rex_[0-9a-f-]{36}$/);
    const rows = await repo.listExceptions({ tenantId: 't1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      tenantId: 't1',
      sourceSystem: 'stripe',
      sourceRecordId: 'txn_1',
      status: 'open',
      severity: 'high',
      amountDelta: 5,
      targetRecordId: null,
      resolvedAt: null,
    });
    expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('listExceptions isolates tenants and filters by status', async () => {
    await repo.createException({
      tenantId: 't1',
      sourceSystem: 'stripe',
      targetSystem: 'bc',
      sourceRecordId: 'a',
      exceptionType: 't',
      severity: 'low',
      description: 'd1',
      suggestedAction: 's',
    });
    await repo.createException({
      tenantId: 't2',
      sourceSystem: 'stripe',
      targetSystem: 'bc',
      sourceRecordId: 'b',
      exceptionType: 't',
      severity: 'low',
      description: 'd2',
      suggestedAction: 's',
    });

    const t1 = await repo.listExceptions({ tenantId: 't1' });
    expect(t1).toHaveLength(1);
    expect(t1[0].description).toBe('d1');

    const t1Open = await repo.listExceptions({ tenantId: 't1', status: 'open' });
    expect(t1Open).toHaveLength(1);

    const t1Resolved = await repo.listExceptions({ tenantId: 't1', status: 'resolved' });
    expect(t1Resolved).toHaveLength(0);
  });

  it('updateStatus to resolved stamps resolved_at and resolution_note', async () => {
    const id = await repo.createException({
      tenantId: 't1',
      sourceSystem: 'stripe',
      targetSystem: 'bc',
      sourceRecordId: 'a',
      exceptionType: 't',
      severity: 'low',
      description: 'd',
      suggestedAction: 's',
    });

    await repo.updateStatus({
      tenantId: 't1',
      exceptionId: id,
      status: 'resolved',
      actorUserId: 'u_ops',
      resolutionNote: 'matched fee adjustment',
    });

    const rows = await repo.listExceptions({ tenantId: 't1', status: 'resolved' });
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).not.toBeNull();
    expect(rows[0].resolutionNote).toBe('matched fee adjustment');
    expect(rows[0].resolvedBy).toBe('u_ops');
  });

  it('updateStatus to a non-resolved status leaves resolved_at null', async () => {
    const id = await repo.createException({
      tenantId: 't1',
      sourceSystem: 'stripe',
      targetSystem: 'bc',
      sourceRecordId: 'a',
      exceptionType: 't',
      severity: 'low',
      description: 'd',
      suggestedAction: 's',
    });

    await repo.updateStatus({
      tenantId: 't1',
      exceptionId: id,
      status: 'dismissed',
      actorUserId: 'u_ops',
    });

    const rows = await repo.listExceptions({ tenantId: 't1', status: 'dismissed' });
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();
    expect(rows[0].resolutionNote).toBeNull();
    expect(rows[0].resolvedBy).toBeNull();
  });

  it('updateStatus throws ReconciliationExceptionNotFoundError when no row matches', async () => {
    await expect(
      repo.updateStatus({
        tenantId: 't1',
        exceptionId: 'rex_does_not_exist',
        status: 'resolved',
        actorUserId: 'u_ops',
        resolutionNote: 'irrelevant',
      }),
    ).rejects.toBeInstanceOf(ReconciliationExceptionNotFoundError);
  });

  it('updateStatus refuses to cross tenant boundaries', async () => {
    const id = await repo.createException({
      tenantId: 't1',
      sourceSystem: 'stripe',
      targetSystem: 'bc',
      sourceRecordId: 'a',
      exceptionType: 't',
      severity: 'low',
      description: 'd',
      suggestedAction: 's',
    });

    // t2 tries to update t1's row. The WHERE clause filters by tenant_id so
    // no row is updated; the repo signals this with a typed NotFound error so
    // the route can map it to a 404.
    await expect(
      repo.updateStatus({
        tenantId: 't2',
        exceptionId: id,
        status: 'resolved',
        actorUserId: 'u_attacker',
        resolutionNote: 'should never apply',
      }),
    ).rejects.toBeInstanceOf(ReconciliationExceptionNotFoundError);

    const rows = await repo.listExceptions({ tenantId: 't1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].resolutionNote).toBeNull();
  });

  describe('existsOpenException', () => {
    it('returns true when an open exception with the same coalescing key exists', async () => {
      await repo.createException({
        tenantId: 't1', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch', severity: 'high',
        description: 'd', suggestedAction: 'a',
      });
      const exists = await repo.existsOpenException({
        tenantId: 't1', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch',
      });
      expect(exists).toBe(true);
    });

    it('returns false when no open exception matches (different tenant)', async () => {
      await repo.createException({
        tenantId: 't1', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch', severity: 'high',
        description: 'd', suggestedAction: 'a',
      });
      const exists = await repo.existsOpenException({
        tenantId: 't2', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch',
      });
      expect(exists).toBe(false);
    });

    it('does not coalesce against a resolved exception (recurring discrepancy is a fresh signal)', async () => {
      const id = await repo.createException({
        tenantId: 't1', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch', severity: 'high',
        description: 'd', suggestedAction: 'a',
      });
      await repo.updateStatus({ tenantId: 't1', exceptionId: id, status: 'resolved', actorUserId: 'u', resolutionNote: 'done' });
      const exists = await repo.existsOpenException({
        tenantId: 't1', sourceSystem: 'netsuite', targetSystem: 'business_central',
        sourceRecordId: 'INV-1', exceptionType: 'amount_mismatch',
      });
      expect(exists).toBe(false);
    });
  });
});
