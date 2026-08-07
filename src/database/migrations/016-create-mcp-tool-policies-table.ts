import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mcp_tool_policies_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS mcp_tool_policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          system_name TEXT NOT NULL,
          tool_pattern TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, system_name, tool_pattern)
        )
      `.execute(db);

      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_policies_tenant
          ON mcp_tool_policies(tenant_id)
      `.execute(db);

      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_policies_tenant_system
          ON mcp_tool_policies(tenant_id, system_name)
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS mcp_tool_policies (
          id SERIAL PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          system_name VARCHAR(255) NOT NULL,
          tool_pattern VARCHAR(255) NOT NULL,
          action VARCHAR(10) NOT NULL
            CONSTRAINT chk_mcp_tool_policies_action CHECK (action IN ('allow', 'deny')),
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tenant_id, system_name, tool_pattern)
        )
      `.execute(db);

      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_policies_tenant
          ON mcp_tool_policies(tenant_id)
      `.execute(db);

      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_tool_policies_tenant_system
          ON mcp_tool_policies(tenant_id, system_name)
      `.execute(db);
    }
  },
};
