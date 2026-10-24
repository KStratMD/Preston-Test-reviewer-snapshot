import { createHash } from 'node:crypto';
import {
  migrationManifestHash,
  orderTransferTables,
  validateTransferManifest,
  type TransferManifest,
} from '../../../../src/database/transfer/manifest';
import committedManifest from '../../../../src/database/transfer/manifest.generated.json';

function sampleManifest(overrides: Partial<TransferManifest> = {}): TransferManifest {
  const migrationNames = ['first', 'second'];
  return {
    format: 'db-transfer-manifest/v1',
    migrationNames,
    migrationManifestHash: migrationManifestHash(migrationNames),
    tables: [
      {
        name: 'parent',
        primaryKey: ['id'],
        sortColumns: ['id'],
        dependsOn: [],
        columns: [
          {
            name: 'id', sourceType: 'TEXT', targetType: 'uuid',
            sourceNullable: false, targetNullable: false, kind: 'uuid',
          },
        ],
        sequenceColumns: [],
      },
    ],
    ...overrides,
  };
}

describe('transfer manifest validation', () => {
  it('hashes ordered migration names deterministically', () => {
    const names = ['a', 'b'];
    const expected = createHash('sha256').update(JSON.stringify(names)).digest('hex');
    expect(migrationManifestHash(names)).toBe(expected);
    expect(migrationManifestHash(['b', 'a'])).not.toBe(expected);
  });

  it('rejects duplicate tables, columns, and missing sort keys', () => {
    expect(() => validateTransferManifest(sampleManifest({
      tables: [sampleManifest().tables[0], sampleManifest().tables[0]],
    }))).toThrow(/duplicate table/i);

    expect(() => validateTransferManifest(sampleManifest({
      tables: [{
        ...sampleManifest().tables[0],
        columns: [sampleManifest().tables[0].columns[0], sampleManifest().tables[0].columns[0]],
      }],
    }))).toThrow(/duplicate column/i);

    expect(() => validateTransferManifest(sampleManifest({
      tables: [{ ...sampleManifest().tables[0], sortColumns: ['missing'] }],
    }))).toThrow(/sort column/i);
  });

  it('rejects dependency cycles and migration hash drift', () => {
    const base = sampleManifest();
    expect(() => validateTransferManifest({
      ...base,
      migrationManifestHash: '0'.repeat(64),
    })).toThrow(/migration.*hash/i);

    const child = { ...base.tables[0], name: 'child', dependsOn: ['parent'] };
    const parent = { ...base.tables[0], dependsOn: ['child'] };
    expect(() => validateTransferManifest({ ...base, tables: [parent, child] })).toThrow(/cycle/i);
  });

  it.each([
    ['primaryKey', /primary key column/i],
    ['sequenceColumns', /sequence column/i],
  ] as const)('identifies an unknown %s column accurately', (field, message) => {
    const base = sampleManifest();
    expect(() => validateTransferManifest({
      ...base,
      tables: [{ ...base.tables[0], [field]: ['missing'] }],
    })).toThrow(message);
  });

  it('covers all governed tables and reviewed seed identities', () => {
    const parsed = validateTransferManifest(committedManifest);
    expect(parsed.tables).toHaveLength(54);
    expect(parsed.tables.find((table) => table.name === 'ai_provider_configs')?.seed?.identities).toEqual([['1']]);
    expect(parsed.tables.find((table) => table.name === 'mdm_survivorship_rules')?.seed?.identities).toHaveLength(14);
  });

  it('orders transfer tables parent-before-child', () => {
    const ordered = orderTransferTables(committedManifest.tables).map((table) => table.name);
    expect(ordered.indexOf('ai_provider_configs')).toBeLessThan(ordered.indexOf('ai_task_model_configs'));
    expect(ordered.indexOf('mdm_golden_records')).toBeLessThan(ordered.indexOf('mdm_entity_sources'));
    expect(ordered.indexOf('tenants')).toBeLessThan(ordered.indexOf('tenant_status_audit'));
  });
});
