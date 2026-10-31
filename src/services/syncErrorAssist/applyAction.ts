export type ApplyAction =
  | { type: 'create'; entityType: string; payload: Record<string, unknown> }
  | { type: 'update'; entityType: string; recordId: string; patch: Record<string, unknown> };

/**
 * Plain-object check that rejects built-in instances (Date, RegExp, Map, Set,
 * Error, etc.) which serialize unpredictably into connector payloads.
 *
 * Accepts: object literals (`{}`, `{...}`) and prototype-less objects
 *   (`Object.create(null)`).
 * Rejects: arrays, null, primitives, and built-in instances whose prototype
 *   is anything other than `Object.prototype` or `null`.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Property keys that, if present anywhere in the payload, would create a
 * prototype-pollution sink when downstream code does `result[key] = value`
 * on an `{}` literal (which has Object.prototype). The connector helper
 * `mapCommonFields` (src/utils/connectorHelpers.ts) does exactly that, so
 * we reject any payload that nests these keys at any depth — defending
 * early at the validator boundary keeps the surface area small.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-walk a value to ensure it is JSON-safe: every nested object is plain
 * (not a Date / RegExp / Map / Set / Error / class instance), every array
 * element passes the same check, and primitives are accepted as-is. Rejects
 * `function`/`symbol`/`bigint`/`undefined` (not JSON-representable). Also
 * rejects FORBIDDEN_KEYS at any depth (prototype-pollution defense).
 *
 * The connector layer ultimately serializes payloads to JSON, where Date
 * and class instances stringify in ways operators don't expect (Date → ISO
 * string, RegExp → empty object, Map/Set → empty object). Rejecting at the
 * validator gives the operator a clear failure mode instead of silent data
 * drift on the wire.
 *
 * The `seen` Set guards against circular references — `obj.self = obj`
 * would otherwise infinite-loop the recursion.
 */
function isJsonSafe(v: unknown, seen: Set<object> = new Set<object>()): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(v)) {
    if (seen.has(v)) return false;
    seen.add(v);
    const ok = v.every((item) => isJsonSafe(item, seen));
    seen.delete(v);
    return ok;
  }
  if (t === 'object') {
    if (!isPlainObject(v)) return false;
    if (seen.has(v)) return false;
    // Use Object.getOwnPropertyNames so an explicit own `__proto__` key
    // (e.g., from JSON.parse('{"__proto__":{}}')) is caught — `Object.keys`
    // would skip it. Reject if any forbidden key is present at this level.
    const keys = Object.getOwnPropertyNames(v);
    if (keys.some((k) => FORBIDDEN_KEYS.has(k))) return false;
    seen.add(v);
    const ok = keys.every((k) => isJsonSafe((v as Record<string, unknown>)[k], seen));
    seen.delete(v);
    return ok;
  }
  return false;
}

export function validateApplyAction(input: unknown): ApplyAction | null {
  if (!isPlainObject(input)) return null;

  const type = input.type;
  const entityType = input.entityType;
  if (typeof entityType !== 'string' || entityType.length === 0) return null;

  if (type === 'create') {
    if (!isPlainObject(input.payload) || !isJsonSafe(input.payload)) return null;
    return { type: 'create', entityType, payload: input.payload };
  }

  if (type === 'update') {
    const recordId = input.recordId;
    if (typeof recordId !== 'string' || recordId.length === 0) return null;
    if (!isPlainObject(input.patch) || !isJsonSafe(input.patch)) return null;
    return { type: 'update', entityType, recordId, patch: input.patch };
  }

  return null;
}
