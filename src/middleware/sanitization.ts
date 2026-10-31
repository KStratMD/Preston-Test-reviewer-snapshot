import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Sanitization options for different types of content
 *
 * NOTE: SQL injection prevention is handled by Kysely ORM's parameterized queries,
 * not by input sanitization. Blacklist-based keyword stripping was removed because:
 * 1. It corrupts legitimate data (e.g., "Please SELECT a date" becomes "Please  a date")
 * 2. It can be bypassed with encoding tricks
 * 3. Parameterized queries are the proper protection
 */
export interface SanitizationOptions {
  /**
   * Allow basic HTML tags (b, i, em, strong, a)
   */
  allowBasicHtml?: boolean;

  /**
   * Maximum string length
   */
  maxLength?: number;

  /**
   * Remove script tags and JavaScript
   */
  preventXss?: boolean;

  /**
   * Trim whitespace
   */
  trimWhitespace?: boolean;
}

/**
 * Sanitizes a string value based on options
 */
function sanitizeString(value: string, options: SanitizationOptions = {}): string {
  let sanitized = value;

  const {
    allowBasicHtml = false,
    maxLength = 10000,
    preventXss = true,
    trimWhitespace = true
  } = options;
  
  // Trim whitespace
  if (trimWhitespace) {
    sanitized = sanitized.trim();
  }
  
  // Prevent XSS
  if (preventXss) {
    // Remove script tags and their content
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove event handlers
    sanitized = sanitized.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/\bon\w+\s*=\s*[^\s>]*/gi, '');
    
    // Remove javascript: protocol
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // Encode HTML entities if not allowing HTML
    if (!allowBasicHtml) {
      sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    } else {
      // If allowing basic HTML, only keep safe tags
      const allowedTags = ['b', 'i', 'em', 'strong', 'a'];
      const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

      sanitized = sanitized.replace(tagRegex, (match: string, tag: string): string => {
        if (allowedTags.includes(tag.toLowerCase())) {
          return match;
        }
        return '';
      });
    }
  }

  // Enforce max length
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Recursively sanitizes an object
 */
function sanitizeObject(obj: unknown, options: SanitizationOptions = {}): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'string') {
    return sanitizeString(obj, options);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, options));
  }
  
  if (typeof obj === 'object' && obj.constructor === Object) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Sanitize the key as well
      const sanitizedKey = sanitizeString(key, { ...options, maxLength: 100 });
      sanitized[sanitizedKey] = sanitizeObject(value, options);
    }
    return sanitized;
  }
  
  // Return other types as-is (numbers, booleans, etc.)
  return obj;
}

/**
 * Express middleware for input sanitization
 */
export function createSanitizationMiddleware(defaultOptions: SanitizationOptions = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body, defaultOptions);
    }
    
    // Sanitize query parameters
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query, defaultOptions) as typeof req.query;
    }
    
    // Sanitize URL parameters
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params, defaultOptions) as typeof req.params;
    }
    
    next();
  };
}

/**
 * Zod schema for validating and sanitizing email
 */
export const EmailSchema = z.string()
  .email()
  .transform(val => val.toLowerCase().trim());

/**
 * Zod schema for validating and sanitizing URLs
 */
export const UrlSchema = z.string()
  .url()
  .transform(val => {
    try {
      const url = new URL(val);
      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid protocol');
      }
      return url.toString();
    } catch {
      throw new Error('Invalid URL');
    }
  });

/**
 * Zod schema for validating and sanitizing phone numbers
 */
export const PhoneSchema = z.string()
  .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number')
  .transform(val => val.replace(/\D/g, ''));

/**
 * Create a sanitized string schema with options
 */
export function createSanitizedStringSchema(options: SanitizationOptions = {}) {
  return z.string().transform(val => sanitizeString(val, options));
}

/**
 * Middleware for validating request against a Zod schema
 */
export function validateRequest<T>(schema: z.ZodSchema<T>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });
      
      // Update request with validated data
      const result = validated as { body?: unknown; query?: unknown; params?: unknown };
      req.body = result.body ?? req.body;
      req.query = (result.query as typeof req.query) ?? req.query;
      req.params = (result.params as typeof req.params) ?? req.params;
      
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.issues
        });
      } else {
        next(error);
      }
    }
  };
}

// Export utility functions for use in other parts of the application
export { sanitizeString, sanitizeObject };