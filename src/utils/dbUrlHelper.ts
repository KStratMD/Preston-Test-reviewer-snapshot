/**
 * Check whether a DATABASE_URL contains embedded credentials (user:pass@host).
 * Uses URL parsing (not regex) for robustness.
 */
export function hasDbUrlCredentials(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return !!parsed.username && !!parsed.password;
  } catch {
    return false;
  }
}

/**
 * Map PGSSLMODE to the pg library's `ssl` option.
 *
 * pg doesn't support prefer/allow semantics natively — passing any ssl
 * object forces TLS. We map to the closest pg behavior:
 *   disable        → false (no TLS)
 *   allow/prefer   → false in dev, TLS + cert validation in prod (defense in depth)
 *   require        → { rejectUnauthorized: false } (TLS, no cert check — per PG spec)
 *   verify-ca/full → { rejectUnauthorized: true } (TLS + cert verification)
 *
 * Production default (prefer) validates certs. To skip cert validation in prod,
 * explicitly set PGSSLMODE=require.
 */
export function pgSslConfig(
  mode: string,
  nodeEnv: string
): false | { rejectUnauthorized: boolean } {
  if (mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode === 'require') return { rejectUnauthorized: false };
  // allow / prefer: TLS with cert validation in production, off in dev
  return nodeEnv === 'production' ? { rejectUnauthorized: true } : false;
}
