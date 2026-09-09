import express, { type Application, Router } from 'express';
import {
  isDynamicRoutePath,
  joinRoutePath,
  normalizeRoutePath,
  type RouteMatchMode,
} from './routePathSemantics';

export type RouteRegistrationSource = 'mount' | 'route';
export type RouteRegistrationCompleteness = 'complete' | 'incomplete';
export type UnresolvedRegistrationReason =
  | 'parameterized_path'
  | 'regexp_path'
  | 'mounted_sub_application'
  | 'non_literal_handler'
  | 'unresolved_mount_prefix';

export interface RecordedRouteRegistration {
  path: string;
  match: RouteMatchMode;
  source: RouteRegistrationSource;
  completeness: RouteRegistrationCompleteness;
  reason?: UnresolvedRegistrationReason;
  /**
   * Upper-case HTTP verbs, only ever set for `source: 'route'`. A mount is a
   * prefix rather than an operation, so giving it methods would invent
   * operations no handler serves.
   */
  methods?: readonly string[];
  /**
   * A printable, stable form of a path this recorder could not resolve to a
   * literal (a RegExp, or any non-string handler argument). Such registrations
   * record `path: ''` and so can never be proven non-API; without a stable name
   * a coverage gate can only drop them (unsound) or fail with nothing to
   * baseline against.
   */
  rawPattern?: string;
}

export interface RouteRegistrationSnapshot {
  registrations: readonly RecordedRouteRegistration[];
  unresolved: readonly RecordedRouteRegistration[];
  complete: boolean;
}

interface LocalRegistration extends RecordedRouteRegistration {
  child?: RouterLike;
}

interface RouterLike {
  stack?: unknown[];
  _router?: { stack?: unknown[] };
  use?: (...args: unknown[]) => unknown;
  get?: (...args: unknown[]) => unknown;
  post?: (...args: unknown[]) => unknown;
  put?: (...args: unknown[]) => unknown;
  patch?: (...args: unknown[]) => unknown;
  delete?: (...args: unknown[]) => unknown;
  options?: (...args: unknown[]) => unknown;
  head?: (...args: unknown[]) => unknown;
  all?: (...args: unknown[]) => unknown;
  route?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

interface Node {
  target: RouterLike;
  registrations: LocalRegistration[];
  children: { node: Node; prefix: string }[];
  patched: boolean;
  seeded: boolean;
}

let nodes = new WeakMap<object, Node>();
const roots = new Set<Node>();
let routerFactoryPatched = false;

const METHOD_NAMES: readonly string[] = [
  'use', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'route',
  'connect', 'trace', 'propfind', 'copy', 'lock', 'mkcol', 'move', 'purge', 'report',
  'search', 'unlink', 'unlock', 'checkout', 'link', 'merge', 'mkactivity', 'notify',
  'rebind', 'source', 'subscribe', 'unbind', 'unsubscribe', 'acl', 'bind', 'm-search',
  'mkcalendar', 'proppatch', 'query',
];

function isRouterLike(value: unknown): value is RouterLike {
  if (typeof value !== 'function') return false;
  const candidate = value as unknown as RouterLike;
  return typeof candidate.use === 'function' || Array.isArray(candidate.stack) || Array.isArray(candidate._router?.stack);
}

function isApplication(value: unknown): boolean {
  return typeof value === 'function' && typeof (value as { listen?: unknown }).listen === 'function';
}

function routerHandlers(value: unknown): RouterLike[] {
  if (Array.isArray(value)) return value.flatMap((item) => routerHandlers(item));
  if (isRouterLike(value) || isApplication(value)) return [value as RouterLike];
  return [];
}

function pathArguments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [value];
}

function reasonForPath(value: unknown): UnresolvedRegistrationReason | undefined {
  if (value instanceof RegExp) return 'regexp_path';
  if (typeof value !== 'string') return 'non_literal_handler';
  let canonical: string;
  try {
    canonical = normalizeRoutePath(value);
  } catch {
    return 'non_literal_handler';
  }
  return isDynamicRoutePath(canonical) ? 'parameterized_path' : undefined;
}

function rawPatternFor(pathValue: unknown): string | undefined {
  if (typeof pathValue === 'string') return undefined;
  if (pathValue instanceof RegExp) return String(pathValue);
  return String(pathValue).slice(0, 120);
}

function record(
  node: Node,
  rawPath: unknown,
  source: RouteRegistrationSource,
  methods?: readonly string[],
): void {
  for (const pathValue of pathArguments(rawPath)) {
    const reason = reasonForPath(pathValue);
    let path: string;
    try {
      path = typeof pathValue === 'string' ? normalizeRoutePath(pathValue) : '';
    } catch {
      path = '';
    }
    const rawPattern = rawPatternFor(pathValue);
    node.registrations.push({
      path,
      match: source === 'route' ? 'exact' : 'prefix',
      source,
      completeness: reason ? 'incomplete' : 'complete',
      ...(reason ? { reason } : {}),
      ...(methods && methods.length > 0 ? { methods } : {}),
      ...(rawPattern !== undefined ? { rawPattern } : {}),
    });
  }
}

function layerPath(layer: unknown): { path: unknown; route: boolean } | null {
  if (!layer || typeof layer !== 'object') return null;
  const candidate = layer as { route?: { path?: unknown }; regexp?: RegExp };
  if (candidate.route && candidate.route.path !== undefined) {
    return { path: candidate.route.path, route: true };
  }
  // A stack layer with a nested stack is a mounted router.  Express does not
  // retain the original mount string, so seed it as unresolved rather than
  // pretending that a compiled regexp is authoritative.
  if (Array.isArray((layer as { handle?: { stack?: unknown[] } }).handle?.stack)) {
    return { path: candidate.regexp ?? '<mounted-router>', route: false };
  }
  return null;
}

/**
 * Express keeps the verbs of a route layer in `layer.route.methods`. This is the
 * only place `app.route(path).post().put()` can be recovered from: those verbs
 * never reach the patched wrapper, which sees a bare `route` call with no verb.
 */
function layerMethods(layer: unknown): readonly string[] | undefined {
  const route = (layer as { route?: { methods?: Record<string, unknown> } } | null)?.route;
  if (!route || typeof route.methods !== 'object' || route.methods === null) return undefined;
  const methods = Object.keys(route.methods)
    .filter((key) => key !== '_all')
    .map((key) => key.toUpperCase())
    .sort();
  return methods.length > 0 ? methods : undefined;
}

function seedExistingStack(node: Node): void {
  if (node.seeded) return;
  node.seeded = true;
  const stack = Array.isArray(node.target.stack) ? node.target.stack : node.target._router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    const found = layerPath(layer);
    if (!found) continue;
    record(node, found.path, found.route ? 'route' : 'mount', found.route ? layerMethods(layer) : undefined);
  }
}

function patchNode(node: Node): void {
  if (node.patched) return;
  node.patched = true;
  for (const methodName of METHOD_NAMES) {
    const original = node.target[methodName];
    if (typeof original !== 'function') continue;
    const wrapped = function (this: RouterLike, ...args: unknown[]): unknown {
      const result = original.apply(this, args);
      const isMount = methodName === 'use';
      if (!isMount && methodName !== 'route' && args.length < 2) return result;
      const pathArg = isMount ? (typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0]) ? args[0] : undefined) : args[0];
      if (pathArg === undefined) {
        if (isMount) {
          for (const child of args.flatMap((value) => routerHandlers(value))) attachChild(node, child, '');
          // A pathless middleware (cors, parsers, error handlers, etc.) is not
          // an addressable route surface. Do not turn ordinary global
          // middleware into an unresolved API registration that would make
          // every real application snapshot permanently incomplete.
        }
        return result;
      }
      // `use` is a prefix, and a bare `route(p)` call carries no verb -- its
      // methods are recovered at snapshot time from `layer.route.methods`.
      const verbMethods =
        isMount || methodName === 'route'
          ? undefined
          : [methodName === 'all' ? 'ALL' : methodName.toUpperCase()];
      record(node, pathArg, isMount ? 'mount' : 'route', verbMethods);
      if (isMount) {
        const children = args.slice(1).flatMap((value) => routerHandlers(value));
        if (children.some((child) => isApplication(child))) {
          const records = node.registrations.slice(-pathArguments(pathArg).length);
          for (const registration of records) {
            registration.completeness = 'incomplete';
            registration.reason = 'mounted_sub_application';
          }
        } else if (children.length > 0) {
          for (const prefix of pathArguments(pathArg)) {
            if (typeof prefix === 'string' && !isDynamicRoutePath(normalizeRoutePath(prefix))) {
              for (const child of children) attachChild(node, child, normalizeRoutePath(prefix));
            } else {
              for (const child of children) attachChild(node, child, '<unresolved>');
            }
          }
        } else if (pathArguments(pathArg).some((p) => typeof p !== 'string' || isDynamicRoutePath(normalizeRoutePath(String(p))))) {
          // app.use('/api/:tenant', handler) has no child router but remains an
          // unresolved registration through the mount record above.
          const last = node.registrations[node.registrations.length - 1];
          if (last) last.completeness = 'incomplete';
        }
      }
      return result;
    };
    node.target[methodName] = wrapped;
  }
}

function attachChild(parent: Node, childTarget: RouterLike, prefix: string): void {
  const child = ensureNode(childTarget);
  if (!parent.children.some((entry) => entry.node === child && entry.prefix === prefix)) {
    parent.children.push({ node: child, prefix });
  }
  seedExistingStack(child);
  patchNode(child);
}

function ensureNode(target: RouterLike): Node {
  const existing = nodes.get(target as object);
  if (existing) return existing;
  const node: Node = { target, registrations: [], children: [], patched: false, seeded: false };
  nodes.set(target as object, node);
  seedExistingStack(node);
  patchNode(node);
  return node;
}

function patchRouterFactory(): void {
  if (routerFactoryPatched) return;
  const currentFactory = express.Router;
  const patchedFactory = function (...args: Parameters<typeof currentFactory>): Router {
    const router = currentFactory(...args);
    // Register routers as soon as they are created so nested mounts made
    // before the router is attached to the application retain their literal
    // path arguments instead of requiring Express's lossy compiled regexp.
    ensureNode(router as unknown as RouterLike);
    return router;
  } as typeof express.Router;
  (express as unknown as { Router: typeof express.Router }).Router = patchedFactory;
  routerFactoryPatched = true;
}

export function installRouteRegistrationRecorder(app: Application): void {
  patchRouterFactory();
  const root = ensureNode(app as unknown as RouterLike);
  roots.add(root);
}

function collect(node: Node, base: string, registrations: RecordedRouteRegistration[], seen: Map<Node, Set<string>>): void {
  const bases = seen.get(node) ?? new Set<string>();
  if (bases.has(base)) return;
  bases.add(base);
  seen.set(node, bases);
  for (const entry of node.registrations) {
    const path = base === '<unresolved>'
      ? '<unresolved>'
      : entry.path === '' ? entry.path : base ? joinRoutePath(base, entry.path) : entry.path;
    registrations.push({
      ...entry,
      path,
      ...(base === '<unresolved>' && entry.completeness === 'complete'
        ? { completeness: 'incomplete' as const, reason: 'unresolved_mount_prefix' as const }
        : {}),
    });
  }
  for (const child of node.children) {
    const childBase = child.prefix === '<unresolved>' ? '<unresolved>' : (base ? joinRoutePath(base, child.prefix || '/') : child.prefix || '/');
    collect(child.node, childBase === '/' ? '' : childBase, registrations, seen);
  }
}

/**
 * Fill in verbs the patched wrapper could not know.
 *
 * `seedExistingStack` is one-shot and runs from `ensureNode` at install time,
 * so it cannot see anything registered afterwards -- which is everything, in
 * normal use. `app.route(p).post().put()` reaches the wrapper as a bare `route`
 * call carrying no verb, so its methods exist only on the Express layer. This
 * pass is idempotent and runs on every snapshot, filling a method-less `route`
 * registration rather than pushing a duplicate that differs only by methods.
 */
function fillMethodsFromStack(node: Node): void {
  const stack = Array.isArray(node.target.stack) ? node.target.stack : node.target._router?.stack;
  if (Array.isArray(stack)) {
    for (const layer of stack) {
      const found = layerPath(layer);
      if (!found || !found.route || typeof found.path !== 'string') continue;
      const methods = layerMethods(layer);
      if (!methods) continue;
      let normalized: string;
      try {
        normalized = normalizeRoutePath(found.path);
      } catch {
        continue;
      }
      const pending = node.registrations.find(
        (entry) => entry.source === 'route' && entry.path === normalized && entry.methods === undefined,
      );
      if (pending) pending.methods = methods;
    }
  }
  for (const child of node.children) fillMethodsFromStack(child.node);
}

export function getRouteRegistrationSnapshot(app: Application): RouteRegistrationSnapshot {
  const root = nodes.get(app as unknown as object);
  if (!root) return { registrations: [], unresolved: [], complete: false };
  seedExistingStack(root);
  fillMethodsFromStack(root);
  const registrations: RecordedRouteRegistration[] = [];
  collect(root, '', registrations, new Map());
  // methods: `GET /x` and `DELETE /x` are two documentable operations at one
  // path, so a key without them silently drops the second verb.
  // rawPattern: every RegExp registration records `path: ''`, so without it two
  // different RegExp routes collapse into one entry and only one of them can
  // ever be named in a coverage baseline.
  const unique = [
    ...new Map(
      registrations.map((entry) => [
        `${entry.source}:${entry.match}:${entry.path}:${entry.reason ?? ''}:${(entry.methods ?? []).join(',')}:${entry.rawPattern ?? ''}`,
        entry,
      ]),
    ).values(),
  ];
  const unresolved = unique.filter((entry) => entry.completeness === 'incomplete');
  return { registrations: unique, unresolved, complete: unresolved.length === 0 };
}

/** Return whether registration recording was installed for this app instance. */
export function isRouteRegistrationRecorderInstalled(app: Application): boolean {
  return nodes.has(app as unknown as object);
}

export function resetRouteRegistrationRecorderForTests(): void {
  roots.clear();
  nodes = new WeakMap<object, Node>();
}
