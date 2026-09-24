import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'crypto';
import type { Database } from '../../database/types';
import { assertTenantStatus, type TenantStatus } from './TenantStatus';
import { TenantStatusConcurrencyError, TenantNotFoundError } from './TenantErrors';

export interface TenantRow {
  id: string;
  status: TenantStatus;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantStatusAuditRow {
  seq: number;
  id: string;
  tenantId: string;
  previousStatus: TenantStatus;
  newStatus: TenantStatus;
  actorUserId: string;
  actorSource: string;
  reason: string | null;
  occurredAt: string;
}

export interface UpdateStatusInput {
  tenantId: string;
  previousStatus: TenantStatus;
  newStatus: TenantStatus;
  actorUserId: string;
  actorSource: string;
  reason?: string;
}

export class TenantLifecycleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(tenantId: string): Promise<TenantRow | undefined> {
    const row = await this.db.selectFrom('tenants').selectAll().where('id', '=', tenantId).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id,
      status: assertTenantStatus(row.status, `tenants.status (id=${row.id})`),
      statusChangedAt: row.status_changed_at, statusChangedBy: row.status_changed_by,
      statusReason: row.status_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async ensureExists(tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    // INSERT ... ON CONFLICT DO NOTHING — preserves status if row already exists.
    // Works in SQLite 3.24+ and Postgres 9.5+.
    await sql`
      INSERT INTO tenants (id, status, created_at, updated_at)
      VALUES (${tenantId}, 'active', ${now}, ${now})
      ON CONFLICT(id) DO NOTHING
    `.execute(this.db);
  }

  async updateStatus(input: UpdateStatusInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable('tenants')
        .set({
          status: input.newStatus, status_changed_at: now,
          status_changed_by: input.actorUserId, status_reason: input.reason ?? null,
          updated_at: now,
        })
        .where('id', '=', input.tenantId)
        .where('status', '=', input.previousStatus)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        // 0 rows affected has two possible meanings:
        //   (a) row exists but status moved between read and write   → 409 race
        //   (b) row does not exist at all                             → 404
        // Disambiguate with a quick SELECT inside the tx so callers (and a
        // future direct-repo consumer that didn't pre-check) get a
        // distinguishable typed error. Service path always pre-checks via
        // peekStatus, so (b) is unreachable from the service today, but the
        // repository is a public class and we don't want to leak ambiguity.
        const exists = await trx.selectFrom('tenants')
          .select('id').where('id', '=', input.tenantId).executeTakeFirst();
        if (!exists) {
          throw new TenantNotFoundError(input.tenantId);
        }
        throw new TenantStatusConcurrencyError(input.tenantId, input.previousStatus);
      }
      await trx.insertInto('tenant_status_audit').values({
        id: randomUUID(), tenant_id: input.tenantId,
        previous_status: input.previousStatus, new_status: input.newStatus,
        actor_user_id: input.actorUserId, actor_source: input.actorSource,
        reason: input.reason ?? null, occurred_at: now,
      }).execute();
    });
  }

  // Audit-only insert used by the service when a side-effect (e.g. token
  // revocation) failed after the primary status flip already committed.
  // No state change on the tenants table; just records that "something
  // happened" against this tenant.
  async recordAuditOnly(input: UpdateStatusInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insertInto('tenant_status_audit').values({
      id: randomUUID(), tenant_id: input.tenantId,
      previous_status: input.previousStatus, new_status: input.newStatus,
      actor_user_id: input.actorUserId, actor_source: input.actorSource,
      reason: input.reason ?? null, occurred_at: now,
    }).execute();
  }

  async listAudit(tenantId: string, limit = 100): Promise<TenantStatusAuditRow[]> {
    const rows = await this.db.selectFrom('tenant_status_audit')
      .selectAll().where('tenant_id', '=', tenantId)
      .orderBy('seq', 'desc').limit(limit).execute();
    return rows.map((r) => ({
      // On Postgres `seq` is BIGINT and node-postgres returns it as a string
      // (or BigInt) by default; on SQLite it's a JS number. Coerce to Number
      // here so consumers (tests doing `a.seq > b.seq`, JSON responses) get
      // a stable JS-number shape. Audit table rows grow at <1/sec under
      // normal operator activity, so the 2^53 precision ceiling (~9e15) is
      // never realistically reached.
      seq: typeof r.seq === 'number' ? r.seq : Number(r.seq),
      id: r.id, tenantId: r.tenant_id,
      previousStatus: assertTenantStatus(
        r.previous_status, `tenant_status_audit.previous_status (id=${r.id})`,
      ),
      newStatus: assertTenantStatus(
        r.new_status, `tenant_status_audit.new_status (id=${r.id})`,
      ),
      actorUserId: r.actor_user_id, actorSource: r.actor_source,
      reason: r.reason, occurredAt: r.occurred_at,
    }));
  }
}
