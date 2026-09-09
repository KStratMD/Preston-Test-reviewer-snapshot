import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { MIGRATIONS } from '../../../src/database/migrations';
import type { Database } from '../../../src/database/types';
import manifestJson from '../../../src/database/transfer/manifest.generated.json';
import { parseTransferManifest, type TransferManifest } from '../../../src/database/transfer/manifest';
import { exportSqliteBundle } from '../../../src/database/transfer/exporter';

export const transferManifest: TransferManifest = parseTransferManifest(manifestJson);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function waitForDatabaseConnectionsToDrain(admin: Pool, databaseName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    if (result.rows.length === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PostgreSQL connections to drain: ${databaseName}`);
}

export interface TemporaryPostgresDatabase {
  readonly connectionString: string;
  close(): Promise<void>;
}

/** Create an isolated database inside the CI Postgres service. */
export async function createTemporaryPostgresDatabase(): Promise<TemporaryPostgresDatabase> {
  const baseUrl = new URL(process.env.DATABASE_URL ?? '');
  const databaseName = `preston_transfer_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const adminUrl = new URL(baseUrl.toString());
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  const targetUrl = new URL(baseUrl.toString());
  targetUrl.pathname = `/${databaseName}`;
  let closed = false;
  return {
    connectionString: targetUrl.toString(),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        // Let pg clients finish their normal close handshake before dropping
        // the disposable database. FORCE can emit an unhandled 57P01 error
        // from an idle pg-pool client even after pool.end() resolves.
        await waitForDatabaseConnectionsToDrain(admin, databaseName);
        await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    },
  };
}

export interface TransferFixture {
  readonly directory: string;
  readonly bundlePath: string;
  readonly key: Buffer;
  readonly sourceSnapshotSha256: string;
  readonly rowCount: number;
  cleanup(): void;
}

/** Build a fully migrated SQLite source and its authenticated transfer bundle. */
export async function createTransferFixture(): Promise<TransferFixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-transfer-postgres-'));
  const sourcePath = path.join(directory, 'source.sqlite');
  const bundlePath = path.join(directory, 'capture.bundle');
  const raw = new BetterSqlite3(sourcePath);
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) });
  try {
    for (const migration of MIGRATIONS) await migration.run(db, 'sqlite');
    // Exercise the one reviewed dialect adapter: SQLite keeps the legacy
    // permission list as JSON text while PostgreSQL stores TEXT[].
    raw.prepare(`
      INSERT INTO api_keys
        (id, key_name, key_hash, key_prefix, permissions, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '550e8400-e29b-41d4-a716-446655440000',
      'transfer-fixture',
      'transfer-fixture-hash',
      'trnsfr01',
      '["read","write"]',
      1,
      'transfer-fixture-user',
    );
  } finally {
    await db.destroy();
    raw.close();
  }

  const key = randomBytes(32);
  const result = exportSqliteBundle({ sourcePath, outputPath: bundlePath, key, manifest: transferManifest });
  return {
    directory,
    bundlePath,
    key,
    sourceSnapshotSha256: result.sourceSha256,
    rowCount: result.rowCount,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
