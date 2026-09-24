import { sql } from 'kysely';
import type { MigrationModule } from './index';

// First centralized tenants table. Today tenant_id is implicit (JWT/API-key).
// This table is the single source of truth for tenant lifecycle status —
// gated by tenantStatusGate middleware after auth.
// Status: active | suspended | disabled | trial_expired. Transitions validated in
// TenantLifecycleService; CHECK constraint is a defence-in-depth backstop.

export const migration: MigrationModule = {
  name: 'create_tenants_and_status_audit_tables',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS tenants (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          status_changed_at TEXT,
          status_changed_by TEXT,
          status_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`.execute(db);
      // seq is the stable audit ordering key. occurred_at is millisecond precision;
      // two transitions in the same millisecond would otherwise have undefined order.
      // INTEGER PRIMARY KEY AUTOINCREMENT is monotonic across the table lifetime.
      //
      // FK on tenant_id → tenants(id) with ON DELETE RESTRICT preserves audit
      // history even if a tenants row were ever deleted (it cannot be while
      // audit rows exist). The application never deletes tenants today; this
      // is referential-integrity defence-in-depth for any future caller.
      // SQLite requires `PRAGMA foreign_keys=ON` at the connection level for
      // FKs to be enforced — DatabaseService does this on initialize.
      await sql`
        CREATE TABLE IF NOT EXISTS tenant_status_audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
          previous_status TEXT NOT NULL
            CHECK (previous_status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          new_status TEXT NOT NULL
            CHECK (new_status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          actor_user_id TEXT NOT NULL,
          actor_source TEXT NOT NULL,
          reason TEXT,
          occurred_at TEXT NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_tenant_status_audit_tenant
          ON tenant_status_audit(tenant_id, seq DESC)
      `.execute(db);
    } else {
      // tenant_status_audit.id defaults to gen_random_uuid(). That function is
      // built into Postgres 13+; on Postgres 12 and earlier it lives in the
      // pgcrypto extension and the table CREATE would fail. Adding the
      // extension defensively keeps the migration safe across the supported
      // PG version range with no behavioral change on PG13+ (the extension
      // is a no-op if already loaded).
      await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS tenants (
          id VARCHAR(255) PRIMARY KEY,
          status VARCHAR(32) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          status_changed_at TIMESTAMPTZ,
          status_changed_by VARCHAR(255),
          status_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`.execute(db);
      // seq is the stable audit ordering key (BIGSERIAL on Postgres).
      // Same as SQLite side: occurred_at is millisecond precision; seq disambiguates.
      //
      // FK on tenant_id → tenants(id) with ON DELETE RESTRICT preserves audit
      // history even if a tenants row were ever deleted (it cannot be while
      // audit rows exist).
      await sql`
        CREATE TABLE IF NOT EXISTS tenant_status_audit (
          seq BIGSERIAL PRIMARY KEY,
          id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
          previous_status VARCHAR(32) NOT NULL
            CHECK (previous_status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          new_status VARCHAR(32) NOT NULL
            CHECK (new_status IN ('active', 'suspended', 'disabled', 'trial_expired')),
          actor_user_id VARCHAR(255) NOT NULL,
          actor_source VARCHAR(64) NOT NULL,
          reason TEXT,
          occurred_at TIMESTAMPTZ NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_tenant_status_audit_tenant
          ON tenant_status_audit(tenant_id, seq DESC)
      `.execute(db);
    }
  },
};
