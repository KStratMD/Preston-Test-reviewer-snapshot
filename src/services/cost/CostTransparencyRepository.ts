import { injectable, inject } from 'inversify';
import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import { SYSTEM_IDENTITY } from '../governance/identityContext';

export interface DailyRollupInput {
  tenantId: string;
  provider: string;
  dateUtc: string; // 'YYYY-MM-DD'
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface PerFlowRollupInput {
  tenantId: string;
  flowName: string;
  dateUtc: string;
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface DailyRollupRow {
  tenantId: string;
  provider: string;
  dateUtc: string;
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface PerFlowRollupRow {
  tenantId: string;
  flowName: string;
  dateUtc: string;
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface ProviderBucket {
  provider: string;
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface FlowBucket {
  flowName: string;
  totalCostUsd: number;
  measuredCount: number;
  estimatedCount: number;
}

export interface DateRange {
  startUtc: string;
  endUtc: string;
}

@injectable()
export class CostTransparencyRepository {
  private readonly db: Kysely<Database>;
  private readonly dbType: 'sqlite' | 'postgres';

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
    this.dbType = databaseService.getDbType();
  }

  async upsertDailyRollup(row: DailyRollupInput): Promise<void> {
    await sql`
      INSERT INTO cost_rollup_daily (id, tenant_id, provider, date_utc, total_cost_usd, measured_count, estimated_count)
      VALUES (${randomUUID()}, ${row.tenantId}, ${row.provider}, ${row.dateUtc}, ${row.totalCostUsd}, ${row.measuredCount}, ${row.estimatedCount})
      ON CONFLICT(tenant_id, provider, date_utc) DO UPDATE SET
        total_cost_usd = excluded.total_cost_usd,
        measured_count = excluded.measured_count,
        estimated_count = excluded.estimated_count
    `.execute(this.db);
  }

  async upsertPerFlowRollup(row: PerFlowRollupInput): Promise<void> {
    await sql`
      INSERT INTO cost_rollup_per_flow (id, tenant_id, flow_name, date_utc, total_cost_usd, measured_count, estimated_count)
      VALUES (${randomUUID()}, ${row.tenantId}, ${row.flowName}, ${row.dateUtc}, ${row.totalCostUsd}, ${row.measuredCount}, ${row.estimatedCount})
      ON CONFLICT(tenant_id, flow_name, date_utc) DO UPDATE SET
        total_cost_usd = excluded.total_cost_usd,
        measured_count = excluded.measured_count,
        estimated_count = excluded.estimated_count
    `.execute(this.db);
  }

  async getDailyRollups(tenantId: string, range: DateRange): Promise<DailyRollupRow[]> {
    const rows = await this.db.selectFrom('cost_rollup_daily')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('date_utc', '>=', range.startUtc)
      .where('date_utc', '<=', range.endUtc)
      .orderBy('date_utc', 'desc')
      .execute();
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      provider: r.provider,
      dateUtc: r.date_utc,
      totalCostUsd: Number(r.total_cost_usd),
      measuredCount: r.measured_count,
      estimatedCount: r.estimated_count,
    }));
  }

  async getPerFlowRollups(tenantId: string, range: DateRange): Promise<PerFlowRollupRow[]> {
    const rows = await this.db.selectFrom('cost_rollup_per_flow')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('date_utc', '>=', range.startUtc)
      .where('date_utc', '<=', range.endUtc)
      .orderBy('date_utc', 'desc')
      .execute();
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      flowName: r.flow_name,
      dateUtc: r.date_utc,
      totalCostUsd: Number(r.total_cost_usd),
      measuredCount: r.measured_count,
      estimatedCount: r.estimated_count,
    }));
  }

  /**
   * Returns day-boundary strings compatible with both SQLite and Postgres.
   *
   * SQLite stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' (space separator).
   * ISO-8601 with 'T' separator (e.g. '2026-05-22T00:00:00.000Z') sorts
   * AFTER space-formatted rows in a lexicographic comparison because 'T' (0x54)
   * > ' ' (0x20), which would silently exclude production rows from rollups.
   *
   * The space-separator format is accepted by Postgres for timestamp comparisons,
   * so this format works on both dialects.
   */
  private dayBoundaries(dateUtc: string): { startOfDay: string; startOfNextDay: string } {
    const next = new Date(`${dateUtc}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const startOfDay = `${dateUtc} 00:00:00`;
    const startOfNextDay = `${next.toISOString().slice(0, 10)} 00:00:00`;
    return { startOfDay, startOfNextDay };
  }

  async getRawUsageForDate(tenantId: string, dateUtc: string): Promise<ProviderBucket[]> {
    const { startOfDay, startOfNextDay } = this.dayBoundaries(dateUtc);

    const rows = await sql<{
      provider_type: string;
      total_cost: number;
      measured_count: number;
      estimated_count: number;
    }>`
      SELECT
        provider_type,
        SUM(estimated_cost)                                                  AS total_cost,
        SUM(CASE WHEN cost_source = 'measured'  THEN 1 ELSE 0 END)           AS measured_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END)           AS estimated_count
      FROM ai_usage_logs
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${startOfDay}
        AND created_at <  ${startOfNextDay}
      GROUP BY provider_type
    `.execute(this.db);

    return rows.rows.map((r) => ({
      provider: r.provider_type,
      totalCostUsd: Number(r.total_cost),
      measuredCount: Number(r.measured_count),
      estimatedCount: Number(r.estimated_count),
    }));
  }

  async getRawFlowUsageForDate(tenantId: string, dateUtc: string): Promise<FlowBucket[]> {
    const { startOfDay, startOfNextDay } = this.dayBoundaries(dateUtc);

    const rows = await sql<{
      task_type: string;
      total_cost: number;
      measured_count: number;
      estimated_count: number;
    }>`
      SELECT
        task_type,
        SUM(estimated_cost)                                                  AS total_cost,
        SUM(CASE WHEN cost_source = 'measured'  THEN 1 ELSE 0 END)           AS measured_count,
        SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END)           AS estimated_count
      FROM ai_usage_logs
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${startOfDay}
        AND created_at <  ${startOfNextDay}
      GROUP BY task_type
    `.execute(this.db);

    return rows.rows.map((r) => ({
      flowName: r.task_type,
      totalCostUsd: Number(r.total_cost),
      measuredCount: Number(r.measured_count),
      estimatedCount: Number(r.estimated_count),
    }));
  }

  async listActiveTenants(withinDays: number): Promise<string[]> {
    const cutoffExpr = this.dbType === 'sqlite'
      ? sql`DATETIME('now', ${'-' + withinDays + ' days'})`
      : sql`NOW() - (${withinDays} * INTERVAL '1 day')`;

    const rows = await sql<{ tenant_id: string }>`
      SELECT DISTINCT tenant_id
      FROM ai_usage_logs
      WHERE created_at >= ${cutoffExpr}
        AND tenant_id <> '__legacy_unattributed__'
        AND tenant_id <> ${SYSTEM_IDENTITY.tenantId}
    `.execute(this.db);
    return rows.rows.map((r) => r.tenant_id);
  }
}
