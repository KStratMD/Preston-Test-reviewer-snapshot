import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'add_mcp_gateway_user_settings_columns',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      const tableInfo = await sql`PRAGMA table_info(mcp_user_settings)`.execute(db);
      const existingColumns = new Set(
        (tableInfo.rows as Record<string, unknown>[]).map(row => String(row.name || ''))
      );

      if (!existingColumns.has('mcp_gateway_enabled')) {
        await sql`
          ALTER TABLE mcp_user_settings
          ADD COLUMN mcp_gateway_enabled INTEGER DEFAULT 0
        `.execute(db);
      }

      if (!existingColumns.has('mcp_bc_enabled')) {
        await sql`
          ALTER TABLE mcp_user_settings
          ADD COLUMN mcp_bc_enabled INTEGER DEFAULT 0
        `.execute(db);
      }
    } else {
      await sql`
        ALTER TABLE mcp_user_settings
        ADD COLUMN IF NOT EXISTS mcp_gateway_enabled BOOLEAN DEFAULT false
      `.execute(db);

      await sql`
        ALTER TABLE mcp_user_settings
        ADD COLUMN IF NOT EXISTS mcp_bc_enabled BOOLEAN DEFAULT false
      `.execute(db);
    }
  },
};
