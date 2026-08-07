import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { SuiteCentralControlPlaneRepository } from '../../../../src/services/suitecentral/controlPlane/SuiteCentralControlPlaneRepository';
import { SuiteCentralConflictError, SuiteCentralNotFoundError } from '../../../../src/services/suitecentral/controlPlane/errors';
import { uuidv4 } from '../../../../src/utils/uuid';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

// A minimal DatabaseService stand-in — the repository only uses getDatabase()/getDbType().
function repoFor(db: Kysely<Database>): SuiteCentralControlPlaneRepository {
  const fakeDatabaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite' as const,
  };
  return new SuiteCentralControlPlaneRepository(fakeDatabaseService as never);
}

describe('SuiteCentralControlPlaneRepository', () => {
  let db: Kysely<Database>;
  let repo: SuiteCentralControlPlaneRepository;

  beforeEach(async () => {
    db = makeDb();
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    repo = repoFor(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  describe('tenant isolation', () => {
    it('does not leak environments across tenants', async () => {
      const envA = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await repo.createEnvironment('tenant-b', uuidv4(), { name: 'Primary', baseUrl: 'https://b.example' }, 'admin-b');

      expect(await repo.findEnvironment('tenant-a', envA.id)).toMatchObject({ tenantId: 'tenant-a' });
      expect(await repo.findEnvironment('tenant-b', envA.id)).toBeUndefined();
      expect(await repo.listEnvironments('tenant-a')).toHaveLength(1);
      expect(await repo.listEnvironments('tenant-b')).toHaveLength(1);
    });

    it("does not list another tenant's credentials", async () => {
      const envA = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await repo.createCredentialMetadata(
        'tenant-a',
        'cred-a1',
        { environmentId: envA.id, name: 'prod', clientId: 'cid' },
        'secret-ref-a',
        'admin-a',
      );
      expect(await repo.listCredentials('tenant-a', envA.id)).toHaveLength(1);
      expect(await repo.listCredentials('tenant-b', envA.id)).toEqual([]);
    });

    it('never exposes secret material on a credential view', async () => {
      const envA = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      const view = await repo.createCredentialMetadata(
        'tenant-a',
        'cred-a2',
        { environmentId: envA.id, name: 'prod', clientId: 'cid' },
        'secret-ref-a',
        'admin-a',
      );
      expect(view).not.toHaveProperty('clientSecret');
      expect(view).not.toHaveProperty('secretRef');
      expect(view.secretConfigured).toBe(true);
      expect(JSON.stringify(view)).not.toContain('secret-ref-a');
    });
  });

  describe('optimistic concurrency', () => {
    it('rejects an environment update with a stale version', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await expect(
        repo.updateEnvironment('tenant-a', env.id, 99, { name: 'Renamed' }, 'admin-a'),
      ).rejects.toBeInstanceOf(SuiteCentralConflictError);
    });

    it('bumps the version on a successful update', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      expect(env.version).toBe(1);
      const updated = await repo.updateEnvironment('tenant-a', env.id, env.version, { name: 'Renamed' }, 'admin-a');
      expect(updated.version).toBe(2);
      expect(updated.name).toBe('Renamed');
    });

    it('raises NotFound updating a missing environment', async () => {
      await expect(
        repo.updateEnvironment('tenant-a', 'does-not-exist', 1, { name: 'X' }, 'admin-a'),
      ).rejects.toBeInstanceOf(SuiteCentralNotFoundError);
    });

    it('maps a duplicate-name create to a typed conflict, not a raw driver error', async () => {
      await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await expect(
        repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a2.example' }, 'admin-a'),
      ).rejects.toBeInstanceOf(SuiteCentralConflictError);
    });

    it('allows the same credential name in different environments of one tenant', async () => {
      const envA = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'EnvA', baseUrl: 'https://a.example' }, 'admin-a');
      const envB = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'EnvB', baseUrl: 'https://b.example' }, 'admin-a');
      await repo.createCredentialMetadata('tenant-a', 'cred-1', { environmentId: envA.id, name: 'prod', clientId: 'c1' }, 'ref-1', 'admin-a');
      await expect(
        repo.createCredentialMetadata('tenant-a', 'cred-2', { environmentId: envB.id, name: 'prod', clientId: 'c2' }, 'ref-2', 'admin-a'),
      ).resolves.toBeDefined();
    });
  });

  describe('credential rotation and deletion', () => {
    // Regression: the repository must persist the caller's profile id verbatim.
    // The secret ref is a deterministic function of (tenantId, profileId) and is
    // written BEFORE this row exists, so an id minted here instead would make
    // every stored ref unresolvable (`secret_reference_mismatch` on first use).
    it('persists a credential under the caller-allocated id', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      const view = await repo.createCredentialMetadata(
        'tenant-a',
        'caller-allocated-id',
        { environmentId: env.id, name: 'prod', clientId: 'cid' },
        'ref-1',
        'admin-a',
      );
      expect(view.id).toBe('caller-allocated-id');
      expect(await repo.findCredentialMetadata('tenant-a', 'caller-allocated-id')).toBeDefined();
    });

    it('rotates the secret_ref and bumps version', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      const cred = await repo.createCredentialMetadata('tenant-a', 'cred-rot', { environmentId: env.id, name: 'prod', clientId: 'cid' }, 'ref-1', 'admin-a');
      const rotated = await repo.rotateCredentialMetadata('tenant-a', cred.id, cred.version, 'admin-a', 'ref-2', new Date().toISOString());
      expect(rotated.version).toBe(cred.version + 1);
      const meta = await repo.findCredentialMetadata('tenant-a', cred.id);
      expect(meta?.secretRef).toBe('ref-2');
    });

    it('rejects deletion with a stale version and allows current version', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      const cred = await repo.createCredentialMetadata('tenant-a', 'cred-del', { environmentId: env.id, name: 'prod', clientId: 'cid' }, 'ref-1', 'admin-a');
      await expect(repo.deleteCredentialMetadata('tenant-a', cred.id, 99)).rejects.toBeInstanceOf(SuiteCentralConflictError);
      await expect(repo.deleteCredentialMetadata('tenant-a', cred.id, cred.version)).resolves.toBeUndefined();
      expect(await repo.findCredentialMetadata('tenant-a', cred.id)).toBeUndefined();
    });
  });

  describe('templates and monitoring', () => {
    it('filters templates by source system within a tenant', async () => {
      await repo.createTemplate('tenant-a', uuidv4(), { name: 'T1', sourceSystem: 'Squire' }, 'admin-a');
      await repo.createTemplate('tenant-a', uuidv4(), { name: 'T2', sourceSystem: 'NetSuite' }, 'admin-a');
      expect(await repo.listTemplates('tenant-a', 'Squire')).toHaveLength(1);
      expect(await repo.listTemplates('tenant-b')).toEqual([]);
    });

    it('upserts a monitoring config (CAS) and lists only enabled ones', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      // expectedVersion 0 => create
      const created = await repo.upsertMonitoringConfig('tenant-a', env.id, { enabled: true, intervalMs: 60000 }, 'admin-a', 0);
      expect(created.enabled).toBe(true);
      expect(created.version).toBe(1);
      // Preserve intervalMs when omitted on update; expectedVersion 1 => update
      const updated = await repo.upsertMonitoringConfig('tenant-a', env.id, { enabled: false }, 'admin-a', created.version);
      expect(updated.version).toBe(created.version + 1);
      expect(updated.intervalMs).toBe(60000);
      expect(await repo.listEnabledMonitoringConfigs()).toEqual([]);
    });

    it('reads back a monitoring config only for its owning tenant', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await repo.upsertMonitoringConfig('tenant-a', env.id, { enabled: true, intervalMs: 60000 }, 'admin-a', 0);

      const found = await repo.findMonitoringConfig('tenant-a', env.id);
      expect(found).toMatchObject({ environmentId: env.id, enabled: true, intervalMs: 60000 });
      // A cross-tenant id is indistinguishable from a missing one.
      expect(await repo.findMonitoringConfig('tenant-b', env.id)).toBeUndefined();
    });

    it('returns undefined for an environment with no monitoring config', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      expect(await repo.findMonitoringConfig('tenant-a', env.id)).toBeUndefined();
    });

    it('rejects a monitoring upsert with a stale expected version', async () => {
      const env = await repo.createEnvironment('tenant-a', uuidv4(), { name: 'Primary', baseUrl: 'https://a.example' }, 'admin-a');
      await repo.upsertMonitoringConfig('tenant-a', env.id, { enabled: true }, 'admin-a', 0);
      await expect(
        repo.upsertMonitoringConfig('tenant-a', env.id, { enabled: false }, 'admin-a', 99),
      ).rejects.toBeInstanceOf(SuiteCentralConflictError);
    });
  });

  describe('platform allowed hosts', () => {
    it('matches an active host case-insensitively and respects revocation', async () => {
      const host = await repo.createAllowedHost(uuidv4(), { hostname: 'API.SuiteCentral.example', allowedPorts: [443] }, 'platform-admin');
      expect(await repo.findActiveAllowedHost('api.suitecentral.example', 443)).toMatchObject({ id: host.id });
      expect(await repo.findActiveAllowedHost('api.suitecentral.example', 8443)).toBeUndefined();
      await repo.revokeAllowedHost(host.id, 'platform-admin');
      expect(await repo.findActiveAllowedHost('api.suitecentral.example', 443)).toBeUndefined();
    });
  });
});
