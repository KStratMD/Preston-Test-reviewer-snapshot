import { assertPostgresMatchesManifest, canonicalKindForColumn } from '../../../../src/database/transfer/manifestAuthoring';
import type { TransferManifest } from '../../../../src/database/transfer/manifest';
import type { DiscoveredSchema } from '../../../../src/database/transfer/schemaDiscovery';
import committedManifest from '../../../../src/database/transfer/manifest.generated.json';

const manifest: TransferManifest = {
  format: 'db-transfer-manifest/v1',
  migrationNames: ['one'],
  migrationManifestHash: 'unused',
  tables: [{
    name: 'events', primaryKey: ['occurred_at'], sortColumns: ['occurred_at'], dependsOn: [], sequenceColumns: [],
    columns: [{ name: 'occurred_at', sourceType: 'TEXT', targetType: 'TIMESTAMP WITHOUT TIME ZONE', sourceNullable: false, targetNullable: false, kind: 'naive_timestamp' }],
  }],
};

const schema: DiscoveredSchema = {
  dialect: 'postgres',
  tables: [{
    name: 'events', primaryKey: ['occurred_at'], dependsOn: [], foreignKeys: [], sequenceColumns: [],
    columns: [{ name: 'occurred_at', declaredType: 'TIMESTAMP WITHOUT TIME ZONE', nullable: false, ordinal: 1, hasSequence: false }],
  }],
};

it('uses the reviewed decimal override as the canonical kind', () => {
  expect(canonicalKindForColumn('data_quality_reports', {
    name: 'quality_score', declaredType: 'REAL', nullable: false, ordinal: 1, hasSequence: false,
  })).toBe('decimal');
});

it('classifies embedded token validity bounds as legacy UTC timestamps', () => {
  expect(canonicalKindForColumn('embedded_service_token_versions', {
    name: 'valid_from', declaredType: 'TEXT', nullable: false, ordinal: 1, hasSequence: false,
  })).toBe('naive_timestamp');
  expect(canonicalKindForColumn('embedded_service_token_versions', {
    name: 'valid_until', declaredType: 'TEXT', nullable: false, ordinal: 2, hasSequence: false,
  })).toBe('naive_timestamp');
});

it('classifies integration configuration history payloads as JSON', () => {
  expect(canonicalKindForColumn('integration_config_history', {
    name: 'configuration', declaredType: 'TEXT', nullable: false, ordinal: 1, hasSequence: false,
  })).toBe('json');
});

it('classifies SuiteCentral allowed ports as the migrated JSON payload', () => {
  expect(canonicalKindForColumn('suitecentral_allowed_hosts', {
    name: 'allowed_ports', declaredType: 'TEXT', nullable: true, ordinal: 1, hasSequence: false,
  })).toBe('json');
});

it('classifies SuiteCentral credential rotation timestamps as instants', () => {
  for (const name of ['rotated_at', 'last_used_at']) {
    expect(canonicalKindForColumn('suitecentral_credential_profiles', {
      name, declaredType: 'TEXT', nullable: true, ordinal: 1, hasSequence: false,
    })).toBe('instant_utc');
  }
});

it('keeps mdm survivorship default flags integer-backed on PostgreSQL', () => {
  expect(canonicalKindForColumn('mdm_survivorship_rules', {
    name: 'is_default', declaredType: 'INTEGER', nullable: false, ordinal: 1, hasSequence: false,
  })).toBe('integer');
});

it('preserves the PostgreSQL-native metrics identity and decimal value types', () => {
  const metrics = (committedManifest as TransferManifest).tables.find((table) => table.name === 'metrics');
  expect(metrics).toBeDefined();
  expect(metrics?.columns.find((column) => column.name === 'id')).toEqual(expect.objectContaining({
    kind: 'uuid', targetType: 'UUID',
  }));
  expect(metrics?.columns.find((column) => column.name === 'value')).toEqual(expect.objectContaining({
    kind: 'decimal', targetType: 'DECIMAL',
  }));
});

it('treats timestamp without time zone as a naive timestamp', () => {
  expect(() => assertPostgresMatchesManifest(schema, manifest)).not.toThrow();
});

it('treats PostgreSQL boolean domains with a bool UDT suffix as booleans', () => {
  const booleanManifest: TransferManifest = {
    ...manifest,
    tables: [{
      ...manifest.tables[0]!,
      name: 'flags',
      columns: [{
        name: 'is_active', sourceType: 'INTEGER', targetType: 'BOOLEAN',
        sourceNullable: false, targetNullable: false, kind: 'boolean',
      }],
    }],
  };
  const booleanSchema: DiscoveredSchema = {
    dialect: 'postgres',
    tables: [{
      name: 'flags', primaryKey: ['is_active'], dependsOn: [], foreignKeys: [], sequenceColumns: [],
      columns: [{ name: 'is_active', declaredType: 'BOOLEAN (bool)', nullable: false, ordinal: 1, hasSequence: false }],
    }],
  };
  expect(() => assertPostgresMatchesManifest(booleanSchema, booleanManifest)).not.toThrow();
});

it('treats PostgreSQL TEXT[] columns as the explicit text-array adapter', () => {
  const arrayManifest: TransferManifest = {
    ...manifest,
    tables: [{
      ...manifest.tables[0]!,
      name: 'api_keys',
      columns: [{
        name: 'permissions', sourceType: 'TEXT', targetType: 'TEXT[]',
        sourceNullable: false, targetNullable: false, kind: 'text_array',
      }],
    }],
  };
  const arraySchema: DiscoveredSchema = {
    dialect: 'postgres',
    tables: [{
      name: 'api_keys', primaryKey: ['permissions'], dependsOn: [], foreignKeys: [], sequenceColumns: [],
      columns: [{ name: 'permissions', declaredType: 'ARRAY (_text)', nullable: false, ordinal: 1, hasSequence: false }],
    }],
  };
  expect(() => assertPostgresMatchesManifest(arraySchema, arrayManifest)).not.toThrow();
});
