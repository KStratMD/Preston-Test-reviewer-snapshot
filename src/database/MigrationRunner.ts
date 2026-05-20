import { Kysely, sql } from 'kysely';
import type { Logger } from '../utils/Logger';
import type { Database } from './types';
import type { DbType, MigrationModule, MigrationName } from './migrations';

export interface MigrationRunnerOptions {
  db: Kysely<Database>;
  dbType: DbType;
  modules: readonly MigrationModule[];
  logger: Logger;
}

export class MigrationRunner {
  private readonly db: Kysely<Database>;
  private readonly dbType: DbType;
  private readonly modulesByName: Map<MigrationName, MigrationModule>;
  private readonly manifest: readonly MigrationName[];
  private readonly logger: Logger;

  constructor(options: MigrationRunnerOptions) {
    this.db = options.db;
    this.dbType = options.dbType;
    this.modulesByName = new Map(
      options.modules.map((module) => [module.name, module] as const),
    );
    this.manifest = options.modules.map((module) => module.name);
    this.logger = options.logger;
  }

  async runAll(): Promise<void> {
    await this.ensureMigrationsTable();

    for (const migrationName of this.manifest) {
      await this.runOne(migrationName);
    }
  }

  private async ensureMigrationsTable(): Promise<void> {
    if (this.dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(this.db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(this.db);
    }
  }

  private async runOne(migrationName: MigrationName): Promise<void> {
    const existing = await sql<{ name: string }>`
      SELECT name FROM migrations WHERE name = ${migrationName}
    `.execute(this.db);

    if (existing.rows.length > 0) {
      this.logger.debug('Migration already executed', { migration: migrationName });
      return;
    }

    const migration = this.modulesByName.get(migrationName);
    if (!migration) {
      throw new Error(`Unknown migration: ${migrationName}`);
    }

    await migration.run(this.db, this.dbType);

    // Conflict-safe insert. The SELECT-first short-circuit above already handles
    // sequential re-runs; this guard covers the narrow concurrent-startup window
    // where two app instances both pass the SELECT check before either records.
    // All migration DDL is idempotent (CREATE ... IF NOT EXISTS, INSERT OR IGNORE /
    // ON CONFLICT DO NOTHING), so a duplicate run is harmless; only the INSERT
    // into `migrations` needs to be conflict-safe.
    if (this.dbType === 'sqlite') {
      await sql`INSERT OR IGNORE INTO migrations (name) VALUES (${migrationName})`.execute(this.db);
    } else {
      await sql`INSERT INTO migrations (name) VALUES (${migrationName}) ON CONFLICT (name) DO NOTHING`.execute(this.db);
    }
    this.logger.debug('Migration executed', { migration: migrationName });
  }
}
