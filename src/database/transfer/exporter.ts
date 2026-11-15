import fs from 'node:fs';
import path from 'node:path';
import type { BundleFrame, CanonicalValue } from './types';
import { orderTransferTables, type TransferManifest } from './manifest';
import { canonicalize } from './canonicalize';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from './digests';
import { encodeBundle } from './bundleCrypto';
import { runSqlitePreflight } from './preflight';
import { SqliteTransferSource } from './sqliteSource';

export interface ExportOptions {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly key: Uint8Array;
  readonly manifest: TransferManifest;
}

export interface ExportResult {
  readonly outputPath: string;
  readonly sourceSha256: string;
  readonly bundleBytes: number;
  readonly tableCount: number;
  readonly rowCount: number;
}

export function exportSqliteBundle(options: ExportOptions): ExportResult {
  const source = new SqliteTransferSource({ filePath: options.sourcePath });
  try {
    const preflight = runSqlitePreflight(source, options.manifest);
    if (!preflight.ok) throw new Error(`SQLite preflight failed: ${preflight.findings[0]?.code ?? 'UNKNOWN'}`);
    source.beginRead();
    const frames: BundleFrame[] = [{
      type: 'bundle_header', formatVersion: 1,
      sourceSnapshotSha256: preflight.sourceSha256,
      migrationManifestHash: options.manifest.migrationManifestHash,
    }];
    let totalRows = 0;
    for (const table of orderTransferTables(options.manifest.tables)) {
      frames.push({ type: 'table_start', table: table.name, columns: table.columns.map((column) => column.name) });
      const rowDigests: Buffer[] = [];
      for (const row of source.rows(table.name, table.columns.map((column) => column.name), table.sortColumns)) {
        const values: Record<string, CanonicalValue> = {};
        const ordered: CanonicalValue[] = [];
        for (const column of table.columns) {
          const value = canonicalize(row[column.name], column.kind, column);
          values[column.name] = value; ordered.push(value);
        }
        const digest = digestCanonicalRow(ordered); rowDigests.push(digest); totalRows += 1;
        frames.push({ type: 'row', table: table.name, values, digest: digestHex(digest) });
      }
      frames.push({ type: 'table_end', table: table.name, rowCount: rowDigests.length, digest: digestHex(digestCanonicalTable(rowDigests)) });
    }
    frames.push({ type: 'bundle_end', tableCount: options.manifest.tables.length, migrationManifestHash: options.manifest.migrationManifestHash });
    source.endRead();
    if (source.sha256() !== preflight.sourceSha256) throw new Error('SQLite source changed during export');
    const encoded = encodeBundle(frames, options.key);
    if (fs.existsSync(options.outputPath)) throw new Error('Bundle destination already exists');
    const temporary = `${path.resolve(options.outputPath)}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, encoded, { flag: 'wx' });
    fs.renameSync(temporary, options.outputPath);
    return { outputPath: options.outputPath, sourceSha256: preflight.sourceSha256, bundleBytes: encoded.length, tableCount: options.manifest.tables.length, rowCount: totalRows };
  } finally {
    source.close();
  }
}
