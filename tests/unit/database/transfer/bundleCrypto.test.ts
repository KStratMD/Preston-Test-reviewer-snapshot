import { randomBytes } from 'node:crypto';
import { decodeBundle, decodeBundleKey, encodeBundle } from '../../../../src/database/transfer/bundleCrypto';
import type { BundleFrame } from '../../../../src/database/transfer/types';

const frames: BundleFrame[] = [
  { type: 'bundle_header', formatVersion: 1, sourceSnapshotSha256: 'a'.repeat(64), migrationManifestHash: 'b'.repeat(64) },
  { type: 'table_start', table: 'items', columns: ['id'] },
  { type: 'row', table: 'items', values: { id: { type: 'text', value: 'one' } }, digest: 'c'.repeat(64) },
  { type: 'table_end', table: 'items', rowCount: 1, digest: 'd'.repeat(64) },
  { type: 'bundle_end', tableCount: 1, migrationManifestHash: 'b'.repeat(64) },
];

describe('encrypted transfer bundles', () => {
  it('strictly decodes keys and authenticates the header as AAD', () => {
    const key = randomBytes(32);
    const encoded = key.toString('base64');
    expect(decodeBundleKey(encoded)).toEqual(key);
    expect(() => decodeBundleKey(encoded.replace(/=+$/, ''))).toThrow();
    const bundle = encodeBundle(frames, key, Buffer.alloc(12, 3));
    expect(decodeBundle(bundle, key)).toEqual(frames);
    const changedHeader = Buffer.from(bundle); changedHeader[0] ^= 1;
    expect(() => decodeBundle(changedHeader, key)).toThrow(/authentication|format/i);
    expect(() => decodeBundle(bundle, randomBytes(32))).toThrow(/authentication/);
  });

  it('rejects truncation and frame-order violations', () => {
    const key = randomBytes(32);
    const bundle = encodeBundle(frames, key);
    expect(() => decodeBundle(bundle.subarray(0, -1), key)).toThrow();
    expect(() => encodeBundle([frames[0]!, frames[2]!, frames[1]!, ...frames.slice(3)], key)).toThrow();
  });
});
