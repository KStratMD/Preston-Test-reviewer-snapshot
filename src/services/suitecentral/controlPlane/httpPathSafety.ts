/**
 * True if an HTTP path (the portion before any query string) is unsafe to send
 * to a pinned single-destination transport: it could traverse outside the
 * validated prefix via `..` segments, backslashes, or percent-encoded
 * separators — including double-encoded forms (`%252e`) that a proxy and backend
 * normalize in successive passes.
 *
 * Used by the pinned transport to reject a bad caller-supplied per-request path
 * before it reaches `https.request`. The outbound policy does NOT need this:
 * `new URL()` already resolves dot-segments (including `%2e` forms) in a
 * configured webhook path at parse time, so no traversal artifact survives into
 * the stored destination.
 */
export function hasUnsafeHttpPath(pathOnly: string): boolean {
  // Recursively percent-decode until stable. At every level reject a backslash
  // or an encoded percent/dot/slash/backslash (`%25` catches double-encoding),
  // and reject malformed encodings outright.
  let current = pathOnly;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.includes('\\') || /%(25|2e|2f|5c)/i.test(current)) {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) {
      break;
    }
    current = decoded;
  }
  if (current.includes('\\')) {
    return true;
  }
  return current.split('/').some((segment) => segment === '..');
}
