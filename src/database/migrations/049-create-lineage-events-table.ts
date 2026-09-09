import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_lineage_events_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS lineage_events (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          chain_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('source_read', 'transform', 'governance_decision', 'target_write')),
          source_system TEXT,
          source_entity_type TEXT,
          source_entity_id TEXT,
          target_system TEXT,
          target_entity_type TEXT,
          target_entity_id TEXT,
          template_id TEXT,
          correlation_id TEXT NOT NULL,
          governance_result TEXT,
          payload_hash TEXT,
          metadata_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          UNIQUE(tenant_id, chain_id, sequence)
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS lineage_events (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          chain_id VARCHAR(255) NOT NULL,
          sequence INTEGER NOT NULL,
          event_type VARCHAR(64) NOT NULL CHECK (event_type IN ('source_read', 'transform', 'governance_decision', 'target_write')),
          source_system VARCHAR(64),
          source_entity_type VARCHAR(128),
          source_entity_id VARCHAR(255),
          target_system VARCHAR(64),
          target_entity_type VARCHAR(128),
          target_entity_id VARCHAR(255),
          template_id VARCHAR(255),
          correlation_id VARCHAR(255) NOT NULL,
          governance_result VARCHAR(64),
          payload_hash VARCHAR(128),
          metadata_json TEXT NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL,
          UNIQUE(tenant_id, chain_id, sequence)
        )
      `.execute(db);
    }

    // idx_lineage_events_tenant_chain was previously declared here but it is
    // redundant with the UNIQUE(tenant_id, chain_id, sequence) constraint —
    // both sqlite and postgres auto-create an index for UNIQUE, so the
    // explicit one was pure write overhead. Removed per PR #846 R2.
    // The record-lookup index includes occurred_at DESC so findLatestChainForRecord's
    // ORDER BY occurred_at DESC LIMIT 1 can be satisfied without a separate sort step.
    await sql`CREATE INDEX IF NOT EXISTS idx_lineage_events_record_lookup ON lineage_events(tenant_id, source_system, source_entity_type, source_entity_id, occurred_at DESC)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_lineage_events_correlation ON lineage_events(tenant_id, correlation_id)`.execute(db);
  },
};
