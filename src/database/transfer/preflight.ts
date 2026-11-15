import { canonicalize, detectUuidCollisions } from './canonicalize';
import type { TransferManifest, ManifestColumn } from './manifest';
import { discoverSqliteSchema } from './schemaDiscovery';
import type { EvidenceReport, EvidenceCheck } from './types';
import { SqliteTransferSource } from './sqliteSource';

export interface PreflightFinding {
  readonly phase: 'preflight';
  readonly code: string;
  readonly table?: string;
  readonly column?: string;
  readonly count: number;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly findings: readonly PreflightFinding[];
  readonly sourceSha256: string;
  readonly evidence: EvidenceReport;
}

function finding(code: string, table?: string, column?: string, count = 1): PreflightFinding {
  return { phase: 'preflight', code, ...(table ? { table } : {}), ...(column ? { column } : {}), count };
}

function makeEvidence(findings: readonly PreflightFinding[]): EvidenceReport {
  const requiredNames = ['sqlite_integrity_check', 'sqlite_foreign_key_check', 'schema_match', 'value_compatibility'];
  const checks: EvidenceCheck[] = requiredNames.map((name) => ({
    name,
    status: findings.length === 0 ? 'passed' : 'failed',
    ...(findings.length ? { code: findings[0]?.code } : {}),
  }));
  return { format: 'db-transfer-evidence/v1', status: findings.length === 0 ? 'passed' : 'failed', checks };
}

function compareSchema(source: ReturnType<typeof discoverSqliteSchema>, manifest: TransferManifest): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const expected = new Map(manifest.tables.map((table) => [table.name, table]));
  const actual = new Map(source.tables.map((table) => [table.name, table]));
  for (const table of source.tables) {
    const declared = expected.get(table.name);
    if (!declared) { findings.push(finding('UNKNOWN_TABLE', table.name)); continue; }
    const columns = new Map(table.columns.map((column) => [column.name, column]));
    const manifestColumns = new Map(declared.columns.map((column) => [column.name, column]));
    for (const column of table.columns) if (!manifestColumns.has(column.name)) findings.push(finding('UNKNOWN_COLUMN', table.name, column.name));
    for (const column of declared.columns) if (!columns.has(column.name)) findings.push(finding('MISSING_COLUMN', table.name, column.name));
    if (table.primaryKey.join(',') !== declared.primaryKey.join(',')) findings.push(finding('PRIMARY_KEY_DRIFT', table.name));
    for (const column of table.columns) {
      const expectedColumn = manifestColumns.get(column.name);
      if (!expectedColumn) continue;
      if (column.declaredType !== expectedColumn.sourceType) findings.push(finding('SOURCE_TYPE_DRIFT', table.name, column.name));
      if (column.nullable !== expectedColumn.sourceNullable) findings.push(finding('SOURCE_NULLABILITY_DRIFT', table.name, column.name));
    }
  }
  for (const table of manifest.tables) if (!actual.has(table.name)) findings.push(finding('MISSING_TABLE', table.name));
  return findings;
}

export function runSqlitePreflight(source: SqliteTransferSource, manifest: TransferManifest): PreflightResult {
  const findings: PreflightFinding[] = [];
  const before = source.sha256();
  source.beginRead();
  try {
    const integrity = source.integrityCheck();
    if (integrity.length !== 1 || integrity[0] !== 'ok') findings.push(finding('SQLITE_INTEGRITY_CHECK'));
    if (source.foreignKeyCheck().length > 0) findings.push(finding('SQLITE_FOREIGN_KEY_CHECK'));
    const schema = discoverSqliteSchema(source.db);
    findings.push(...compareSchema(schema, manifest));
    const actualTables = new Map(schema.tables.map((table) => [table.name, table]));
    for (const table of manifest.tables) {
      const actualTable = actualTables.get(table.name);
      if (!actualTable) continue;
      const actualColumns = new Set(actualTable.columns.map((column) => column.name));
      const requiredColumns = [...table.columns.map((column) => column.name), ...table.sortColumns];
      if (requiredColumns.some((column) => !actualColumns.has(column))) continue;
      const uuidValues: { table: string; column: string; value: unknown }[] = [];
      const rows = source.rows(table.name, table.columns.map((column) => column.name), table.sortColumns);
      for (const row of rows) {
        for (const column of table.columns) {
          try {
            canonicalize(row[column.name], column.kind, column);
            if (column.kind === 'uuid' && row[column.name] !== null && row[column.name] !== undefined) uuidValues.push({ table: table.name, column: column.name, value: row[column.name] });
          } catch (error) {
            const code = column.kind === 'json' ? 'INVALID_JSON' : column.kind === 'naive_timestamp' || column.kind === 'instant_utc' ? 'INVALID_TIMESTAMP' : `INVALID_${column.kind.toUpperCase()}`;
            findings.push(finding(code, table.name, column.name));
          }
        }
      }
      try { detectUuidCollisions(uuidValues); } catch { findings.push(finding('UUID_COLLISION', table.name)); }
    }
  } finally {
    source.endRead();
  }
  const after = source.sha256();
  if (before !== after) findings.push(finding('SOURCE_MUTATED'));
  const aggregate = new Map<string, PreflightFinding>();
  for (const item of findings) {
    const key = `${item.code}\u0000${item.table ?? ''}\u0000${item.column ?? ''}`;
    const prior = aggregate.get(key);
    aggregate.set(key, prior ? { ...prior, count: prior.count + item.count } : item);
  }
  const finalFindings = [...aggregate.values()];
  return { ok: finalFindings.length === 0, findings: finalFindings, sourceSha256: before, evidence: makeEvidence(finalFindings) };
}
