import type { Request, Response } from "express";

export interface ErrorOptions {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Sanitizes error details to prevent sensitive information leakage
 */
function sanitizeErrorDetails(details: unknown): unknown {
  if (!details || typeof details !== "object") {
    return details;
  }

  const sensitiveKeys = new Set([
    "password", "secret", "token", "key", "authorization", "auth",
    "credentials", "apikey", "api_key", "private", "internal",
    "connectionstring", "connection_string", "database_url", "db_url",
    "jwt", "session", "cookie", "header", "env", "environment",
  ]);

  const sensitivePatterns = [
    /bearer\s+/i,
    /basic\s+/i,
    /^\d{4}-\d{4}-\d{4}-\d{4}$/,  // Credit card pattern
    /^[\w-]+\.[\w-]+\.[\w-]+$/,    // JWT pattern
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,  // Email pattern
  ];

  function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      // Check for sensitive patterns
      for (const pattern of sensitivePatterns) {
        if (pattern.test(value)) {
          return "[REDACTED]";
        }
      }

      // Truncate very long strings that might contain sensitive data
      if (value.length > 500) {
        return value.substring(0, 100) + "... [TRUNCATED]";
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => sanitizeValue(item));
    }

    if (value && typeof value === "object") {
      return sanitizeObject(value);
    }

    return value;
  }

  function sanitizeObject(obj: unknown): unknown {
    if (!obj || typeof obj !== "object" || obj instanceof Date) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeValue(item));
    }

    const sanitized: Record<string, unknown> = {};
    const objRecord = obj as Record<string, unknown>;

    for (const [key, value] of Object.entries(objRecord)) {
      const keyLower = key.toLowerCase();

      if (sensitiveKeys.has(keyLower) || keyLower.includes("pass") || keyLower.includes("secret")) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizeValue(value);
      }
    }

    return sanitized;
  }

  return sanitizeObject(details);
}

/**
 * Sends a standardized error envelope while preserving legacy `error` field.
 * Adds timestamp and optional path when a Request is provided.
 */
export function sendError(
  res: Response,
  statusCode: number,
  opts: ErrorOptions,
  req?: Request,
  extra?: Record<string, unknown>,
) {
  const body: Record<string, unknown> = {
    error: opts.message, // legacy/simple value
    code: opts.code,
    message: opts.message,
    ...(opts.details !== undefined ? { details: sanitizeErrorDetails(opts.details) } : {}),
    timestamp: new Date().toISOString(),
    ...(req ? { path: req.originalUrl } : {}),
    ...(extra ?? {}),
  };
  return res.status(statusCode).json(body);
}

