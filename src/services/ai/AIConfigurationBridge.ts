/**
 * AI Configuration Bridge Service
 * Bridges AI Configuration Dashboard with Field Mapping Editor
 * Ensures AI provider configuration is accessible to mapping features
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import { AIConfigurationService, type AIProviderConfig, type AITaskModelConfig } from './AIConfigurationService';

export interface TaskModelSelection {
  taskModelConfigId?: number;
  providerConfigId?: number;
  providerType: string;
  providerName: string;
  modelVersion: string;
  modelParameters: Record<string, unknown>;
  priority: number;
}

export interface AIConfigStatus {
  configured: boolean;
  activeProvider: AIProviderConfig | null;
  fieldMappingTask: TaskModelSelection | null;
  message: string;
}

/**
 * Bridge service connecting AI Configuration to Field Mapping features
 */
@injectable()
export class AIConfigurationBridge {
  private logger: Logger;
  private aiConfigService: AIConfigurationService;
  private activeProviderCache: AIProviderConfig | null = null;
  private taskConfigCache = new Map<string, TaskModelSelection>();
  private lastCacheUpdate = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AIConfigurationService) aiConfigService: AIConfigurationService,
  ) {
    this.logger = logger;
    this.aiConfigService = aiConfigService;
  }

  /**
   * Initialize by fetching active AI provider and task configs
   */
  async initialize(userId = 1): Promise<void> {
    try {
      // Check if cache is still valid
      if (this.isCacheValid()) {
        this.logger.debug('Using cached AI configuration');
        return;
      }

      // Fetch active provider (default provider)
      const providers = await this.aiConfigService.getProviderConfigs(userId);
      this.activeProviderCache = providers.find((p: AIProviderConfig) => p.isDefault && p.isActive) || null;

      // Fetch field mapping task configuration
      const fieldMappingTask = await this.aiConfigService.getTaskModelConfig(userId, 'field_mapping');
      this.taskConfigCache.clear();
      if (fieldMappingTask) {
        this.taskConfigCache.set('field_mapping', fieldMappingTask);
      }

      this.lastCacheUpdate = Date.now();

      this.logger.info('AI Configuration Bridge initialized', {
        activeProvider: this.activeProviderCache?.providerName || 'none',
        taskCount: this.taskConfigCache.size,
        userId: String(userId),
      });
    } catch (error) {
      this.logger.error('Failed to initialize AI Configuration Bridge', {
        error: error instanceof Error ? error.message : String(error),
        userId: String(userId),
      });
      throw error;
    }
  }

  /**
   * Check if cache is still valid
   */
  private isCacheValid(): boolean {
    return Date.now() - this.lastCacheUpdate < this.CACHE_TTL;
  }

  /**
   * Check if AI is properly configured for field mapping
   */
  async isConfiguredForFieldMapping(userId = 1): Promise<boolean> {
    await this.ensureCacheValid(userId);

    const mappingTask = this.taskConfigCache.get('field_mapping');

    // Field mapping is configured if:
    // 1. The task exists with a model version AND
    // 2. Either has an active provider OR has its own provider configured
    if (!mappingTask || !mappingTask.modelVersion) {
      return false;
    }

    // Check if task has its own provider configuration
    const hasTaskProvider = !!mappingTask.providerConfigId || !!mappingTask.providerType;

    return this.activeProviderCache !== null || hasTaskProvider;
  }

  /**
   * Get active provider details
   */
  async getActiveProvider(userId = 1): Promise<AIProviderConfig | null> {
    await this.ensureCacheValid(userId);
    return this.activeProviderCache;
  }

  /**
   * Get configuration for specific task type
   */
  async getTaskConfig(taskType: string, userId = 1): Promise<TaskModelSelection | null> {
    await this.ensureCacheValid(userId);
    return this.taskConfigCache.get(taskType) || null;
  }

  /**
   * Get comprehensive AI configuration status for field mapping
   * @param userId - User ID for configuration
   * @param forceRefresh - If true, clears cache and fetches fresh data
   */
  async getFieldMappingStatus(userId = 1, forceRefresh = false): Promise<AIConfigStatus> {
    if (forceRefresh) {
      this.clearCache();
    }
    await this.ensureCacheValid(userId);

    const isConfigured = await this.isConfiguredForFieldMapping(userId);
    const fieldMappingTask = this.taskConfigCache.get('field_mapping') || null;

    let message: string;
    if (!fieldMappingTask) {
      message = 'Field mapping task not configured. Please configure the field_mapping task in the AI Configuration Dashboard.';
    } else if (!fieldMappingTask.modelVersion) {
      message = 'No model selected for field mapping task. Please select a model in the AI Configuration Dashboard.';
    } else if (!isConfigured) {
      message = 'No AI provider configured for field mapping. Please configure an AI provider in the AI Configuration Dashboard.';
    } else if (fieldMappingTask.providerConfigId || fieldMappingTask.providerType) {
      // Task has its own provider configuration - PRIORITIZE THIS over default provider
      const providerName = fieldMappingTask.providerName || fieldMappingTask.providerType || 'configured provider';
      message = `AI configured: ${providerName} with ${fieldMappingTask.modelVersion}`;
    } else if (this.activeProviderCache) {
      // Fallback to default provider if no task-specific config
      message = `AI configured: ${this.activeProviderCache.providerName} with ${fieldMappingTask.modelVersion}`;
    } else {
      message = 'AI provider configured';
    }

    // Sanitize fieldMappingTask to remove sensitive data (API keys)
    const sanitizedTask = fieldMappingTask ? {
      ...fieldMappingTask,
      apiKey: undefined as string | undefined // Never expose API keys to frontend
    } : null;

    return {
      configured: isConfigured,
      activeProvider: this.activeProviderCache,
      fieldMappingTask: sanitizedTask,
      message,
    };
  }

  /**
   * Refresh configuration (call after AI config changes)
   */
  async refresh(userId = 1): Promise<void> {
    this.lastCacheUpdate = 0; // Invalidate cache
    await this.initialize(userId);
  }

  /**
   * Ensure cache is valid, refresh if needed
   */
  private async ensureCacheValid(userId = 1): Promise<void> {
    if (!this.isCacheValid()) {
      await this.initialize(userId);
    }
  }

  /**
   * Clear cache manually
   */
  clearCache(): void {
    this.activeProviderCache = null;
    this.taskConfigCache.clear();
    this.lastCacheUpdate = 0;
    this.logger.debug('AI Configuration Bridge cache cleared');
  }
}
