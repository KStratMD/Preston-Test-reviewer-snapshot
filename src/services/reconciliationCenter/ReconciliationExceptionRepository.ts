import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import type {
  NewReconciliationException,
  ReconciliationExceptionStatus,
  ReconciliationExceptionView,
} from './ReconciliationCenterTypes';

export interface ListExceptionsInput {
  tenantId: string;
  status?: ReconciliationExceptionStatus;
}

export interface UpdateStatusInput {
  tenantId: string;
  exceptionId: string;
  status: ReconciliationExceptionStatus;
  actorUserId: string;
  resolutionNote?: string | null;
}

export interface ExistsOpenExceptionInput {
  tenantId: string;
  sourceSystem: string;
  targetSystem: string;
  sourceRecordId: string;
  exceptionType: string;
}

/**
 * Thrown when {@link ReconciliationExceptionRepository.updateStatus} finds no
 * matching row (either the id does not exist or it belongs to a different
 * tenant). Routes map this to a 404 so silent success doesn't mask operator
 * errors.
 */
export class ReconciliationExceptionNotFoundError extends Error {
  readonly tenantId: string;
  readonly exceptionId: string;
  constructor(tenantId: string, exceptionId: string) {
    super(`reconciliation exception not found: tenantId=${tenantId} id=${exceptionId}`);
    this.name = 'ReconciliationExceptionNotFoundError';
    this.tenantId = tenantId;
    this.exceptionId = exceptionId;
  }
}

@injectable()
export class ReconciliationExceptionRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) dbService: DatabaseService) {
    this.db = dbService.getDatabase();
  }

  async createException(input: NewReconciliationException): Promise<string> {
    const now = new Date().toISOString();
    const id = `rex_${randomUUID()}`;
    await this.db.insertInto('reconciliation_exceptions').values({
      id,
      tenant_id: input.tenantId,
      source_system: input.sourceSystem,
      target_system: input.targetSystem,
      source_record_id: input.sourceRecordId,
      target_record_id: input.targetRecordId ?? null,
      exception_type: input.exceptionType,
      severity: input.severity,
      status: 'open',
      amount_delta: input.amountDelta ?? null,
      currency: input.currency ?? null,
      description: input.description,
      suggested_action: input.suggestedAction,
      assigned_to: input.assignedTo ?? null,
      due_at: input.dueAt ?? null,
      resolved_at: null,
      resolution_note: null,
      resolved_by: null,
      created_at: now,
      updated_at: now,
    }).execute();
    return id;
  }

  async listExceptions(input: ListExceptionsInput): Promise<ReconciliationExceptionView[]> {
    let query = this.db
      .selectFrom('reconciliation_exceptions')
      .selectAll()
      .where('tenant_id', '=', input.tenantId);
    if (input.status) {
      query = query.where('status', '=', input.status);
    }
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      sourceSystem: r.source_system,
      targetSystem: r.target_system,
      sourceRecordId: r.source_record_id,
      targetRecordId: r.target_record_id,
      exceptionType: r.exception_type,
      severity: r.severity,
      status: r.status,
      // Postgres returns NUMERIC as strings via node-postgres; coerce to number
      // so the API contract is stable across sqlite (which already returns
      // numbers for REAL) and postgres. Mirrors CostTransparencyRepository's
      // Number(r.total_cost_usd) mapping.
      amountDelta: r.amount_delta == null ? null : Number(r.amount_delta),
      currency: r.currency,
      description: r.description,
      suggestedAction: r.suggested_action,
      assignedTo: r.assigned_to,
      dueAt: r.due_at,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
      resolvedBy: r.resolved_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async updateStatus(input: UpdateStatusInput): Promise<void> {
    const now = new Date().toISOString();
    const isResolution = input.status === 'resolved';
    const result = await this.db
      .updateTable('reconciliation_exceptions')
      .set({
        status: input.status,
        resolved_at: isResolution ? now : null,
        resolution_note: input.resolutionNote ?? null,
        resolved_by: isResolution ? input.actorUserId : null,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.exceptionId)
      .executeTakeFirst();
    // `numUpdatedRows` is typed as bigint in Kysely but the runtime value
    // varies by dialect/driver (bigint on postgres pg-driver, number on
    // better-sqlite3, occasionally string-shaped). Normalize via Number() so
    // the missing/cross-tenant path consistently throws across all dialects.
    // If no row was touched the id either does not exist or belongs to
    // another tenant — either way the right signal is 404, not silent 204.
    if (Number(result.numUpdatedRows ?? 0n) === 0) {
      throw new ReconciliationExceptionNotFoundError(input.tenantId, input.exceptionId);
    }
  }

  /**
   * True when an OPEN exception already exists for the coalescing key
   * (tenant, source, target, sourceRecordId, exceptionType). The cadence
   * dispatch uses this to avoid re-creating the same open exception on every
   * tick. Resolved/dismissed prior exceptions do NOT suppress a fresh open one.
   */
  async existsOpenException(input: ExistsOpenExceptionInput): Promise<boolean> {
    const row = await this.db
      .selectFrom('reconciliation_exceptions')
      .select('id')
      .where('tenant_id', '=', input.tenantId)
      .where('source_system', '=', input.sourceSystem)
      .where('target_system', '=', input.targetSystem)
      .where('source_record_id', '=', input.sourceRecordId)
      .where('exception_type', '=', input.exceptionType)
      .where('status', '=', 'open')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}
