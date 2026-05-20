import type { IConnector, ListOptions, SearchCriteria } from '../interfaces/IConnector';
import type { DataRecord, SyncResult, SyncError, ConnectionStatus, SystemInfo, AuthConfig } from '../types';
import type { Logger } from '../utils/Logger';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';
import { GovernanceBlockedError, PendingApprovalError } from '../services/governance/OutboundGovernanceErrors';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { CryptoUtils } from '../utils/crypto';
import { CircuitBreaker, type CircuitBreakerOptions } from '../utils/CircuitBreaker';
import { stripControlCharacters } from '../utils/sanitization';
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { VALIDATION_CONSTANTS, HTTP_CONSTANTS } from '../constants/systemConstants';
import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import {
  UnauthorizedAppError,
  ForbiddenAppError,
  NotFoundAppError,
  InternalServerAppError,
  BadRequestAppError,
  ServiceUnavailableAppError,
} from '../errors/AppError';

/**
 * BaseConnector centralizes reliability features such as retry logic and
 * circuit breaking. All connectors must extend this class to inherit these
 * mechanisms and ensure consistent behavior across systems.
 */

@injectable()
export abstract class BaseConnector implements IConnector {
  protected httpClient: AxiosInstance;
  public authConfig!: AuthConfig;
  protected logger: Logger;
  protected isAuthenticated = false;
  protected circuitBreaker: CircuitBreaker;
  /**
   * Maximum retry attempts for API requests, configurable for tests.
   */
  public maxRetries: number = HTTP_CONSTANTS.RETRY_MAX_ATTEMPTS;

  constructor(
    public readonly systemType: string,
    public readonly systemId: string,
    @inject(TYPES.Logger) logger: Logger,
    circuitBreakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    // Create a child logger with the connector type as context
    this.logger = logger;
    this.httpClient = axios.create({
      timeout: HTTP_CONSTANTS.REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'IntegrationHub/1.0',
      },
    });

    // Initialize circuit breaker with defaults
    const defaultOptions: CircuitBreakerOptions = {
      failureThreshold: HTTP_CONSTANTS.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      resetTimeout: HTTP_CONSTANTS.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
      monitoringPeriod: HTTP_CONSTANTS.CIRCUIT_BREAKER_MONITORING_PERIOD_MS,
      expectedErrors: (error: unknown) => {
        // Consider 5xx errors and network errors as circuit breaker failures
        const message = error instanceof Error ? error.message : String(error);
        return message.includes('Network error') ||
               message.includes('Server error') ||
               message.includes('timeout');
      },
    };

    this.circuitBreaker = new CircuitBreaker({
      ...defaultOptions,
      ...circuitBreakerOptions,
    });

    // Ensure interceptors exist (for mocked HTTP clients)
    if (!(this.httpClient as any).interceptors) {
      (this.httpClient as any).interceptors = {
        request: {
          use: (onFulfilled?: unknown, _onRejected?: unknown) => (typeof onFulfilled === 'function' ? onFulfilled : undefined),
        },
        response: {
          use: (onFulfilled?: unknown, _onRejected?: unknown) => (typeof onFulfilled === 'function' ? onFulfilled : undefined),
        },
      };
    }
    this.setupRequestInterceptors();
    this.setupResponseInterceptors();
  }

  abstract initialize(config: AuthConfig): Promise<void>;
  abstract authenticate(): Promise<boolean>;
  abstract getSystemInfo(): Promise<SystemInfo>;

  async testConnection(): Promise<ConnectionStatus> {
    const startTime = Date.now();
    try {
      await this.authenticate();
      await this.getSystemInfo();
      const latency = Date.now() - startTime;

      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: true,
        lastTestTime: new Date(),
        latency,
      };
    } catch (error) {
      return {
        systemType: this.systemType,
        systemId: this.systemId,
        isConnected: false,
        lastTestTime: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  protected async ensureAuthenticated(): Promise<void> {
    if (!this.isAuthenticated) {
      await this.authenticate();
    }
  }

  protected isAuthenticating = false;

  protected async makeRequest<T = unknown>(config: AxiosRequestConfig): Promise<T> {
    return this.circuitBreaker.execute(async () => {
      try {
        if (!this.isAuthenticated || this.isTokenExpired()) {
          if (!this.isAuthenticating) {
            this.isAuthenticating = true;
            try {
              await this.authenticate();
            } finally {
              this.isAuthenticating = false;
            }
          }
        }

        const client: AxiosInstance = this.httpClient;
        const response: AxiosResponse<T> = await this.retry(() => client.request<T>(config));
        return response.data;
      } catch (error) {
        this.logger.error('Request failed', error);
        throw this.handleApiError(error);
      }
    });
  }

  protected sanitizeString(input: string): string {
    if (!input || typeof input !== 'string') return '';

    const escaped = input.replace(/[<>&"']/g, (match): string => {
      const entities: Record<string, string> = {
        '<': '&lt;', '>': '&gt;', '&': '&amp;',
        '"': '&quot;', '\'': '&#39;',
      };
      return entities[match] ?? '';
    });

    return stripControlCharacters(escaped)
      .trim()
      .substring(0, VALIDATION_CONSTANTS.MAX_STRING_LENGTH);
  }

  protected sanitizeObject(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return this.sanitizeString(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (obj && typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const sanitizedKey = this.sanitizeString(key);
        sanitized[sanitizedKey] = this.sanitizeObject(value);
      }
      return sanitized;
    }

    return obj;
  }

  protected handleApiError(error: unknown): Error {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      const message = this.sanitizeString(error.response.data?.message || error.response.statusText);
      const originalError = error instanceof Error ? error : undefined;

      if (status === 401) {
        this.isAuthenticated = false;
        return new UnauthorizedAppError(`Authentication failed: ${message}`, originalError);
      } else if (status === 403) {
        return new ForbiddenAppError(`Access forbidden: ${message}`, originalError);
      } else if (status === 404) {
        return new NotFoundAppError(`Resource not found: ${message}`, originalError);
      } else if (status === 400) {
        return new BadRequestAppError(`Bad request: ${message}`, originalError);
      } else if (status === 503) {
        return new ServiceUnavailableAppError(`Service unavailable: ${message}`, originalError);
      } else if (status >= 500) {
        return new InternalServerAppError(`Server error: ${message}`, originalError);
      }

      return new BadRequestAppError(`API error (${status}): ${message}`, originalError);
    } else if (axios.isAxiosError(error) && error.request) {
      const originalError = error instanceof Error ? error : undefined;
      return new ServiceUnavailableAppError('Network error: No response received', originalError);
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const originalError = error instanceof Error ? error : undefined;
      return new BadRequestAppError(`Request setup error: ${errorMessage}`, originalError);
    }
  }

  protected async retry<T>(
    operation: () => Promise<T>,
    maxAttempts?: number,
    baseDelay: number = HTTP_CONSTANTS.RETRY_BASE_DELAY_MS,
    exponentialBackoff = true,
  ): Promise<T> {
    const attempts = maxAttempts ?? this.maxRetries;
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        // Preserve axios errors as-is, convert others to Error objects
        if (axios.isAxiosError(error)) {
          lastError = error;
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        // Don't retry on authentication errors or client errors (4xx)
        if (lastError instanceof Error && this.isNonRetryableError(lastError)) {
          throw lastError;
        }

        if (attempt === attempts) {
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = exponentialBackoff
          ? baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000
          : baseDelay;

        this.logger.warn(`Attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`, {
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
        await this.delay(delay);
      }
    }

    throw lastError!;
  }

  private isNonRetryableError(error: Error): boolean {
    return error instanceof UnauthorizedAppError ||
           error instanceof ForbiddenAppError ||
           error instanceof BadRequestAppError ||
           error instanceof NotFoundAppError;
  }

  protected async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected setupRequestInterceptors(): void {
    this.httpClient.interceptors.request.use(
      (config) => {
        this.logger.debug(`Making ${config.method?.toUpperCase()} request to ${config.url}`);
        return config;
      },
      async (error) => {
        this.logger.error('Request interceptor error', error);
        return Promise.reject(error);
      },
    );
  }

  protected setupResponseInterceptors(): void {
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug(`Response received: ${response.status} ${response.statusText}`);
        return response;
      },
      async (error) => {
        this.logger.error('Response interceptor error', error);
        return Promise.reject(error);
      },
    );
  }



  protected validateDataRecord(data: DataRecord): void {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data record: must be an object');
    }

    if (data.id && typeof data.id !== 'string') {
      throw new Error('Invalid data record: id must be a string');
    }

    if (data.externalId && typeof data.externalId !== 'string') {
      throw new Error('Invalid data record: externalId must be a string');
    }

    if (!data.fields || typeof data.fields !== 'object') {
      throw new Error('Invalid data record: fields must be an object');
    }
  }

  protected validateEntityType(entityType: string): void {
    if (!entityType || typeof entityType !== 'string') {
      throw new Error('Entity type must be a non-empty string');
    }

    const sanitized = this.sanitizeString(entityType);
    if (sanitized !== entityType) {
      throw new Error('Entity type contains invalid characters');
    }
  }

  protected validateId(id: string): void {
    if (!id || typeof id !== 'string') {
      throw new Error('ID must be a non-empty string');
    }

    const sanitized = this.sanitizeString(id);
    if (sanitized !== id) {
      throw new Error('ID contains invalid characters');
    }
  }

  abstract create(entityType: string, data: DataRecord): Promise<DataRecord>;
  abstract read(entityType: string, id: string): Promise<DataRecord | null>;
  abstract update(entityType: string, id: string, data: Partial<DataRecord>): Promise<DataRecord>;
  abstract delete(entityType: string, id: string): Promise<boolean>;
  abstract list(entityType: string, options?: ListOptions): Promise<DataRecord[]>;
  abstract search(entityType: string, criteria: SearchCriteria): Promise<DataRecord[]>;

  async bulkCreate(entityType: string, records: DataRecord[]): Promise<SyncResult> {
    // Validate and sanitize inputs
    this.validateEntityType(entityType);

    if (!Array.isArray(records)) {
      throw new Error('Records must be an array');
    }

    if (records.length > VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH) {
      throw new Error(`Too many records: maximum ${VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH} allowed`);
    }

    const sanitizedRecords = records.map(record => {
      this.validateDataRecord(record);
      return record; // Assuming input is already sanitized by a middleware or upstream
    });

    const syncId = CryptoUtils.generateUUID();
    const startTime = new Date();
    const errors: SyncError[] = [];
    let successCount = 0;

    this.logger.info(`Starting bulk create for ${sanitizedRecords.length} ${entityType} records`);

    for (const record of sanitizedRecords) {
      try {
        await this.create(entityType, record);
        successCount++;
      } catch (error) {
        errors.push({
          recordId: record.id ?? record.externalId ?? 'unknown',
          errorCode: 'CREATE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
          severity: 'error' as const,
        });
      }
    }

    const status = errors.length === 0 ? 'success' : errors.length < records.length ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId,
      status,
      success: status === 'success',
      recordsProcessed: records.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors: errors.map(e => typeof e === 'string' ? e : e.errorMessage),
      startTime,
      endTime: new Date(),
    };
  }

  async bulkUpdate(entityType: string, records: Partial<DataRecord>[]): Promise<SyncResult> {
    // Validate and sanitize inputs
    this.validateEntityType(entityType);

    if (!Array.isArray(records)) {
      throw new Error('Records must be an array');
    }

    if (records.length > VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH) {
      throw new Error(`Too many records: maximum ${VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH} allowed`);
    }

    const sanitizedRecords = records.map(record => this.sanitizeObject(record) as Partial<DataRecord>);

    const syncId = CryptoUtils.generateUUID();
    const startTime = new Date();
    const errors: SyncError[] = [];
    let successCount = 0;

    this.logger.info(`Starting bulk update for ${sanitizedRecords.length} ${entityType} records`);

    for (const record of sanitizedRecords) {
      try {
        if (!record.id && !record.externalId) {
          throw new Error('Record must have id or externalId for update');
        }

        const id = record.id || record.externalId!;
        this.validateId(id);

        await this.update(entityType, id, record);
        successCount++;
      } catch (error) {
        errors.push({
          recordId: record.id ?? record.externalId ?? 'unknown',
          errorCode: 'UPDATE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
          severity: 'error' as const,
        });
      }
    }

    const status = errors.length === 0 ? 'success' : errors.length < records.length ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId,
      status,
      success: status === 'success',
      recordsProcessed: records.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors: errors.map(e => typeof e === 'string' ? e : e.errorMessage),
      startTime,
      endTime: new Date(),
    };
  }

  async bulkDelete(entityType: string, ids: string[]): Promise<SyncResult> {
    // Validate and sanitize inputs
    this.validateEntityType(entityType);

    if (!Array.isArray(ids)) {
      throw new Error('IDs must be an array');
    }

    if (ids.length > VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH) {
      throw new Error(`Too many IDs: maximum ${VALIDATION_CONSTANTS.MAX_ARRAY_LENGTH} allowed`);
    }

    const sanitizedIds = ids.map(id => {
      if (typeof id !== 'string') {
        throw new Error('All IDs must be strings');
      }
      // Assuming input is already sanitized by a middleware or upstream
      return id;
    });

    const syncId = CryptoUtils.generateUUID();
    const startTime = new Date();
    const errors: SyncError[] = [];
    let successCount = 0;

    this.logger.info(`Starting bulk delete for ${sanitizedIds.length} ${entityType} records`);

    for (const id of sanitizedIds) {
      try {
        await this.delete(entityType, id);
        successCount++;
      } catch (error) {
        errors.push({
          recordId: id,
          errorCode: 'DELETE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
          severity: 'error' as const,
        });
      }
    }

    const status = errors.length === 0 ? 'success' : errors.length < ids.length ? 'partial' : 'failed';
    return {
      integrationId: this.systemId,
      syncId,
      status,
      success: status === 'success',
      recordsProcessed: ids.length,
      recordsSuccessful: successCount,
      recordsFailed: errors.length,
      errors: errors.map(e => typeof e === 'string' ? e : e.errorMessage),
      startTime,
      endTime: new Date(),
    };
  }



  protected isTokenExpired(): boolean {
    if (!this.authConfig?.expiresAt) {
      return false;
    }

    const bufferTime = 300000; // 5 minutes buffer
    const now = new Date();
    return this.authConfig.expiresAt.getTime() <= now.getTime() + bufferTime;
  }

  protected async validateOutboundWrite<T>(
    outboundGovernance: OutboundGovernanceService,
    operation: 'create' | 'update' | 'delete',
    entityType: string,
    payload: T,
    options?: { resourceId?: string },
  ): Promise<T> {
    // Per-caller identity threading is deferred to PR 2C-Auth; connector writes use SYSTEM_IDENTITY until then.
    const ctx = {
      tenantId: SYSTEM_IDENTITY.tenantId,
      userId: SYSTEM_IDENTITY.userId,
      destination: 'connector_write' as const,
      destinationDetail: `${this.systemType.toLowerCase()}.${operation}`,
      operationType: 'write' as const,
      resourceType: entityType,
      resourceId: options?.resourceId,
    };
    const decision = await outboundGovernance.validateConnectorWrite(payload, ctx);
    if (decision.approvalRequired) {
      throw new PendingApprovalError(decision);
    }
    if (!decision.approved) {
      throw new GovernanceBlockedError(decision);
    }
    return (decision.redactedPayload as T) ?? payload;
  }
}
