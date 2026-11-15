import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/Logger';
import { createHash, timingSafeEqual, randomBytes } from 'crypto';

// Extended request interface for file uploads using proper Multer types
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  stream: import('stream').Readable;
  destination: string;
  filename: string;
  path: string;
}

interface MulterRequest extends Request {
  file?: MulterFile;
  files?: MulterFile[] | { [fieldname: string]: MulterFile[] };
}

export interface SecurityConfig {
  enableCSP?: boolean;
  enableHSTS?: boolean;
  enableFrameGuard?: boolean;
  enableXSSProtection?: boolean;
  enableContentTypeValidation?: boolean;
  enableInputSanitization?: boolean;
  enableRateLimitByUser?: boolean;
  enableSQLInjectionProtection?: boolean;
  enableFileUploadProtection?: boolean;
  maxRequestSize?: string;
  allowedOrigins?: string[];
  blockedUserAgents?: RegExp[];
  suspiciousPatterns?: RegExp[];
  enableEmbedding?: boolean;
}

export interface SecurityMetrics {
  totalRequests: number;
  blockedRequests: number;
  suspiciousRequests: number;
  cspViolations: number;
  xssAttempts: number;
  sqlInjectionAttempts: number;
  fileUploadAttacks: number;
  rateLimitHits: number;
  lastThreatDetected?: Date;
  threatsByType: Record<string, number>;
  blockedIPs: Set<string>;
}

export class AdvancedSecurityMiddleware {
  private readonly config: Required<SecurityConfig>;
  private readonly metrics: SecurityMetrics;
  private readonly blockedIPs = new Set<string>();
  private readonly suspiciousIPs = new Map<string, { count: number; lastSeen: Date }>();
  private readonly nonces = new Map<string, { nonce: string; expires: number }>();

  private cleanupInterval: NodeJS.Timeout;

  constructor(config: SecurityConfig = {}) {
    this.config = {
      enableCSP: config.enableCSP ?? true,
      enableHSTS: config.enableHSTS ?? true,
      enableFrameGuard: config.enableFrameGuard ?? true,
      enableXSSProtection: config.enableXSSProtection ?? true,
      enableContentTypeValidation: config.enableContentTypeValidation ?? true,
      enableInputSanitization: config.enableInputSanitization ?? true,
      enableRateLimitByUser: config.enableRateLimitByUser ?? true,
      enableSQLInjectionProtection: config.enableSQLInjectionProtection ?? true,
      enableFileUploadProtection: config.enableFileUploadProtection ?? true,
      maxRequestSize: config.maxRequestSize || '10mb',
      allowedOrigins: config.allowedOrigins || ['http://localhost:3000'],
      blockedUserAgents: config.blockedUserAgents || [
        /bot/i, /crawler/i, /spider/i, /scraper/i,
      ],
      suspiciousPatterns: config.suspiciousPatterns || [
        /(\bUNION\b.*\bSELECT\b)/i,
        /(\bSELECT\b.*\bFROM\b.*\bWHERE\b)/i,
        /<script[^>]*>.*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /\beval\s*\(/gi,
        /\bdocument\.cookie\b/gi,
      ],
      enableEmbedding: config.enableEmbedding ?? false,
    };

    this.metrics = {
      totalRequests: 0,
      blockedRequests: 0,
      suspiciousRequests: 0,
      cspViolations: 0,
      xssAttempts: 0,
      sqlInjectionAttempts: 0,
      fileUploadAttacks: 0,
      rateLimitHits: 0,
      threatsByType: {},
      blockedIPs: this.blockedIPs,
    };

    this.cleanupInterval = this.startCleanupTimer();
  }

  public cleanup(): void {
    clearInterval(this.cleanupInterval);
  }

  // Main security middleware
  public getMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      this.metrics.totalRequests++;

      try {
        // Check if IP is blocked
        const clientIP = this.getClientIP(req);
        if (this.blockedIPs.has(clientIP)) {
          this.recordThreat('blocked_ip', req);
          res.status(403).json({ error: 'Access denied' });
          return;
        }

        // Apply security headers
        this.applySecurityHeaders(req, res);

        // Validate user agent
        if (this.isBlockedUserAgent(req)) {
          this.recordThreat('blocked_user_agent', req);
          res.status(403).json({ error: 'Access denied' });
          return;
        }

        // Check for suspicious patterns
        if (this.detectSuspiciousPatterns(req)) {
          this.handleSuspiciousRequest(req, res);
          return;
        }

        // Content type validation
        if (this.config.enableContentTypeValidation && !this.validateContentType(req)) {
          this.recordThreat('invalid_content_type', req);
          res.status(400).json({ error: 'Invalid content type' });
          return;
        }

        // Input sanitization
        if (this.config.enableInputSanitization) {
          this.sanitizeInput(req);
        }

        next();
      } catch (error) {
        logger.error('Security middleware error', { error, ip: this.getClientIP(req) });
        next();
      }
    };
  }

  private applySecurityHeaders(req: Request, res: Response): void {
    // Content Security Policy
    if (this.config.enableCSP) {
      const nonce = this.generateNonce();

      // Determine frame-ancestors
      let frameAncestors = "'none'";
      if (this.config.enableEmbedding) {
        // Get allowed frame ancestors from env or use defaults
        const allowedAncestors = process.env.ALLOWED_FRAME_ANCESTORS
          ? process.env.ALLOWED_FRAME_ANCESTORS.split(',').map(d => d.trim()).join(' ')
          : "'self' https://*.netsuite.com https://*.app.netsuite.com https://*.businesscentral.dynamics.com https://*.bc.dynamics.com";
        frameAncestors = allowedAncestors;
      }

      const csp = [
        'default-src \'self\'',
        `script-src 'self' 'nonce-${nonce}'`,
        'style-src \'self\' \'unsafe-inline\'',
        'img-src \'self\' data: https:',
        'font-src \'self\' https:',
        'connect-src \'self\'',
        `frame-ancestors ${frameAncestors}`,
      ].join('; ');
      res.setHeader('Content-Security-Policy', csp);
      (req as Request & { nonce?: string }).nonce = nonce;
    }

    // HTTP Strict Transport Security
    if (this.config.enableHSTS) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    // Frame protection
    // Only apply X-Frame-Options if embedding is NOT enabled (CSP frame-ancestors handles it otherwise)
    if (this.config.enableFrameGuard && !this.config.enableEmbedding) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Frame-Options', 'DENY');
    }

    // XSS Protection
    if (this.config.enableXSSProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // Additional security headers
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  }

  private generateNonce(): string {
    const nonce = randomBytes(16).toString('base64');
    const expires = Date.now() + 300000; // 5 minutes

    // Clean up old nonces
    for (const [key, value] of this.nonces.entries()) {
      if (value.expires < Date.now()) {
        this.nonces.delete(key);
      }
    }

    this.nonces.set(nonce, { nonce, expires });
    return nonce;
  }

  private isBlockedUserAgent(req: Request): boolean {
    const userAgent = req.get('User-Agent') || '';
    return this.config.blockedUserAgents.some(pattern => pattern.test(userAgent));
  }

  private detectSuspiciousPatterns(req: Request): boolean {
    const inputs = [
      req.url,
      req.get('User-Agent') || '',
      req.get('Referer') || '',
      JSON.stringify(req.query),
      JSON.stringify(req.body || {}),
    ];

    for (const input of inputs) {
      for (const pattern of this.config.suspiciousPatterns) {
        if (pattern.test(input)) {
          const patternType = this.getPatternType(pattern);
          this.recordThreat(patternType, req);
          return true;
        }
      }
    }

    return false;
  }

  private getPatternType(pattern: RegExp): string {
    const patternStr = pattern.toString();
    if (patternStr.includes('UNION') || patternStr.includes('SELECT')) {
      return 'sql_injection';
    }
    if (patternStr.includes('script') || patternStr.includes('javascript')) {
      return 'xss_attempt';
    }
    return 'suspicious_pattern';
  }

  private validateContentType(req: Request): boolean {
    const method = req.method.toLowerCase();
    const contentType = req.get('Content-Type') || '';

    // Only validate for methods that should have content
    if (['post', 'put', 'patch'].includes(method)) {
      const allowedTypes = [
        'application/json',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
      ];

      // Check if content type is allowed
      const isAllowed = allowedTypes.some(type =>
        contentType.toLowerCase().startsWith(type.toLowerCase()),
      );

      if (!isAllowed && req.body && Object.keys(req.body).length > 0) {
        return false;
      }
    }

    return true;
  }

  private sanitizeInput(req: Request): void {
    if (req.body && typeof req.body === 'object') {
      req.body = this.sanitizeObject(req.body);
    }

    if (req.query && typeof req.query === 'object') {
      // sanitizeObject returns unknown; assert to any to satisfy Express query typing
      req.query = this.sanitizeObject(req.query) as any;
    }
  }

  private sanitizeObject(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) {
      return this.sanitizeString(String(obj));
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const sanitizedKey = this.sanitizeString(key);
      sanitized[sanitizedKey] = this.sanitizeObject(value);
    }

    return sanitized;
  }

  private sanitizeString(str: string): string {
    if (typeof str !== 'string') return str;

    return str
      // Remove script tags
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      // Remove javascript: protocols
      .replace(/javascript:/gi, '')
      // Remove on event handlers
      .replace(/on\w+\s*=/gi, '')
      // Remove SQL injection patterns
      .replace(/(\bUNION\b.*\bSELECT\b)/gi, '')
      .replace(/(\bSELECT\b.*\bFROM\b.*\bWHERE\b)/gi, '')
      // Escape HTML characters with strong typing in replace callback
      .replace(/[<>&"']/g, (match): string => {
        const entities: Record<string, string> = {
          '<': '&lt;', '>': '&gt;', '&': '&amp;',
          '"': '&quot;', '\'': '&#39;',
        };
        return entities[match] ?? '';
      });
  }

  private handleSuspiciousRequest(req: Request, res: Response): void {
    const clientIP = this.getClientIP(req);

    // Track suspicious activity
    const current = this.suspiciousIPs.get(clientIP) || { count: 0, lastSeen: new Date() };
    current.count++;
    current.lastSeen = new Date();
    this.suspiciousIPs.set(clientIP, current);

    // Block IP after threshold
    if (current.count >= 5) {
      this.blockedIPs.add(clientIP);
      logger.warn('IP blocked due to suspicious activity', {
        ip: clientIP,
        suspiciousCount: current.count,
        userAgent: req.get('User-Agent'),
        url: req.url,
      });
    }

    this.metrics.suspiciousRequests++;
    res.status(400).json({
      error: 'Suspicious request detected',
      requestId: this.generateRequestId(),
    });
  }

  private recordThreat(type: string, req: Request): void {
    this.metrics.blockedRequests++;
    this.metrics.threatsByType[type] = (this.metrics.threatsByType[type] || 0) + 1;
    this.metrics.lastThreatDetected = new Date();

    // Update specific metrics
    switch (type) {
      case 'xss_attempt':
        this.metrics.xssAttempts++;
        break;
      case 'sql_injection':
        this.metrics.sqlInjectionAttempts++;
        break;
      case 'file_upload_attack':
        this.metrics.fileUploadAttacks++;
        break;
      case 'rate_limit':
        this.metrics.rateLimitHits++;
        break;
    }

    logger.warn('Security threat detected', {
      type,
      ip: this.getClientIP(req),
      userAgent: req.get('User-Agent'),
      url: req.url,
      timestamp: new Date().toISOString(),
    });
  }

  private getClientIP(req: Request): string {
    return (
      req.ip ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      req.get('X-Forwarded-For')?.split(',')[0] ||
      req.get('X-Real-IP') ||
      'unknown'
    );
  }

  private generateRequestId(): string {
    return randomBytes(8).toString('hex');
  }

  private startCleanupTimer(): NodeJS.Timeout {
    return setInterval(() => {
      this.cleanupOldEntries();
    }, 300000); // 5 minutes
  }

  private cleanupOldEntries(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    // Clean up suspicious IPs
    for (const [ip, data] of this.suspiciousIPs.entries()) {
      if (now - data.lastSeen.getTime() > maxAge) {
        this.suspiciousIPs.delete(ip);
      }
    }

    // Clean up old nonces
    for (const [nonce, data] of this.nonces.entries()) {
      if (data.expires < now) {
        this.nonces.delete(nonce);
      }
    }

    logger.debug('Security cleanup completed', {
      suspiciousIPs: this.suspiciousIPs.size,
      blockedIPs: this.blockedIPs.size,
      activeNonces: this.nonces.size,
    });
  }

  // CORS middleware with advanced options
  public getCORSMiddleware(options: {
    credentials?: boolean;
    maxAge?: number;
    exposedHeaders?: string[];
  } = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
      const origin = req.get('Origin');

      // Check if origin is allowed
      if (origin && this.config.allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else if (this.config.allowedOrigins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }

      // Set CORS headers
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,X-API-Key');

      if (options.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (options.maxAge) {
        res.setHeader('Access-Control-Max-Age', options.maxAge.toString());
      }

      if (options.exposedHeaders) {
        res.setHeader('Access-Control-Expose-Headers', options.exposedHeaders.join(','));
      }

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      next();
    };
  }

  // File upload security middleware
  public getFileUploadSecurityMiddleware() {
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain', 'text/csv',
      'application/json', 'application/xml',
    ];

    const blockedExtensions = [
      '.exe', '.bat', '.cmd', '.scr', '.pif', '.jar',
      '.js', '.vbs', '.php', '.asp', '.jsp',
    ];

    return (req: Request, res: Response, next: NextFunction) => {
      const multerReq = req as MulterRequest;

      if (multerReq.file || multerReq.files) {
        const files = multerReq.files ? Object.values(multerReq.files).flat() : [multerReq.file];

        for (const file of files) {
          if (!file) continue;

          // Check file size (example: 10MB max)
          if (file.size > 10 * 1024 * 1024) {
            this.recordThreat('file_upload_attack', req);
            res.status(413).json({ error: 'File too large' });
            return;
          }

          // Check MIME type
          if (!allowedMimeTypes.includes(file.mimetype)) {
            this.recordThreat('file_upload_attack', req);
            res.status(400).json({ error: 'File type not allowed' });
            return;
          }

          // Check file extension
          const ext = `.${file.originalname.split('.').pop()?.toLowerCase()}`;
          if (blockedExtensions.includes(ext)) {
            this.recordThreat('file_upload_attack', req);
            res.status(400).json({ error: 'File extension not allowed' });
            return;
          }

          // Check for embedded scripts in filenames
          if (this.config.suspiciousPatterns.some(pattern => pattern.test(file.originalname))) {
            this.recordThreat('file_upload_attack', req);
            res.status(400).json({ error: 'Suspicious filename detected' });
            return;
          }
        }
      }

      next();
    };
  }

  // API key validation with timing attack protection
  public validateAPIKey(providedKey: string, validKey: string): boolean {
    if (!providedKey || !validKey) {
      return false;
    }

    // Hash both keys to ensure consistent length
    const providedHash = createHash('sha256').update(providedKey).digest();
    const validHash = createHash('sha256').update(validKey).digest();

    // Use timing-safe comparison
    return timingSafeEqual(providedHash, validHash);
  }

  // Get security metrics
  public getMetrics(): SecurityMetrics {
    return {
      ...this.metrics,
      blockedIPs: new Set(this.blockedIPs), // Return a copy
    };
  }

  // Unblock IP address
  public unblockIP(ip: string): boolean {
    const wasBlocked = this.blockedIPs.has(ip);
    this.blockedIPs.delete(ip);
    this.suspiciousIPs.delete(ip);

    if (wasBlocked) {
      logger.info('IP unblocked', { ip });
    }

    return wasBlocked;
  }

  // Get security report
  public getSecurityReport(): unknown {
    const metrics = this.getMetrics();
    const blockRate = metrics.totalRequests > 0
      ? (metrics.blockedRequests / metrics.totalRequests * 100).toFixed(2)
      : '0.00';

    return {
      overview: {
        totalRequests: metrics.totalRequests,
        blockedRequests: metrics.blockedRequests,
        blockRate: `${blockRate}%`,
        lastThreatDetected: metrics.lastThreatDetected?.toISOString() || 'None',
      },
      threats: metrics.threatsByType,
      blocked: {
        ipCount: metrics.blockedIPs.size,
        ips: Array.from(metrics.blockedIPs).slice(0, 10), // Show first 10
      },
      suspicious: {
        ipCount: this.suspiciousIPs.size,
        ips: Array.from(this.suspiciousIPs.entries())
          .slice(0, 10)
          .map(([ip, data]) => ({ ip, count: data.count, lastSeen: data.lastSeen })),
      },
    };
  }
}
