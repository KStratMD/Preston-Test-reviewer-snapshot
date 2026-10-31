import { createHash } from 'node:crypto';

export interface ParsedTargetIdentity {
  readonly protocol: 'postgres:' | 'postgresql:';
  readonly hostname: string;
  readonly port: number;
  readonly database: string;
  readonly fingerprint: string;
}

export const FORBIDDEN_SESSION_OPTION_KEYS: ReadonlySet<string> = new Set([
  'options', 'search_path', 'currentschema', 'timezone',
  'statement_timeout', 'lock_timeout', 'application_name',
]);

/** Parse and validate the explicitly selected PostgreSQL target without ever
 * returning credentials or query-string session overrides. */
export function parseTargetIdentity(databaseUrl: string): ParsedTargetIdentity {
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is invalid'); }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('DATABASE_URL must use a PostgreSQL scheme');
  if (!parsed.hostname || !parsed.username || !parsed.password) throw new Error('DATABASE_URL requires host, user, and password');
  for (const key of parsed.searchParams.keys()) if (FORBIDDEN_SESSION_OPTION_KEYS.has(key.toLowerCase())) throw new Error('DATABASE_URL contains a session-option override');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL requires a database name');
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DATABASE_URL port is invalid');
  const hostname = parsed.hostname.toLowerCase();
  const normalized = `${hostname}:${port}/${database}`;
  return {
    protocol: parsed.protocol,
    hostname,
    port,
    database,
    fingerprint: createHash('sha256').update(normalized).digest('hex'),
  };
}

export function targetFingerprint(databaseUrl: string): string {
  return parseTargetIdentity(databaseUrl).fingerprint;
}
