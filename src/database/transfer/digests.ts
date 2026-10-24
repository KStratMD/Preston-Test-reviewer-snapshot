import { createHash } from 'node:crypto';
import type { CanonicalValue } from './types';

function frame(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4); length.writeUInt32BE(value.length, 0); return Buffer.concat([length, value]);
}

function encodeValue(value: CanonicalValue): Buffer {
  if (value.type === 'null') return Buffer.from([0]);
  if (value.type === 'boolean') return Buffer.from([1, value.value ? 1 : 0]);
  const type = Buffer.from(value.type, 'utf8');
  const data = Buffer.from(value.value, 'utf8');
  return Buffer.concat([Buffer.from([2]), frame(type), frame(data)]);
}

export function digestCanonicalRow(values: readonly CanonicalValue[]): Buffer {
  const hash = createHash('sha256');
  hash.update(Buffer.from('db-transfer-row-v1\0', 'utf8'));
  for (const value of values) hash.update(frame(encodeValue(value)));
  return hash.digest();
}

export function digestCanonicalTable(rowDigests: readonly Uint8Array[]): Buffer {
  const sorted = rowDigests.map((digest) => Buffer.from(digest)).sort(Buffer.compare);
  const hash = createHash('sha256'); hash.update(Buffer.from('db-transfer-table-v1\0', 'utf8'));
  const count = Buffer.allocUnsafe(8); count.writeBigUInt64BE(BigInt(sorted.length)); hash.update(count);
  for (const digest of sorted) hash.update(frame(digest));
  return hash.digest();
}

export function digestHex(value: Uint8Array): string { return Buffer.from(value).toString('hex'); }
