import type {
  BundleFrame,
  CanonicalKind,
  CanonicalValue,
  EvidenceReport,
} from '../../../../src/database/transfer/types';

describe('database transfer contracts', () => {
  it('keeps canonical values explicitly tagged', () => {
    const kinds: CanonicalKind[] = [
      'uuid', 'boolean', 'integer', 'decimal', 'float32', 'float64',
      'date', 'inet', 'json', 'binary', 'text', 'instant_utc', 'naive_timestamp',
    ];
    const values: CanonicalValue[] = [
      { type: 'null' },
      { type: 'boolean', value: true },
      { type: 'uuid', value: '00000000-0000-0000-0000-000000000000' },
      { type: 'json', value: '{"large":9007199254740993}' },
      { type: 'binary', value: 'AA==' },
    ];

    expect(kinds).toHaveLength(13);
    expect(values.every((value) => typeof value.type === 'string')).toBe(true);
  });

  it('represents bundle frames as a closed discriminated union', () => {
    const frame: BundleFrame = {
      type: 'bundle_end',
      tableCount: 0,
      migrationManifestHash: 'a'.repeat(64),
    };

    expect(frame.type).toBe('bundle_end');
  });

  it('models incomplete evidence explicitly instead of treating absence as success', () => {
    const report: EvidenceReport = {
      format: 'db-transfer-evidence/v1',
      status: 'not_run',
      checks: [],
    };

    expect(report.status).toBe('not_run');
  });
});
