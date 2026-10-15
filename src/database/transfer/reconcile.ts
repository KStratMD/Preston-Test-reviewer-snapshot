import type { BundleFrame, CanonicalValue } from './types';
import type { TransferManifest } from './manifest';
import { canonicalize } from './canonicalize';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from './digests';
import { discoverPostgresSchema } from './schemaDiscovery';
import { assertPostgresMatchesManifest } from './manifestAuthoring';

interface Queryable { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
function quote(identifier: string): string { return `"${identifier.replace(/"/g, '""')}"`; }
function quoteQualified(identifier: string): string { return identifier.split('.').map(quote).join('.'); }

function targetInput(value: unknown, kind: string): unknown {
  if (value instanceof Date) return value.toISOString();
  if (kind === 'json' && value && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export interface ReconciliationMismatch {
  readonly table: string;
  readonly code: 'ROW_COUNT_MISMATCH' | 'DIGEST_MISMATCH' | 'MIGRATION_HISTORY_MISMATCH' | 'SCHEMA_MISMATCH' | 'FOREIGN_KEY_MISMATCH' | 'SEED_MISMATCH' | 'SEQUENCE_MISMATCH';
  readonly expected?: string;
  readonly actual?: string;
}

export interface ReconcileOptions { readonly verifyMetadata?: boolean; }

function seedKey(table: TransferManifest['tables'][number], row: Record<string, unknown>, columns: readonly string[]): string {
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  return columns.map((name) => {
    const column = byName.get(name);
    if (!column) throw new Error(`Unknown seed identity column: ${table.name}.${name}`);
    return JSON.stringify(canonicalize(row[name], column.kind, column));
  }).join('|');
}

async function verifyMetadata(client: Queryable, manifest: TransferManifest): Promise<ReconciliationMismatch[]> {
  const mismatches: ReconciliationMismatch[] = [];
  try {
    const result = await client.query('SELECT name FROM public.migrations ORDER BY id');
    const actual = result.rows.map((row) => String(row.name));
    if (actual.length !== manifest.migrationNames.length || actual.some((name, index) => name !== manifest.migrationNames[index])) {
      mismatches.push({ table: 'migrations', code: 'MIGRATION_HISTORY_MISMATCH', expected: String(manifest.migrationNames.length), actual: String(actual.length) });
    }
  } catch {
    mismatches.push({ table: 'migrations', code: 'MIGRATION_HISTORY_MISMATCH' });
  }

  try {
    assertPostgresMatchesManifest(await discoverPostgresSchema(client as unknown as Parameters<typeof discoverPostgresSchema>[0]), manifest);
  } catch {
    mismatches.push({ table: '__schema__', code: 'SCHEMA_MISMATCH' });
  }

  try {
    const invalid = await client.query("SELECT COUNT(*)::text AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated");
    if (Number(invalid.rows[0]?.count ?? 0) !== 0) mismatches.push({ table: '__foreign_keys__', code: 'FOREIGN_KEY_MISMATCH', expected: '0', actual: String(invalid.rows[0]?.count ?? '0') });
  } catch {
    mismatches.push({ table: '__foreign_keys__', code: 'FOREIGN_KEY_MISMATCH' });
  }

  for (const table of manifest.tables) {
    if (table.seed) {
      try {
        const columns = table.seed.identityColumns;
        const rows = (await client.query(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table.name)}`)).rows;
        const expected = new Set(table.seed.identities.map((identity) => seedKey(table, Object.fromEntries(columns.map((column, index) => [column, identity[index]])), columns)));
        const actual = new Set(rows.map((row) => seedKey(table, row, columns)));
        if (rows.length !== expected.size || actual.size !== expected.size || [...expected].some((identity) => !actual.has(identity))) {
          mismatches.push({ table: table.name, code: 'SEED_MISMATCH', expected: String(expected.size), actual: String(rows.length) });
        }
      } catch {
        mismatches.push({ table: table.name, code: 'SEED_MISMATCH' });
      }
    }

    for (const sequenceColumn of table.sequenceColumns) {
      try {
        const sequenceResult = await client.query('SELECT pg_get_serial_sequence($1, $2) AS sequence_name', [`public.${table.name}`, sequenceColumn]);
        const sequenceName = String(sequenceResult.rows[0]?.sequence_name ?? '');
        if (!sequenceName) throw new Error('missing sequence');
        const state = await client.query(`SELECT last_value::text AS last_value, is_called FROM ${quoteQualified(sequenceName)}`);
        const rows = await client.query(`SELECT COUNT(*)::text AS count, MAX(${quote(sequenceColumn)})::text AS max_value FROM ${quote(table.name)}`);
        const count = Number(rows.rows[0]?.count ?? 0);
        const maxValue = rows.rows[0]?.max_value == null ? null : BigInt(String(rows.rows[0].max_value));
        const lastValue = BigInt(String(state.rows[0]?.last_value ?? '0'));
        const isCalled = Boolean(state.rows[0]?.is_called);
        if ((maxValue !== null && lastValue < maxValue) || (maxValue === null && isCalled)) {
          mismatches.push({ table: `${table.name}.${sequenceColumn}`, code: 'SEQUENCE_MISMATCH' });
        }
      } catch {
        mismatches.push({ table: `${table.name}.${sequenceColumn}`, code: 'SEQUENCE_MISMATCH' });
      }
    }
  }
  return mismatches;
}

export async function reconcilePostgres(client: Queryable, frames: readonly BundleFrame[], manifest: TransferManifest, options: ReconcileOptions = {}): Promise<{ ok: boolean; mismatches: readonly ReconciliationMismatch[] }> {
  const mismatches: ReconciliationMismatch[] = options.verifyMetadata ? await verifyMetadata(client, manifest) : [];
  const ends = new Map(frames.filter((frame): frame is Extract<BundleFrame, { type: 'table_end' }> => frame.type === 'table_end').map((frame) => [frame.table, frame]));
  for (const table of manifest.tables) {
    const textCastKinds = new Set<string>(['json', 'date', 'instant_utc', 'naive_timestamp']);
    const select = table.columns.map((column) => textCastKinds.has(column.kind) ? `${quote(column.name)}::text AS ${quote(column.name)}` : quote(column.name)).join(', ');
    const rows = (await client.query(`SELECT ${select} FROM ${quote(table.name)} ORDER BY ${table.sortColumns.map(quote).join(', ')}`)).rows;
    const digests: Buffer[] = [];
    for (const row of rows) {
      const values: CanonicalValue[] = table.columns.map((column) => canonicalize(targetInput(row[column.name], column.kind), column.kind, column));
      digests.push(digestCanonicalRow(values));
    }
    const expected = ends.get(table.name);
    if (!expected || expected.rowCount !== rows.length) mismatches.push({ table: table.name, code: 'ROW_COUNT_MISMATCH', expected: String(expected?.rowCount ?? -1), actual: String(rows.length) });
    const actualDigest = digestHex(digestCanonicalTable(digests));
    if (!expected || expected.digest !== actualDigest) mismatches.push({ table: table.name, code: 'DIGEST_MISMATCH', expected: expected?.digest, actual: actualDigest });
  }
  return { ok: mismatches.length === 0, mismatches };
}
