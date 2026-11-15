import fs from 'node:fs';
import { Pool, types as pgTypes, type CustomTypesConfig, type PoolClient } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { MigrationRunner } from '../MigrationRunner';
import { MIGRATIONS } from '../migrations';
import type { Database } from '../types';
import type { BundleFrame, CanonicalValue } from './types';
import { orderTransferTables, type TransferManifest } from './manifest';
import { decodeBundle } from './bundleCrypto';
import { discoverPostgresSchema } from './schemaDiscovery';
import { assertPostgresMatchesManifest } from './manifestAuthoring';
import { parseTargetIdentity } from './targetIdentity';
import { canonicalize } from './canonicalize';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from './digests';
import { reconcilePostgres } from './reconcile';

interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number; }
interface Queryable { query(text: string, values?: readonly unknown[]): Promise<QueryResult>; }

const RAW_TEXT_OIDS = new Set([1082, 1114, 1184, 700, 701, 114, 3802]);

function transferTypeOverrides(): CustomTypesConfig {
  return {
    getTypeParser: (oid, format) => RAW_TEXT_OIDS.has(oid)
      ? ((value: string | Buffer) => typeof value === 'string' ? value : Buffer.from(value).toString('utf8'))
      : pgTypes.getTypeParser(oid, format),
  };
}

function quote(identifier: string): string { return `"${identifier.replace(/"/g, '""')}"`; }

function bind(value: CanonicalValue): unknown {
  if (value.type === 'null') return null;
  if (value.type === 'boolean') return value.value;
  if (value.type === 'binary') return Buffer.from(value.value, 'base64');
  if (value.type === 'text_array') return JSON.parse(value.value) as string[];
  return value.value;
}

function columnExpression(column: string, value: CanonicalValue, index: number): string {
  const placeholder = `$${index + 1}`;
  if (value.type === 'json') return `CAST(${placeholder} AS JSONB)`;
  if (value.type === 'text_array') return `CAST(${placeholder} AS TEXT[])`;
  return placeholder;
}

export interface PostgresTargetOptions {
  readonly connectionString: string;
  readonly manifest: TransferManifest;
  readonly readOnly?: boolean;
}

export class PostgresTransferTarget {
  readonly pool: Pool;
  readonly manifest: TransferManifest;
  private readonly connectionString: string;

  constructor(options: PostgresTargetOptions) {
    parseTargetIdentity(options.connectionString);
    this.connectionString = options.connectionString;
    const sessionOptions = ['-c timezone=UTC', ...(options.readOnly ? ['-c default_transaction_read_only=on'] : [])].join(' ');
    this.pool = new Pool({ connectionString: options.connectionString, max: 2, options: sessionOptions, types: transferTypeOverrides() });
    this.manifest = options.manifest;
  }

  async assertFresh(client: Queryable = this.pool): Promise<void> {
    const migrations = await client.query(`SELECT name FROM public.migrations ORDER BY id`).catch((): QueryResult => ({ rows: [] }));
    if (migrations.rows.length > 0) throw new Error('Target database is not fresh');
    const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'migrations'`);
    if (tables.rows.length > 0) throw new Error('Target database contains pre-existing tables');
  }

  async close(): Promise<void> { await this.pool.end(); }

  async initializeFreshSchema(): Promise<void> {
    await this.assertFresh();
    // Kysely owns and ends the pool supplied to its dialect on destroy(). Use
    // a migration-only pool so cleanup cannot close the transfer target pool
    // that import/reconcile still need.
    const migrationPool = new Pool({ connectionString: this.connectionString, max: 2, options: '-c timezone=UTC', types: transferTypeOverrides() });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: migrationPool }) });
    const logger = { debug: (): void => undefined } as never;
    try { await new MigrationRunner({ db, dbType: 'postgres', modules: MIGRATIONS, logger }).runAll(); }
    finally { await db.destroy(); }
    assertPostgresMatchesManifest(await discoverPostgresSchema(this.pool), this.manifest);
  }
}

async function importFrames(client: PoolClient, frames: readonly BundleFrame[], manifest: TransferManifest): Promise<{ rowCount: number }> {
  const byTable = new Map(manifest.tables.map((table) => [table.name, table]));
  let rowCount = 0;
  await client.query('BEGIN');
  try {
    await verifyAndDeleteSeedBaseline(client, manifest);
    const rowDigests = new Map<string, Buffer[]>();
    const rowCounts = new Map<string, number>();
    const starts = new Map<string, readonly string[]>();
    for (const frame of frames) {
      if (frame.type === 'table_start') {
        const table = byTable.get(frame.table);
        if (!table || frame.columns.join('\u0000') !== table.columns.map((column) => column.name).join('\u0000')) throw new Error(`Bundle table columns mismatch: ${frame.table}`);
        starts.set(frame.table, frame.columns);
        rowDigests.set(frame.table, []); rowCounts.set(frame.table, 0);
        continue;
      }
      if (frame.type === 'table_end') {
        const digests = rowDigests.get(frame.table);
        if (!starts.has(frame.table) || !digests || frame.rowCount !== (rowCounts.get(frame.table) ?? 0) || frame.digest !== digestHex(digestCanonicalTable(digests))) throw new Error(`Bundle table digest mismatch: ${frame.table}`);
        continue;
      }
      if (frame.type !== 'row') continue;
      const table = byTable.get(frame.table);
      if (!table) throw new Error(`Bundle table is not governed: ${frame.table}`);
      const columns = table.columns.map((column) => column.name);
      const orderedValues = columns.map((column) => frame.values[column]);
      if (orderedValues.some((value) => value === undefined)) throw new Error(`Bundle row columns mismatch: ${frame.table}`);
      if (Object.keys(frame.values).length !== columns.length) throw new Error(`Bundle row has unknown columns: ${frame.table}`);
      for (const [index, column] of table.columns.entries()) {
        const value = orderedValues[index]!;
        if (value.type !== 'null' && value.type !== column.kind) throw new Error(`Bundle row type mismatch: ${frame.table}.${column.name}`);
      }
      const digest = digestCanonicalRow(orderedValues);
      if (frame.digest !== digestHex(digest)) throw new Error(`Bundle row digest mismatch: ${frame.table}`);
      const sql = `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) VALUES (${orderedValues.map((value, index) => columnExpression(columns[index]!, value!, index)).join(', ')})`;
      await client.query(sql, orderedValues.map(bind)); rowCount += 1;
      rowDigests.get(frame.table)?.push(digest);
      rowCounts.set(frame.table, (rowCounts.get(frame.table) ?? 0) + 1);
    }
    for (const table of manifest.tables) if (!starts.has(table.name)) throw new Error(`Bundle table is missing: ${table.name}`);
    await reseedSequences(client, manifest);
    const reconciliation = await reconcilePostgres(client, frames, manifest);
    if (!reconciliation.ok) throw new Error('PostgreSQL reconciliation failed during import');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch((): undefined => undefined);
    throw error;
  }
  return { rowCount };
}

function canonicalIdentityKey(table: TransferManifest['tables'][number], row: Record<string, unknown>, identityColumns: readonly string[]): string {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  return identityColumns.map((name) => {
    const column = columns.get(name);
    if (!column) throw new Error(`Unknown seed identity column: ${table.name}.${name}`);
    return JSON.stringify(canonicalize(row[name], column.kind, column));
  }).join('|');
}

async function verifyAndDeleteSeedBaseline(client: Queryable, manifest: TransferManifest): Promise<void> {
  // Verification here checks only that the expected identity set is present in
  // the target (each seed row identified by its identityColumns matches exactly).
  // It does NOT perform a full row-value comparison, so SeedBaseline
  // volatileColumns/volatileJsonPaths are not yet enforced at this level.
  // They are reserved for a future row-level verification pass.
  for (const table of manifest.tables) {
    if (!table.seed) {
      const result = await client.query(`SELECT COUNT(*)::text AS count FROM ${quote(table.name)}`);
      if (Number(result.rows[0]?.count ?? 0) !== 0) throw new Error(`Target table is not empty: ${table.name}`);
      continue;
    }
    const identityColumns = table.seed.identityColumns;
    const rows = (await client.query(`SELECT ${identityColumns.map(quote).join(', ')} FROM ${quote(table.name)}`)).rows;
    const expected = new Set(table.seed.identities.map((identity) => canonicalIdentityKey(table, Object.fromEntries(identityColumns.map((column, index) => [column, identity[index]])), identityColumns)));
    const actual = new Set(rows.map((row) => canonicalIdentityKey(table, row, identityColumns)));
    if (rows.length !== expected.size || actual.size !== expected.size || [...expected].some((identity) => !actual.has(identity))) throw new Error(`Target seed baseline mismatch: ${table.name}`);
  }

  // Delete only the recognized seeds, child-before-parent, within the import
  // transaction. No force/overwrite path exists for other target rows.
  for (const table of orderTransferTables(manifest.tables).reverse()) {
    if (!table.seed) continue;
    const identities = table.seed.identities;
    if (identities.length === 0) continue;
    const values: unknown[] = [];
    const predicates = identities.map((identity) => {
      const parts = table.seed!.identityColumns.map((column, index) => {
        const manifestColumn = table.columns.find((candidate) => candidate.name === column);
        if (!manifestColumn) throw new Error(`Unknown seed identity column: ${table.name}.${column}`);
        values.push(bind(canonicalize(identity[index], manifestColumn.kind, manifestColumn)));
        return `${quote(column)} = $${values.length}`;
      });
      return `(${parts.join(' AND ')})`;
    });
    await client.query(`DELETE FROM ${quote(table.name)} WHERE ${predicates.join(' OR ')}`, values);
  }
}

async function reseedSequences(client: Queryable, manifest: TransferManifest): Promise<void> {
  for (const table of manifest.tables) {
    for (const sequenceColumn of table.sequenceColumns) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quote(sequenceColumn)}) FROM ${quote(table.name)}), 1), (SELECT COUNT(*) > 0 FROM ${quote(table.name)}))`, [`public.${table.name}`, sequenceColumn]);
    }
  }
}

export interface ImportOptions {
  readonly bundlePath: string;
  readonly key: Uint8Array;
  readonly connectionString: string;
  readonly manifest: TransferManifest;
  readonly targetFactory?: (connectionString: string, manifest: TransferManifest) => PostgresTransferTarget;
}

export async function importBundleIntoPostgres(options: ImportOptions): Promise<{ rowCount: number }> {
  const bundleBytes = fs.readFileSync(options.bundlePath);
  // Authentication and full frame validation deliberately happen before the
  // target object is constructed, so a bad bundle cannot open a DB connection.
  const frames = decodeBundle(bundleBytes, options.key);
  const header = frames[0];
  if (header?.type !== 'bundle_header' || header.migrationManifestHash !== options.manifest.migrationManifestHash) throw new Error('Bundle manifest hash mismatch');
  const target = (options.targetFactory ?? ((connectionString, manifest) => new PostgresTransferTarget({ connectionString, manifest })))(options.connectionString, options.manifest);
  try {
    await target.initializeFreshSchema();
    const client = await target.pool.connect();
    try { return await importFrames(client, frames, options.manifest); } finally { client.release(); }
  } finally { await target.close(); }
}
