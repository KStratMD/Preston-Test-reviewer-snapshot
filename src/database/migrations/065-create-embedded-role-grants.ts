import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 065 — a privileged role gets a source that is not the request body.
 *
 * The embedded host-bootstrap endpoint accepts `userRoles` from its caller and
 * persists them to `embedded_sessions.user_roles`. `_governanceAuth.ts` reads
 * that column in `hasApproverRole` / `hasAdminRole`, which gate the approval
 * and operations endpoints — so the host was choosing its own authority.
 * Measured 2026-09-03 against the unfixed bootstrap: a body carrying
 * `["admin","approver"]` returned 200 and both predicates answered true.
 *
 * `embedded_role_grants` is the replacement source of truth. A Squire operator
 * issues a row; the host cannot. Three details are load-bearing:
 *
 * 1. The unique index is PARTIAL — `WHERE revoked_at IS NULL`. At most one
 *    OPEN grant exists per (tenant, platform, account, user, role), and a
 *    revoke releases the slot so the same person can be re-granted later. An
 *    expired-but-unrevoked row still occupies it: expiry is a claim about
 *    time, revocation is a decision, and only the decision frees the key.
 *    Renewal therefore has to close the old row explicitly rather than
 *    relying on `expires_at` to step aside.
 *
 * 2. `secret_enc` is NOT NULL. A grant with no secret could never be asserted
 *    against, so it would be a row that looks like authority but grants
 *    nothing — worse than no row at all. It holds `EncryptionService`
 *    ciphertext; the plaintext secret is never stored.
 *
 * 3. `embedded_user_assertion_nonces` is a SEPARATE table, not a session
 *    column, because the guest teardown deletes session rows on pagehide. A
 *    replay ledger that dies with the session is not a replay ledger.
 *
 * Every pre-existing `embedded_sessions` row is expired as the last step. Those
 * rows were created under the old rule and may carry host-asserted `admin`;
 * leaving them live would let the very sessions this migration exists to stop
 * keep their authority until they aged out on their own.
 */
export const migration: MigrationModule = {
  name: 'create_embedded_role_grants',
  async run(db, dbType) {
    const isPg = dbType === 'postgres';
    const T = isPg ? 'VARCHAR(255)' : 'TEXT';
    const ID = isPg ? 'VARCHAR(64)' : 'TEXT';
    const SHORT = isPg ? 'VARCHAR(32)' : 'TEXT';
    // TIMESTAMP, not TIMESTAMPTZ. The transfer manifest classifies this table's
    // timestamps as `naive_timestamp` (the default for a new table), and
    // PostgresTransferTarget.initializeFreshSchema runs these migrations against
    // Postgres and then asserts the result matches that manifest. TIMESTAMPTZ
    // classifies as `instant_utc`, so it read as real type drift and failed the
    // Postgres transfer outright. Migration 032 sets the same precedent for
    // embedded_sessions: TEXT on SQLite, TIMESTAMP on Postgres.
    const TS = isPg ? 'TIMESTAMP' : 'TEXT';

    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS embedded_role_grants (
          id ${ID} PRIMARY KEY,
          tenant_id ${T} NOT NULL,
          platform ${SHORT} NOT NULL,
          platform_account_id ${T} NOT NULL,
          user_id ${T} NOT NULL,
          role ${isPg ? 'VARCHAR(16)' : 'TEXT'} NOT NULL
            CHECK (role IN ('viewer','requester','approver','admin')),
          source ${SHORT} NOT NULL
            CHECK (source IN ('squire_operator','squire_invitation','erp_verified')),
          granted_by ${T} NOT NULL,
          granted_at ${TS} NOT NULL,
          expires_at ${TS},
          revoked_at ${TS},
          revoked_by ${T},
          secret_enc TEXT NOT NULL
        )`,
      )
      .execute(db);

    await sql
      .raw(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_embedded_role_grants_active
         ON embedded_role_grants (tenant_id, platform, platform_account_id, user_id, role)
         WHERE revoked_at IS NULL`,
      )
      .execute(db);

    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS embedded_user_assertion_nonces (
          nonce ${isPg ? 'VARCHAR(128)' : 'TEXT'} PRIMARY KEY,
          grant_id ${ID} NOT NULL,
          used_at ${TS} NOT NULL
        )`,
      )
      .execute(db);

    // Retention sweeps delete by age, so the ledger does not grow without bound.
    await sql
      .raw(
        `CREATE INDEX IF NOT EXISTS ix_embedded_user_assertion_nonces_used_at
         ON embedded_user_assertion_nonces (used_at)`,
      )
      .execute(db);

    const sessionColumns = [
      [
        'user_identity',
        `${SHORT} NOT NULL DEFAULT 'host_asserted' CHECK (user_identity IN ('host_asserted','squire_verified'))`,
      ],
      ['verified_grant_id', ID],
    ] as const;
    await addColumns(db, isPg, 'embedded_sessions', sessionColumns);

    const approvalColumns = [
      [
        'requester_provenance',
        // Constrained like role, source and user_identity above. Without the
        // CHECK this column fails OPEN: sodWeak is computed as
        // `provenance === 'host_asserted' || provenance === 'unknown'`, so an
        // unexpected value makes a request read as NOT weak — the opposite of
        // what an unrecognised provenance should mean. The database is the
        // right place for it, because the value is cast to RequesterProvenance
        // on read and nothing downstream re-validates it.
        `${SHORT} NOT NULL DEFAULT 'unknown' CHECK (requester_provenance IN ` +
          `('squire_verified','host_asserted','jwt','system','unknown'))`,
      ],
      ['requester_platform', SHORT],
      ['requester_platform_account_id', T],
    ] as const;
    await addColumns(db, isPg, 'governance_approvals', approvalColumns);

    // Expire every session created under the old rule. The literal format
    // matches the `toISOString()` strings EmbeddedSessionRepository writes so
    // that `new Date(session.expires_at).getTime()` in validateGuestContext
    // (src/middleware/embeddedAuthMiddleware.ts) can PARSE it — the comparison
    // there is numeric, not lexical. A format Date cannot parse yields NaN,
    // and a NaN comparison is false either way, which would leave exactly the
    // sessions this migration exists to kill looking valid.
    await sql
      .raw(
        isPg
          ? `UPDATE embedded_sessions SET expires_at = NOW()`
          : `UPDATE embedded_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .execute(db);
  },
};

/**
 * Add columns idempotently. Postgres has `ADD COLUMN IF NOT EXISTS`; SQLite
 * does not, so the column list is read first. Re-running a migration must be
 * safe — the runner has no per-migration ledger to rely on.
 */
async function addColumns(
  db: Parameters<MigrationModule['run']>[0],
  isPg: boolean,
  table: 'embedded_sessions' | 'governance_approvals',
  columns: readonly (readonly [string, string])[],
): Promise<void> {
  for (const [name, ddl] of columns) {
    if (isPg) {
      await sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${ddl}`).execute(db);
      continue;
    }
    const info = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${sql.lit(table)})`.execute(db);
    if (!info.rows.some((c) => c.name === name)) {
      await sql.raw(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`).execute(db);
    }
  }
}
