import compression from 'compression';
import { Request, Response } from 'express';

/**
 * Configuration for response compression
 */
export interface CompressionConfig {
  /**
   * The level of zlib compression to apply (0-9)
   * 0 = no compression, 9 = maximum compression
   */
  level?: number;
  
  /**
   * Minimum response size in bytes to compress
   * Responses smaller than this won't be compressed
   */
  threshold?: number;
  
  /**
   * Filter function to determine if response should be compressed
   */
  filter?: (req: Request, res: Response) => boolean;
  
  /**
   * Memory level for compression (1-9)
   */
  memLevel?: number;
  
  /**
   * Strategy for compression
   */
  strategy?: number;
}

/**
 * Creates optimized compression middleware for the application
 */
export function createCompressionMiddleware(config: CompressionConfig = {}) {
  const defaultConfig: compression.CompressionOptions = {
    // Use level 6 as a good balance between speed and compression
    level: config.level ?? 6,
    
    // Only compress responses larger than 1KB
    threshold: config.threshold ?? 1024,
    
    // Memory level
    memLevel: config.memLevel ?? 8,
    
    // Strategy
    strategy: config.strategy ?? 0, // Z_DEFAULT_STRATEGY
    
    // Custom filter function
    filter: config.filter ?? ((req, res) => {
      // Don't compress if client doesn't support it
      if (!req.headers['accept-encoding']) {
        return false;
      }
      
      // Don't compress server-sent events
      if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
        return false;
      }
      
      // Don't compress if already compressed
      if (res.getHeader('Content-Encoding')) {
        return false;
      }
      
      // Use compression's default filter for other cases
      return compression.filter(req, res);
    })
  };
  
  return compression(defaultConfig);
}

/**
 * Creates a compression middleware specifically optimized for API responses
 */
export function createApiCompressionMiddleware() {
  return createCompressionMiddleware({
    // Higher compression for API responses since they're typically JSON
    level: 7,
    
    // Lower threshold for API responses
    threshold: 512,
    
    filter: (req, res) => {
      const contentType = res.getHeader('Content-Type')?.toString().toLowerCase();
      
      // Always compress JSON responses
      if (contentType?.includes('application/json')) {
        return true;
      }
      
      // Always compress CSV responses
      if (contentType?.includes('text/csv')) {
        return true;
      }
      
      // Always compress XML responses
      if (contentType?.includes('application/xml') || contentType?.includes('text/xml')) {
        return true;
      }
      
      // Don't compress images, videos, or already compressed files
      if (contentType?.match(/^(image|video|audio)\//)) {
        return false;
      }
      
      // Use default compression filter
      return compression.filter(req, res);
    }
  });
}

/**
 * Creates a compression middleware for static assets
 */
export function createStaticCompressionMiddleware() {
  return createCompressionMiddleware({
    // Maximum compression for static assets since they're served many times
    level: 9,
    
    // Higher threshold for static files
    threshold: 2048,
    
    filter: (req, res) => {
      const contentType = res.getHeader('Content-Type')?.toString().toLowerCase();
      
      // Compress text-based static assets
      if (contentType?.match(/^(text|application)\/(css|javascript|html)/)) {
        return true;
      }
      
      // Compress SVG images
      if (contentType?.includes('image/svg+xml')) {
        return true;
      }
      
      // Don't compress other images or already compressed files
      if (contentType?.match(/^(image|video|audio)\//)) {
        return false;
      }
      
      return compression.filter(req, res);
    }
  });
}