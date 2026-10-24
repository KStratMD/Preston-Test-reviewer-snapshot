import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { MigrationRunner } from '../../../src/database/MigrationRunner';
import type { Database } from '../../../src/database/types';
import type { MigrationModule } from '../../../src/database/migrations';

describe('MigrationRunner exact history verification', () => {
  it('accepts only the exact ordered migration list', async () => {
    const raw = new BetterSqlite3(':memory:'); const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) });
    const modules: MigrationModule[] = [
      { name: 'create_integration_jobs_table', run: async () => undefined },
      { name: 'create_integration_config_history_table', run: async () => undefined },
    ];
    const runner = new MigrationRunner({ db, dbType: 'sqlite', modules, logger: { debug: () => undefined } as never });
    await sql`CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`.execute(db);
    await sql`INSERT INTO migrations (id,name) VALUES (1,'create_integration_jobs_table'),(2,'create_integration_config_history_table')`.execute(db);
    await expect(runner.verifyExactHistory()).resolves.toBeUndefined();
    await sql`UPDATE migrations SET name='create_integration_jobs_table' WHERE id=2`.execute(db);
    await expect(runner.verifyExactHistory()).rejects.toThrow(/exactly/);
    await db.destroy(); raw.close();
  });
});
