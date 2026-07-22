import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

const MIGRATION_057_NAME = 'create_suitecentral_control_plane_tables';

const TABLES = [
  'suitecentral_environments',
  'suitecentral_credential_profiles',
  'suitecentral_templates',
  'suitecentral_monitoring_configs',
  'suitecentral_allowed_hosts',
] as const;

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = ON`.execute(db);
  for (const m of MIGRATIONS) {
    await m.run(db, 'sqlite');
  }
}

// better-sqlite3 caches its SqliteError constructor process-globally, so
// `.rejects.toThrow()` can misfire across Jest VM realms. Capture via try/catch
// + string match instead (same pattern as the 040/042/049/056 migration tests).
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

const NOW = '2026-07-15T00:00:00.000Z';

async function insertEnvironment(
  db: Kysely<Database>,
  overrides: { id?: string; tenantId?: string; name?: string } = {},
): Promise<{ id: string; tenantId: string }> {
  const id = overrides.id ?? 'env-1';
  const tenantId = overrides.tenantId ?? 'tenant-a';
  await sql`
    INSERT INTO suitecentral_environments
      (id, tenant_id, name, base_url, environment_tier, timeout_ms, retry_attempts, version, created_at, updated_at)
    VALUES
      (${id}, ${tenantId}, ${overrides.name ?? 'Primary'}, ${'https://acme.suitecentral.example'},
       ${'sandbox'}, ${30000}, ${3}, ${1}, ${NOW}, ${NOW})
  `.execute(db);
  return { id, tenantId };
}

describe('migration 057 — SuiteCentral control-plane schema', () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('is registered under its canonical name', () => {
    expect(MIGRATIONS.some((m) => m.name === MIGRATION_057_NAME)).toBe(true);
  });

  it('creates all control-plane tables and tenant indexes', async () => {
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table'
    `.execute(db);
    expect(tables.rows.map((r) => r.name)).toEqual(expect.arrayContaining([...TABLES]));

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index'
    `.execute(db);
    expect(indexes.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'uq_suitecentral_environment_tenant_name',
        'idx_suitecentral_environment_tenant_id',
        'idx_suitecentral_credential_tenant_environment',
        'idx_suitecentral_template_tenant_source',
        'uq_suitecentral_monitoring_tenant_environment',
        'uq_suitecentral_allowed_host_hostname',
      ]),
    );
  });

  it('rejects a duplicate (tenant_id, name) environment', async () => {
    await insertEnvironment(db, { id: 'env-1', name: 'Primary' });
    const err = await captureExecError(() => insertEnvironment(db, { id: 'env-2', name: 'Primary' }));
    expect(err).toMatch(/UNIQUE|constraint/i);
  });

  it('allows the same environment name for a different tenant', async () => {
    await insertEnvironment(db, { id: 'env-a', tenantId: 'tenant-a', name: 'Primary' });
    await expect(
      insertEnvironment(db, { id: 'env-b', tenantId: 'tenant-b', name: 'Primary' }),
    ).resolves.toBeDefined();
  });

  it('rejects duplicate hostnames case-insensitively', async () => {
    await sql`
      INSERT INTO suitecentral_allowed_hosts (id, hostname, status, created_at, updated_at)
      VALUES (${'h1'}, ${'api.suitecentral.example'}, ${'active'}, ${NOW}, ${NOW})
    `.execute(db);
    const err = await captureExecError(() =>
      sql`
        INSERT INTO suitecentral_allowed_hosts (id, hostname, status, created_at, updated_at)
        VALUES (${'h2'}, ${'API.SuiteCentral.Example'}, ${'active'}, ${NOW}, ${NOW})
      `.execute(db),
    );
    expect(err).toMatch(/UNIQUE|constraint/i);
  });

  it('rejects a credential referencing an environment from another tenant', async () => {
    await insertEnvironment(db, { id: 'env-a', tenantId: 'tenant-a', name: 'Primary' });
    // Credential for tenant-b referencing tenant-a's environment id must fail the
    // composite (tenant_id, environment_id) foreign key.
    const err = await captureExecError(() =>
      sql`
        INSERT INTO suitecentral_credential_profiles
          (id, tenant_id, environment_id, name, client_id, secret_ref, is_active, version, created_at, updated_at)
        VALUES
          (${'cred-1'}, ${'tenant-b'}, ${'env-a'}, ${'Cross'}, ${'client-x'}, ${'ref-x'}, ${1}, ${1}, ${NOW}, ${NOW})
      `.execute(db),
    );
    expect(err).toMatch(/FOREIGN KEY|constraint/i);
  });

  it('accepts a credential referencing its own tenant environment', async () => {
    await insertEnvironment(db, { id: 'env-a', tenantId: 'tenant-a', name: 'Primary' });
    await expect(
      sql`
        INSERT INTO suitecentral_credential_profiles
          (id, tenant_id, environment_id, name, client_id, secret_ref, is_active, version, created_at, updated_at)
        VALUES
          (${'cred-1'}, ${'tenant-a'}, ${'env-a'}, ${'Own'}, ${'client-x'}, ${'ref-x'}, ${1}, ${1}, ${NOW}, ${NOW})
      `.execute(db),
    ).resolves.toBeDefined();
  });
});
