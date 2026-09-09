import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_conflict_indexes',
  async run(db, _dbType) {
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_cs_field ON mdm_conflict_stats(field_name)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_cs_source ON mdm_conflict_stats(source_system)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_ch_field_created ON mdm_conflict_history(field_name, created_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_ch_resolution ON mdm_conflict_history(resolution)`.execute(db);
  },
};
