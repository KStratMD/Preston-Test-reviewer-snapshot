import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 057 — SuiteCentral control-plane durable schema.
 *
 * Replaces the retired process-global in-memory environment/credential/
 * monitoring maps (legacy SuiteCentralConfigService/MonitoringService) with
 * durable, tenant-scoped tables for the redesigned control plane (PR-A).
 *
 * Tenant isolation is structural: every tenant-owned table carries a
 * `UNIQUE (tenant_id, id)` key so child rows reference their parent via a
 * COMPOSITE foreign key `(tenant_id, environment_id) -> (tenant_id, id)`,
 * making a cross-tenant reference impossible at the schema level.
 *
 * `suitecentral_allowed_hosts` is a PLATFORM (not tenant) table — the outbound
 * destination allowlist is administered by platform admins, so hostnames are
 * globally unique (case-insensitive after canonicalization).
 *
 * Secrets are never stored here: credential rows carry only a deterministic
 * `secret_ref` resolved through SecretManager (PR-A2).
 *
 * Every tenant-owned mutable row carries `version INTEGER NOT NULL DEFAULT 1`
 * for compare-and-swap updates. (`suitecentral_allowed_hosts` is the exception:
 * it is platform-scoped and only ever transitions active→revoked, so it has no
 * version column.) Dialect split: SQLite uses TEXT/INTEGER, PostgreSQL
 * uses VARCHAR/BOOLEAN/JSONB/TIMESTAMPTZ. Both build the SAME `LOWER(hostname)`
 * unique index for case-insensitive host uniqueness (SQLite expression index /
 * Postgres functional index), so the runtime `WHERE LOWER(hostname) = ?` lookup
 * is index-backed on either engine.
 */
export const migration: MigrationModule = {
  name: 'create_suitecentral_control_plane_tables',
  async run(db, dbType) {
    const isSqlite = dbType === 'sqlite';

    // Column-type helpers per dialect.
    const TEXT = 'TEXT';
    const JSON_COL = isSqlite ? 'TEXT' : 'JSONB';
    const BOOL = isSqlite ? 'INTEGER' : 'BOOLEAN';
    const INT = 'INTEGER';
    const TS = isSqlite ? 'TEXT' : 'TIMESTAMPTZ';
    const boolDefault = (v: boolean) => (isSqlite ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE');

    // --- suitecentral_environments ---
    await sql.raw(`
      CREATE TABLE IF NOT EXISTS suitecentral_environments (
        id ${TEXT} NOT NULL,
        tenant_id ${TEXT} NOT NULL,
        name ${TEXT} NOT NULL,
        base_url ${TEXT} NOT NULL,
        environment_tier ${TEXT} NOT NULL DEFAULT 'sandbox'
          CHECK (environment_tier IN ('sandbox', 'production')),
        api_version ${TEXT},
        timeout_ms ${INT} NOT NULL DEFAULT 30000,
        retry_attempts ${INT} NOT NULL DEFAULT 3,
        rate_limit_config ${JSON_COL},
        security_config ${JSON_COL},
        feature_config ${JSON_COL},
        version ${INT} NOT NULL DEFAULT 1,
        created_by ${TEXT},
        updated_by ${TEXT},
        created_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id)
      )
    `).execute(db);

    // Named uniques/indexes are created explicitly (not as inline table
    // constraints) so SQLite registers them under these exact names in
    // sqlite_master rather than auto-generated sqlite_autoindex_* names.
    await sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suitecentral_environment_tenant_name
        ON suitecentral_environments (tenant_id, name)
    `).execute(db);

    await sql.raw(`
      CREATE INDEX IF NOT EXISTS idx_suitecentral_environment_tenant_id
        ON suitecentral_environments (tenant_id)
    `).execute(db);

    // --- suitecentral_credential_profiles ---
    await sql.raw(`
      CREATE TABLE IF NOT EXISTS suitecentral_credential_profiles (
        id ${TEXT} NOT NULL,
        tenant_id ${TEXT} NOT NULL,
        environment_id ${TEXT} NOT NULL,
        name ${TEXT} NOT NULL,
        client_id ${TEXT} NOT NULL,
        secret_ref ${TEXT} NOT NULL,
        company_id ${TEXT},
        scopes ${JSON_COL},
        is_active ${BOOL} NOT NULL DEFAULT ${boolDefault(true)},
        rotated_at ${TS},
        last_used_at ${TS},
        version ${INT} NOT NULL DEFAULT 1,
        created_by ${TEXT},
        updated_by ${TEXT},
        created_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT fk_suitecentral_credential_environment
          FOREIGN KEY (tenant_id, environment_id)
          REFERENCES suitecentral_environments (tenant_id, id)
          ON DELETE CASCADE
      )
    `).execute(db);

    // Credential names are unique per ENVIRONMENT (not per tenant): each
    // environment can have its own "prod"/"sandbox" profile.
    await sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suitecentral_credential_tenant_env_name
        ON suitecentral_credential_profiles (tenant_id, environment_id, name)
    `).execute(db);

    await sql.raw(`
      CREATE INDEX IF NOT EXISTS idx_suitecentral_credential_tenant_environment
        ON suitecentral_credential_profiles (tenant_id, environment_id)
    `).execute(db);

    // --- suitecentral_templates ---
    await sql.raw(`
      CREATE TABLE IF NOT EXISTS suitecentral_templates (
        id ${TEXT} NOT NULL,
        tenant_id ${TEXT} NOT NULL,
        name ${TEXT} NOT NULL,
        description ${TEXT},
        source_system ${TEXT} NOT NULL,
        target_entities ${JSON_COL},
        field_mappings ${JSON_COL},
        business_rules ${JSON_COL},
        sync_settings ${JSON_COL},
        version ${INT} NOT NULL DEFAULT 1,
        created_by ${TEXT},
        updated_by ${TEXT},
        created_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id)
      )
    `).execute(db);

    await sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suitecentral_template_tenant_name
        ON suitecentral_templates (tenant_id, name)
    `).execute(db);

    await sql.raw(`
      CREATE INDEX IF NOT EXISTS idx_suitecentral_template_tenant_source
        ON suitecentral_templates (tenant_id, source_system)
    `).execute(db);

    // --- suitecentral_monitoring_configs ---
    await sql.raw(`
      CREATE TABLE IF NOT EXISTS suitecentral_monitoring_configs (
        id ${TEXT} NOT NULL,
        tenant_id ${TEXT} NOT NULL,
        environment_id ${TEXT} NOT NULL,
        enabled ${BOOL} NOT NULL DEFAULT ${boolDefault(false)},
        interval_ms ${INT} NOT NULL DEFAULT 300000,
        thresholds ${JSON_COL},
        version ${INT} NOT NULL DEFAULT 1,
        created_by ${TEXT},
        updated_by ${TEXT},
        created_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT fk_suitecentral_monitoring_environment
          FOREIGN KEY (tenant_id, environment_id)
          REFERENCES suitecentral_environments (tenant_id, id)
          ON DELETE CASCADE
      )
    `).execute(db);

    await sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suitecentral_monitoring_tenant_environment
        ON suitecentral_monitoring_configs (tenant_id, environment_id)
    `).execute(db);

    // --- suitecentral_allowed_hosts (platform-scoped) ---
    await sql.raw(`
      CREATE TABLE IF NOT EXISTS suitecentral_allowed_hosts (
        id ${TEXT} NOT NULL,
        hostname ${TEXT} NOT NULL,
        allowed_ports ${JSON_COL},
        status ${TEXT} NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked')),
        justification ${TEXT},
        created_by ${TEXT},
        updated_by ${TEXT},
        created_at ${TS} NOT NULL,
        updated_at ${TS} NOT NULL,
        PRIMARY KEY (id)
      )
    `).execute(db);

    // Both dialects index the SAME expression, LOWER(hostname), so the runtime
    // lookup `WHERE LOWER(hostname) = ?` uses the unique index on either engine
    // (SQLite supports expression indexes; Postgres uses the functional index).
    // Uniqueness is therefore case-insensitive on both.
    await sql.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_suitecentral_allowed_host_hostname
        ON suitecentral_allowed_hosts (LOWER(hostname))
    `).execute(db);
  },
};
