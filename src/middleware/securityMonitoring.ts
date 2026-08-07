import type { Request, Response, NextFunction } from 'express';
import type { SecurityMonitor } from '../services/SecurityMonitor';
import { Logger } from '../utils/Logger';

const logger = new Logger('SecurityMonitoringMiddleware');

// Replace (rather than intersect) the global Express.Request user property:
// the global augmentation in src/types/express/index.d.ts declares
// `user?: Express.User` with `id?: number`, while runtime middleware in
// this project sets id as a string. Intersecting with `id?: string` would
// collapse to `never` and silently hide the value at usage sites.
interface AuthedUser {
  id?: string;
  roles?: string[];
}
type AuthedRequest = Omit<Request, 'user'> & { user?: AuthedUser };

// Helper to get SecurityMonitor instance
let securityMonitorInstance: SecurityMonitor | null = null;

export function setSecurityMonitorInstance(instance: SecurityMonitor): void {
  securityMonitorInstance = instance;
}

function getSecurityMonitor(): SecurityMonitor {
  if (!securityMonitorInstance) {
    throw new Error('SecurityMonitor not initialized. Call setSecurityMonitorInstance() first.');
  }
  return securityMonitorInstance;
}

/**
 * Middleware to monitor authentication attempts
 */
export function monitorAuthentication() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const originalJson = res.json;

    res.json = function(body: unknown) {
      try {
        const securityMonitor = getSecurityMonitor();

        // Monitor failed authentication attempts
        if (res.statusCode === 401 || res.statusCode === 403) {
          securityMonitor.recordEvent({
            type: 'authentication_failure',
            severity: 'medium',
            source: 'AuthenticationMiddleware',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              statusCode: res.statusCode,
              endpoint: req.path,
              method: req.method,
              timestamp: new Date().toISOString(),
            },
          });
        }

        // Monitor successful authentication for unusual patterns
        if (res.statusCode === 200 && req.path.includes('/auth/')) {
          const userAgent = req.get('User-Agent') || '';
          const ip = req.ip || '';

          // Detect potential bot activity
          if (userAgent.length < 10 || !userAgent.includes('Mozilla')) {
            securityMonitor.recordEvent({
              type: 'suspicious_activity',
              severity: 'medium',
              source: 'AuthenticationMiddleware',
              userId: req.user?.id,
              ip,
              userAgent,
              resource: req.path,
              action: req.method,
              details: {
                reason: 'Suspicious user agent in authentication',
                userAgent,
                statusCode: res.statusCode,
              },
            });
          }
        }
      } catch (error) {
        logger.error('Error in authentication monitoring', {
          error: error instanceof Error ? error.message : String(error),
          path: req.path,
        });
      }

      return originalJson.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to monitor authorization failures
 */
export function monitorAuthorization() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const originalJson = res.json;

    res.json = function(body: unknown) {
      try {
        const securityMonitor = getSecurityMonitor();

        if (res.statusCode === 403) {
          securityMonitor.recordEvent({
            type: 'authorization_failure',
            severity: 'medium',
            source: 'AuthorizationMiddleware',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              statusCode: res.statusCode,
              endpoint: req.path,
              method: req.method,
              userRoles: req.user?.roles,
              attemptedResource: req.path,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } catch (error) {
        logger.error('Error in authorization monitoring', {
          error: error instanceof Error ? error.message : String(error),
          path: req.path,
        });
      }

      return originalJson.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to monitor rate limit violations
 */
export function monitorRateLimit() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const originalJson = res.json;

    res.json = function(body: unknown) {
      try {
        const securityMonitor = getSecurityMonitor();

        if (res.statusCode === 429) {
          securityMonitor.recordEvent({
            type: 'rate_limit_exceeded',
            severity: 'high',
            source: 'RateLimitMiddleware',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              statusCode: res.statusCode,
              endpoint: req.path,
              method: req.method,
              rateLimitInfo: req.rateLimit,
              timestamp: new Date().toISOString(),
            },
          });
        }
      } catch (error) {
        logger.error('Error in rate limit monitoring', {
          error: error instanceof Error ? error.message : String(error),
          path: req.path,
        });
      }

      return originalJson.call(this, body);
    };

    next();
  };
}

/**
 * Middleware to detect malicious payloads
 */
export function monitorMaliciousPayloads() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const securityMonitor = getSecurityMonitor();

      // Check for common attack patterns in request body
      if (req.body && typeof req.body === 'object') {
        const bodyString = JSON.stringify(req.body).toLowerCase();

        // SQL injection patterns
        const sqlPatterns = [
          /union\s+select/i,
          /drop\s+table/i,
          /insert\s+into/i,
          /delete\s+from/i,
          /update\s+.*\s+set/i,
          /exec\s*\(/i,
          /script\s*>/i,
        ];

        // XSS patterns
        const xssPatterns = [
          /<script[^>]*>.*?<\/script>/i,
          /javascript:/i,
          /on\w+\s*=/i,
          /<iframe/i,
          /eval\s*\(/i,
          /alert\s*\(/i,
        ];

        // Check for SQL injection
        if (sqlPatterns.some(pattern => pattern.test(bodyString))) {
          securityMonitor.recordEvent({
            type: 'injection_attempt',
            severity: 'critical',
            source: 'PayloadMonitoring',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              attackType: 'SQL Injection',
              endpoint: req.path,
              method: req.method,
              payloadSize: bodyString.length,
              timestamp: new Date().toISOString(),
            },
          });
        }

        // Check for XSS
        if (xssPatterns.some(pattern => pattern.test(bodyString))) {
          securityMonitor.recordEvent({
            type: 'xss_attempt',
            severity: 'high',
            source: 'PayloadMonitoring',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              attackType: 'Cross-Site Scripting (XSS)',
              endpoint: req.path,
              method: req.method,
              payloadSize: bodyString.length,
              timestamp: new Date().toISOString(),
            },
          });
        }
      }

      // Check for suspicious file upload attempts
      if (req.headers['content-type']?.includes('multipart/form-data')) {
        const contentLength = parseInt(req.headers['content-length'] || '0');

        // Large file uploads outside of expected endpoints
        if (contentLength > 100 * 1024 * 1024 && !req.path.includes('/upload')) { // 100MB
          securityMonitor.recordEvent({
            type: 'suspicious_activity',
            severity: 'medium',
            source: 'PayloadMonitoring',
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            resource: req.path,
            action: req.method,
            details: {
              reason: 'Large file upload to unexpected endpoint',
              contentLength,
              contentType: req.headers['content-type'],
              endpoint: req.path,
            },
          });
        }
      }
    } catch (error) {
      logger.error('Error in payload monitoring', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
      });
    }

    next();
  };
}

/**
 * Middleware to monitor API abuse patterns
 */
export function monitorAPIAbuse() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const securityMonitor = getSecurityMonitor();

      // Monitor for rapid API calls from same IP
      const ip = req.ip || '';
      const userAgent = req.get('User-Agent') || '';

      // Detect automation tools
      const automationPatterns = [
        /curl/i,
        /wget/i,
        /python-requests/i,
        /postman/i,
        /insomnia/i,
        /httpie/i,
        /go-http-client/i,
        /java/i,
        /apache-httpclient/i,
      ];

      const isAutomation = automationPatterns.some(pattern => pattern.test(userAgent));

      // If automation detected without proper authentication, flag as potential abuse
      if (isAutomation && !req.user?.id && !req.path.includes('/health')) {
        securityMonitor.recordEvent({
          type: 'api_abuse',
          severity: 'medium',
          source: 'APIMonitoring',
          ip,
          userAgent,
          resource: req.path,
          action: req.method,
          details: {
            reason: 'Automated tool detected without authentication',
            userAgent,
            endpoint: req.path,
            method: req.method,
          },
        });
      }

      // Monitor for requests to sensitive endpoints
      const sensitiveEndpoints = [
        '/admin/',
        '/config/',
        '/secrets/',
        '/users/',
        '/roles/',
        '/.env',
        '/backup',
        '/dump',
      ];

      if (sensitiveEndpoints.some(endpoint => req.path.includes(endpoint))) {
        securityMonitor.recordEvent({
          type: 'suspicious_activity',
          severity: 'medium',
          source: 'APIMonitoring',
          userId: req.user?.id,
          ip,
          userAgent,
          resource: req.path,
          action: req.method,
          details: {
            reason: 'Access to sensitive endpoint',
            endpoint: req.path,
            method: req.method,
            authenticated: !!req.user?.id,
          },
        });
      }
    } catch (error) {
      logger.error('Error in API abuse monitoring', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
      });
    }

    next();
  };
}

/**
 * Middleware to check quarantined IPs
 */
export function blockQuarantinedIPs() {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const securityMonitor = getSecurityMonitor();
      const ip = req.ip || '';

      if (securityMonitor.isIPQuarantined(ip)) {
        logger.warn('Blocked request from quarantined IP', {
          ip,
          path: req.path,
          method: req.method,
          userAgent: req.get('User-Agent'),
        });

        return res.status(403).json({
          error: 'Access Denied',
          message: 'Your IP address has been temporarily blocked due to suspicious activity',
          code: 'IP_QUARANTINED',
        });
      }
    } catch (error) {
      logger.error('Error checking quarantined IPs', {
        error: error instanceof Error ? error.message : String(error),
        ip: req.ip,
      });
    }

    return next();
  };
}

/**
 * Comprehensive security monitoring middleware stack
 */
export function createSecurityMonitoringMiddleware() {
  return [
    blockQuarantinedIPs(),
    monitorMaliciousPayloads(),
    monitorAPIAbuse(),
    monitorAuthentication(),
    monitorAuthorization(),
    monitorRateLimit(),
  ];
}

/**
 * Middleware to log configuration changes for audit
 */
export function monitorConfigurationChanges() {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const configEndpoints = ['/api/config/', '/api/integrations/'];
    const isConfigEndpoint = configEndpoints.some(endpoint => req.path.includes(endpoint));

    if (isConfigEndpoint && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const originalJson = res.json;

      res.json = function(body: unknown) {
        try {
          const securityMonitor = getSecurityMonitor();

          if (res.statusCode >= 200 && res.statusCode < 300) {
            securityMonitor.recordEvent({
              type: 'configuration_change',
              severity: 'medium',
              source: 'ConfigurationMonitoring',
              userId: req.user?.id,
              ip: req.ip,
              userAgent: req.get('User-Agent'),
              resource: req.path,
              action: req.method,
              details: {
                endpoint: req.path,
                method: req.method,
                statusCode: res.statusCode,
                changeType: req.method,
                resourceId: req.params.id,
                timestamp: new Date().toISOString(),
              },
            });
          }
        } catch (error) {
          logger.error('Error in configuration change monitoring', {
            error: error instanceof Error ? error.message : String(error),
            path: req.path,
          });
        }

        return originalJson.call(this, body);
      };
    }

    next();
  };
}
