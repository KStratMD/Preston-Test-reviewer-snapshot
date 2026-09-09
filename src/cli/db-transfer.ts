import fs from 'node:fs';
import { Command } from 'commander';
import manifestJson from '../database/transfer/manifest.generated.json';
import { parseTransferManifest } from '../database/transfer/manifest';
import { decodeBundle, decodeBundleKey } from '../database/transfer/bundleCrypto';
import { exportSqliteBundle } from '../database/transfer/exporter';
import { runSqlitePreflight } from '../database/transfer/preflight';
import { SqliteTransferSource } from '../database/transfer/sqliteSource';
import { PostgresTransferTarget, importBundleIntoPostgres } from '../database/transfer/postgresTarget';
import { reconcilePostgres } from '../database/transfer/reconcile';
import { parseTargetIdentity } from '../database/transfer/targetIdentity';
import { EvidenceReportBuilder, writeEvidenceReportAtomic } from '../database/transfer/evidence';

const manifest = parseTransferManifest(manifestJson);
let activeReportPath: string | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required through the environment`);
  return value;
}

function optionPath(options: { sqlite?: string; source?: string }): string {
  const value = options.sqlite ?? options.source;
  if (!value) throw new Error('--sqlite is required');
  return value;
}

function bundlePath(options: { bundle?: string; output?: string }): string {
  const value = options.bundle ?? options.output;
  if (!value) throw new Error('--bundle is required');
  return value;
}

function requirePostgresTarget(expectedFingerprint: string): { connectionString: string; fingerprint: string } {
  if (process.env.DB_TYPE !== 'postgres') throw new Error('DB_TYPE must be postgres');
  const connectionString = requiredEnv('DATABASE_URL');
  const fingerprint = parseTargetIdentity(connectionString).fingerprint;
  if (fingerprint !== expectedFingerprint) throw new Error('Target fingerprint mismatch');
  return { connectionString, fingerprint };
}

function writeChecks(reportPath: string | undefined, checks: readonly { name: string; status: 'passed' | 'failed'; code?: string }[]): void {
  if (!reportPath) return;
  const builder = new EvidenceReportBuilder(checks.map((check) => check.name));
  for (const check of checks) builder.addCheck(check);
  writeEvidenceReportAtomic(reportPath, builder.build());
}

function reportOption(command: Command): Command {
  return command.option('--report <path>', 'value-free evidence report path');
}

const program = new Command()
  .name('db-transfer')
  .description('Fail-closed SQLite to PostgreSQL preservation tooling')
  .addHelpText('after', '\ninit-target, import, and reconcile are separately approved target actions; this CLI never authorizes production cutover.\n');

reportOption(program.command('preflight')
  .option('--sqlite <path>')
  .option('--source <path>'))
  .action((options: { sqlite?: string; source?: string; report?: string }) => {
    activeReportPath = options.report;
    const source = new SqliteTransferSource({ filePath: optionPath(options) });
    try {
      const result = runSqlitePreflight(source, manifest);
      writeChecks(options.report, [{ name: 'sqlite_preflight', status: result.ok ? 'passed' : 'failed', ...(result.ok ? {} : { code: result.findings[0]?.code }) }]);
      process.stdout.write(`${JSON.stringify({ ok: result.ok, findings: result.findings, sourceSha256: result.sourceSha256, evidence: result.evidence })}\n`);
      if (!result.ok) process.exitCode = 2;
    } finally { source.close(); }
  });

reportOption(program.command('export')
  .option('--sqlite <path>')
  .option('--source <path>')
  .option('--bundle <path>')
  .option('--output <path>'))
  .action((options: { sqlite?: string; source?: string; bundle?: string; output?: string; report?: string }) => {
    activeReportPath = options.report;
    const result = exportSqliteBundle({ sourcePath: optionPath(options), outputPath: bundlePath(options), key: decodeBundleKey(requiredEnv('MIGRATION_BUNDLE_KEY')), manifest });
    writeChecks(options.report, [{ name: 'export', status: 'passed' }]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

reportOption(program.command('verify-bundle')
  .requiredOption('--bundle <path>')
  .action((options: { bundle: string; report?: string }) => {
    activeReportPath = options.report;
    const frames = decodeBundle(fs.readFileSync(options.bundle), decodeBundleKey(requiredEnv('MIGRATION_BUNDLE_KEY')));
    const header = frames[0]; const end = frames.at(-1);
    if (header?.type !== 'bundle_header' || end?.type !== 'bundle_end' || header.migrationManifestHash !== manifest.migrationManifestHash || end.migrationManifestHash !== manifest.migrationManifestHash) throw new Error('Bundle manifest hash mismatch');
    writeChecks(options.report, [{ name: 'bundle_authentication', status: 'passed' }, { name: 'bundle_manifest', status: 'passed' }]);
    process.stdout.write(`${JSON.stringify({ ok: true, tableCount: end.tableCount, sourceSnapshotSha256: header.sourceSnapshotSha256, migrationManifestHash: header.migrationManifestHash })}\n`);
  }));

reportOption(program.command('target-id')
  .action((options: { report?: string }) => {
    activeReportPath = options.report;
    if (process.env.DB_TYPE !== 'postgres') throw new Error('DB_TYPE must be postgres');
    const fingerprint = parseTargetIdentity(requiredEnv('DATABASE_URL')).fingerprint;
    writeChecks(options.report, [{ name: 'target_identity', status: 'passed' }]);
    process.stdout.write(`${JSON.stringify({ fingerprint })}\n`);
  }));

const initTarget = program.command('init-target').requiredOption('--target-id <sha256>');
reportOption(initTarget).action(async (options: { targetId: string; report?: string }) => {
  activeReportPath = options.report;
  const target = requirePostgresTarget(options.targetId);
  const database = new PostgresTransferTarget({ connectionString: target.connectionString, manifest });
  try { await database.initializeFreshSchema(); }
  finally { await database.close(); }
  writeChecks(options.report, [{ name: 'target_identity', status: 'passed' }, { name: 'target_schema', status: 'passed' }]);
  process.stdout.write(`${JSON.stringify({ ok: true, fingerprint: target.fingerprint })}\n`);
});

const importCommand = program.command('import').requiredOption('--bundle <path>').requiredOption('--target-id <sha256>');
reportOption(importCommand).action(async (options: { bundle: string; targetId: string; report?: string }) => {
  activeReportPath = options.report;
  const target = requirePostgresTarget(options.targetId);
  const result = await importBundleIntoPostgres({ bundlePath: options.bundle, key: decodeBundleKey(requiredEnv('MIGRATION_BUNDLE_KEY')), connectionString: target.connectionString, manifest });
  writeChecks(options.report, [{ name: 'target_identity', status: 'passed' }, { name: 'import', status: 'passed' }, { name: 'reconcile', status: 'passed' }]);
  process.stdout.write(`${JSON.stringify({ ok: true, fingerprint: target.fingerprint, ...result })}\n`);
});

const reconcileCommand = program.command('reconcile').requiredOption('--sqlite <path>').requiredOption('--bundle <path>').requiredOption('--target-id <sha256>');
reportOption(reconcileCommand).action(async (options: { sqlite: string; bundle: string; targetId: string; report?: string }) => {
  activeReportPath = options.report;
  const key = decodeBundleKey(requiredEnv('MIGRATION_BUNDLE_KEY'));
  const frames = decodeBundle(fs.readFileSync(options.bundle), key);
  const header = frames[0];
  if (header?.type !== 'bundle_header' || header.migrationManifestHash !== manifest.migrationManifestHash) throw new Error('Bundle manifest hash mismatch');
  const source = new SqliteTransferSource({ filePath: options.sqlite });
  try { if (source.sha256() !== header.sourceSnapshotSha256) throw new Error('SQLite source snapshot mismatch'); }
  finally { source.close(); }
  const target = requirePostgresTarget(options.targetId);
  const database = new PostgresTransferTarget({ connectionString: target.connectionString, manifest, readOnly: true });
  try {
    const result = await reconcilePostgres(database.pool, frames, manifest, { verifyMetadata: true });
    if (!result.ok) throw new Error('PostgreSQL reconciliation failed');
    writeChecks(options.report, [{ name: 'source_snapshot', status: 'passed' }, { name: 'target_reconcile', status: 'passed' }]);
    process.stdout.write(`${JSON.stringify({ fingerprint: target.fingerprint, ...result })}\n`);
  } finally { await database.close(); }
});

if (process.argv.length > 2) {
  program.parseAsync(process.argv).catch(() => {
    if (activeReportPath) {
      try { writeChecks(activeReportPath, [{ name: 'command', status: 'failed', code: 'TRANSFER_FAILED' }]); } catch { /* preserve safe CLI failure */ }
    }
    process.stderr.write('db-transfer failed; consult the value-free evidence report\n');
    process.exitCode = 1;
  });
}
