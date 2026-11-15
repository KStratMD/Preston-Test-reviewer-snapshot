import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration } from '../../../../src/database/migrations/064-widen-transfer-float-columns';

describe('migration 064 widen transfer float columns', () => {
  it('is a no-op on SQLite so the source schema remains unchanged', async () => {
    const sqlite = new BetterSqlite3(':memory:');
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });

    await expect(migration.run(db, 'sqlite')).resolves.toBeUndefined();
    await db.destroy();
  });
});
