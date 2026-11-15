import createJsonBigInt from 'json-bigint';

const parser = createJsonBigInt({
  alwaysParseAsBig: true,
  protoAction: 'error',
  constructorAction: 'error',
});

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => key.includes('\u0000') || containsNul(child));
  }
  return false;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  if (isBigNumber(value)) return value;
  const object = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort(utf8Compare)) sorted[key] = sortJson(object[key]);
  return sorted;
}

function isBigNumber(value: unknown): value is { toString(): string; c: number[] | null; e: number; s: 1 | -1 } {
  if (!value || typeof value !== 'object' || typeof (value as { toString?: unknown }).toString !== 'function') return false;
  const keys = Object.keys(value as object).sort();
  if (keys.length !== 3 || keys[0] !== 'c' || keys[1] !== 'e' || keys[2] !== 's') return false;
  const obj = value as { c: unknown; e: unknown; s: unknown };
  // bignumber.js stores coefficient as an integer array (or null), exponent as a
  // number, and sign as 1 or -1. Plain objects such as {c:1,e:2,s:3} fail these
  // structural checks, preventing false positives in canonicalizeJson().
  return (Array.isArray(obj.c) || obj.c === null) &&
    typeof obj.e === 'number' &&
    (obj.s === 1 || obj.s === -1);
}

function stringifyLossless(value: unknown): string {
  if (isBigNumber(value)) return value.toString();
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(stringifyLossless).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, child]) => `${JSON.stringify(key)}:${stringifyLossless(child)}`).join(',')}}`;
  }
  throw new Error('Unsupported JSON value');
}

export function parseLosslessJson(text: string): unknown {
  if (text.includes('\u0000')) throw new Error('JSON contains U+0000');
  const parsed = parser.parse(text);
  if (containsNul(parsed)) throw new Error('JSON contains U+0000');
  return parsed;
}

export function canonicalizeJson(text: string): string {
  return stringifyLossless(sortJson(parseLosslessJson(text)));
}

export function assertJsonHasNoNul(value: unknown): void {
  if (containsNul(value)) throw new Error('JSON contains U+0000');
}
