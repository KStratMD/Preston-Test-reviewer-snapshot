import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { CostTransparencyRepository } from '../../../../src/services/cost/CostTransparencyRepository';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>) {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

describe('CostTransparencyRepository', () => {
  let db: Kysely<Database>;
  let repo: CostTransparencyRepository;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
    repo = new CostTransparencyRepository({ getDatabase: () => db, getDbType: () => 'sqlite' } as any);
  });

  afterEach(async () => { await db.destroy(); });

  it('upserts a daily rollup idempotently on (tenant, provider, date)', async () => {
    await repo.upsertDailyRollup({
      tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22',
      totalCostUsd: 1.50, measuredCount: 5, estimatedCount: 2,
    });
    await repo.upsertDailyRollup({
      tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22',
      totalCostUsd: 2.00, measuredCount: 10, estimatedCount: 0,
    });

    const rows = await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalCostUsd).toBe(2.00);
    expect(rows[0].measuredCount).toBe(10);
  });

  it('isolates tenants on read', async () => {
    await repo.upsertDailyRollup({ tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22', totalCostUsd: 1, measuredCount: 1, estimatedCount: 0 });
    await repo.upsertDailyRollup({ tenantId: 't2', provider: 'openai', dateUtc: '2026-05-22', totalCostUsd: 99, measuredCount: 1, estimatedCount: 0 });

    const t1 = await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(t1).toHaveLength(1);
    expect(t1[0].totalCostUsd).toBe(1);
  });

  it('aggregates raw usage by provider and source on a given date', async () => {
    await db.insertInto('ai_usage_logs').values([
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'measured',  model_version: 'gpt-4o', task_type: 'mapping', request_type: 'sync', total_tokens: 100, estimated_cost: 0.50, created_at: '2026-05-22T10:00:00.000Z' as unknown as Date } as any,
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'estimated', model_version: 'gpt-4o', task_type: 'mapping', request_type: 'sync', total_tokens: 50,  estimated_cost: 0.25, created_at: '2026-05-22T11:00:00.000Z' as unknown as Date } as any,
      { user_id: 1, tenant_id: 't1', provider_type: 'anthropic', cost_source: 'measured', model_version: 'claude-3-5-sonnet', task_type: 'mapping', request_type: 'sync', total_tokens: 200, estimated_cost: 1.00, created_at: '2026-05-22T12:00:00.000Z' as unknown as Date } as any,
    ]).execute();

    const buckets = await repo.getRawUsageForDate('t1', '2026-05-22');
    expect(buckets).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai',    totalCostUsd: 0.75, measuredCount: 1, estimatedCount: 1 }),
      expect.objectContaining({ provider: 'anthropic', totalCostUsd: 1.00, measuredCount: 1, estimatedCount: 0 }),
    ]));
  });

  it('aggregates raw flow usage and round-trips through upsertPerFlowRollup + getPerFlowRollups', async () => {
    await db.insertInto('ai_usage_logs').values([
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'measured',  model_version: 'gpt-4o', task_type: 'mapping',           request_type: 'sync', total_tokens: 100, estimated_cost: 0.40, created_at: '2026-05-22T10:00:00.000Z' as unknown as Date } as any,
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'estimated', model_version: 'gpt-4o', task_type: 'mapping',           request_type: 'sync', total_tokens: 50,  estimated_cost: 0.20, created_at: '2026-05-22T11:00:00.000Z' as unknown as Date } as any,
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'measured',  model_version: 'gpt-4o', task_type: 'sync-error-assist', request_type: 'sync', total_tokens: 200, estimated_cost: 0.80, created_at: '2026-05-22T12:00:00.000Z' as unknown as Date } as any,
    ]).execute();

    const flowBuckets = await repo.getRawFlowUsageForDate('t1', '2026-05-22');
    expect(flowBuckets).toHaveLength(2);
    const mapping = flowBuckets.find((b) => b.flowName === 'mapping')!;
    const sea    = flowBuckets.find((b) => b.flowName === 'sync-error-assist')!;
    expect(mapping.totalCostUsd).toBeCloseTo(0.60, 9);
    expect(mapping.measuredCount).toBe(1);
    expect(mapping.estimatedCount).toBe(1);
    expect(sea.totalCostUsd).toBeCloseTo(0.80, 9);
    expect(sea.measuredCount).toBe(1);
    expect(sea.estimatedCount).toBe(0);

    // Round-trip a per-flow rollup: second upsert should overwrite
    await repo.upsertPerFlowRollup({ tenantId: 't1', flowName: 'mapping', dateUtc: '2026-05-22', totalCostUsd: 0.60, measuredCount: 1, estimatedCount: 1 });
    await repo.upsertPerFlowRollup({ tenantId: 't1', flowName: 'mapping', dateUtc: '2026-05-22', totalCostUsd: 0.75, measuredCount: 2, estimatedCount: 1 });

    const stored = await repo.getPerFlowRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ flowName: 'mapping', totalCostUsd: 0.75, measuredCount: 2, estimatedCount: 1 });
  });

  it('matches rows whose created_at uses SQLite CURRENT_TIMESTAMP format (space separator)', async () => {
    await db.insertInto('ai_usage_logs').values([
      {
        user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'measured',
        model_version: 'gpt-4o', task_type: 'mapping', request_type: 'sync',
        total_tokens: 1, estimated_cost: 0.50,
        created_at: '2026-05-22 10:00:00' as unknown as Date,
      } as any,
    ]).execute();
    const buckets = await repo.getRawUsageForDate('t1', '2026-05-22');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalCostUsd).toBe(0.50);
  });

  it('listActiveTenants returns distinct tenants from recent usage, skipping __legacy_unattributed__ and __system__', async () => {
    const nowIso = new Date().toISOString();
    await db.insertInto('ai_usage_logs').values([
      { user_id: 1, tenant_id: 't1', provider_type: 'openai', cost_source: 'measured',  model_version: 'gpt-4o', task_type: 'm', request_type: 's', total_tokens: 1, estimated_cost: 0, created_at: nowIso as any } as any,
      { user_id: 1, tenant_id: 't2', provider_type: 'openai', cost_source: 'estimated', model_version: 'gpt-4o', task_type: 'm', request_type: 's', total_tokens: 1, estimated_cost: 0, created_at: nowIso as any } as any,
      { user_id: 1, tenant_id: '__legacy_unattributed__', provider_type: 'openai', cost_source: 'measured', model_version: 'gpt-4o', task_type: 'm', request_type: 's', total_tokens: 1, estimated_cost: 0, created_at: nowIso as any } as any,
      { user_id: 1, tenant_id: '__system__', provider_type: 'openai', cost_source: 'measured', model_version: 'gpt-4o', task_type: 'm', request_type: 's', total_tokens: 1, estimated_cost: 0, created_at: nowIso as any } as any,
    ]).execute();
    const tenants = await repo.listActiveTenants(30);
    expect(tenants.sort()).toEqual(['t1', 't2']);
  });
});
