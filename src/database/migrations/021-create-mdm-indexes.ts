import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_indexes',
  async run(db, _dbType) {
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_gr_entity_type ON mdm_golden_records(entity_type)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_gr_status ON mdm_golden_records(status)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_gr_conflict_count ON mdm_golden_records(conflict_count)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_es_golden_record_id ON mdm_entity_sources(golden_record_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_es_source ON mdm_entity_sources(source_system, source_record_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_sr_golden_record_id ON mdm_sync_requests(golden_record_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_mdm_sr_status ON mdm_sync_requests(status)`.execute(db);
  },
};
