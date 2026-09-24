import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 063 — durable operations for the forced serialized-asset retry (A9).
 *
 * The forced retry is the design's only operator remedy for a stuck unit, and
 * it currently runs INSIDE the HTTP request: the caller waits for a full
 * backlog drain against NetSuite and Salesforce, and if the process restarts or
 * the client disconnects mid-run, nothing anywhere records that work was owed
 * or how far it got. This table is what makes the operation outlive the
 * request.
 *
 * NOT a job framework, deliberately. There is no payload column, no handler
 * name, no priority, no retry policy — one purpose-built table for one
 * operation, per the design's explicit instruction not to grow a general queue.
 *
 * WHAT IT MAY HOLD is as much the point as what it does. The rows are
 * operator-readable and reach an HTTP status endpoint, so the result projection
 * is bounded counters plus a fixed error code and error class — there is
 * nowhere to put a serial number, a source payload, a raw connector message, or
 * a cause chain (decision 8). Adding a free-text column here would undo that.
 *
 * The single-active rule is a partial unique index over
 * `(tenant_id, configuration_id)` restricted to the non-terminal statuses. A
 * second forced retry for the same configuration must converge on the existing
 * operation rather than start parallel work against one backlog; restricting to
 * `accepted`/`running` is what keeps a FINISHED retry from blocking the next
 * one forever. Same shape and the same reasoning as migration 062's
 * pending-approval index.
 *
 * `status` also carries a CHECK constraint rather than relying on the
 * TypeScript union. The worker reads this column back and dispatches on it, so
 * a value outside the vocabulary would strand the operation in a state no code
 * path can advance.
 *
 * Idempotent on replay: `CREATE TABLE IF NOT EXISTS` plus
 * `CREATE INDEX IF NOT EXISTS`, identical on both engines.
 */
export const migration: MigrationModule = {
  name: 'create_serialized_asset_retry_operations_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS serialized_asset_retry_operations (
          id                 TEXT PRIMARY KEY,
          tenant_id          TEXT NOT NULL,
          configuration_id   TEXT NOT NULL,
          requester_user_id  TEXT NOT NULL,
          correlation_id     TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'accepted'
                               CHECK (status IN ('accepted','running','succeeded','failed','interrupted')),
          lease_owner        TEXT,
          fencing_token      INTEGER NOT NULL DEFAULT 0,
          lease_expires_at   TEXT,
          heartbeat_at       TEXT,
          created_at         TEXT NOT NULL,
          started_at         TEXT,
          finished_at        TEXT,
          units_read         INTEGER,
          units_upserted     INTEGER,
          units_deferred     INTEGER,
          units_quarantined  INTEGER,
          units_failed       INTEGER,
          error_code         TEXT,
          error_class        TEXT
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS serialized_asset_retry_operations (
          id                 VARCHAR(64)  PRIMARY KEY,
          tenant_id          VARCHAR(255) NOT NULL,
          configuration_id   VARCHAR(255) NOT NULL,
          requester_user_id  VARCHAR(255) NOT NULL,
          correlation_id     VARCHAR(255) NOT NULL,
          status             VARCHAR(32)  NOT NULL DEFAULT 'accepted'
                               CHECK (status IN ('accepted','running','succeeded','failed','interrupted')),
          lease_owner        VARCHAR(255),
          fencing_token      BIGINT       NOT NULL DEFAULT 0,
          lease_expires_at   TIMESTAMP WITH TIME ZONE,
          heartbeat_at       TIMESTAMP WITH TIME ZONE,
          created_at         TIMESTAMP WITH TIME ZONE NOT NULL,
          started_at         TIMESTAMP WITH TIME ZONE,
          finished_at        TIMESTAMP WITH TIME ZONE,
          units_read         INTEGER,
          units_upserted     INTEGER,
          units_deferred     INTEGER,
          units_quarantined  INTEGER,
          units_failed       INTEGER,
          error_code         VARCHAR(64),
          error_class        VARCHAR(64)
        )
      `.execute(db);
    }

    // One live forced retry per (tenant, configuration). Terminal rows are
    // outside the predicate so a finished retry never blocks the next one.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_serialized_asset_retry_active
        ON serialized_asset_retry_operations (tenant_id, configuration_id)
        WHERE status IN ('accepted','running')
    `.execute(db);

    // Tenant-scoped status reads (the HTTP status endpoint) and operator
    // history for one configuration.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_serialized_asset_retry_tenant_config_status
        ON serialized_asset_retry_operations (tenant_id, configuration_id, status)
    `.execute(db);

    // The worker's claim scan: find work that is claimable now. Ordered
    // (status, lease_expires_at) because every claim query filters on a
    // non-terminal status first and then on whether the lease has lapsed.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_serialized_asset_retry_claimable
        ON serialized_asset_retry_operations (status, lease_expires_at)
    `.execute(db);
  },
};
