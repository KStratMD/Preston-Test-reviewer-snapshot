import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import { migration as createFinanceCentralApprovals } from '../../../../src/database/migrations/039-create-finance-central-approvals-table';
import { FinanceCentralRepository } from '../../../../src/services/financeCentral/FinanceCentralRepository';
import type { ApprovalPriority, DocumentType } from '../../../../src/services/financeCentral/types';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

function makeRepo(db: Kysely<Database>): FinanceCentralRepository {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  return new FinanceCentralRepository(databaseService);
}

interface SeedOverrides {
  approvalId?: string;
  documentType?: DocumentType;
  amount?: number;
  priority?: ApprovalPriority;
  netSuiteId?: string;
  submittedAt?: string;
  documentNumber?: string;
  description?: string;
}

async function seedPending(
  repo: FinanceCentralRepository,
  tenantId: string,
  overrides: SeedOverrides = {},
): Promise<string> {
  const approvalId = overrides.approvalId ?? `appr-${Math.random().toString(36).slice(2, 8)}`;
  await repo.insertIfMissing({
    tenantId,
    approvalId,
    documentId: `doc-${approvalId}`,
    documentNumber: overrides.documentNumber ?? `INV-${approvalId}`,
    documentType: overrides.documentType ?? 'invoice',
    description: overrides.description ?? 'seeded approval',
    amount: overrides.amount ?? 1000,
    currency: 'USD',
    submittedBy: 'seed@company.com',
    submittedAt: overrides.submittedAt ?? new Date().toISOString(),
    currentApprover: 'approver@company.com',
    approvalLevel: 1,
    priority: overrides.priority ?? 'medium',
    netSuiteId: overrides.netSuiteId,
  });
  return approvalId;
}

describe('FinanceCentralRepository', () => {
  let db: Kysely<Database>;
  let repo: FinanceCentralRepository;

  beforeEach(async () => {
    db = makeDb();
    await createFinanceCentralApprovals.run(db, 'sqlite');
    repo = makeRepo(db);
  });

  afterEach(async () => { await db.destroy(); });

  describe('insertIfMissing', () => {
    it('returns true on first insert and false on conflict (idempotent)', async () => {
      const tenant = 'tnt_A';
      const first = await repo.insertIfMissing({
        tenantId: tenant,
        approvalId: 'appr-001',
        documentId: 'doc-001',
        documentNumber: 'INV-001',
        documentType: 'invoice',
        description: 'first insert',
        amount: 100,
        currency: 'USD',
        submittedBy: 's@x',
        submittedAt: new Date().toISOString(),
        currentApprover: 'a@x',
        approvalLevel: 1,
        priority: 'medium',
      });
      expect(first).toBe(true);

      const second = await repo.insertIfMissing({
        tenantId: tenant,
        approvalId: 'appr-001',
        documentId: 'doc-001-rewrite',
        documentNumber: 'INV-001',
        documentType: 'invoice',
        description: 'attempted overwrite',
        amount: 999,
        currency: 'USD',
        submittedBy: 's@x',
        submittedAt: new Date().toISOString(),
        currentApprover: 'a@x',
        approvalLevel: 1,
        priority: 'medium',
      });
      expect(second).toBe(false);

      const row = await repo.getRowByApprovalId(tenant, 'appr-001');
      expect(row?.description).toBe('first insert');
      expect(row?.amount).toBe(100);
    });
  });

  describe('getRowByApprovalId / getDisposition', () => {
    it('returns null when no row exists', async () => {
      expect(await repo.getRowByApprovalId('tnt_A', 'missing')).toBeNull();
      expect(await repo.getDisposition('tnt_A', 'missing')).toBeNull();
    });

    it('returns row + disposition for an existing pending approval', async () => {
      await seedPending(repo, 'tnt_A', { approvalId: 'appr-001' });
      const row = await repo.getRowByApprovalId('tnt_A', 'appr-001');
      expect(row?.approval_id).toBe('appr-001');
      expect(row?.operator_disposition).toBe('pending');
      expect(await repo.getDisposition('tnt_A', 'appr-001')).toBe('pending');
    });

    it('scopes by tenant — other tenant cannot read', async () => {
      await seedPending(repo, 'tnt_A', { approvalId: 'appr-001' });
      expect(await repo.getRowByApprovalId('tnt_B', 'appr-001')).toBeNull();
    });
  });

  describe('listPendingApprovals', () => {
    it('returns only pending rows for the given tenant', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await seedPending(repo, tenant, { approvalId: 'appr-2' });
      await seedPending(repo, 'tnt_OTHER', { approvalId: 'appr-other' });
      // Move one approval to 'applying' so it is excluded from pending list.
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_1' });

      const views = await repo.listPendingApprovals({ tenantId: tenant });
      expect(views).toHaveLength(1);
      expect(views[0].id).toBe('appr-2');
    });

    it('orders by priority (urgent>high>medium>low) then daysWaiting (descending)', async () => {
      const tenant = 'tnt_A';
      const now = Date.now();
      const iso = (offsetDays: number) => new Date(now - offsetDays * 86_400_000).toISOString();
      await seedPending(repo, tenant, { approvalId: 'a-med-old',  priority: 'medium', submittedAt: iso(10) });
      await seedPending(repo, tenant, { approvalId: 'a-urgent',   priority: 'urgent', submittedAt: iso(0) });
      await seedPending(repo, tenant, { approvalId: 'a-high-new', priority: 'high',   submittedAt: iso(1) });
      await seedPending(repo, tenant, { approvalId: 'a-high-old', priority: 'high',   submittedAt: iso(5) });
      await seedPending(repo, tenant, { approvalId: 'a-low',      priority: 'low',    submittedAt: iso(3) });

      const views = await repo.listPendingApprovals({ tenantId: tenant });
      expect(views.map(v => v.id)).toEqual([
        'a-urgent',
        'a-high-old',
        'a-high-new',
        'a-med-old',
        'a-low',
      ]);
    });

    it('honors limit', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'a-1', priority: 'urgent' });
      await seedPending(repo, tenant, { approvalId: 'a-2', priority: 'high' });
      await seedPending(repo, tenant, { approvalId: 'a-3', priority: 'medium' });
      const views = await repo.listPendingApprovals({ tenantId: tenant, limit: 2 });
      expect(views).toHaveLength(2);
    });

    it('filters by type, priority, and approver', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'a-inv',  documentType: 'invoice',  priority: 'high' });
      await seedPending(repo, tenant, { approvalId: 'a-bill', documentType: 'bill',     priority: 'high' });
      await seedPending(repo, tenant, { approvalId: 'a-low',  documentType: 'invoice',  priority: 'low' });

      const onlyInvoices = await repo.listPendingApprovals({ tenantId: tenant, filters: { type: 'invoice' } });
      expect(onlyInvoices.map(v => v.id).sort()).toEqual(['a-inv', 'a-low']);

      const onlyHigh = await repo.listPendingApprovals({ tenantId: tenant, filters: { priority: 'high' } });
      expect(onlyHigh.map(v => v.id).sort()).toEqual(['a-bill', 'a-inv']);

      const byApprover = await repo.listPendingApprovals({ tenantId: tenant, filters: { approver: 'approver@company.com' } });
      expect(byApprover.length).toBeGreaterThan(0);
      expect(await repo.listPendingApprovals({ tenantId: tenant, filters: { approver: 'nobody@x' } })).toEqual([]);
    });

    it('computes daysWaiting from submitted_at at read time', async () => {
      const tenant = 'tnt_A';
      const submittedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
      await seedPending(repo, tenant, { approvalId: 'a-1', submittedAt });
      const [view] = await repo.listPendingApprovals({ tenantId: tenant });
      expect(view.daysWaiting).toBeGreaterThanOrEqual(3);
      expect(view.daysWaiting).toBeLessThanOrEqual(5);
    });
  });

  describe('beginAccept', () => {
    it('transitions pending → applying atomically and returns true', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      const ok = await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      expect(ok).toBe(true);
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition).toBe('applying');
      expect(row?.operator_disposition_user_id).toBe('op_42');
      expect(row?.operator_disposition_at).not.toBeNull();
    });

    it('returns false when row is already applying (concurrent caller wins)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_first' });
      const second = await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_second' });
      expect(second).toBe(false);
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition_user_id).toBe('op_first');
    });

    it('returns false when row is accepted or rejected (terminal states)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-rej' });
      await repo.markRejected({ tenantId: tenant, approvalId: 'appr-rej', userId: 'op_1', rejectionReason: 'no' });
      expect(await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-rej', userId: 'op_2' })).toBe(false);
    });

    it('returns false when row does not exist (no insert side-effect)', async () => {
      expect(await repo.beginAccept({ tenantId: 'tnt_A', approvalId: 'missing', userId: 'op_1' })).toBe(false);
      expect(await repo.getRowByApprovalId('tnt_A', 'missing')).toBeNull();
    });
  });

  describe('completeAccept', () => {
    it('transitions applying → accepted atomically and stamps appliedRecordId + comments', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      const ok = await repo.completeAccept({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_42',
        appliedRecordId: 'NS-1234',
        approvalComments: 'looks good',
      });
      expect(ok).toBe(true);
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition).toBe('accepted');
      expect(row?.applied_record_id).toBe('NS-1234');
      expect(row?.approval_comments).toBe('looks good');
    });

    it('refuses to complete a lease held by a DIFFERENT user (lease isolation)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      const ok = await repo.completeAccept({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_OTHER',
        appliedRecordId: 'NS-X',
      });
      expect(ok).toBe(false);
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition).toBe('applying');
      expect(row?.operator_disposition_user_id).toBe('op_42');
    });

    it('returns false when row is no longer in applying state (reaper revert / completed already)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      // Never called beginAccept, so row is pending.
      const ok = await repo.completeAccept({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_42',
        appliedRecordId: 'NS-X',
      });
      expect(ok).toBe(false);
    });
  });

  describe('revertToPending', () => {
    it('transitions applying → pending atomically (failure-recovery path) AND clears lease metadata', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      const ok = await repo.revertToPending({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      expect(ok).toBe(true);
      expect(await repo.getDisposition(tenant, 'appr-1')).toBe('pending');
      // PR 6 R2 (Copilot R2): lease metadata is cleared on revert so a re-attempting
      // operator doesn't see stale holder/timestamp data.
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition_user_id).toBeNull();
      expect(row?.operator_disposition_at).toBeNull();
    });

    it('refuses to revert a lease held by a DIFFERENT user (lease isolation)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      const ok = await repo.revertToPending({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_OTHER' });
      expect(ok).toBe(false);
      expect(await repo.getDisposition(tenant, 'appr-1')).toBe('applying');
    });
  });

  describe('markRejected', () => {
    it('transitions pending → rejected atomically with reason + userId', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      const ok = await repo.markRejected({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_42',
        rejectionReason: 'missing receipts',
      });
      expect(ok).toBe(true);
      const row = await repo.getRowByApprovalId(tenant, 'appr-1');
      expect(row?.operator_disposition).toBe('rejected');
      expect(row?.rejection_reason).toBe('missing receipts');
      expect(row?.operator_disposition_user_id).toBe('op_42');
    });

    it('returns false when row is in applying state (must wait or revert first)', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.beginAccept({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_42' });
      const ok = await repo.markRejected({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_99',
        rejectionReason: 'race',
      });
      expect(ok).toBe(false);
      expect(await repo.getDisposition(tenant, 'appr-1')).toBe('applying');
    });

    it('returns false when row is already rejected', async () => {
      const tenant = 'tnt_A';
      await seedPending(repo, tenant, { approvalId: 'appr-1' });
      await repo.markRejected({ tenantId: tenant, approvalId: 'appr-1', userId: 'op_1', rejectionReason: 'no' });
      const second = await repo.markRejected({
        tenantId: tenant,
        approvalId: 'appr-1',
        userId: 'op_2',
        rejectionReason: 'still no',
      });
      expect(second).toBe(false);
    });
  });
});
