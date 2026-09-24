import { sql } from 'kysely';
import { Logger } from '../../../src/utils/Logger';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { MIGRATIONS } from '../../../src/database/migrations';

function buildLogger(): Logger {
  return new Logger('postgres-migrations-smoke');
}

/**
 * P5(b) smoke test: schema path.
 *
 * Asserts all MIGRATIONS modules apply cleanly to a fresh Postgres database
 * and a spot-check column is present. DatabaseService.initialize() auto-runs
 * the migration runner; we read back the `migrations` log table to confirm
 * every module recorded a row.
 *
 * Independent of P5(a) connection and P5(c) FOR UPDATE — this test fails
 * only when a migration's SQL is incompatible with Postgres.
 */
describe('postgres migrations smoke (P5b)', () => {
  let db: DatabaseService;

  beforeAll(async () => {
    db = new DatabaseService(buildLogger());
    await db.initialize(); // runs MigrationRunner.runAll() internally
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('records one log row per MIGRATIONS module', async () => {
    const k = db.getDatabase();
    const result = await sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM migrations`.execute(k);
    // Postgres COUNT returns bigint; cast to text in SQL to avoid JS BigInt vs number coercion.
    expect(Number(result.rows[0].count)).toBe(MIGRATIONS.length);
  });

  it('applied every named migration', async () => {
    const k = db.getDatabase();
    const result = await sql<{ name: string }>`SELECT name FROM migrations ORDER BY name`.execute(k);
    const recordedNames = result.rows.map((r) => r.name).sort();
    const expectedNames = MIGRATIONS.map((m) => m.name).sort();
    expect(recordedNames).toEqual(expectedNames);
  });

  it('produced workflow_central_tasks.tenant_id column (PR-OP-2, migration 041)', async () => {
    const k = db.getDatabase();
    const result = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'workflow_central_tasks'
        AND column_name = 'tenant_id'
    `.execute(k);
    expect(result.rows).toHaveLength(1);
  });

  /**
   * A8 migration 062. The unit suite proves this partial unique index on
   * SQLite; the ENGINE decides whether a predicate-restricted unique index
   * behaves as intended, so the dedupe domain is asserted here against real
   * Postgres rather than inferred from the other engine.
   */
  describe('governance_approvals.request_fingerprint dedupe domain (migration 062)', () => {
    // Monotonic, not merely random: two ids drawn from the same source can
    // collide, and here a collision would make the "different tenant" insert
    // re-enter the unique-index domain and fail the test for a reason that has
    // nothing to do with the index (Copilot R7).
    let seq = 0;
    const suffix = (): string => {
      seq += 1;
      return `${seq}-${Math.random().toString(36).slice(2, 10)}`;
    };

    async function insert(
      k: ReturnType<DatabaseService['getDatabase']>,
      o: { id: string; tenantId: string; status?: string; operationType?: string; fingerprint?: string | null },
    ): Promise<void> {
      await sql`
        INSERT INTO governance_approvals
          (id, tenant_id, requester_user_id, operation_type, resource_type, resource_id,
           risk_level, redacted_payload, policy_findings, status, created_at, expires_at,
           request_fingerprint)
        VALUES
          (${o.id}, ${o.tenantId}, ${'user-1'}, ${o.operationType ?? 'ownership_write'},
           ${'contacts'}, ${'new'}, ${'medium'}, ${'{}'}, ${'[]'},
           ${o.status ?? 'pending'}, NOW(), NOW() + INTERVAL '1 day',
           ${o.fingerprint === undefined ? 'a'.repeat(64) : o.fingerprint})
      `.execute(k);
    }

    it('rejects a duplicate pending ownership fingerprint, and only in that domain', async () => {
      const k = db.getDatabase();
      // Structurally distinct prefixes, so these two can never be the same id
      // even before the counter is considered.
      const tenant = `t-${suffix()}`;
      const other = `o-${suffix()}`;
      const fp = 'a'.repeat(64);

      await insert(k, { id: `p1-${suffix()}`, tenantId: tenant, fingerprint: fp });

      // Same tenant + fingerprint + pending + ownership -> blocked.
      let conflict: unknown = null;
      try {
        await insert(k, { id: `p2-${suffix()}`, tenantId: tenant, fingerprint: fp });
      } catch (e) {
        conflict = e;
      }
      expect(String(conflict)).toMatch(/uq_governance_approvals_pending_ownership_fingerprint|duplicate key/i);

      // Everything just outside the domain is still permitted.
      await insert(k, { id: `p3-${suffix()}`, tenantId: other, fingerprint: fp });
      await insert(k, { id: `p4-${suffix()}`, tenantId: tenant, fingerprint: fp, status: 'approved' });
      await insert(k, { id: `p5-${suffix()}`, tenantId: tenant, fingerprint: fp, operationType: 'ai_call' });
      await insert(k, { id: `p6-${suffix()}`, tenantId: tenant, fingerprint: null });
      await insert(k, { id: `p7-${suffix()}`, tenantId: tenant, fingerprint: null });

      const count = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM governance_approvals WHERE tenant_id IN (${tenant}, ${other})
      `.execute(k);
      expect(Number(count.rows[0].count)).toBe(6);
    });

    it('frees the fingerprint once the blocking row leaves pending', async () => {
      const k = db.getDatabase();
      const tenant = `t-${suffix()}`;
      const fp = 'c'.repeat(64);
      const blockerId = `b1-${suffix()}`;

      await insert(k, { id: blockerId, tenantId: tenant, fingerprint: fp });
      await sql`UPDATE governance_approvals SET status = 'expired' WHERE id = ${blockerId}`.execute(k);
      await insert(k, { id: `b2-${suffix()}`, tenantId: tenant, fingerprint: fp });

      const count = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM governance_approvals WHERE tenant_id = ${tenant}
      `.execute(k);
      expect(Number(count.rows[0].count)).toBe(2);
    });
  });

  /**
   * A9 migration 063. Same reasoning as the fingerprint index above, and
   * asserted on the real engine for the same reason: Postgres decides whether a
   * predicate-restricted unique index and a CHECK constraint behave as
   * intended, and the SQLite suite cannot answer that for it.
   */
  describe('serialized_asset_retry_operations single-active rule (migration 063)', () => {
    let seq = 0;
    const suffix = (): string => {
      seq += 1;
      return `${seq}-${Math.random().toString(36).slice(2, 10)}`;
    };

    it('permits one active forced retry per tenant+configuration, and closes the status vocabulary', async () => {
      const k = db.getDatabase();
      const tenantId = `t-${suffix()}`;
      const configId = `c-${suffix()}`;

      const insertOp = (id: string, status: string, cfg = configId, tnt = tenantId) => sql`
        INSERT INTO serialized_asset_retry_operations
          (id, tenant_id, configuration_id, requester_user_id, correlation_id, status, created_at)
        VALUES (${id}, ${tnt}, ${cfg}, ${'user-1'}, ${'corr-1'}, ${status}, NOW())
      `.execute(k);

      await insertOp(`op-${suffix()}`, 'accepted');

      // A second live operation for the same configuration is refused —
      // parallel forced retries would race against one backlog.
      let conflict: unknown = null;
      try {
        await insertOp(`op-${suffix()}`, 'running');
      } catch (e) {
        conflict = e;
      }
      expect(String(conflict)).toMatch(/uq_serialized_asset_retry_active|duplicate key/i);

      // Everything outside the active predicate is permitted.
      await insertOp(`op-${suffix()}`, 'accepted', `c-${suffix()}`);
      await insertOp(`op-${suffix()}`, 'accepted', configId, `t-${suffix()}`);

      const countActive = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM serialized_asset_retry_operations WHERE tenant_id = ${tenantId}
      `.execute(k);
      expect(Number(countActive.rows[0].count)).toBe(2);
    });

    it('lets a new operation through once the previous one is terminal', async () => {
      const k = db.getDatabase();
      const tenantId = `t-${suffix()}`;
      const configId = `c-${suffix()}`;
      const firstId = `op-${suffix()}`;

      await sql`
        INSERT INTO serialized_asset_retry_operations
          (id, tenant_id, configuration_id, requester_user_id, correlation_id, status, created_at)
        VALUES (${firstId}, ${tenantId}, ${configId}, ${'user-1'}, ${'corr-1'}, ${'running'}, NOW())
      `.execute(k);
      await sql`UPDATE serialized_asset_retry_operations SET status = 'succeeded' WHERE id = ${firstId}`.execute(k);
      await sql`
        INSERT INTO serialized_asset_retry_operations
          (id, tenant_id, configuration_id, requester_user_id, correlation_id, status, created_at)
        VALUES (${`op-${suffix()}`}, ${tenantId}, ${configId}, ${'user-1'}, ${'corr-1'}, ${'accepted'}, NOW())
      `.execute(k);

      const count = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM serialized_asset_retry_operations WHERE tenant_id = ${tenantId}
      `.execute(k);
      expect(Number(count.rows[0].count)).toBe(2);
    });

    it('rejects a status outside the closed vocabulary', async () => {
      const k = db.getDatabase();
      let violation: unknown = null;
      try {
        await sql`
          INSERT INTO serialized_asset_retry_operations
            (id, tenant_id, configuration_id, requester_user_id, correlation_id, status, created_at)
          VALUES (${`op-${suffix()}`}, ${`t-${suffix()}`}, ${`c-${suffix()}`}, ${'user-1'}, ${'corr-1'}, ${'inflight'}, NOW())
        `.execute(k);
      } catch (e) {
        violation = e;
      }
      expect(String(violation)).toMatch(/check constraint|violates check/i);
    });
  });
});
