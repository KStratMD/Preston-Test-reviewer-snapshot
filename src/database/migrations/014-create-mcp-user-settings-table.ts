import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mcp_user_settings_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      // MCP User Settings Table (SQLite)
      await sql`
        CREATE TABLE IF NOT EXISTS mcp_user_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          mcp_schema_enabled INTEGER DEFAULT 0,
          mcp_ai_context_enabled INTEGER DEFAULT 0,
          mcp_validation_enabled INTEGER DEFAULT 0,
          mcp_gateway_enabled INTEGER DEFAULT 0,
          mcp_bc_enabled INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id)
        )
      `.execute(db);

      // Index for fast user lookups
      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_user_settings_user_id
          ON mcp_user_settings(user_id)
      `.execute(db);
    } else {
      // MCP User Settings Table (PostgreSQL)
      await sql`
        CREATE TABLE IF NOT EXISTS mcp_user_settings (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          mcp_schema_enabled BOOLEAN DEFAULT false,
          mcp_ai_context_enabled BOOLEAN DEFAULT false,
          mcp_validation_enabled BOOLEAN DEFAULT false,
          mcp_gateway_enabled BOOLEAN DEFAULT false,
          mcp_bc_enabled BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id)
        )
      `.execute(db);

      // Index for fast user lookups
      await sql`
        CREATE INDEX IF NOT EXISTS idx_mcp_user_settings_user_id
          ON mcp_user_settings(user_id)
      `.execute(db);

      // Auto-update trigger for updated_at
      await sql`
        CREATE OR REPLACE FUNCTION update_mcp_user_settings_timestamp()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `.execute(db);

      await sql`
        DROP TRIGGER IF EXISTS mcp_user_settings_update_timestamp ON mcp_user_settings
      `.execute(db);

      await sql`
        CREATE TRIGGER mcp_user_settings_update_timestamp
            BEFORE UPDATE ON mcp_user_settings
            FOR EACH ROW EXECUTE FUNCTION update_mcp_user_settings_timestamp()
      `.execute(db);
    }
  },
};
