import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { AuditLogRepository } from '../database/repositories/AuditLogRepository';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

export interface ErrorContext {
  operation: string;
  service: string;
  userId?: string;
  tenantId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorClassification {
  category: 'user' | 'system' | 'external' | 'validation' | 'auth' | 'network' | 'unknown';
  severity: 'low' | 'medium' | 'high' | 'critical';
  retryable: boolean;
  userMessage: string;
  technicalMessage: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    correlationId?: string;
  };
}

/**
 * Centralized error handling service
 * Provides error classification, logging, and response formatting
 */
@injectable()
export class ErrorHandlingService {
  private readonly logger: Logger;
  private readonly auditLogRepository: AuditLogRepository;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AuditLogRepository) auditLogRepository: AuditLogRepository,
  ) {
    this.logger = logger;
    this.auditLogRepository = auditLogRepository;
  }

  /**
   * Handle and classify an error
   */
  async handleError(
    error: unknown,
    context: ErrorContext,
  ): Promise<ErrorClassification> {
    const classification = this.classifyError(error);

    // Log the error
    await this.logError(error, context, classification);

    // Record audit log for security-related errors
    if (classification.category === 'auth' || classification.severity === 'critical') {
      await this.recordAuditLog(error, context, classification);
    }

    return classification;
  }

  /**
   * Classify error into categories and severity
   */
  classifyError(error: unknown): ErrorClassification {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const stack = error.stack || '';

      // Authentication/Authorization errors
      if (this.isAuthError(message)) {
        return {
          category: 'auth',
          severity: 'medium',
          retryable: false,
          userMessage: 'Authentication failed. Please check your credentials.',
          technicalMessage: error.message,
        };
      }

      // Validation errors
      if (this.isValidationError(message)) {
        return {
          category: 'validation',
          severity: 'low',
          retryable: false,
          userMessage: 'Invalid input provided. Please check your data.',
          technicalMessage: error.message,
        };
      }

      // Network errors
      if (this.isNetworkError(message)) {
        return {
          category: 'network',
          severity: 'medium',
          retryable: true,
          userMessage: 'Network connectivity issue. Please try again.',
          technicalMessage: error.message,
        };
      }

      // External service errors
      if (this.isExternalServiceError(message, stack)) {
        return {
          category: 'external',
          severity: 'high',
          retryable: true,
          userMessage: 'External service temporarily unavailable. Please try again.',
          technicalMessage: error.message,
        };
      }

      // System errors
      if (this.isSystemError(message, stack)) {
        return {
          category: 'system',
          severity: 'critical',
          retryable: false,
          userMessage: 'An unexpected system error occurred. Support has been notified.',
          technicalMessage: error.message,
        };
      }

      // User errors
      if (this.isUserError(message)) {
        return {
          category: 'user',
          severity: 'low',
          retryable: false,
          userMessage: 'Invalid request. Please check your input.',
          technicalMessage: error.message,
        };
      }
    }

    // Default classification
    return {
      category: 'unknown',
      severity: 'medium',
      retryable: false,
      userMessage: 'An unexpected error occurred. Please try again or contact support.',
      technicalMessage: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Format error for API response
   */
  formatErrorResponse(
    error: unknown,
    classification: ErrorClassification,
    correlationId?: string,
  ): ErrorResponse {
    const errorCode = this.generateErrorCode(classification);

    return {
      error: {
        code: errorCode,
        message: classification.userMessage,
        details: this.extractErrorDetails(error, classification),
        timestamp: new Date().toISOString(),
        correlationId,
      },
    };
  }

  /**
   * Log error with appropriate level
   */
  private async logError(
    error: unknown,
    context: ErrorContext,
    classification: ErrorClassification,
  ): Promise<void> {
    const logLevel = this.getLogLevel(classification.severity);
    const logData = {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
      context,
      classification,
      timestamp: new Date().toISOString(),
    };

    switch (logLevel) {
    case 'error':
      this.logger.error('ErrorHandlingService encountered an error', logData);
      break;
    case 'warn':
      this.logger.warn('ErrorHandlingService warning', logData);
      break;
    case 'info':
      this.logger.info('ErrorHandlingService info', logData);
      break;
    default:
      this.logger.debug('ErrorHandlingService debug', logData);
      break;
    }
  }

  /**
   * Record audit log for security-related errors
   */
  private async recordAuditLog(
    error: unknown,
    context: ErrorContext,
    classification: ErrorClassification,
  ): Promise<void> {
    try {
      await this.auditLogRepository.create({
        tenant_id: context.tenantId?.trim() || SYSTEM_IDENTITY.tenantId,
        user_id: context.userId || 'system',
        action: 'error_occurred',
        resource_type: 'error',
        resource_id: context.correlationId || 'unknown',
        old_values: null,
        new_values: {
          error: error instanceof Error ? error.message : String(error),
          category: classification.category,
          severity: classification.severity,
          operation: context.operation,
          service: context.service,
          metadata: context.metadata,
        },
        ip_address: null,
        user_agent: null,
      });
    } catch (auditError) {
      this.logger.error('ErrorHandlingService failed to record audit log for error', {
        originalError: error instanceof Error ? error.message : String(error),
        auditError: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
  }

  /**
   * Check if error is authentication related
   */
  private isAuthError(message: string): boolean {
    const authKeywords = [
      'unauthorized', 'forbidden', 'authentication', 'credential',
      'token', 'permission', 'access denied', 'invalid key',
      'expired', 'unauthenticated', 'unauthorized access',
    ];

    return authKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Check if error is validation related
   */
  private isValidationError(message: string): boolean {
    const validationKeywords = [
      'validation', 'invalid', 'required', 'format',
      'schema', 'constraint', 'bad request', 'malformed',
      'missing', 'empty', 'null', 'undefined',
    ];

    return validationKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Check if error is network related
   */
  private isNetworkError(message: string): boolean {
    const networkKeywords = [
      'network', 'connection', 'timeout', 'unreachable',
      'dns', 'socket', 'econnrefused', 'enotfound',
      'etimedout', 'ehostunreach', 'econnreset',
    ];

    return networkKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Check if error is from external service
   */
  private isExternalServiceError(message: string, stack: string): boolean {
    const externalKeywords = [
      'salesforce', 'netsuite', 'dynamics', 'sap', 'oracle',
      'api', 'service unavailable', 'rate limit', 'quota',
      'third party', 'external',
    ];

    const stackKeywords = [
      'connectors/', 'external/', 'api/',
    ];

    return externalKeywords.some(keyword => message.includes(keyword)) ||
           stackKeywords.some(keyword => stack.includes(keyword));
  }

  /**
   * Check if error is system related
   */
  private isSystemError(message: string, stack: string): boolean {
    const systemKeywords = [
      'out of memory', 'segmentation fault', 'assertion',
      'fatal', 'internal error', 'database', 'file system',
      'disk space', 'permission denied', 'access violation',
    ];

    // The stack check is too broad and causes false positives in a test environment.
    // It has been removed to make classification more reliable.
    return systemKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Check if error is user related
   */
  private isUserError(message: string): boolean {
    const userKeywords = [
      'not found', 'does not exist', 'already exists',
      'duplicate', 'conflict', 'precondition',
      'method not allowed', 'unsupported',
    ];

    return userKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Get log level based on severity
   */
  private getLogLevel(severity: string): string {
    switch (severity) {
    case 'critical':
      return 'error';
    case 'high':
      return 'error';
    case 'medium':
      return 'warn';
    case 'low':
      return 'info';
    default:
      return 'debug';
    }
  }

  /**
   * Generate error code based on classification
   */
  private generateErrorCode(classification: ErrorClassification): string {
    const categoryCode = classification.category.toUpperCase();
    const severityCode = classification.severity.toUpperCase();
    const timestamp = Date.now().toString().slice(-6);

    return `${categoryCode}_${severityCode}_${timestamp}`;
  }

  /**
   * Extract relevant error details
   */
  private extractErrorDetails(
    error: unknown,
    classification: ErrorClassification,
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      category: classification.category,
      severity: classification.severity,
      retryable: classification.retryable,
    };

    if (error instanceof Error) {
      details.type = error.name;

      // Add stack trace for system errors only
      if (classification.category === 'system' || classification.severity === 'critical') {
        details.stack = error.stack;
      }
    }

    return details;
  }

  /**
   * Create error context
   */
  static createContext(
    operation: string,
    service: string,
    options?: {
      userId?: string;
      tenantId?: string;
      correlationId?: string;
      metadata?: Record<string, unknown>;
    },
  ): ErrorContext {
    return {
      operation,
      service,
      userId: options?.userId,
      tenantId: options?.tenantId,
      correlationId: options?.correlationId,
      metadata: options?.metadata,
    };
  }

  /**
   * Wrap a function with error handling
   */
  withErrorHandling<T extends unknown[], R>(
    fn: (...args: T) => Promise<R>,
    context: ErrorContext,
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        const classification = await this.handleError(error, context);

        // Re-throw the error after handling
        throw error;
      }
    };
  }
}
