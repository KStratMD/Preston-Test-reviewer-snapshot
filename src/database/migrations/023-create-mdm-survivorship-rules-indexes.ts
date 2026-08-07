import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_survivorship_rules_indexes',
  async run(db, _dbType) {
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_rules_entity_type ON mdm_survivorship_rules(entity_type)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_rules_entity_field ON mdm_survivorship_rules(entity_type, field_name)`.execute(db);
  },
};
