export interface DiscoveredColumn {
  readonly name: string;
  readonly declaredType: string;
  readonly nullable: boolean;
  readonly ordinal: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly hasSequence: boolean;
}

export interface DiscoveredForeignKey {
  readonly column: string;
  readonly parentTable: string;
  readonly parentColumn: string;
}

export interface DiscoveredTable {
  name: string;
  columns: readonly DiscoveredColumn[];
  primaryKey: readonly string[];
  dependsOn: readonly string[];
  foreignKeys: readonly DiscoveredForeignKey[];
  sequenceColumns: readonly string[];
  readonly indexes?: readonly { name: string; columns: readonly string[]; unique: boolean }[];
}

export interface DiscoveredSchema {
  readonly dialect: 'sqlite' | 'postgres';
  readonly tables: readonly DiscoveredTable[];
}

interface SqliteConnection {
  prepare(sql: string): { all(...parameters: unknown[]): unknown[] };
}

interface SqliteMasterRow {
  name: string;
  sql: string | null;
}

interface SqliteTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

interface SqliteForeignKeyRow {
  table: string;
  from: string;
  to: string;
}
interface SqliteIndexRow { name: string; unique: number; }
interface SqliteIndexInfoRow { name: string; seqno: number; }

interface PostgresQueryResult<Row> {
  rows: Row[];
}

interface PostgresConnection {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeDeclaredType(type: string | null | undefined): string {
  return (type ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function discoverSqliteSchema(connection: SqliteConnection): DiscoveredSchema {
  const masterRows = connection.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'migrations'
    ORDER BY name
  `).all() as SqliteMasterRow[];

  const tables = masterRows.map((master) => {
    const tableIdentifier = quoteSqliteIdentifier(master.name);
    const info = connection.prepare(`PRAGMA table_info(${tableIdentifier})`).all() as SqliteTableInfoRow[];
    const foreignKeys = connection.prepare(`PRAGMA foreign_key_list(${tableIdentifier})`).all() as SqliteForeignKeyRow[];
    const indexes = (connection.prepare(`PRAGMA index_list(${tableIdentifier})`).all() as SqliteIndexRow[]).map((index) => ({
      name: index.name,
      unique: index.unique === 1,
      columns: (connection.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as SqliteIndexInfoRow[])
        .sort((left, right) => left.seqno - right.seqno).map((column) => column.name),
    }));
    const primaryKey = info
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    const hasAutoincrement = /\bAUTOINCREMENT\b/i.test(master.sql ?? '');
    const sequenceColumns = hasAutoincrement
      ? info.filter((column) => column.pk > 0 && /^INTEGER$/i.test(column.type)).map((column) => column.name)
      : [];

    return {
      name: master.name,
      columns: info
        .sort((left, right) => left.cid - right.cid)
        .map((column) => ({
          name: column.name,
          declaredType: normalizeDeclaredType(column.type),
          // SQLite may report `notnull = 0` for a table-level TEXT PRIMARY KEY;
          // the primary-key constraint is still non-null in the transfer contract.
          nullable: column.notnull === 0 && column.pk === 0,
          ordinal: column.cid,
          hasSequence: sequenceColumns.includes(column.name),
        })),
      primaryKey,
      dependsOn: [...new Set(foreignKeys.map((foreignKey) => foreignKey.table))].sort(),
      foreignKeys: foreignKeys.map((foreignKey) => ({
        column: foreignKey.from,
        parentTable: foreignKey.table,
        parentColumn: foreignKey.to,
      })),
      sequenceColumns,
      indexes,
    } satisfies DiscoveredTable;
  });

  return { dialect: 'sqlite', tables };
}

interface PostgresColumnRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  numeric_precision: number | null;
  numeric_scale: number | null;
  column_default: string | null;
  is_identity: 'YES' | 'NO';
}

interface PostgresKeyRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
}

interface PostgresForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
}
interface PostgresSequenceRow { table_name: string; column_name: string; sequence_name: string | null; }

export async function discoverPostgresSchema(connection: PostgresConnection): Promise<DiscoveredSchema> {
  const columns = (await connection.query<PostgresColumnRow>(`
    SELECT table_name, column_name, ordinal_position, data_type, udt_name,
           is_nullable, numeric_precision, numeric_scale, column_default, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name <> 'migrations'
    ORDER BY table_name, ordinal_position
  `)).rows;
  const primaryKeys = (await connection.query<PostgresKeyRow>(`
    SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY tc.table_name, kcu.ordinal_position
  `)).rows;
  const foreignKeys = (await connection.query<PostgresForeignKeyRow>(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, kcu.column_name
  `)).rows;
  const sequences = (await connection.query<PostgresSequenceRow>(`
    SELECT c.table_name, c.column_name,
           pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS sequence_name
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public' AND c.table_name <> 'migrations'
  `)).rows;

  const byTable = new Map<string, DiscoveredTable>();
  for (const column of columns) {
    const table = byTable.get(column.table_name) ?? {
      name: column.table_name,
      columns: [],
      primaryKey: [],
      dependsOn: [],
      foreignKeys: [],
      sequenceColumns: [],
    } satisfies DiscoveredTable;
    const declaredType = `${column.data_type.toUpperCase()}${column.udt_name && column.udt_name !== column.data_type ? ` (${column.udt_name})` : ''}`;
    const nextColumn: DiscoveredColumn = {
      name: column.column_name,
      declaredType,
      nullable: column.is_nullable === 'YES',
      ordinal: column.ordinal_position,
      ...(column.numeric_precision === null ? {} : { precision: Number(column.numeric_precision) }),
      ...(column.numeric_scale === null ? {} : { scale: Number(column.numeric_scale) }),
      hasSequence: column.is_identity === 'YES' || (column.column_default ?? '').includes('nextval('),
    };
    table.columns = [...table.columns, nextColumn];
    if (nextColumn.hasSequence) table.sequenceColumns = [...table.sequenceColumns, nextColumn.name];
    byTable.set(table.name, table);
  }

  for (const key of primaryKeys) {
    const table = byTable.get(key.table_name);
    if (table) table.primaryKey = [...table.primaryKey, key.column_name];
  }
  for (const foreignKey of foreignKeys) {
    const table = byTable.get(foreignKey.table_name);
    if (!table) continue;
    table.foreignKeys = [...table.foreignKeys, {
      column: foreignKey.column_name,
      parentTable: foreignKey.foreign_table_name,
      parentColumn: foreignKey.foreign_column_name,
    }];
    table.dependsOn = [...new Set([...table.dependsOn, foreignKey.foreign_table_name])].sort();
  }
  for (const sequence of sequences) {
    if (!sequence.sequence_name) continue;
    const table = byTable.get(sequence.table_name);
    if (!table || table.sequenceColumns.includes(sequence.column_name)) continue;
    table.sequenceColumns = [...table.sequenceColumns, sequence.column_name];
    table.columns = table.columns.map((column) => column.name === sequence.column_name ? { ...column, hasSequence: true } : column);
  }

  return {
    dialect: 'postgres',
    tables: [...byTable.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}
