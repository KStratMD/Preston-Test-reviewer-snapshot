import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../../utils/Logger';
import { VALIDATION_CONSTANTS } from '../../constants/systemConstants';

/**
 * Input sanitization middleware to prevent XSS and injection attacks
 */
export function createInputSanitizer(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const removeControlChars = (input: string): string => {
      let out = '';
      for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        // Skip C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters
        if ((code >= 0x00 && code <= 0x1F) || code === 0x7F || (code >= 0x80 && code <= 0x9F)) {
          continue;
        }
        out += input[i];
      }
      return out;
    };
    const sanitizeValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let out = value
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
          .replace(/on\w+\s*=\s*(['"]).*?\1/gi, ''); // Remove event handlers with quoted values
        out = removeControlChars(out);
        // If it's a pure javascript: URL after trimming, blank it. Otherwise, strip occurrences.
        const trimmed = out.trim();
        if (/^javascript\s*:/i.test(trimmed)) {
          out = '';
        } else {
          out = trimmed.replace(/javascript\s*:/gi, '');
        }
        return out.substring(0, VALIDATION_CONSTANTS.MAX_STRING_LENGTH);
      }

      if (Array.isArray(value)) {
        return value.map(sanitizeValue);
      }

      if (value && typeof value === 'object') {
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          // Sanitize keys as well
          const cleanKey = sanitizeValue(key) as string;
          sanitized[cleanKey] = sanitizeValue(val);
        }
        return sanitized;
      }

      return value;
    };

    try {
      if (req.body) {
        req.body = sanitizeValue(req.body);
      }
    } catch (error) {
      logger.error('Input sanitization failed for body', error);
    }

    try {
      if (req.query && typeof req.query === 'object') {
        const sanitizedQuery = sanitizeValue(req.query) as Record<string, unknown>;
        Object.keys(req.query).forEach(key => {
          delete req.query[key];
        });
        Object.assign(req.query, sanitizedQuery);
      }
    } catch (error) {
      logger.error('Input sanitization failed for query', error);
    }

    try {
      if (req.params && typeof req.params === 'object') {
        const sanitizedParams = sanitizeValue(req.params) as Record<string, unknown>;
        Object.keys(req.params).forEach(key => {
          delete req.params[key];
        });
        Object.assign(req.params, sanitizedParams);
      }
    } catch (error) {
      logger.error('Input sanitization failed for params', error);
    }

    next();
  };
}

/**
 * HTML entity encoder to prevent XSS in HTML contexts
 */
export function htmlEncode(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * URL encoder to prevent injection in URL contexts
 */
export function urlEncode(str: string): string {
  return encodeURIComponent(str);
}

/**
 * CSS value sanitizer to prevent CSS injection
 */
export function sanitizeCSSValue(value: string): string {
  // Remove potentially dangerous CSS patterns
  return value
    .replace(/expression\s*\(/gi, '') // IE CSS expressions
    .replace(/javascript\s*:/gi, '') // JavaScript URLs
    .replace(/vbscript\s*:/gi, '') // VBScript URLs
    .replace(/@import/gi, '') // CSS imports
    .replace(/behavior\s*:/gi, '') // IE behaviors
    .trim();
}