import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { decodeFrames, encodeFrames } from './bundleFrames';
import type { BundleFrame } from './types';

const MAGIC = Buffer.from('DBTR', 'ascii');
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function decodeBundleKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Invalid bundle key encoding');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('Invalid bundle key length or padding');
  return decoded;
}

function header(nonce: Buffer): Buffer { return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce]); }

export function encodeBundle(frames: readonly BundleFrame[], key: Uint8Array, nonce = randomBytes(NONCE_BYTES)): Buffer {
  if (key.length !== 32 || nonce.length !== NONCE_BYTES) throw new Error('Invalid bundle cryptographic material');
  const aad = header(Buffer.from(nonce));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(encodeFrames(frames)), cipher.final()]);
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
}

export function decodeBundle(bundle: Uint8Array, key: Uint8Array): BundleFrame[] {
  const input = Buffer.from(bundle);
  if (input.length < MAGIC.length + 1 + NONCE_BYTES + TAG_BYTES) throw new Error('Bundle is truncated');
  const aad = input.subarray(0, MAGIC.length + 1 + NONCE_BYTES);
  if (!aad.subarray(0, MAGIC.length).equals(MAGIC) || aad[MAGIC.length] !== VERSION) throw new Error('Unsupported bundle format');
  const nonce = aad.subarray(MAGIC.length + 1);
  const ciphertext = input.subarray(aad.length, input.length - TAG_BYTES);
  const tag = input.subarray(input.length - TAG_BYTES);
  if (key.length !== 32) throw new Error('Invalid bundle key length');
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), nonce);
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decodeFrames(plaintext);
  } catch { throw new Error('Bundle authentication or framing failed'); }
}

export function authenticateBundleFile(filePath: string, key: Uint8Array): { size: number; mtimeMs: number; sha256: string } {
  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  decodeBundle(bytes, key);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const after = fs.statSync(filePath);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Bundle changed during authentication');
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash };
}
