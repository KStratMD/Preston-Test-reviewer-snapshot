import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'add_tenant_configurations_key_value_index',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_tenant_configurations_key_value
          ON tenant_configurations(setting_key, setting_value)
      `.execute(db);
    } else {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_tenant_configurations_key_value
          ON tenant_configurations(setting_key, setting_value)
      `.execute(db);
    }
  },
};
