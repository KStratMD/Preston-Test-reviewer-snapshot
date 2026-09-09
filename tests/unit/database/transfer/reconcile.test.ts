import { canonicalize } from '../../../../src/database/transfer/canonicalize';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from '../../../../src/database/transfer/digests';
import { reconcilePostgres } from '../../../../src/database/transfer/reconcile';
import type { TransferManifest } from '../../../../src/database/transfer/manifest';
import type { BundleFrame } from '../../../../src/database/transfer/types';

const manifest: TransferManifest = {
  format: 'db-transfer-manifest/v1', migrationNames: ['x'], migrationManifestHash: 'h',
  tables: [{ name: 'items', primaryKey: ['id'], sortColumns: ['id'], dependsOn: [], sequenceColumns: [], columns: [{ name: 'id', sourceType: 'TEXT', targetType: 'TEXT', sourceNullable: false, targetNullable: false, kind: 'text' }] }],
};

describe('PostgreSQL reconciliation', () => {
  it('matches order-independent table digests and detects count drift', async () => {
    const row = canonicalize('one', 'text'); const rowDigest = digestCanonicalRow([row]);
    const frames: BundleFrame[] = [
      { type: 'bundle_header', formatVersion: 1, sourceSnapshotSha256: 'a', migrationManifestHash: 'h' },
      { type: 'table_start', table: 'items', columns: ['id'] },
      { type: 'row', table: 'items', values: { id: row }, digest: digestHex(rowDigest) },
      { type: 'table_end', table: 'items', rowCount: 1, digest: digestHex(digestCanonicalTable([rowDigest])) },
      { type: 'bundle_end', tableCount: 1, migrationManifestHash: 'h' },
    ];
    const client = { query: async () => ({ rows: [{ id: 'one' }] }) };
    await expect(reconcilePostgres(client, frames, manifest)).resolves.toEqual({ ok: true, mismatches: [] });
    const drift = { query: async () => ({ rows: [] }) };
    const result = await reconcilePostgres(drift, frames, manifest);
    expect(result.ok).toBe(false); expect(result.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ROW_COUNT_MISMATCH' })]));
  });
});
