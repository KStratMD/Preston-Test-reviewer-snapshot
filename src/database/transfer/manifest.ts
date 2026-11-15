import { createHash } from 'node:crypto';
import type { CanonicalKind } from './types';

export interface ManifestColumn {
  readonly name: string;
  readonly sourceType: string;
  readonly targetType: string;
  readonly sourceNullable: boolean;
  readonly targetNullable: boolean;
  readonly kind: CanonicalKind;
  readonly precision?: number;
  readonly scale?: number;
  readonly floatWidth?: 32 | 64;
  readonly timestampPolicy?: 'strict' | 'utc_z_to_naive';
  readonly volatileJsonPaths?: readonly string[];
}

export interface SeedBaseline {
  readonly identityColumns: readonly string[];
  readonly identities: readonly (readonly string[])[];
  readonly volatileColumns?: readonly string[];
  readonly volatileJsonPaths?: readonly string[];
}

export interface ManifestTable {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly sortColumns: readonly string[];
  readonly dependsOn: readonly string[];
  readonly columns: readonly ManifestColumn[];
  readonly sequenceColumns: readonly string[];
  readonly seed?: SeedBaseline;
}

export interface TransferManifest {
  readonly format: 'db-transfer-manifest/v1';
  readonly migrationNames: readonly string[];
  readonly migrationManifestHash: string;
  readonly tables: readonly ManifestTable[];
}

const CANONICAL_KINDS = new Set<CanonicalKind>([
  'uuid', 'boolean', 'integer', 'decimal', 'float32', 'float64',
  'date', 'inet', 'json', 'binary', 'text', 'text_array', 'instant_utc', 'naive_timestamp',
]);

export function migrationManifestHash(names: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

export function validateTransferManifest(manifest: TransferManifest): TransferManifest {
  if (manifest.format !== 'db-transfer-manifest/v1') {
    throw new Error('Unsupported transfer manifest format');
  }
  if (manifest.migrationNames.length === 0 || new Set(manifest.migrationNames).size !== manifest.migrationNames.length) {
    throw new Error('Migration manifest names must be non-empty and unique');
  }
  if (manifest.migrationManifestHash !== migrationManifestHash(manifest.migrationNames)) {
    throw new Error('Migration manifest hash does not match ordered names');
  }

  const tableNames = new Set<string>();
  for (const table of manifest.tables) {
    if (tableNames.has(table.name)) throw new Error(`Duplicate table: ${table.name}`);
    tableNames.add(table.name);
    if (table.primaryKey.length === 0) throw new Error(`Table ${table.name} has no primary key`);
    if (table.sortColumns.length === 0) throw new Error(`Table ${table.name} has no sort columns`);

    const columnNames = new Set<string>();
    for (const column of table.columns) {
      if (columnNames.has(column.name)) throw new Error(`Duplicate column ${table.name}.${column.name}`);
      columnNames.add(column.name);
      if (!CANONICAL_KINDS.has(column.kind)) throw new Error(`Unknown canonical kind: ${column.kind}`);
    }
    for (const column of table.primaryKey) {
      if (!columnNames.has(column)) throw new Error(`Unknown primary key column ${table.name}.${column}`);
    }
    for (const column of table.sortColumns) {
      if (!columnNames.has(column)) throw new Error(`Unknown sort column ${table.name}.${column}`);
    }
    for (const column of table.sequenceColumns) {
      if (!columnNames.has(column)) throw new Error(`Unknown sequence column ${table.name}.${column}`);
    }
    for (const dependency of table.dependsOn) {
      if (dependency === table.name) throw new Error(`Dependency cycle at ${table.name}`);
    }
    if (table.seed) {
      if (table.seed.identityColumns.length === 0 || table.seed.identities.length === 0) throw new Error(`Seed baseline for ${table.name} must declare identities`);
      for (const identityColumn of table.seed.identityColumns) {
        if (!columnNames.has(identityColumn)) {
          throw new Error(`Unknown seed identity column ${table.name}.${identityColumn}`);
        }
      }
      for (const identity of table.seed.identities) {
        if (identity.length !== table.seed.identityColumns.length || identity.some((value) => typeof value !== 'string')) {
          throw new Error(`Invalid seed identity ${table.name}`);
        }
      }
    }
  }

  for (const table of manifest.tables) {
    for (const dependency of table.dependsOn) {
      if (!tableNames.has(dependency)) throw new Error(`Unknown dependency ${table.name} -> ${dependency}`);
    }
  }

  const byName = new Map(manifest.tables.map((table) => [table.name, table]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`Dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const table of manifest.tables) visit(table.name);

  return manifest;
}

export function parseTransferManifest(value: unknown): TransferManifest {
  if (!value || typeof value !== 'object') throw new Error('Transfer manifest must be an object');
  return validateTransferManifest(value as TransferManifest);
}

/** Stable parent-before-child order for writes. Independent tables retain the
 * committed manifest order, while foreign-key dependencies are emitted first. */
export function orderTransferTables(tables: readonly ManifestTable[]): ManifestTable[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ManifestTable[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Dependency cycle at ${name}`);
    const table = byName.get(name);
    if (!table) throw new Error(`Unknown dependency ${name}`);
    visiting.add(name);
    for (const dependency of table.dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(table);
  };
  for (const table of tables) visit(table.name);
  return ordered;
}
