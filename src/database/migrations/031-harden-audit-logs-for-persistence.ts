import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'harden_audit_logs_for_persistence',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS audit_logs_hardened (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          old_values TEXT,
          new_values TEXT,
          details TEXT,
          result TEXT NOT NULL DEFAULT 'success',
          error_message TEXT,
          duration_ms INTEGER,
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `.execute(db);

      await sql`
        INSERT INTO audit_logs_hardened (
          id, tenant_id, user_id, action, resource_type, resource_id,
          old_values, new_values, details, result, error_message, duration_ms,
          ip_address, user_agent, created_at
        )
        SELECT
          id,
          COALESCE(tenant_id, '__legacy_unattributed__'),
          user_id,
          action,
          resource_type,
          resource_id,
          old_values,
          new_values,
          NULL,
          'success',
          NULL,
          NULL,
          ip_address,
          user_agent,
          CASE WHEN created_at LIKE '%T%Z' THEN created_at
               ELSE STRFTIME('%Y-%m-%dT%H:%M:%fZ', created_at)
          END
        FROM audit_logs
      `.execute(db);

      await sql`DROP TABLE audit_logs`.execute(db);
      await sql`ALTER TABLE audit_logs_hardened RENAME TO audit_logs`.execute(db);
    } else {
      await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details JSONB`.execute(db);
      await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS result VARCHAR(32) NOT NULL DEFAULT 'success'`.execute(db);
      await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS error_message TEXT`.execute(db);
      await sql`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER`.execute(db);
      await sql`UPDATE audit_logs SET tenant_id = '__legacy_unattributed__' WHERE tenant_id IS NULL`.execute(db);
      await sql`ALTER TABLE audit_logs ALTER COLUMN tenant_id SET NOT NULL`.execute(db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created_at ON audit_logs(tenant_id, created_at)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_result ON audit_logs(result)`.execute(db);
  },
};
