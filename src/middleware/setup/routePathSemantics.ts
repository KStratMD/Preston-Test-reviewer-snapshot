/**
 * Shared path semantics for route registration, manifests, and dispatch.
 *
 * This module deliberately has no Express dependency.  Registration records
 * and manifests can therefore be consumed by the VM-based audit scripts as
 * well as by the runtime middleware.
 */

export type RouteMatchMode = 'exact' | 'prefix';

/** Normalize a request or registration path to the canonical route spelling. */
export function normalizeRoutePath(path: string): string {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new TypeError('Route path must be a non-empty string');
  }

  let normalized = path.trim().replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized.toLowerCase();
}

/** Return true when a normalized path contains an Express dynamic token. */
export function isDynamicRoutePath(path: string): boolean {
  return /[:*?+()[\]{}]/.test(path);
}

/** Match exact paths or path-component prefixes using shared normalization. */
export function routePathMatches(
  requestPath: string,
  manifestPath: string,
  mode: RouteMatchMode = 'prefix',
): boolean {
  const request = normalizeRoutePath(requestPath);
  const manifest = normalizeRoutePath(manifestPath);
  return mode === 'exact' ? request === manifest : request === manifest || request.startsWith(`${manifest}/`);
}

/** Join a mount path and a child route while retaining canonical semantics. */
export function joinRoutePath(parentPath: string, childPath: string): string {
  const parent = normalizeRoutePath(parentPath);
  const child = normalizeRoutePath(childPath);
  if (parent === '/') return child;
  if (child === '/') return parent;
  return normalizeRoutePath(`${parent}/${child}`);
}
