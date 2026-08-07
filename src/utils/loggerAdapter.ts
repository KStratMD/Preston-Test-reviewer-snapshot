type Callable = (...args: unknown[]) => unknown;

type ChildLoggerFactory = (ctx?: unknown) => unknown;

interface CloseableLogger {
  close?: Callable;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getMethod(value: unknown, methodName: string): Callable | undefined {
  if (!isObjectRecord(value)) return undefined;
  const maybeMethod = value[methodName];
  return typeof maybeMethod === "function" ? (maybeMethod as Callable) : undefined;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return isObjectRecord(value) && typeof value.then === "function";
}

export interface ScopeLoggerLike {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  child?: (ctx?: unknown) => ScopeLoggerLike;
}

export function adaptScopeLogger(logger: unknown): ScopeLoggerLike {
  const base = isObjectRecord(logger) ? logger : {};
  const wrap = (fnName: string) => (...args: unknown[]) => {
    try {
      const fn = getMethod(base, fnName) ?? getMethod(base, "log");
      if (fn) {
        return fn.apply(base, args);
      }
    } catch (_) {
      // swallow logging adapter errors in demo mode
    }
  };

  const adapter: ScopeLoggerLike = {
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    debug: wrap("debug"),
    child: (ctx?: unknown) => {
      try {
        const childFactory = getMethod(base, "child") as ChildLoggerFactory | undefined;
        if (childFactory) {
          return adaptScopeLogger(childFactory(ctx));
        }
      } catch (_) { /* ignore */ }
      return adapter;
    },
  };

  return adapter;
}

export async function safeCloseLogger(logger: unknown): Promise<void> {
  if (!logger) return;
  try {
    const closeFn = getMethod(logger as CloseableLogger, "close");
    if (closeFn) {
      // Some loggers return a promise, some accept a callback, handle both
      const res = closeFn.call(logger);
      if (isPromiseLike(res)) await res;
    }
  } catch (_) {
    // swallow
  }
}
