const FORBIDDEN_FIELD_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export interface FieldLevelPayload<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  payload: TPayload;
  mode: 'drop_disallowed' | 'block_on_any_disallowed';
}

export function assertSafeFieldPath(path: string): void {
  if (path.length === 0) {
    throw new Error('unsafe field path: empty path');
  }

  for (const segment of path.split('.')) {
    if (segment.length === 0) {
      throw new Error(`unsafe field path '${path}': empty segment`);
    }
    if (FORBIDDEN_FIELD_PATH_SEGMENTS.has(segment)) {
      throw new Error(`unsafe field path segment '${segment}' in '${path}'`);
    }
  }
}

export function fieldPathsFromPayload(payload: unknown): string[] {
  if (!isRecordLike(payload)) return [];

  const paths: string[] = [];
  collectFieldPaths(payload, [], paths);
  return paths.sort();
}

export function pickPayloadFields(
  payload: Record<string, unknown>,
  allowedFieldPaths: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const fieldPath of allowedFieldPaths) {
    assertSafeFieldPath(fieldPath);
    const segments = fieldPath.split('.');
    const value = readPath(payload, segments);
    if (!value.found) continue;
    if (!isPickableLeaf(value.value)) continue;
    writePath(picked, segments, value.value);
  }

  return picked;
}

function collectFieldPaths(
  value: Record<string, unknown>,
  prefix: string[],
  paths: string[],
): void {
  const entries = Object.entries(value);
  if (entries.length === 0 && prefix.length > 0) {
    const fieldPath = prefix.join('.');
    assertSafeFieldPath(fieldPath);
    paths.push(fieldPath);
    return;
  }

  for (const [key, child] of entries) {
    const next = [...prefix, key];
    const fieldPath = next.join('.');
    assertSafeFieldPath(fieldPath);

    if (isRecordLike(child)) {
      collectFieldPaths(child, next, paths);
    } else {
      paths.push(fieldPath);
    }
  }
}

function readPath(
  payload: Record<string, unknown>,
  segments: readonly string[],
): { found: true; value: unknown } | { found: false } {
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (!isRecordLike(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

function writePath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (!isRecordLike(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]] = value;
}

function isPickableLeaf(value: unknown): boolean {
  return !isRecordLike(value) || Object.keys(value).length === 0;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}