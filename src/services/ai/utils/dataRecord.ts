import type { DataRecord } from '../../../types';

const RESERVED_DIRECT_KEYS = new Set([
  'id',
  'externalId',
  'fields',
  'metadata',
  'lastModified',
  'source',
  'version',
  'createdAt',
  'updatedAt'
]);

type RecordLike = Partial<DataRecord> | Record<string, unknown>;

export function normalizeRecords(records: unknown[]): Record<string, unknown>[] {
  return records
    .filter((record): record is Record<string, unknown> =>
      record !== null && typeof record === 'object'
    );
}

export function getRecordValue(record: RecordLike, fieldName: string): unknown {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  // Prefer nested field dictionaries when present
  const fields = (record as { fields?: Record<string, unknown> }).fields;
  if (fields && typeof fields === 'object' && fieldName in fields) {
    return fields[fieldName];
  }

  // Fall back to direct property access (legacy shape)
  if (fieldName in record) {
    return (record as Record<string, unknown>)[fieldName];
  }

  // Support dotted paths for nested attributes
  if (fieldName.includes('.')) {
    const segments = fieldName.split('.');
    let current: unknown = record;
    for (const segment of segments) {
      if (!current || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  return undefined;
}

export function getRecordValues(records: unknown[], fieldName: string): unknown[] {
  return normalizeRecords(records)
    .map(record => getRecordValue(record, fieldName))
    .filter((value): value is unknown => value !== undefined && value !== null);
}

export function getRecordFieldNames(record: RecordLike): string[] {
  if (!record || typeof record !== 'object') {
    return [];
  }

  const fields = (record as { fields?: Record<string, unknown> }).fields;
  if (fields && typeof fields === 'object') {
    return Object.keys(fields);
  }

  return Object.keys(record as Record<string, unknown>)
    .filter(key => !RESERVED_DIRECT_KEYS.has(key));
}

export function getAllFieldNames(records: unknown[]): string[] {
  const normalized = normalizeRecords(records);
  if (normalized.length === 0) {
    return [];
  }

  const fieldSets = normalized.map(record => getRecordFieldNames(record));
  const flattened = fieldSets.flat();

  if (flattened.length > 0) {
    return Array.from(new Set(flattened));
  }

  // Fallback: use direct keys from the first record
  return Object.keys(normalized[0]);
}
