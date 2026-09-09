import type { BundleFrame, CanonicalValue } from './types';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

function isCanonicalValue(value: unknown): value is CanonicalValue {
  if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return false;
  const typed = value as { type: string; value?: unknown };
  if (typed.type === 'null') return !('value' in typed);
  if (typed.type === 'boolean') return typeof typed.value === 'boolean';
  return typeof typed.value === 'string';
}

function validateFrameShape(frame: unknown): asserts frame is BundleFrame {
  if (!frame || typeof frame !== 'object' || typeof (frame as { type?: unknown }).type !== 'string') throw new Error('Invalid bundle frame');
  const typed = frame as Record<string, unknown>;
  switch (typed.type) {
    case 'bundle_header':
      if (typed.formatVersion !== 1 || typeof typed.sourceSnapshotSha256 !== 'string' || typeof typed.migrationManifestHash !== 'string') throw new Error('Invalid bundle header');
      return;
    case 'table_start':
      if (typeof typed.table !== 'string' || !Array.isArray(typed.columns) || !typed.columns.every((column) => typeof column === 'string')) throw new Error('Invalid table start');
      return;
    case 'row':
      if (typeof typed.table !== 'string' || typeof typed.digest !== 'string' || !typed.values || typeof typed.values !== 'object' || !Object.values(typed.values as object).every(isCanonicalValue)) throw new Error('Invalid row frame');
      return;
    case 'table_end':
      if (typeof typed.table !== 'string' || typeof typed.rowCount !== 'number' || !Number.isSafeInteger(typed.rowCount) || typed.rowCount < 0 || typeof typed.digest !== 'string') throw new Error('Invalid table end');
      return;
    case 'bundle_end':
      if (typeof typed.tableCount !== 'number' || !Number.isSafeInteger(typed.tableCount) || typed.tableCount < 0 || typeof typed.migrationManifestHash !== 'string') throw new Error('Invalid bundle end');
      return;
    default: throw new Error('Unknown bundle frame type');
  }
}

export function encodeFrames(frames: readonly BundleFrame[]): Buffer {
  if (frames.length < 2) throw new Error('Bundle requires frames');
  for (const frame of frames) validateFrameShape(frame);
  if (frames[0]?.type !== 'bundle_header' || frames.at(-1)?.type !== 'bundle_end') throw new Error('Bundle frame order is invalid');
  validateFrameOrder(frames);
  const body = Buffer.from(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', 'utf8');
  if (body.length > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds maximum size');
  return body;
}

export function decodeFrames(body: Buffer): BundleFrame[] {
  if (body.length > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds maximum size');
  const text = body.toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw new Error('Bundle frame stream is truncated');
  lines.pop();
  const frames: BundleFrame[] = [];
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes === 0 || bytes > MAX_FRAME_BYTES) throw new Error('Invalid bundle frame size');
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error('Invalid bundle frame JSON'); }
    validateFrameShape(parsed);
    frames.push(parsed);
  }
  validateFrameOrder(frames);
  return frames;
}

export function validateFrameOrder(frames: readonly BundleFrame[]): void {
  if (frames.length < 2 || frames[0]?.type !== 'bundle_header' || frames.at(-1)?.type !== 'bundle_end') throw new Error('Bundle frame order is invalid');
  let state: 'header' | 'table_start' | 'rows' | 'table_end' | 'bundle_end' = 'header';
  let currentTable: string | undefined;
  const seenTables = new Set<string>();
  let tableCount = 0;
  for (const frame of frames) {
    if (state === 'header') { if (frame.type !== 'bundle_header') throw new Error('Bundle header is missing'); state = 'table_start'; continue; }
    if (state === 'table_start') {
      if (frame.type === 'bundle_end') { state = 'bundle_end'; continue; }
      if (frame.type !== 'table_start' || seenTables.has(frame.table)) throw new Error('Table frame order is invalid');
      seenTables.add(frame.table); currentTable = frame.table; tableCount += 1; state = 'rows'; continue;
    }
    if (state === 'rows') {
      if (frame.type === 'row') { if (frame.table !== currentTable) throw new Error('Row table mismatch'); continue; }
      if (frame.type !== 'table_end' || frame.table !== currentTable) throw new Error('Table end is missing');
      state = 'table_start'; currentTable = undefined; continue;
    }
    if (state === 'bundle_end') throw new Error('Frames follow bundle end');
  }
  const end = frames.at(-1);
  if (state !== 'bundle_end' || end?.type !== 'bundle_end' || end.tableCount !== tableCount) throw new Error('Bundle end does not match tables');
}
