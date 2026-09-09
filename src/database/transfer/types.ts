export type CanonicalKind =
  | 'uuid'
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'float32'
  | 'float64'
  | 'date'
  | 'inet'
  | 'json'
  | 'binary'
  | 'text'
  | 'text_array'
  | 'instant_utc'
  | 'naive_timestamp';

export type CanonicalValue =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | {
    type: Exclude<CanonicalKind, 'boolean' | 'json' | 'binary'>;
    value: string;
  }
  | { type: 'json'; value: string }
  | { type: 'binary'; value: string };

export type JsonFrameValue = string | number | boolean | null;

export type BundleFrame =
  | {
    type: 'bundle_header';
    formatVersion: number;
    sourceSnapshotSha256: string;
    migrationManifestHash: string;
  }
  | {
    type: 'table_start';
    table: string;
    columns: readonly string[];
  }
  | {
    type: 'row';
    table: string;
    values: Record<string, CanonicalValue>;
    digest: string;
  }
  | {
    type: 'table_end';
    table: string;
    rowCount: number;
    digest: string;
  }
  | {
    type: 'bundle_end';
    tableCount: number;
    migrationManifestHash: string;
  };

export type EvidenceStatus = 'passed' | 'failed' | 'not_run';

export interface EvidenceCheck {
  readonly name: string;
  readonly status: EvidenceStatus;
  readonly code?: string;
}

export interface EvidenceReport {
  readonly format: 'db-transfer-evidence/v1';
  readonly status: EvidenceStatus;
  readonly checks: readonly EvidenceCheck[];
}

export type TransferPhase =
  | 'preflight'
  | 'export'
  | 'authenticate'
  | 'target_preflight'
  | 'import'
  | 'reconcile'
  | 'capture'
  | 'cutover_boot';
