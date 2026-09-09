import type { RequestHandler } from 'express';
import type { Logger } from '../../utils/Logger';

// Import all security modules
import { createInputSanitizer } from './sanitization';
import { 
  createRequestSizeValidator, 
  createContentTypeValidator, 
  createFileUploadValidator,
  createUrlParameterValidator 
} from './validation';
import { 
  createSQLInjectionProtection, 
  createXSSProtection, 
  createPathTraversalProtection,
  createRateLimitProtection,
  createCSRFProtection 
} from './protection';
import { 
  createApiKeyValidator, 
  createJWTValidator, 
  createBasicAuthValidator,
  createSessionValidator,
  createRoleValidator,
  createPermissionValidator 
} from './authentication';

export interface SecurityOptions {
  sanitization?: {
    enabled: boolean;
  };
  validation?: {
    requestSize?: {
      enabled: boolean;
      maxSizeBytes?: number;
    };
    contentType?: {
      enabled: boolean;
      allowedTypes?: string[];
    };
    fileUpload?: {
      enabled: boolean;
      maxFileSize?: number;
      allowedTypes?: string[];
      maxFiles?: number;
    };
    urlParameters?: {
      enabled: boolean;
      validations?: Record<string, {
        required?: boolean;
        pattern?: RegExp;
        maxLength?: number;
        allowedValues?: string[];
      }>;
    };
  };
  protection?: {
    sqlInjection?: {
      enabled: boolean;
    };
    xss?: {
      enabled: boolean;
    };
    pathTraversal?: {
      enabled: boolean;
    };
    rateLimit?: {
      enabled: boolean;
      windowMs?: number;
      maxRequests?: number;
      keyGenerator?: (req: unknown) => string;
    };
    csrf?: {
      enabled: boolean;
      tokenSecret?: string;
    };
  };
  authentication?: {
    apiKey?: {
      enabled: boolean;
    };
    jwt?: {
      enabled: boolean;
      secret?: string;
    };
    basicAuth?: {
      enabled: boolean;
      credentials?: { username: string; password: string }[];
    };
    session?: {
      enabled: boolean;
    };
    roles?: {
      enabled: boolean;
      allowedRoles?: string[];
    };
    permissions?: {
      enabled: boolean;
      requiredPermissions?: string[];
    };
  };
}

/**
 * Factory class for creating modular security middleware
 */
export class SecurityMiddlewareFactory {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Create input sanitization middleware
   */
  createSanitization(options: SecurityOptions['sanitization'] = { enabled: true }): RequestHandler | null {
    if (!options.enabled) return null;
    return createInputSanitizer(this.logger);
  }

  /**
   * Create request validation middleware stack
   */
  createValidation(options: SecurityOptions['validation'] = {}): RequestHandler[] {
    const middlewares: RequestHandler[] = [];

    if (options.requestSize?.enabled) {
      middlewares.push(createRequestSizeValidator(
        this.logger, 
        options.requestSize.maxSizeBytes
      ));
    }

    if (options.contentType?.enabled) {
      middlewares.push(createContentTypeValidator(
        this.logger, 
        options.contentType.allowedTypes
      ));
    }

    if (options.fileUpload?.enabled) {
      middlewares.push(createFileUploadValidator(this.logger, {
        maxFileSize: options.fileUpload.maxFileSize,
        allowedTypes: options.fileUpload.allowedTypes,
        maxFiles: options.fileUpload.maxFiles,
      }));
    }

    if (options.urlParameters?.enabled && options.urlParameters.validations) {
      middlewares.push(createUrlParameterValidator(
        this.logger,
        options.urlParameters.validations
      ));
    }

    return middlewares;
  }

  /**
   * Create security protection middleware stack
   */
  createProtection(options: SecurityOptions['protection'] = {}): RequestHandler[] {
    const middlewares: RequestHandler[] = [];

    if (options.sqlInjection?.enabled) {
      middlewares.push(createSQLInjectionProtection(this.logger));
    }

    if (options.xss?.enabled) {
      middlewares.push(createXSSProtection(this.logger));
    }

    if (options.pathTraversal?.enabled) {
      middlewares.push(createPathTraversalProtection(this.logger));
    }

    if (options.rateLimit?.enabled) {
      middlewares.push(createRateLimitProtection(this.logger, {
        windowMs: options.rateLimit.windowMs,
        maxRequests: options.rateLimit.maxRequests,
        keyGenerator: options.rateLimit.keyGenerator,
      }));
    }

    if (options.csrf?.enabled && options.csrf.tokenSecret) {
      middlewares.push(createCSRFProtection(this.logger, options.csrf.tokenSecret));
    }

    return middlewares;
  }

  /**
   * Create authentication middleware stack
   */
  createAuthentication(options: SecurityOptions['authentication'] = {}): RequestHandler[] {
    const middlewares: RequestHandler[] = [];

    if (options.apiKey?.enabled) {
      middlewares.push(createApiKeyValidator(this.logger));
    }

    if (options.jwt?.enabled && options.jwt.secret) {
      middlewares.push(createJWTValidator(this.logger, options.jwt.secret));
    }

    if (options.basicAuth?.enabled && options.basicAuth.credentials) {
      middlewares.push(createBasicAuthValidator(this.logger, options.basicAuth.credentials));
    }

    if (options.session?.enabled) {
      middlewares.push(createSessionValidator(this.logger));
    }

    if (options.roles?.enabled && options.roles.allowedRoles) {
      middlewares.push(createRoleValidator(this.logger, options.roles.allowedRoles));
    }

    if (options.permissions?.enabled && options.permissions.requiredPermissions) {
      middlewares.push(createPermissionValidator(this.logger, options.permissions.requiredPermissions));
    }

    return middlewares;
  }

  /**
   * Create a complete security middleware stack with all enabled options
   */
  createSecurityStack(options: SecurityOptions): RequestHandler[] {
    const middlewares: RequestHandler[] = [];

    // 1. Sanitization (first)
    const sanitization = this.createSanitization(options.sanitization);
    if (sanitization) middlewares.push(sanitization);

    // 2. Protection middleware
    middlewares.push(...this.createProtection(options.protection));

    // 3. Validation middleware
    middlewares.push(...this.createValidation(options.validation));

    // 4. Authentication middleware (last)
    middlewares.push(...this.createAuthentication(options.authentication));

    return middlewares;
  }

  /**
   * Create a lightweight security stack for development
   */
  createDevelopmentSecurity(): RequestHandler[] {
    return this.createSecurityStack({
      sanitization: { enabled: true },
      protection: {
        sqlInjection: { enabled: true },
        xss: { enabled: true },
        pathTraversal: { enabled: true },
        rateLimit: { enabled: false }, // Disabled in development
      },
      validation: {
        requestSize: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
        contentType: { enabled: true },
      },
    });
  }

  /**
   * Create a production security stack with all protections enabled
   */
  createProductionSecurity(jwtSecret: string, csrfSecret: string): RequestHandler[] {
    return this.createSecurityStack({
      sanitization: { enabled: true },
      protection: {
        sqlInjection: { enabled: true },
        xss: { enabled: true },
        pathTraversal: { enabled: true },
        rateLimit: { 
          enabled: true, 
          windowMs: 15 * 60 * 1000, 
          maxRequests: 100 
        },
        csrf: { 
          enabled: true, 
          tokenSecret: csrfSecret 
        },
      },
      validation: {
        requestSize: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
        contentType: { enabled: true },
        fileUpload: { 
          enabled: true, 
          maxFileSize: 5 * 1024 * 1024,
          maxFiles: 5 
        },
      },
      authentication: {
        jwt: { enabled: true, secret: jwtSecret },
      },
    });
  }

  /**
   * Create API-specific security stack
   */
  createApiSecurity(): RequestHandler[] {
    return this.createSecurityStack({
      sanitization: { enabled: true },
      protection: {
        sqlInjection: { enabled: true },
        xss: { enabled: true },
        rateLimit: { 
          enabled: true, 
          windowMs: 15 * 60 * 1000, 
          maxRequests: 1000 // Higher limit for APIs
        },
      },
      validation: {
        requestSize: { enabled: true },
        contentType: { enabled: true, allowedTypes: ['application/json'] },
      },
      authentication: {
        apiKey: { enabled: true },
      },
    });
  }

  /**
   * Create file upload specific security stack
   */
  createFileUploadSecurity(): RequestHandler[] {
    return this.createSecurityStack({
      sanitization: { enabled: true },
      protection: {
        pathTraversal: { enabled: true },
        rateLimit: { 
          enabled: true, 
          windowMs: 60 * 1000, 
          maxRequests: 10 // Lower limit for uploads
        },
      },
      validation: {
        requestSize: { enabled: true, maxSizeBytes: 50 * 1024 * 1024 }, // 50MB for uploads
        fileUpload: { 
          enabled: true,
          maxFileSize: 10 * 1024 * 1024, // 10MB per file
          allowedTypes: [
            'image/jpeg',
            'image/png', 
            'image/gif',
            'text/csv',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/json'
          ],
          maxFiles: 5
        },
      },
    });
  }
}