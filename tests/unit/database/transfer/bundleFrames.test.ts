import { decodeFrames, encodeFrames } from '../../../../src/database/transfer/bundleFrames';
import type { BundleFrame } from '../../../../src/database/transfer/types';

describe('bundle frame stream', () => {
  it('requires one header, ordered tables, and one end frame', () => {
    const frames: BundleFrame[] = [
      { type: 'bundle_header', formatVersion: 1, sourceSnapshotSha256: 'a', migrationManifestHash: 'b' },
      { type: 'table_start', table: 'x', columns: ['id'] },
      { type: 'table_end', table: 'x', rowCount: 0, digest: 'd' },
      { type: 'bundle_end', tableCount: 1, migrationManifestHash: 'b' },
    ];
    expect(decodeFrames(encodeFrames(frames))).toEqual(frames);
    expect(() => encodeFrames([frames[0]!, frames[3]!])).toThrow();
  });
});
