'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const BetterSqlite3 = require('better-sqlite3');

const sourcePath = process.env.SQLITE_SOURCE_PATH;
const destinationPath = process.env.SQLITE_DESTINATION_PATH;
const heartbeatMs = Number(process.env.SQLITE_HEARTBEAT_MS || 1000);
if (!sourcePath || !destinationPath) throw new Error('SQLITE_SOURCE_PATH and SQLITE_DESTINATION_PATH are required');
if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100) throw new Error('SQLITE_HEARTBEAT_MS is invalid');
if (!fs.existsSync(sourcePath)) throw new Error('SQLite source file does not exist');

const sessionId = crypto.randomBytes(16).toString('hex');
const source = new BetterSqlite3(sourcePath, { fileMustExist: true });
const snapshot = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
let locked = false;
let heartbeat;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function release(code) {
  if (heartbeat) clearInterval(heartbeat);
  try { if (locked) source.exec('ROLLBACK'); } catch { /* preserve the original shutdown */ }
  try { snapshot.close(); } finally { source.close(); }
  process.exit(code);
}

process.once('SIGTERM', () => release(1));
process.once('SIGINT', () => release(1));

async function main() {
  source.pragma('busy_timeout = 5000');
  source.exec('BEGIN IMMEDIATE');
  locked = true;
  await snapshot.backup(destinationPath);
  const captured = new BetterSqlite3(destinationPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = captured.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  } finally {
    captured.close();
  }
  process.stdout.write(`CAPTURE_READY ${sessionId} ${sha256(destinationPath)}\n`);
  heartbeat = setInterval(() => process.stdout.write(`CAPTURE_HEARTBEAT ${sessionId}\n`), heartbeatMs);
}

main().catch(() => release(1));
