import ipaddr from 'ipaddr.js';
import type { CanonicalKind, CanonicalValue } from './types';
import { canonicalizeJson } from './losslessJson';

export interface CanonicalizeOptions {
  readonly precision?: number;
  readonly scale?: number;
  readonly floatWidth?: 32 | 64;
  readonly timestampPolicy?: 'strict' | 'utc_z_to_naive';
}

function fail(message: string): never { throw new Error(message); }

function canonicalUuid(value: unknown): string {
  // PostgreSQL accepts all RFC-shaped UUIDs, including nil/custom-version
  // values. Do not narrow the contract to UUID versions 1-5: newer versions
  // (for example v7) and application-generated UUID-shaped values are valid
  // database identities and still canonicalize safely by case-folding.
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('Invalid UUID');
  return value.toLowerCase();
}

function canonicalBoolean(value: unknown): boolean {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'TRUE') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'FALSE') return false;
  fail('Invalid boolean');
}

function numericString(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Non-finite number');
    if (Object.is(value, -0)) return '-0';
    return value.toString();
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  fail('Invalid number');
}

function expandDecimal(text: string): string {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) fail('Invalid decimal');
  const sign = match[1] === '-' ? '-' : '';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 200_000) fail('Decimal exponent is out of range');
  // Keep the source leading zeroes while positioning the decimal point. They
  // occupy real places in the mantissa; stripping them first shifts values
  // such as 0.85 to 8.5.
  const digits = `${whole}${fraction}` || '0';
  const decimalPosition = whole.length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) expanded = `0.${'0'.repeat(-decimalPosition)}${digits}`;
  else if (decimalPosition >= digits.length) expanded = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  else expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [expandedWhole, expandedFraction = ''] = expanded.split('.');
  const normalizedWhole = expandedWhole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = expandedFraction.replace(/0+$/, '');
  const isZero = normalizedWhole === '0' && normalizedFraction === '';
  return `${isZero ? '' : sign}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function canonicalInteger(value: unknown): string {
  const text = numericString(value);
  if (!/^[+-]?\d+$/.test(text)) fail('Invalid integer');
  const normalized = text.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1');
  return normalized === '-0' ? '0' : normalized;
}

function decimalScale(text: string): number {
  const mantissa = text.toLowerCase().split('e')[0] ?? text;
  return Math.max(0, (mantissa.split('.')[1] ?? '').length);
}

function canonicalDecimal(value: unknown, options: CanonicalizeOptions): string {
  const text = numericString(value);
  const normalized = expandDecimal(text);
  if (options.scale !== undefined && decimalScale(normalized) > options.scale) {
    const [, fraction = ''] = normalized.split('.');
    if (fraction.replace(/0+$/, '').length > options.scale) fail('Decimal requires target rounding');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const unsignedWhole = whole.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const result = `${sign}${unsignedWhole || '0'}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
  if (options.precision !== undefined) {
    const digits = result.replace(/[-.]/g, '').replace(/^0+/, '').length;
    if (digits > options.precision) fail('Decimal exceeds target precision');
  }
  return result === '-0' ? '0' : result;
}

function canonicalFloat(value: unknown, width: 32 | 64): string {
  const text = numericString(value);
  const number = Number(text);
  if (!Number.isFinite(number)) fail('Non-finite float');
  if (Object.is(number, -0)) return '-0';
  if (width === 32 && Math.fround(number) !== number) fail('Float32 narrowing changes value');
  return number.toString();
}

function isLeapYear(year: number): boolean { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function parseDate(value: unknown): { year: number; month: number; day: number } {
  if (typeof value !== 'string') fail('Invalid date');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail('Invalid date');
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail('Invalid date');
  return { year, month, day };
}

function timestampParts(value: unknown): { year: number; month: number; day: number; hour: number; minute: number; second: number; fraction: string; offsetMinutes?: number } {
  if (typeof value !== 'string') fail('Invalid timestamp');
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (!match) fail('Invalid timestamp');
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) fail('Invalid timestamp');
  const zone = match[8];
  const offsetMinutes = zone === undefined || zone === 'Z' ? (zone === 'Z' ? 0 : undefined) : (() => {
    const offset = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone);
    if (!offset) fail('Invalid timestamp offset');
    const sign = offset[1] === '-' ? -1 : 1;
    const hours = Number(offset[2]); const minutes = Number(offset[3] ?? '0');
    if (hours > 23 || minutes > 59) fail('Invalid timestamp offset');
    return sign * (hours * 60 + minutes);
  })();
  return { year, month, day, hour, minute, second, fraction: (match[7] ?? '').padEnd(6, '0'), ...(offsetMinutes === undefined ? {} : { offsetMinutes }) };
}

function formatTimestamp(parts: ReturnType<typeof timestampParts>, instant: boolean): string {
  let { year, month, day, hour, minute, second } = parts;
  if (instant) {
    // Date.UTC treats years 0-99 as 1900-1999. Construct through the
    // full-year setter so valid PostgreSQL dates in that range preserve their
    // Gregorian year during offset normalization.
    const base = new Date(0);
    base.setUTCFullYear(year, month - 1, day);
    base.setUTCHours(hour, minute, second, 0);
    const shifted = new Date(base.getTime() - (parts.offsetMinutes ?? 0) * 60_000);
    year = shifted.getUTCFullYear(); month = shifted.getUTCMonth() + 1; day = shifted.getUTCDate();
    hour = shifted.getUTCHours(); minute = shifted.getUTCMinutes(); second = shifted.getUTCSeconds();
  }
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${parts.fraction}`;
  return `${date}T${time}${instant ? 'Z' : ''}`;
}

function canonicalInet(value: unknown): string {
  if (typeof value !== 'string') fail('Invalid inet');
  try {
    const parsed: [ipaddr.IPv4 | ipaddr.IPv6, number | undefined] = value.includes('/')
      ? ipaddr.parseCIDR(value)
      : [ipaddr.parse(value), undefined];
    const address = parsed[0]; const prefix = parsed[1] as number | undefined;
    const fullWidth = address.kind() === 'ipv4' ? 32 : 128;
    return prefix === undefined || prefix === fullWidth ? address.toString() : `${address.toString()}/${prefix}`;
  } catch { fail('Invalid inet'); }
}

function canonicalTextArray(value: unknown): string {
  let entries: unknown = value;
  if (typeof value === 'string') {
    try { entries = JSON.parse(value) as unknown; } catch { fail('Invalid text array'); }
  }
  if (!Array.isArray(entries) || !entries.every((entry): entry is string => typeof entry === 'string')) fail('Invalid text array');
  if (entries.some((entry) => entry.includes('\u0000'))) fail('Text array contains U+0000');
  return JSON.stringify(entries);
}

export function canonicalize(value: unknown, kind: CanonicalKind, options: CanonicalizeOptions = {}): CanonicalValue {
  if (value === null || value === undefined) return { type: 'null' };
  switch (kind) {
    case 'uuid': return { type: 'uuid', value: canonicalUuid(value) };
    case 'boolean': return { type: 'boolean', value: canonicalBoolean(value) };
    case 'integer': return { type: 'integer', value: canonicalInteger(value) };
    case 'decimal': return { type: 'decimal', value: canonicalDecimal(value, options) };
    case 'float32': return { type: 'float32', value: canonicalFloat(value, 32) };
    case 'float64': return { type: 'float64', value: canonicalFloat(value, 64) };
    case 'date': return { type: 'date', value: (() => { const parsed = parseDate(value); return `${String(parsed.year).padStart(4, '0')}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`; })() };
    case 'inet': return { type: 'inet', value: canonicalInet(value) };
    case 'json': return { type: 'json', value: typeof value === 'string' ? canonicalizeJson(value) : fail('JSON source must be text') };
    case 'binary': {
      let buffer: Buffer;
      if (Buffer.isBuffer(value)) buffer = value;
      else if (typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        buffer = Buffer.from(value, 'base64');
        if (buffer.toString('base64') !== value) fail('Invalid binary');
      } else fail('Invalid binary');
      return { type: 'binary', value: buffer.toString('base64') };
    }
    case 'text': {
      if (typeof value !== 'string') fail('Invalid text');
      if (value.includes('\u0000')) fail('Text contains U+0000');
      return { type: 'text', value };
    }
    case 'text_array': return { type: 'text_array', value: canonicalTextArray(value) };
    case 'instant_utc': {
      const parts = timestampParts(value); return { type: 'instant_utc', value: formatTimestamp(parts, true) };
    }
    case 'naive_timestamp': {
      const parts = timestampParts(value);
      if (parts.offsetMinutes !== undefined && !(options.timestampPolicy === 'utc_z_to_naive' && parts.offsetMinutes === 0)) fail('Naive timestamp cannot contain timezone');
      return { type: 'naive_timestamp', value: formatTimestamp(parts, false) };
    }
    default: return fail('Unsupported canonical kind');
  }
}

export function detectUuidCollisions(values: readonly { table: string; column: string; value: unknown }[]): void {
  const seen = new Map<string, { table: string; column: string }>();
  for (const item of values) {
    const normalized = canonicalUuid(item.value);
    const prior = seen.get(normalized);
    if (prior) throw new Error(`UUID collision at ${item.table}.${item.column} with ${prior.table}.${prior.column}`);
    seen.set(normalized, { table: item.table, column: item.column });
  }
}
