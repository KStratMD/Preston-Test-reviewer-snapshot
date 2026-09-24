import BetterSqlite3 from 'better-sqlite3';
import { discoverSqliteSchema } from '../../../../src/database/transfer/schemaDiscovery';

describe('SQLite transfer schema discovery', () => {
  it('discovers columns, primary keys, and parent dependencies while excluding internal tables', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id TEXT PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE child (
        child_id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id TEXT NOT NULL REFERENCES parent(id),
        payload TEXT
      );
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    `);

    const schema = discoverSqliteSchema(db);
    expect(schema.tables.map((table) => table.name)).toEqual(['child', 'parent']);
    expect(schema.tables.find((table) => table.name === 'child')).toMatchObject({
      primaryKey: ['child_id'],
      dependsOn: ['parent'],
      sequenceColumns: ['child_id'],
    });
    expect(schema.tables.find((table) => table.name === 'parent')?.columns).toEqual([
      expect.objectContaining({ name: 'id', declaredType: 'TEXT', nullable: false }),
      expect.objectContaining({ name: 'label', declaredType: 'TEXT', nullable: false }),
    ]);
    db.close();
  });
});
