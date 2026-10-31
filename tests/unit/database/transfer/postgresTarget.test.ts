import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeBundle } from '../../../../src/database/transfer/bundleCrypto';
import { importBundleIntoPostgres } from '../../../../src/database/transfer/postgresTarget';
import type { BundleFrame } from '../../../../src/database/transfer/types';
import type { TransferManifest } from '../../../../src/database/transfer/manifest';

const manifest: TransferManifest = { format: 'db-transfer-manifest/v1', migrationNames: ['x'], migrationManifestHash: 'h', tables: [] };

describe('PostgreSQL importer connection boundary', () => {
  it('authenticates the complete bundle before constructing a target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-transfer-import-')); const bundlePath = path.join(dir, 'bad.bundle');
    const frames: BundleFrame[] = [
      { type: 'bundle_header', formatVersion: 1, sourceSnapshotSha256: 'a', migrationManifestHash: 'h' },
      { type: 'bundle_end', tableCount: 0, migrationManifestHash: 'h' },
    ];
    const correct = randomBytes(32); fs.writeFileSync(bundlePath, encodeBundle(frames, correct));
    let constructed = 0;
    await expect(importBundleIntoPostgres({
      bundlePath, key: randomBytes(32), connectionString: 'postgres://user:password@host/db', manifest,
      targetFactory: () => { constructed += 1; throw new Error('target must not be constructed'); },
    })).rejects.toThrow(/authentication/);
    expect(constructed).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
