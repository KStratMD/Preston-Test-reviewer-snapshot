// tests/integration/costTransparency.fixture.test.ts
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS } from '../../src/database/migrations';
import type { Database } from '../../src/database/types';
import { CostTransparencyRepository } from '../../src/services/cost/CostTransparencyRepository';
import { CostTransparencyService } from '../../src/services/cost/CostTransparencyService';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function seedUsage(
  db: Kysely<Database>,
  rows: Array<{
    tenantId: string;
    provider: string;
    flow: string;
    model: string;
    source: 'measured' | 'estimated';
    cost: number;
    createdAt: Date;
  }>,
) {
  for (const r of rows) {
    await db
      .insertInto('ai_usage_logs')
      .values({
        user_id: 1,
        tenant_id: r.tenantId,
        provider_type: r.provider,
        cost_source: r.source,
        model_version: r.model,
        task_type: r.flow,
        request_type: 'sync',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 1,
        estimated_cost: r.cost,
        success: 1,
        execution_time_ms: 0,
        records_processed: 0,
        fields_analyzed: 0,
        created_at: r.createdAt.toISOString() as unknown as Date,
      } as any)
      .execute();
  }
}

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

describe('CostTransparency 6-scenario integration', () => {
  let db: Kysely<Database>;
  let repo: CostTransparencyRepository;
  let svc: CostTransparencyService;

  beforeEach(async () => {
    db = makeDb();
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    repo = new CostTransparencyRepository({ getDatabase: () => db, getDbType: () => 'sqlite' } as any);
    svc = new CostTransparencyService(logger, repo);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('scenario 1: all-measured single provider', async () => {
    await seedUsage(db, [
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 0.10, createdAt: new Date('2026-05-22T10:00:00Z') },
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 0.20, createdAt: new Date('2026-05-22T11:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');
    const rollup = await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(rollup).toHaveLength(1);
    expect(rollup[0].measuredCount).toBe(2);
    expect(rollup[0].estimatedCount).toBe(0);
    expect(rollup[0].totalCostUsd).toBeCloseTo(0.30, 6);
  });

  it('scenario 2: all-estimated single provider (LMStudio)', async () => {
    await seedUsage(db, [
      { tenantId: 't1', provider: 'lmstudio', flow: 'mapping', model: 'lmstudio/local', source: 'estimated', cost: 0, createdAt: new Date('2026-05-22T10:00:00Z') },
      { tenantId: 't1', provider: 'lmstudio', flow: 'mapping', model: 'lmstudio/local', source: 'estimated', cost: 0, createdAt: new Date('2026-05-22T11:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');
    const r = (await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' }))[0];
    expect(r.measuredCount).toBe(0);
    expect(r.estimatedCount).toBe(2);
    expect(CostTransparencyService.formatSourceLabel(r.measuredCount, r.estimatedCount)).toBe('estimated');
  });

  it('scenario 3: mixed measured + estimated → mixed label with counts', async () => {
    await seedUsage(db, [
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured',  cost: 0.10, createdAt: new Date('2026-05-22T10:00:00Z') },
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'estimated', cost: 0.05, createdAt: new Date('2026-05-22T11:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');
    const r = (await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' }))[0];
    expect(CostTransparencyService.formatSourceLabel(r.measuredCount, r.estimatedCount))
      .toBe('mixed (1 measured, 1 estimated)');
  });

  it('scenario 4: multiple providers → one rollup row per provider', async () => {
    await seedUsage(db, [
      { tenantId: 't1', provider: 'openai',    flow: 'mapping', model: 'gpt-4o',            source: 'measured', cost: 0.10, createdAt: new Date('2026-05-22T10:00:00Z') },
      { tenantId: 't1', provider: 'anthropic', flow: 'mapping', model: 'claude-3-5-sonnet', source: 'measured', cost: 0.20, createdAt: new Date('2026-05-22T11:00:00Z') },
      { tenantId: 't1', provider: 'openrouter', flow: 'mapping', model: 'openrouter/auto',  source: 'measured', cost: 0.05, createdAt: new Date('2026-05-22T12:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');
    const rollup = await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(rollup.map((r) => r.provider).sort()).toEqual(['anthropic', 'openai', 'openrouter']);
  });

  it('scenario 5: tenant isolation — t2 cannot see t1 rollups', async () => {
    await seedUsage(db, [
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 99,   createdAt: new Date('2026-05-22T10:00:00Z') },
      { tenantId: 't2', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 0.01, createdAt: new Date('2026-05-22T10:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');
    await svc.rollupDay('t2', '2026-05-22');

    const t1 = await repo.getDailyRollups('t1', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    const t2 = await repo.getDailyRollups('t2', { startUtc: '2026-05-22', endUtc: '2026-05-22' });
    expect(t1[0].totalCostUsd).toBeCloseTo(99, 2);
    expect(t2[0].totalCostUsd).toBeCloseTo(0.01, 2);
  });

  it('scenario 6: anomaly trigger when day > 3× 7d avg AND > $1', async () => {
    // Seed today + 7 prior days = 8 days total (matches MIN_HISTORY_FOR_ANOMALY = 8).
    // Prior 7 days at $0.50/day → average = $0.50; 3× = $1.50.
    // Today at $5.00: $5 > $1.50 AND $5 > $1.00 floor → anomaly.

    // Seed and roll up the 7 prior days so they appear in cost_rollup_daily.
    for (let i = 7; i >= 1; i--) {
      const d = new Date('2026-05-22T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      await seedUsage(db, [
        { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 0.50, createdAt: d },
      ]);
      await svc.rollupDay('t1', d.toISOString().slice(0, 10));
    }

    // Seed and roll up today.
    await seedUsage(db, [
      { tenantId: 't1', provider: 'openai', flow: 'mapping', model: 'gpt-4o', source: 'measured', cost: 5.00, createdAt: new Date('2026-05-22T10:00:00Z') },
    ]);
    await svc.rollupDay('t1', '2026-05-22');

    // Pin Date.now() so getDashboard resolves endUtc to '2026-05-22' deterministically.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-22T12:00:00Z'));
    try {
      const dash = await svc.getDashboard('t1');
      expect(dash.anomalyDetected).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
