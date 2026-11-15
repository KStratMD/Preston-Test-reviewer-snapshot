import { injectable, inject } from 'inversify';
import crypto from 'crypto';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { DatabaseService } from '../database/DatabaseService';
import type { AuditLogRepository } from '../database/repositories/AuditLogRepository';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

export interface ApiKeyData {
  id: string;
  tenantId?: string;
  keyName: string;
  keyHash: string;
  keyPrefix: string;
  plainKey?: string; // Only available during creation
  permissions: string[];
  rateLimit?: number;
  expiresAt?: Date;
  lastUsedAt?: Date;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyUsage {
  keyId: string;
  endpoint: string;
  method: string;
  responseStatus: number;
  responseTime: number;
  userAgent?: string;
  ipAddress?: string;
  timestamp: Date;
}

export interface ApiKeyStats {
  totalKeys: number;
  activeKeys: number;
  expiredKeys: number;
  totalUsage: number;
  usageByKey: Record<string, number>;
  usageByEndpoint: Record<string, number>;
}

/**
 * API Key management service with scoped permissions and rate limiting
 * Provides secure API access control and usage tracking
 */
@injectable()
export class ApiKeyService {
  private readonly logger: Logger;
  private readonly databaseService: DatabaseService;
  private readonly auditLogRepository: AuditLogRepository;
  private readonly keyCache = new Map<string, ApiKeyData>();
  private readonly usageCache = new Map<string, number>();

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.DatabaseService) databaseService: DatabaseService,
    @inject(TYPES.AuditLogRepository) auditLogRepository: AuditLogRepository,
  ) {
    this.logger = logger;
    this.databaseService = databaseService;
    this.auditLogRepository = auditLogRepository;
  }

  /**
   * Initialize API key service
   */
  async initialize(): Promise<void> {
    try {
      await this.loadActiveKeysToCache();

      this.logger.info('API key service initialized', {
        cachedKeys: this.keyCache.size,
      });
    } catch (error) {
      this.logger.error('Failed to initialize API key service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create a new API key
   */
  async createApiKey(
    keyName: string,
    permissions: string[],
    createdBy: string,
    options?: {
      tenantId?: string;
      rateLimit?: number;
      expiresAt?: Date;
    },
  ): Promise<ApiKeyData> {
    try {
      const plainKey = this.generateApiKey();
      const keyPrefix = plainKey.substring(0, 8);
      const keyHash = await this.hashApiKey(plainKey);

      const apiKey: ApiKeyData = {
        id: crypto.randomUUID(),
        tenantId: options?.tenantId,
        keyName,
        keyHash,
        keyPrefix,
        plainKey, // Include plain key only during creation
        permissions,
        rateLimit: options?.rateLimit,
        expiresAt: options?.expiresAt,
        isActive: true,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Store in database
      const db = this.databaseService.getDatabase();
      await db
        .insertInto('api_keys')
        .values({
          id: apiKey.id,
          tenant_id: apiKey.tenantId,
          key_name: apiKey.keyName,
          key_hash: apiKey.keyHash,
          key_prefix: apiKey.keyPrefix,
          permissions: apiKey.permissions,
          rate_limit: apiKey.rateLimit,
          expires_at: apiKey.expiresAt,
          is_active: apiKey.isActive,
          created_by: apiKey.createdBy,
          created_at: apiKey.createdAt,
          updated_at: apiKey.updatedAt,
        })
        .execute();

      // Add to cache (without plain key)
      const cacheKey = { ...apiKey };
      delete cacheKey.plainKey;
      this.keyCache.set(keyPrefix, cacheKey);

      // Audit log
      await this.auditLogRepository.create({
        tenant_id: options?.tenantId ?? SYSTEM_IDENTITY.tenantId,
        user_id: createdBy,
        action: 'api_key_created',
        resource_type: 'api_key',
        resource_id: apiKey.id,
        old_values: null,
        new_values: {
          keyName: apiKey.keyName,
          keyPrefix: apiKey.keyPrefix,
          permissions: apiKey.permissions,
          rateLimit: apiKey.rateLimit,
          expiresAt: apiKey.expiresAt,
        },
        ip_address: null,
        user_agent: null,
      });

      this.logger.info('API key created', {
        keyId: apiKey.id,
        keyName: apiKey.keyName,
        keyPrefix: apiKey.keyPrefix,
        createdBy,
        tenantId: options?.tenantId,
      });

      return apiKey;
    } catch (error) {
      this.logger.error('Failed to create API key', {
        keyName,
        createdBy,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate API key and return key data
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyData | null> {
    try {
      const keyPrefix = apiKey.substring(0, 8);

      // Check cache first
      let keyData = this.keyCache.get(keyPrefix);

      if (!keyData) {
        // Load from database
        keyData = await this.loadApiKeyFromDatabase(keyPrefix) || undefined;
        if (keyData) {
          this.keyCache.set(keyPrefix, keyData);
        }
      }

      if (!keyData) {
        return null;
      }

      // Verify key hash
      const isValid = await this.verifyApiKey(apiKey, keyData.keyHash);
      if (!isValid) {
        return null;
      }

      // Check if key is active
      if (!keyData.isActive) {
        return null;
      }

      // Check if key is expired
      if (keyData.expiresAt && keyData.expiresAt < new Date()) {
        return null;
      }

      // Update last used timestamp
      await this.updateLastUsed(keyData.id);

      return keyData;
    } catch (error) {
      this.logger.error('Failed to validate API key', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check if API key has specific permission
   */
  hasPermission(keyData: ApiKeyData, permission: string): boolean {
    return keyData.permissions.includes(permission) || keyData.permissions.includes('*');
  }

  /**
   * Check rate limit for API key
   */
  async checkRateLimit(keyData: ApiKeyData): Promise<{
    allowed: boolean;
    currentUsage: number;
    limit: number;
    resetTime: Date;
  }> {
    if (!keyData.rateLimit) {
      return {
        allowed: true,
        currentUsage: 0,
        limit: 0,
        resetTime: new Date(),
      };
    }

    const windowStart = new Date();
    windowStart.setHours(windowStart.getHours() - 1); // 1-hour window

    const db = this.databaseService.getDatabase();
    const usage = await db
      .selectFrom('api_key_usage')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('key_id', '=', keyData.id)
      .where('timestamp', '>=', windowStart)
      .executeTakeFirst();

    const currentUsage = Number(usage?.count || 0);
    const resetTime = new Date(windowStart.getTime() + 60 * 60 * 1000); // Next hour

    return {
      allowed: currentUsage < keyData.rateLimit,
      currentUsage,
      limit: keyData.rateLimit,
      resetTime,
    };
  }

  /**
   * Record API key usage
   */
  async recordUsage(
    keyData: ApiKeyData,
    endpoint: string,
    method: string,
    responseStatus: number,
    responseTime: number,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<void> {
    try {
      const usage: ApiKeyUsage = {
        keyId: keyData.id,
        endpoint,
        method,
        responseStatus,
        responseTime,
        userAgent,
        ipAddress,
        timestamp: new Date(),
      };

      const db = this.databaseService.getDatabase();
      await db
        .insertInto('api_key_usage')
        .values({
          id: crypto.randomUUID(),
          key_id: usage.keyId,
          endpoint: usage.endpoint,
          method: usage.method,
          status_code: usage.responseStatus, // Use responseStatus as status_code
          response_status: usage.responseStatus,
          response_time: usage.responseTime,
          request_size: null, // Optional field
          response_size: null, // Optional field
          user_agent: usage.userAgent,
          ip_address: usage.ipAddress,
          timestamp: usage.timestamp,
        })
        .execute();

      // Update usage cache
      const cacheKey = `usage_${keyData.id}`;
      const currentUsage = this.usageCache.get(cacheKey) || 0;
      this.usageCache.set(cacheKey, currentUsage + 1);

      this.logger.debug('API key usage recorded', {
        keyId: keyData.id,
        endpoint,
        method,
        responseStatus,
        responseTime,
      });
    } catch (error) {
      this.logger.error('Failed to record API key usage', {
        keyId: keyData.id,
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Revoke API key
   */
  async revokeApiKey(keyId: string, revokedBy: string): Promise<void> {
    try {
      const db = this.databaseService.getDatabase();

      // Get key data before revoking
      const keyData = await db
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', keyId)
        .executeTakeFirst();

      if (!keyData) {
        throw new Error(`API key not found: ${keyId}`);
      }

      // Revoke key
      await db
        .updateTable('api_keys')
        .set({
          is_active: false,
          updated_at: new Date(),
        })
        .where('id', '=', keyId)
        .execute();

      // Remove from cache
      this.keyCache.delete(keyData.key_prefix);

      // Audit log
      await this.auditLogRepository.create({
        tenant_id: keyData.tenant_id ?? SYSTEM_IDENTITY.tenantId,
        user_id: revokedBy,
        action: 'api_key_revoked',
        resource_type: 'api_key',
        resource_id: keyId,
        old_values: {
          isActive: true,
        },
        new_values: {
          isActive: false,
        },
        ip_address: null,
        user_agent: null,
      });

      this.logger.info('API key revoked', {
        keyId,
        keyPrefix: keyData.key_prefix,
        revokedBy,
      });
    } catch (error) {
      this.logger.error('Failed to revoke API key', {
        keyId,
        revokedBy,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * List API keys with filtering and pagination
   */
  async listApiKeys(options?: {
    tenantId?: string;
    createdBy?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    keys: Omit<ApiKeyData, 'keyHash' | 'plainKey'>[];
    total: number;
  }> {
    try {
      const db = this.databaseService.getDatabase();

      let query = db.selectFrom('api_keys').selectAll();

      if (options?.tenantId) {
        query = query.where('tenant_id', '=', options.tenantId);
      }

      if (options?.createdBy) {
        query = query.where('created_by', '=', options.createdBy);
      }

      if (options?.isActive !== undefined) {
        query = query.where('is_active', '=', options.isActive);
      }

      // Get total count
      const countResult = await query
        .select((eb) => eb.fn.count('id').as('total'))
        .executeTakeFirst();
      const total = Number(countResult?.total || 0);

      // Get keys with pagination
      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.offset(options.offset);
      }

      query = query.orderBy('created_at', 'desc');
      const results = await query.execute();

      const keys = results.map(row => ({
        id: row.id,
        tenantId: row.tenant_id || undefined,
        keyName: row.key_name,
        keyPrefix: row.key_prefix,
        permissions: row.permissions,
        rateLimit: row.rate_limit || undefined,
        expiresAt: row.expires_at || undefined,
        lastUsedAt: row.last_used_at || undefined,
        isActive: row.is_active,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return { keys, total };
    } catch (error) {
      this.logger.error('Failed to list API keys', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get API key statistics
   */
  async getStatistics(tenantId?: string): Promise<ApiKeyStats> {
    try {
      const db = this.databaseService.getDatabase();

      let keyQuery = db.selectFrom('api_keys');
      if (tenantId) {
        keyQuery = keyQuery.where('tenant_id', '=', tenantId);
      }

      // Get key counts
      const keyStats = await keyQuery
        .select([
          (eb) => eb.fn.count('id').as('total'),
          (eb) => eb.fn.countAll().filterWhere('is_active', '=', true).as('active'),
          (eb) => eb.fn.countAll().filterWhere('expires_at', '<', new Date()).as('expired'),
        ])
        .executeTakeFirst();

      // Get usage statistics
      let usageQuery = db
        .selectFrom('api_key_usage as aku')
        .innerJoin('api_keys as ak', 'ak.id', 'aku.key_id');

      if (tenantId) {
        usageQuery = usageQuery.where('ak.tenant_id', '=', tenantId);
      }

      const usageStats = await usageQuery
        .select((eb) => eb.fn.count('aku.id').as('total'))
        .executeTakeFirst();

      // Get usage by key
      const usageByKeyResults = await usageQuery
        .select(['ak.key_prefix', (eb) => eb.fn.count('aku.id').as('count')])
        .groupBy('ak.key_prefix')
        .execute();

      const usageByKey = usageByKeyResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.key_prefix] = Number(row.count);
        return acc;
      }, {});

      // Get usage by endpoint
      const usageByEndpointResults = await usageQuery
        .select(['aku.endpoint', (eb) => eb.fn.count('aku.id').as('count')])
        .groupBy('aku.endpoint')
        .execute();

      const usageByEndpoint = usageByEndpointResults.reduce<Record<string, number>>((acc, row) => {
        acc[row.endpoint] = Number(row.count);
        return acc;
      }, {});

      return {
        totalKeys: Number(keyStats?.total || 0),
        activeKeys: Number(keyStats?.active || 0),
        expiredKeys: Number(keyStats?.expired || 0),
        totalUsage: Number(usageStats?.total || 0),
        usageByKey,
        usageByEndpoint,
      };
    } catch (error) {
      this.logger.error('Failed to get API key statistics', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clean up expired keys and old usage records
   */
  async cleanup(olderThanDays = 90): Promise<{
    expiredKeysDeactivated: number;
    oldUsageRecordsDeleted: number;
  }> {
    try {
      const db = this.databaseService.getDatabase();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      // Deactivate expired keys
      const expiredResult = await db
        .updateTable('api_keys')
        .set({ is_active: false, updated_at: new Date() })
        .where('expires_at', '<', new Date())
        .where('is_active', '=', true)
        .executeTakeFirst();

      // Delete old usage records
      const usageResult = await db
        .deleteFrom('api_key_usage')
        .where('timestamp', '<', cutoffDate)
        .executeTakeFirst();

      const result = {
        expiredKeysDeactivated: Number(expiredResult.numUpdatedRows || 0),
        oldUsageRecordsDeleted: Number(usageResult.numDeletedRows || 0),
      };

      this.logger.info('API key cleanup completed', result);

      return result;
    } catch (error) {
      this.logger.error('Failed to cleanup API keys', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Load active keys to cache
   */
  private async loadActiveKeysToCache(): Promise<void> {
    const db = this.databaseService.getDatabase();
    const activeKeys = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('is_active', '=', true)
      .where((eb) =>
        eb.or([
          eb('expires_at', 'is', null),
          eb('expires_at', '>', new Date()),
        ]),
      )
      .execute();

    for (const key of activeKeys) {
      const keyData: ApiKeyData = {
        id: key.id,
        tenantId: key.tenant_id || undefined,
        keyName: key.key_name,
        keyHash: key.key_hash,
        keyPrefix: key.key_prefix,
        permissions: key.permissions,
        rateLimit: key.rate_limit || undefined,
        expiresAt: key.expires_at || undefined,
        lastUsedAt: key.last_used_at || undefined,
        isActive: key.is_active,
        createdBy: key.created_by,
        createdAt: key.created_at,
        updatedAt: key.updated_at,
      };

      this.keyCache.set(key.key_prefix, keyData);
    }
  }

  /**
   * Load API key from database
   */
  private async loadApiKeyFromDatabase(keyPrefix: string): Promise<ApiKeyData | null> {
    const db = this.databaseService.getDatabase();
    const key = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('key_prefix', '=', keyPrefix)
      .executeTakeFirst();

    if (!key) {
      return null;
    }

    return {
      id: key.id,
      tenantId: key.tenant_id || undefined,
      keyName: key.key_name,
      keyHash: key.key_hash,
      keyPrefix: key.key_prefix,
      permissions: key.permissions,
      rateLimit: key.rate_limit || undefined,
      expiresAt: key.expires_at || undefined,
      lastUsedAt: key.last_used_at || undefined,
      isActive: key.is_active,
      createdBy: key.created_by,
      createdAt: key.created_at,
      updatedAt: key.updated_at,
    };
  }

  /**
   * Update last used timestamp
   */
  private async updateLastUsed(keyId: string): Promise<void> {
    const db = this.databaseService.getDatabase();
    await db
      .updateTable('api_keys')
      .set({
        last_used_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', keyId)
      .execute();
  }

  /**
   * Generate secure API key
   */
  private generateApiKey(): string {
    const prefix = 'ik'; // integration-hub
    const random = crypto.randomBytes(32).toString('hex');
    return `${prefix}_${random}`;
  }

  /**
   * Hash API key for storage
   */
  private async hashApiKey(apiKey: string): Promise<string> {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Verify API key against hash
   */
  private async verifyApiKey(apiKey: string, hash: string): Promise<boolean> {
    const keyHash = await this.hashApiKey(apiKey);
    return keyHash === hash;
  }
}
