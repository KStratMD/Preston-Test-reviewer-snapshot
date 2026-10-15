/**
 * Migration 065 — the schema that lets a privileged role come from somewhere
 * other than the host's request body.
 *
 * Before this migration `embedded_sessions.user_roles`, written straight from
 * the host-bootstrap body, was the only input to `hasApproverRole` /
 * `hasAdminRole`. `embedded_role_grants` is the replacement source of truth:
 * an operator issues a row, and the row — not the host — decides authority.
 *
 * Uses the captureExecError pattern rather than `.rejects.toThrow()`:
 * better-sqlite3 caches its SqliteError constructor process-globally, so
 * matching on the constructor misfires across Jest VM realms (same reason as
 * the 040/042/049/056/057/058/062/063 tests).
 */
import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

const MIGRATION_065_NAME = 'create_embedded_role_grants';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

/** Run every migration strictly BEFORE 065, so 065's own effects can be observed. */
async function runThroughBefore065(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) {
    if (m.name === MIGRATION_065_NAME) return;
    await m.run(db, 'sqlite');
  }
  throw new Error(`${MIGRATION_065_NAME} is not registered in MIGRATIONS`);
}

async function run065(db: Kysely<Database>): Promise<void> {
  const m = MIGRATIONS.find(x => x.name === MIGRATION_065_NAME);
  if (!m) throw new Error(`${MIGRATION_065_NAME} is not registered in MIGRATIONS`);
  await m.run(db, 'sqlite');
}

async function captureExecError(run: () => Promise<unknown>): Promise<string> {
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
  return String(err);
}

const GRANTED_AT = '2026-09-03T00:00:00.000Z';

function baseGrant(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 't1',
    platform: 'netsuite',
    platform_account_id: 'a1',
    user_id: 'u1',
    role: 'approver',
    source: 'squire_operator',
    granted_by: 'op1',
    granted_at: GRANTED_AT,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    secret_enc: 'enc:test-secret',
    ...overrides,
  };
}

function minimalSession(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    tenant_id: 't_sess',
    user_id: 'u_sess',
    platform: 'netsuite',
    platform_account_id: 'a_sess',
    csrf_token: `csrf_${sessionId}`,
    expected_host_origin: 'https://12345.app.netsuite.com',
    expires_at: '2099-01-01T00:00:00.000Z',
    last_rotation_at: null,
    erp_record_type: null,
    erp_record_id: null,
    erp_record_url: null,
    user_roles: null,
    ...overrides,
  };
}

describe('migration 065 — embedded role grants, requester provenance, session expiry', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates embedded_role_grants with an open-row unique index that a revoke releases', async () => {
    await db
      .insertInto('embedded_role_grants')
      .values({ id: 'g1', ...baseGrant() })
      .execute();

    const dup = await captureExecError(() =>
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g2', ...baseGrant() })
        .execute(),
    );
    expect(dup).toMatch(/UNIQUE|unique/i);

    await db
      .updateTable('embedded_role_grants')
      .set({ revoked_at: GRANTED_AT, revoked_by: 'op1' })
      .where('id', '=', 'g1')
      .execute();

    await expect(
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g3', ...baseGrant() })
        .execute(),
    ).resolves.toBeDefined();
  });

  it('an expired but unrevoked grant still occupies the index — renewal must close it explicitly', async () => {
    await db
      .insertInto('embedded_role_grants')
      .values({
        id: 'g4',
        ...baseGrant({
          tenant_id: 't2',
          granted_at: '2000-01-01T00:00:00.000Z',
          expires_at: '2000-01-02T00:00:00.000Z',
        }),
      })
      .execute();

    const dup = await captureExecError(() =>
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g5', ...baseGrant({ tenant_id: 't2' }) })
        .execute(),
    );
    expect(dup).toMatch(/UNIQUE|unique/i);
  });

  it('rejects a role outside the vocabulary and a source outside the vocabulary', async () => {
    const badRole = await captureExecError(() =>
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g6', ...baseGrant({ tenant_id: 't3', role: 'superuser' }) })
        .execute(),
    );
    expect(badRole).toMatch(/CHECK|constraint/i);

    const badSource = await captureExecError(() =>
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g7', ...baseGrant({ tenant_id: 't4', source: 'host_asserted' }) })
        .execute(),
    );
    expect(badSource).toMatch(/CHECK|constraint/i);
  });

  it('rejects a grant without secret_enc — a grant with no secret cannot be asserted against', async () => {
    const grant = baseGrant({ tenant_id: 't5' }) as Record<string, unknown>;
    delete grant.secret_enc;

    const err = await captureExecError(() =>
      db
        .insertInto('embedded_role_grants')
        .values({ id: 'g8', ...grant } as never)
        .execute(),
    );
    expect(err).toMatch(/NOT NULL|constraint/i);
  });

  it('rejects a session user_identity outside the CHECK and accepts both allowed values', async () => {
    const err = await captureExecError(() =>
      db
        .insertInto('embedded_sessions')
        .values(minimalSession('s_chk', { user_identity: 'other' }) as never)
        .execute(),
    );
    expect(err).toMatch(/CHECK|constraint/i);

    await expect(
      db
        .insertInto('embedded_sessions')
        .values(minimalSession('s_host', { user_identity: 'host_asserted' }) as never)
        .execute(),
    ).resolves.toBeDefined();

    await expect(
      db
        .insertInto('embedded_sessions')
        .values(minimalSession('s_ver', { user_identity: 'squire_verified', verified_grant_id: 'g1' }) as never)
        .execute(),
    ).resolves.toBeDefined();
  });

  it('defaults user_identity to host_asserted so an un-migrated writer cannot claim verification', async () => {
    await db
      .insertInto('embedded_sessions')
      .values(minimalSession('s_default') as never)
      .execute();

    const row = await db
      .selectFrom('embedded_sessions')
      .selectAll()
      .where('session_id', '=', 's_default')
      .executeTakeFirstOrThrow();
    expect(row.user_identity).toBe('host_asserted');
    expect(row.verified_grant_id).toBeNull();
  });

  it('the nonce ledger rejects a replayed nonce', async () => {
    await db
      .insertInto('embedded_user_assertion_nonces')
      .values({ nonce: 'n1', grant_id: 'g1', used_at: GRANTED_AT })
      .execute();

    const err = await captureExecError(() =>
      db
        .insertInto('embedded_user_assertion_nonces')
        .values({ nonce: 'n1', grant_id: 'g1', used_at: GRANTED_AT })
        .execute(),
    );
    expect(err).toMatch(/UNIQUE|PRIMARY|constraint/i);
  });

  it('adds requester provenance and scope columns to governance_approvals', async () => {
    const tables = await db.introspection.getTables();
    const approvals = tables.find(t => t.name === 'governance_approvals');
    expect(approvals).toBeDefined();

    const names = approvals!.columns.map(c => c.name);
    for (const c of ['requester_provenance', 'requester_platform', 'requester_platform_account_id']) {
      expect(names).toContain(c);
    }
  });

  it('rejects a requester_provenance outside the vocabulary, and defaults to unknown', async () => {
    // This column fails OPEN without the CHECK: sodWeak is
    // `provenance === 'host_asserted' || provenance === 'unknown'`, so an
    // unexpected value reads as NOT weak — the opposite of what an
    // unrecognised provenance should mean. The database is the right place to
    // enforce it, because the value is cast to RequesterProvenance on read and
    // nothing downstream re-validates it.
    const approval = {
      id: 'apr_prov',
      tenant_id: 't_prov',
      requester_user_id: 'u1',
      operation_type: 'connector_write',
      resource_type: 'customer',
      resource_id: 'c1',
      risk_level: 'high',
      redacted_payload: '{}',
      policy_findings: '[]',
      status: 'pending',
      created_at: GRANTED_AT,
      expires_at: '2099-01-01T00:00:00.000Z',
    };

    const err = await captureExecError(() =>
      db
        .insertInto('governance_approvals')
        .values({ ...approval, requester_provenance: 'made_up' } as never)
        .execute(),
    );
    expect(err).toMatch(/CHECK|constraint/i);

    await db
      .insertInto('governance_approvals')
      .values(approval as never)
      .execute();
    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_prov')
      .executeTakeFirstOrThrow();
    expect(row.requester_provenance).toBe('unknown');
  });

  it('expires every embedded_sessions row that existed before the migration ran', async () => {
    // Rebuild stopping short of 065 so a pre-existing session can be planted.
    await db.destroy();
    db = makeDb();
    await runThroughBefore065(db);

    await db
      .insertInto('embedded_sessions')
      .values(minimalSession('s_pre') as never)
      .execute();
    const before = await db
      .selectFrom('embedded_sessions')
      .select('expires_at')
      .where('session_id', '=', 's_pre')
      .executeTakeFirstOrThrow();
    expect(new Date(String(before.expires_at)).getTime()).toBeGreaterThan(Date.now());

    await run065(db);

    const after = await db
      .selectFrom('embedded_sessions')
      .select('expires_at')
      .where('session_id', '=', 's_pre')
      .executeTakeFirstOrThrow();
    expect(new Date(String(after.expires_at)).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
