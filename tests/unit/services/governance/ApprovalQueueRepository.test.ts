import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import { migration as createGovernanceApprovals } from '../../../../src/database/migrations/045-create-governance-approvals-table';
import { migration as addWriteDescriptor } from '../../../../src/database/migrations/050-add-write-descriptor-to-governance-approvals';
import { migration as addApplyLifecycle } from '../../../../src/database/migrations/051-add-apply-lifecycle-to-governance-approvals';
import {
  ApprovalQueueRepository,
  InvalidLimitError,
  InvalidOffsetError,
  type NewPendingApprovalRow,
} from '../../../../src/services/governance/ApprovalQueueRepository';

// ---------------------------------------------------------------------------
// Helpers — mirror the WorkflowCentralRepository unit-test fixture pattern:
// stand up a fresh in-memory sqlite via BetterSqlite3 + SqliteDialect, run
// ONLY migration 045 (governance_approvals has no FK dependencies), and stub
// just enough of DatabaseService for ApprovalQueueRepository to operate.
// Hold an explicit ref to the BetterSqlite3 handle so afterEach can close it
// — Kysely.destroy() does NOT close the underlying connection. See the long
// comment in WorkflowCentralRepository.test.ts for why this matters when this
// suite runs after other SQLite-heavy suites.
// ---------------------------------------------------------------------------

function makeDb(): { db: Kysely<Database>; sqlite: BetterSqlite3.Database } {
  const sqlite = new BetterSqlite3(':memory:');
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  return { db, sqlite };
}

function makeRepo(db: Kysely<Database>): ApprovalQueueRepository {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite' as const,
  } as unknown as DatabaseService;
  return new ApprovalQueueRepository(databaseService);
}

let rowCounter = 0;
// Far-future default expiresAt so the new TTL gate (R3 / Codex 5.4 HIGH) does
// not silently exclude fixtures from list/count/decide. Individual tests
// override when they need a past expiry.
const FAR_FUTURE_ISO = '2099-12-31T23:59:59.000Z';
function makePendingRow(
  overrides: Partial<NewPendingApprovalRow> = {},
): NewPendingApprovalRow {
  rowCounter++;
  return {
    id: `apr_${rowCounter}_${Date.now()}`,
    tenantId: 'tnt_A',
    requesterUserId: 'user-1',
    operationType: 'ai_call',
    resourceType: 'connector',
    resourceId: 'res-1',
    riskLevel: 'medium',
    redactedPayload: JSON.stringify({ q: 'redacted' }),
    policyFindings: JSON.stringify(['EMAIL', 'SSN']),
    createdAt: new Date('2026-05-18T00:00:00.000Z').toISOString(),
    expiresAt: FAR_FUTURE_ISO,
    ...overrides,
  };
}

/** Helper: insert a row + transition it to 'approved' so claimForApply can fire. */
async function insertApproved(
  repo: ApprovalQueueRepository,
  overrides: Partial<NewPendingApprovalRow> = {},
): Promise<{ tenantId: string; id: string }> {
  const row = makePendingRow(overrides);
  await repo.insertPending(row);
  const result = await repo.decide({
    tenantId: row.tenantId,
    id: row.id,
    decidedByUserId: 'approver-1',
    decision: 'approved',
    decisionReason: null,
    decidedAt: new Date('2026-05-18T00:30:00.000Z').toISOString(),
  });
  if (result.outcome !== 'updated') throw new Error(`unexpected decide outcome: ${result.outcome}`);
  return { tenantId: row.tenantId, id: row.id };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ApprovalQueueRepository', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;
  let repo: ApprovalQueueRepository;

  beforeEach(async () => {
    const fixture = makeDb();
    db = fixture.db;
    sqlite = fixture.sqlite;
    // Codex R1 (PR 13b) P2: run BOTH 045 (table) and 050 (write_descriptor)
    // in the default fixture. The repo's insertPending always references
    // `write_descriptor` (column added by 050), so the prior 045-only
    // fixture relied on Kysely's silent-skip-of-undefined behavior — fragile
    // and would break the moment a default included a non-undefined
    // writeDescriptor. Running 050 matches the production schema.
    await createGovernanceApprovals.run(db, 'sqlite');
    await addWriteDescriptor.run(db, 'sqlite');
    await addApplyLifecycle.run(db, 'sqlite');
    repo = makeRepo(db);
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  // -------------------------------------------------------------------------
  describe('insertPending + getById', () => {
    it('round-trips a pending row with all fields populated', async () => {
      const input = makePendingRow({
        id: 'apr_rt_1',
        tenantId: 'tnt_RT',
        requesterUserId: 'user-rt',
        operationType: 'connector_write',
        resourceType: 'netsuite',
        resourceId: 'ns-42',
        riskLevel: 'high',
        redactedPayload: JSON.stringify({ amount: '<REDACTED>' }),
        policyFindings: JSON.stringify(['CREDIT_CARD']),
      });
      const inserted = await repo.insertPending(input);

      expect(inserted).toMatchObject({
        id: input.id,
        tenantId: input.tenantId,
        requesterUserId: input.requesterUserId,
        operationType: 'connector_write',
        resourceType: 'netsuite',
        resourceId: 'ns-42',
        riskLevel: 'high',
        redactedPayload: input.redactedPayload,
        policyFindings: input.policyFindings,
        status: 'pending',
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        decidedAt: null,
        decidedByUserId: null,
        decisionReason: null,
        applyIdempotencyKey: null,
      });

      const fetched = await repo.getById(input.tenantId, input.id);
      expect(fetched).toEqual(inserted);
    });

    it('getById returns null when tenant mismatches the row tenant', async () => {
      const input = makePendingRow({ id: 'apr_tenant_iso', tenantId: 'tnt_A' });
      await repo.insertPending(input);

      const wrongTenant = await repo.getById('tnt_B', input.id);
      expect(wrongTenant).toBeNull();
    });

    it('getById returns null for an unknown id', async () => {
      const result = await repo.getById('tnt_A', 'apr_does_not_exist');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('listPendingForTenant + countPendingForTenant', () => {
    it('lists tenant pending rows ordered by created_at DESC + id DESC tiebreak', async () => {
      const sharedTs = new Date('2026-05-18T12:00:00.000Z').toISOString();
      const olderTs = new Date('2026-05-18T11:00:00.000Z').toISOString();

      // Two same-timestamp rows; id-DESC tiebreaker should put 'apr_zzz' before 'apr_aaa'.
      await repo.insertPending(
        makePendingRow({ id: 'apr_aaa', tenantId: 'tnt_A', createdAt: sharedTs }),
      );
      await repo.insertPending(
        makePendingRow({ id: 'apr_zzz', tenantId: 'tnt_A', createdAt: sharedTs }),
      );
      // Older row should land last.
      await repo.insertPending(
        makePendingRow({ id: 'apr_mid', tenantId: 'tnt_A', createdAt: olderTs }),
      );

      const rows = await repo.listPendingForTenant('tnt_A');
      expect(rows.map((r) => r.id)).toEqual(['apr_zzz', 'apr_aaa', 'apr_mid']);
    });

    it('excludes rows belonging to other tenants', async () => {
      await repo.insertPending(makePendingRow({ id: 'apr_a1', tenantId: 'tnt_A' }));
      await repo.insertPending(makePendingRow({ id: 'apr_b1', tenantId: 'tnt_B' }));
      await repo.insertPending(makePendingRow({ id: 'apr_b2', tenantId: 'tnt_B' }));

      const aRows = await repo.listPendingForTenant('tnt_A');
      expect(aRows.map((r) => r.id)).toEqual(['apr_a1']);

      const bRows = await repo.listPendingForTenant('tnt_B');
      expect(bRows.map((r) => r.id).sort()).toEqual(['apr_b1', 'apr_b2']);
    });

    it('respects default limit of 10 and max of 100', async () => {
      // Insert 12 pending rows; default cap = 10.
      for (let i = 0; i < 12; i++) {
        await repo.insertPending(
          makePendingRow({
            id: `apr_lim_${String(i).padStart(2, '0')}`,
            tenantId: 'tnt_LIM',
            // Stagger created_at so DESC ordering is deterministic.
            createdAt: new Date(Date.UTC(2026, 4, 18, 0, i, 0)).toISOString(),
          }),
        );
      }
      const defaulted = await repo.listPendingForTenant('tnt_LIM');
      expect(defaulted).toHaveLength(10);

      // limit=100 is the documented max and must be accepted (not rejected).
      const maxLimit = await repo.listPendingForTenant('tnt_LIM', { limit: 100 });
      expect(maxLimit).toHaveLength(12);
    });

    it.each([
      ['zero', 0],
      ['above max', 101],
      ['negative', -1],
      ['non-integer', 1.5],
      ['non-number string', 'abc' as unknown as number],
    ])('throws InvalidLimitError on limit=%s', async (_label, badLimit) => {
      await expect(
        repo.listPendingForTenant('tnt_A', { limit: badLimit as number }),
      ).rejects.toBeInstanceOf(InvalidLimitError);
    });

    it('countPendingForTenant returns count of pending rows only', async () => {
      await repo.insertPending(makePendingRow({ id: 'apr_cnt_1', tenantId: 'tnt_CNT' }));
      await repo.insertPending(makePendingRow({ id: 'apr_cnt_2', tenantId: 'tnt_CNT' }));
      const decidedRow = makePendingRow({ id: 'apr_cnt_3', tenantId: 'tnt_CNT' });
      await repo.insertPending(decidedRow);
      const outcome = await repo.decide({
        tenantId: 'tnt_CNT',
        id: decidedRow.id,
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: null,
        decidedAt: new Date('2026-05-18T00:30:00.000Z').toISOString(),
      });
      expect(outcome.outcome).toBe('updated');

      const count = await repo.countPendingForTenant('tnt_CNT');
      expect(count).toBe(2);
    });

    // R3 / Copilot R3 #2: offset validation
    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['non-numeric string', 'abc'],
      ['NaN', Number.NaN],
    ])('throws InvalidOffsetError on %s offset', async (_label, badOffset) => {
      await expect(
        repo.listPendingForTenant('tnt_A', { offset: badOffset as number }),
      ).rejects.toBeInstanceOf(InvalidOffsetError);
    });

    // R3 / Codex 5.4 HIGH: TTL exclusion on list + count
    it('listPendingForTenant excludes expired-but-unswept rows (TTL gate)', async () => {
      const past = '2020-01-01T00:00:00.000Z';
      const future = FAR_FUTURE_ISO;
      await repo.insertPending(
        makePendingRow({ id: 'apr_ttl_fresh', tenantId: 'tnt_TTL', expiresAt: future }),
      );
      await repo.insertPending(
        makePendingRow({ id: 'apr_ttl_expired', tenantId: 'tnt_TTL', expiresAt: past }),
      );

      const rows = await repo.listPendingForTenant('tnt_TTL', {
        nowIso: '2025-01-01T00:00:00.000Z',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('apr_ttl_fresh');
    });

    it('countPendingForTenant excludes expired-but-unswept rows (TTL gate)', async () => {
      const past = '2020-01-01T00:00:00.000Z';
      const future = FAR_FUTURE_ISO;
      await repo.insertPending(
        makePendingRow({ id: 'apr_ttl_cnt_fresh', tenantId: 'tnt_TTL_CNT', expiresAt: future }),
      );
      await repo.insertPending(
        makePendingRow({ id: 'apr_ttl_cnt_expired', tenantId: 'tnt_TTL_CNT', expiresAt: past }),
      );

      const count = await repo.countPendingForTenant('tnt_TTL_CNT', '2025-01-01T00:00:00.000Z');
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tier-C history view: listByTerminalStatusForTenant + countByTerminalStatusForTenant
  // -------------------------------------------------------------------------
  describe('listByTerminalStatusForTenant + countByTerminalStatusForTenant', () => {
    async function seedDecidedRow(args: {
      tenantId: string;
      id: string;
      decision: 'approved' | 'rejected';
      createdAt?: string;
      decidedAt?: string;
      reason?: string | null;
    }): Promise<void> {
      const row = makePendingRow({
        id: args.id,
        tenantId: args.tenantId,
        createdAt: args.createdAt ?? new Date('2026-05-18T12:00:00.000Z').toISOString(),
      });
      await repo.insertPending(row);
      const outcome = await repo.decide({
        tenantId: args.tenantId,
        id: args.id,
        decidedByUserId: 'admin-1',
        decision: args.decision,
        decisionReason: args.reason ?? `operator note for ${args.id}`,
        decidedAt: args.decidedAt ?? new Date('2026-05-18T12:30:00.000Z').toISOString(),
      });
      expect(outcome.outcome).toBe('updated');
    }

    it('lists approved rows ordered by decided_at DESC + id DESC tiebreak (Codex 5.5 MEDIUM on PR #826)', async () => {
      // Audit-trail ordering: most-recently-DECIDED rows first, not
      // most-recently-CREATED. Two same-decided_at rows tie-break by id DESC.
      const sharedDecidedTs = new Date('2026-05-18T12:30:00.000Z').toISOString();
      const olderDecidedTs = new Date('2026-05-18T11:30:00.000Z').toISOString();
      await seedDecidedRow({ tenantId: 'tnt_H_A', id: 'apr_h_aaa', decision: 'approved', decidedAt: sharedDecidedTs });
      await seedDecidedRow({ tenantId: 'tnt_H_A', id: 'apr_h_zzz', decision: 'approved', decidedAt: sharedDecidedTs });
      await seedDecidedRow({ tenantId: 'tnt_H_A', id: 'apr_h_mid', decision: 'approved', decidedAt: olderDecidedTs });

      const rows = await repo.listByTerminalStatusForTenant('tnt_H_A', 'approved');
      expect(rows.map((r) => r.id)).toEqual(['apr_h_zzz', 'apr_h_aaa', 'apr_h_mid']);
      expect(rows.every((r) => r.status === 'approved')).toBe(true);
    });

    it('orders by decided_at NOT created_at — old request decided today appears ABOVE newer request decided earlier (Codex 5.5 MEDIUM regression)', async () => {
      // Pin the actual bug Codex caught: an OLD request (early createdAt)
      // approved RECENTLY should appear above a NEWER request approved
      // EARLIER. The audit story is "what got decided when", not "what
      // was requested when".
      const oldRequest_createdAt = new Date('2026-05-01T08:00:00.000Z').toISOString();
      const oldRequest_decidedAt = new Date('2026-05-18T14:00:00.000Z').toISOString();
      const newRequest_createdAt = new Date('2026-05-18T10:00:00.000Z').toISOString();
      const newRequest_decidedAt = new Date('2026-05-18T11:00:00.000Z').toISOString();

      await seedDecidedRow({
        tenantId: 'tnt_H_ORDER',
        id: 'apr_h_new_req_early_decision',
        decision: 'approved',
        createdAt: newRequest_createdAt,
        decidedAt: newRequest_decidedAt,
      });
      await seedDecidedRow({
        tenantId: 'tnt_H_ORDER',
        id: 'apr_h_old_req_late_decision',
        decision: 'approved',
        createdAt: oldRequest_createdAt,
        decidedAt: oldRequest_decidedAt,
      });

      const rows = await repo.listByTerminalStatusForTenant('tnt_H_ORDER', 'approved');
      // The OLD request (created 2026-05-01) was DECIDED on 05-18 14:00,
      // AFTER the new request's 05-18 11:00 decision. So old_req comes first.
      expect(rows.map((r) => r.id)).toEqual([
        'apr_h_old_req_late_decision',
        'apr_h_new_req_early_decision',
      ]);
    });

    it('lists rejected rows separately from approved rows', async () => {
      await seedDecidedRow({ tenantId: 'tnt_H_MIX', id: 'apr_h_appr', decision: 'approved' });
      await seedDecidedRow({ tenantId: 'tnt_H_MIX', id: 'apr_h_rej', decision: 'rejected' });

      const approvedRows = await repo.listByTerminalStatusForTenant('tnt_H_MIX', 'approved');
      expect(approvedRows.map((r) => r.id)).toEqual(['apr_h_appr']);

      const rejectedRows = await repo.listByTerminalStatusForTenant('tnt_H_MIX', 'rejected');
      expect(rejectedRows.map((r) => r.id)).toEqual(['apr_h_rej']);
    });

    it('excludes pending rows even though they share the tenant', async () => {
      await seedDecidedRow({ tenantId: 'tnt_H_PEND', id: 'apr_h_decided', decision: 'approved' });
      await repo.insertPending(makePendingRow({ id: 'apr_h_pending', tenantId: 'tnt_H_PEND' }));

      const rows = await repo.listByTerminalStatusForTenant('tnt_H_PEND', 'approved');
      expect(rows.map((r) => r.id)).toEqual(['apr_h_decided']);
    });

    it('respects tenant isolation', async () => {
      await seedDecidedRow({ tenantId: 'tnt_H_X', id: 'apr_h_x1', decision: 'approved' });
      await seedDecidedRow({ tenantId: 'tnt_H_Y', id: 'apr_h_y1', decision: 'approved' });

      const xRows = await repo.listByTerminalStatusForTenant('tnt_H_X', 'approved');
      expect(xRows.map((r) => r.id)).toEqual(['apr_h_x1']);
      const yRows = await repo.listByTerminalStatusForTenant('tnt_H_Y', 'approved');
      expect(yRows.map((r) => r.id)).toEqual(['apr_h_y1']);
    });

    it('respects default limit of 10 and max of 100', async () => {
      for (let i = 0; i < 12; i++) {
        await seedDecidedRow({
          tenantId: 'tnt_H_LIM',
          id: `apr_h_lim_${String(i).padStart(2, '0')}`,
          decision: 'approved',
          createdAt: new Date(Date.UTC(2026, 4, 18, 0, i, 0)).toISOString(),
        });
      }
      const defaulted = await repo.listByTerminalStatusForTenant('tnt_H_LIM', 'approved');
      expect(defaulted).toHaveLength(10);

      const maxLimit = await repo.listByTerminalStatusForTenant('tnt_H_LIM', 'approved', { limit: 100 });
      expect(maxLimit).toHaveLength(12);
    });

    it.each([
      ['zero', 0],
      ['above max', 101],
      ['negative', -1],
      ['non-integer', 1.5],
    ])('throws InvalidLimitError on limit=%s', async (_label, badLimit) => {
      await expect(
        repo.listByTerminalStatusForTenant('tnt_H_A', 'approved', { limit: badLimit as number }),
      ).rejects.toBeInstanceOf(InvalidLimitError);
    });

    it.each([
      ['negative', -1],
      ['fractional', 1.5],
    ])('throws InvalidOffsetError on %s offset', async (_label, badOffset) => {
      await expect(
        repo.listByTerminalStatusForTenant('tnt_H_A', 'approved', { offset: badOffset as number }),
      ).rejects.toBeInstanceOf(InvalidOffsetError);
    });

    it('countByTerminalStatusForTenant returns count for the given status only', async () => {
      await seedDecidedRow({ tenantId: 'tnt_H_CNT', id: 'apr_h_cnt_appr_1', decision: 'approved' });
      await seedDecidedRow({ tenantId: 'tnt_H_CNT', id: 'apr_h_cnt_appr_2', decision: 'approved' });
      await seedDecidedRow({ tenantId: 'tnt_H_CNT', id: 'apr_h_cnt_rej', decision: 'rejected' });

      expect(await repo.countByTerminalStatusForTenant('tnt_H_CNT', 'approved')).toBe(2);
      expect(await repo.countByTerminalStatusForTenant('tnt_H_CNT', 'rejected')).toBe(1);
    });

    it('does NOT apply TTL gate (decided rows are immutable; expires_at is informational)', async () => {
      // Seed a decided row whose expires_at is in the past — proves the
      // terminal-status query does not filter on expires_at the way the
      // pending query does. (The decide() CAS gate ensures terminal rows
      // were inside their TTL at the moment of decision; once decided, the
      // TTL no longer applies.)
      const decidedRow = makePendingRow({
        id: 'apr_h_ttl_past',
        tenantId: 'tnt_H_TTL',
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
      await repo.insertPending(decidedRow);
      // Need to decide BEFORE its expires_at — supply a decidedAt that
      // predates the expiry. The CAS gate (`expires_at > decidedAt`) will
      // then succeed and we end up with a terminal-status row whose
      // expires_at is in the past relative to NOW.
      const outcome = await repo.decide({
        tenantId: 'tnt_H_TTL',
        id: decidedRow.id,
        decidedByUserId: 'admin-1',
        decision: 'approved',
        decisionReason: null,
        decidedAt: '2019-12-31T23:59:59.000Z',
      });
      expect(outcome.outcome).toBe('updated');

      const rows = await repo.listByTerminalStatusForTenant('tnt_H_TTL', 'approved');
      expect(rows.map((r) => r.id)).toEqual(['apr_h_ttl_past']);
      expect(await repo.countByTerminalStatusForTenant('tnt_H_TTL', 'approved')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('decide CAS semantics', () => {
    it('returns updated outcome on first decide', async () => {
      const row = makePendingRow({ id: 'apr_dec_1', tenantId: 'tnt_DEC' });
      await repo.insertPending(row);

      const decidedAt = new Date('2026-05-18T13:00:00.000Z').toISOString();
      const outcome = await repo.decide({
        tenantId: 'tnt_DEC',
        id: row.id,
        decidedByUserId: 'admin-1',
        decision: 'approved',
        decisionReason: 'looks fine',
        decidedAt,
      });

      expect(outcome.outcome).toBe('updated');
      if (outcome.outcome !== 'updated') throw new Error('unreachable');
      expect(outcome.row.status).toBe('approved');
      expect(outcome.row.decidedAt).toBe(decidedAt);
      expect(outcome.row.decidedByUserId).toBe('admin-1');
      expect(outcome.row.decisionReason).toBe('looks fine');
    });

    it('returns already_decided outcome on second decide and preserves first decision', async () => {
      const row = makePendingRow({ id: 'apr_dec_2', tenantId: 'tnt_DEC' });
      await repo.insertPending(row);

      await repo.decide({
        tenantId: 'tnt_DEC',
        id: row.id,
        decidedByUserId: 'admin-1',
        decision: 'approved',
        decisionReason: 'first',
        decidedAt: new Date('2026-05-18T13:00:00.000Z').toISOString(),
      });

      const second = await repo.decide({
        tenantId: 'tnt_DEC',
        id: row.id,
        decidedByUserId: 'admin-2',
        decision: 'rejected',
        decisionReason: 'second',
        decidedAt: new Date('2026-05-18T14:00:00.000Z').toISOString(),
      });

      expect(second.outcome).toBe('already_decided');
      if (second.outcome !== 'already_decided') throw new Error('unreachable');
      // CAS guard: the first decision must still be intact.
      expect(second.row.status).toBe('approved');
      expect(second.row.decidedByUserId).toBe('admin-1');
      expect(second.row.decisionReason).toBe('first');
    });

    it('returns not_found when id is unknown or tenant mismatches', async () => {
      const unknown = await repo.decide({
        tenantId: 'tnt_DEC',
        id: 'apr_nope',
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: null,
        decidedAt: new Date().toISOString(),
      });
      expect(unknown.outcome).toBe('not_found');

      const row = makePendingRow({ id: 'apr_mismatch', tenantId: 'tnt_A' });
      await repo.insertPending(row);
      const wrongTenant = await repo.decide({
        tenantId: 'tnt_B',
        id: row.id,
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: null,
        decidedAt: new Date().toISOString(),
      });
      expect(wrongTenant.outcome).toBe('not_found');
    });

    it('serializes a concurrent decide race: exactly one updated, one already_decided', async () => {
      const row = makePendingRow({ id: 'apr_race_1', tenantId: 'tnt_RACE' });
      await repo.insertPending(row);

      const now = new Date('2026-05-18T15:00:00.000Z').toISOString();
      const [a, b] = await Promise.all([
        repo.decide({
          tenantId: 'tnt_RACE',
          id: row.id,
          decidedByUserId: 'admin-A',
          decision: 'approved',
          decisionReason: 'A',
          decidedAt: now,
        }),
        repo.decide({
          tenantId: 'tnt_RACE',
          id: row.id,
          decidedByUserId: 'admin-B',
          decision: 'rejected',
          decisionReason: 'B',
          decidedAt: now,
        }),
      ]);

      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(['already_decided', 'updated']);
    });

    // R3 / Codex 5.4 HIGH + Copilot R3 #1: decide must refuse expired rows.
    it("returns 'expired' outcome when the row is pending but past its TTL (TTL gate)", async () => {
      const past = '2020-01-01T00:00:00.000Z';
      const row = makePendingRow({ id: 'apr_dec_expired', tenantId: 'tnt_DEC_EXP', expiresAt: past });
      await repo.insertPending(row);

      const decidedAt = '2025-01-01T00:00:00.000Z'; // long after expiresAt
      const outcome = await repo.decide({
        tenantId: 'tnt_DEC_EXP',
        id: row.id,
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: 'too late',
        decidedAt,
      });
      expect(outcome.outcome).toBe('expired');
      if (outcome.outcome !== 'expired') throw new Error('unreachable');
      expect(outcome.row.status).toBe('pending'); // not transitioned
      expect(outcome.row.decidedAt).toBeNull();   // no write happened
      expect(outcome.row.decidedByUserId).toBeNull();
    });

    // R4 / Copilot R4: post-sweep expired rows must ALSO return 'expired'
    // (not 'already_decided') so the route layer maps to 410 consistently.
    it("returns 'expired' outcome when the row was already swept to status='expired' (post-sweep)", async () => {
      const past = '2020-01-01T00:00:00.000Z';
      const row = makePendingRow({
        id: 'apr_dec_post_sweep_expired',
        tenantId: 'tnt_DEC_EXP',
        expiresAt: past,
      });
      await repo.insertPending(row);
      // Run the sweeper so status becomes 'expired'.
      const swept = await repo.expireStale('2024-01-01T00:00:00.000Z');
      expect(swept).toBeGreaterThanOrEqual(1);

      const decidedAt = '2025-01-01T00:00:00.000Z';
      const outcome = await repo.decide({
        tenantId: 'tnt_DEC_EXP',
        id: row.id,
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: 'too late post-sweep',
        decidedAt,
      });
      expect(outcome.outcome).toBe('expired');
      if (outcome.outcome !== 'expired') throw new Error('unreachable');
      expect(outcome.row.status).toBe('expired'); // sweeper already transitioned it
    });
  });

  // -------------------------------------------------------------------------
  describe('claimForApply per-approval CAS', () => {
    it('first claim returns the row with applyIdempotencyKey set to the passed key (status=approved precondition)', async () => {
      const { tenantId, id } = await insertApproved(repo, { id: 'apr_claim_1', tenantId: 'tnt_CLM' });

      const claimed = await repo.claimForApply({
        tenantId,
        id,
        idempotencyKey: 'key-A',
      });
      expect(claimed).not.toBeNull();
      expect(claimed!.applyIdempotencyKey).toBe('key-A');
      expect(claimed!.applyStatus).toBe('claimed');
    });

    it('records apply_failed and allows one admin reset of the failed claim', async () => {
      const { tenantId, id } = await insertApproved(repo, { id: 'apr_claim_failed_reset', tenantId: 'tnt_CLM' });
      await repo.claimForApply({ tenantId, id, idempotencyKey: 'key-fail' });

      const failed = await repo.markApplyFailed({
        tenantId,
        id,
        error: 'connector down',
        failedAt: '2026-05-18T01:00:00.000Z',
      });

      expect(failed).not.toBeNull();
      expect(failed!.applyStatus).toBe('failed');
      expect(failed!.applyError).toBe('connector down');

      const reset = await repo.resetFailedApplyClaim({
        tenantId,
        id,
      });

      expect(reset.outcome).toBe('reset');
      if (reset.outcome !== 'reset') throw new Error('unreachable');
      expect(reset.row.applyIdempotencyKey).toBeNull();
      expect(reset.row.applyStatus).toBe('not_started');
      expect(reset.row.applyError).toBeNull();
    });

    it('resetFailedApplyClaim returns not_failed for a claimed row without a recorded failure', async () => {
      const { tenantId, id } = await insertApproved(repo, { id: 'apr_claim_not_failed', tenantId: 'tnt_CLM' });
      await repo.claimForApply({ tenantId, id, idempotencyKey: 'key-claimed' });

      const reset = await repo.resetFailedApplyClaim({ tenantId, id });

      expect(reset.outcome).toBe('not_failed');
    });

    it('second claim against the same id returns null even with a different key', async () => {
      const { tenantId, id } = await insertApproved(repo, { id: 'apr_claim_2', tenantId: 'tnt_CLM' });

      const first = await repo.claimForApply({
        tenantId,
        id,
        idempotencyKey: 'key-A',
      });
      expect(first).not.toBeNull();

      const second = await repo.claimForApply({
        tenantId,
        id,
        idempotencyKey: 'key-B-different',
      });
      expect(second).toBeNull();

      // The key from the first claim must remain in place — second claim is a no-op.
      const fetched = await repo.getById(tenantId, id);
      expect(fetched!.applyIdempotencyKey).toBe('key-A');
    });

    it('same key value succeeds against two different approval ids (NON-UNIQUE schema)', async () => {
      const r1 = await insertApproved(repo, { id: 'apr_claim_dupkey_1', tenantId: 'tnt_CLM' });
      const r2 = await insertApproved(repo, { id: 'apr_claim_dupkey_2', tenantId: 'tnt_CLM' });

      const c1 = await repo.claimForApply({
        tenantId: r1.tenantId,
        id: r1.id,
        idempotencyKey: 'shared-key',
      });
      const c2 = await repo.claimForApply({
        tenantId: r2.tenantId,
        id: r2.id,
        idempotencyKey: 'shared-key',
      });
      expect(c1).not.toBeNull();
      expect(c2).not.toBeNull();
      expect(c1!.applyIdempotencyKey).toBe('shared-key');
      expect(c2!.applyIdempotencyKey).toBe('shared-key');
    });

    it('serializes a concurrent claim race: exactly one row claimed, the other null', async () => {
      const { tenantId, id } = await insertApproved(repo, { id: 'apr_claim_race', tenantId: 'tnt_CLM' });

      const [a, b] = await Promise.all([
        repo.claimForApply({ tenantId, id, idempotencyKey: 'keyA' }),
        repo.claimForApply({ tenantId, id, idempotencyKey: 'keyB' }),
      ]);

      const winners = [a, b].filter((x) => x !== null);
      const losers = [a, b].filter((x) => x === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // Whichever key won is fine — the contract is only "exactly one wins".
      expect(['keyA', 'keyB']).toContain(winners[0]!.applyIdempotencyKey);
    });

    // R3 / Codex 5.4 MEDIUM: claimForApply must refuse non-approved rows.
    it('returns null when status=pending (Codex 5.4 MEDIUM gate)', async () => {
      const row = makePendingRow({ id: 'apr_claim_pending', tenantId: 'tnt_CLM_STATUS' });
      await repo.insertPending(row);
      // Row is pending — no decide() call.
      const claimed = await repo.claimForApply({
        tenantId: row.tenantId,
        id: row.id,
        idempotencyKey: 'key-pending',
      });
      expect(claimed).toBeNull();
      // applyIdempotencyKey must remain null (no write happened).
      const fetched = await repo.getById(row.tenantId, row.id);
      expect(fetched!.applyIdempotencyKey).toBeNull();
    });

    it('returns null when status=rejected (Codex 5.4 MEDIUM gate)', async () => {
      const row = makePendingRow({ id: 'apr_claim_rejected', tenantId: 'tnt_CLM_STATUS' });
      await repo.insertPending(row);
      await repo.decide({
        tenantId: row.tenantId,
        id: row.id,
        decidedByUserId: 'admin',
        decision: 'rejected',
        decisionReason: 'no',
        decidedAt: new Date('2026-05-18T00:30:00.000Z').toISOString(),
      });
      const claimed = await repo.claimForApply({
        tenantId: row.tenantId,
        id: row.id,
        idempotencyKey: 'key-rej',
      });
      expect(claimed).toBeNull();
    });

    it('returns null when status=expired (Codex 5.4 MEDIUM gate)', async () => {
      const past = '2020-01-01T00:00:00.000Z';
      const row = makePendingRow({
        id: 'apr_claim_expired',
        tenantId: 'tnt_CLM_STATUS',
        expiresAt: past,
      });
      await repo.insertPending(row);
      // Mark as expired via the sweeper.
      const swept = await repo.expireStale('2024-01-01T00:00:00.000Z');
      expect(swept).toBeGreaterThanOrEqual(1);
      const claimed = await repo.claimForApply({
        tenantId: row.tenantId,
        id: row.id,
        idempotencyKey: 'key-exp',
      });
      expect(claimed).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('expireStale', () => {
    it('transitions only pending rows whose expires_at <= now and leaves decided rows alone', async () => {
      const now = new Date('2026-05-18T20:00:00.000Z').toISOString();
      const past = new Date('2026-05-18T19:00:00.000Z').toISOString();
      const future = new Date('2026-05-18T21:00:00.000Z').toISOString();

      // Two stale pending rows.
      await repo.insertPending(
        makePendingRow({ id: 'apr_exp_stale1', tenantId: 'tnt_EXP', expiresAt: past }),
      );
      await repo.insertPending(
        makePendingRow({ id: 'apr_exp_stale2', tenantId: 'tnt_EXP', expiresAt: past }),
      );
      // A pending row that has not yet expired.
      await repo.insertPending(
        makePendingRow({ id: 'apr_exp_fresh', tenantId: 'tnt_EXP', expiresAt: future }),
      );
      // A decided row whose expires_at is in the past — must NOT be overwritten.
      const decidedStaleRow = makePendingRow({
        id: 'apr_exp_decided',
        tenantId: 'tnt_EXP',
        expiresAt: past,
      });
      await repo.insertPending(decidedStaleRow);
      // decidedAt must be BEFORE expiresAt or the new TTL gate (R3) will
      // refuse the transition and the row will stay pending — making
      // expireStale sweep it later. Use 18:30 so it's < the past expiresAt 19:00.
      await repo.decide({
        tenantId: 'tnt_EXP',
        id: decidedStaleRow.id,
        decidedByUserId: 'admin',
        decision: 'approved',
        decisionReason: null,
        decidedAt: new Date('2026-05-18T18:30:00.000Z').toISOString(),
      });

      const expiredCount = await repo.expireStale(now);
      expect(expiredCount).toBe(2);

      const stale1 = await repo.getById('tnt_EXP', 'apr_exp_stale1');
      const stale2 = await repo.getById('tnt_EXP', 'apr_exp_stale2');
      const fresh = await repo.getById('tnt_EXP', 'apr_exp_fresh');
      const decided = await repo.getById('tnt_EXP', 'apr_exp_decided');

      expect(stale1!.status).toBe('expired');
      expect(stale2!.status).toBe('expired');
      expect(fresh!.status).toBe('pending');
      // Decided row stays approved — expireStale's WHERE status='pending' guard protects it.
      expect(decided!.status).toBe('approved');
    });
  });

  // -------------------------------------------------------------------------
  // writeDescriptor round-trip (PR 13b Stage B — migration 050)
  // The describe block sets up a separate in-memory DB with BOTH migrations.
  // -------------------------------------------------------------------------
  describe('writeDescriptor round-trip (PR 13b migration 050)', () => {
    let db050: Kysely<Database>;
    let sqlite050: BetterSqlite3.Database;
    let repo050: ApprovalQueueRepository;

    beforeEach(async () => {
      const f = makeDb();
      db050 = f.db;
      sqlite050 = f.sqlite;
      // Run the approval-table migrations so writeDescriptor and apply lifecycle columns exist.
      await createGovernanceApprovals.run(db050, 'sqlite');
      await addWriteDescriptor.run(db050, 'sqlite');
      await addApplyLifecycle.run(db050, 'sqlite');
      repo050 = makeRepo(db050);
    });

    afterEach(async () => {
      await db050.destroy();
      sqlite050.close();
    });

    it('governance arm: insertPending persists writeDescriptor=null and getById returns null', async () => {
      const row = makePendingRow({
        id: 'apr_wd_null',
        tenantId: 'tnt_WD',
        writeDescriptor: null,
      });
      await repo050.insertPending(row);
      const persisted = await repo050.getById('tnt_WD', 'apr_wd_null');
      expect(persisted).not.toBeNull();
      expect(persisted!.writeDescriptor).toBeNull();
    });

    it('ownership arm: insertPending persists JSON writeDescriptor and getById returns it verbatim', async () => {
      const descriptor = JSON.stringify({
        targetSystemId: 'hubspot',
        operation: 'create',
        entityType: 'Contact',
        args: { firstName: 'Ada' },
        ownership: { entity: 'customer', declaredOwner: 'hubspot', callerSystem: 'netsuite', targetSystem: 'hubspot' },
      });

      const row = makePendingRow({
        id: 'apr_wd_json',
        tenantId: 'tnt_WD',
        operationType: 'ownership_write',
        writeDescriptor: descriptor,
      });
      await repo050.insertPending(row);
      const persisted = await repo050.getById('tnt_WD', 'apr_wd_json');
      expect(persisted).not.toBeNull();
      expect(persisted!.writeDescriptor).toBe(descriptor);
      // Confirm it round-trips to the original object.
      const parsed = JSON.parse(persisted!.writeDescriptor!);
      expect(parsed.ownership.declaredOwner).toBe('hubspot');
    });
  });
});
