/**
 * Task-Aware Provider Factory - Enhanced with Database-Backed Configuration
 * Intelligent routing with task-specific model selection and secure configuration management
 */

import { logger, type Logger } from '../../../utils/Logger';
import type { AIProvider, AISuggestion, AIQualityReport } from './types';
import { OpenAIProvider, type OpenAIConfig } from './OpenAIProvider';
import { ClaudeProvider, type ClaudeAuthMode, type ClaudeConfig } from './ClaudeProvider';
import { GeminiProvider, type GeminiConfig } from './GeminiProvider';
import { LMStudioProvider, type LMStudioConfig } from './LMStudioProvider';
import { OpenRouterProvider, type OpenRouterConfig } from './OpenRouterProvider';
import { RuleBasedProvider } from './RuleBasedProvider';
import { AIConfigurationService, type AITaskType, type AIProviderType, type TaskModelSelection } from '../AIConfigurationService';
import { normalizeOpenRouterBaseUrl, normalizePositiveInteger } from '../utils/openRouter';
import { canonicalizeLMStudioBaseUrl, resolveLMStudioBaseUrl } from '../utils/lmstudio';
import { OutboundGovernanceService } from '../../governance/OutboundGovernanceService';

export interface TaskContext {
  taskType: AITaskType;
  complexity?: 'low' | 'medium' | 'high';
  urgency?: 'low' | 'medium' | 'high';
  dataSize?: number;
  sessionId?: string;
  userId?: number;
}

export interface ProviderExecutionResult {
  result: AISuggestion[] | AIQualityReport;
  providerType: AIProviderType;
  modelVersion: string;
  executionTime: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  success: boolean;
  errorMessage?: string;
}

export class TaskAwareProviderFactory {
  private configService: AIConfigurationService;
  private providerInstances = new Map<string, AIProvider>(); // Key: "providerType:modelVersion"
  private sessionBudget = 0.20; // Default $0.20 session budget
  private sessionCosts = new Map<number, number>(); // userId -> total session cost

  constructor(
    private logger: Logger,
    configService: AIConfigurationService,
    private outboundGovernance: OutboundGovernanceService
  ) {
    this.configService = configService;
  }

  /**
   * Execute AI task with intelligent provider and model selection
   */
  async executeTask(
    context: TaskContext,
    operation: 'suggest' | 'assessQuality',
    ...args: unknown[]
  ): Promise<ProviderExecutionResult> {
    const userId = context.userId || 1; // Default user in development
    const startTime = Date.now();

    try {
      // Get optimal provider configuration for this task
      const modelSelection = await this.getOptimalTaskConfig(userId, context);

      if (!modelSelection) {
        throw new Error(`No AI provider configured for task: ${context.taskType}`);
      }

      // Check session budget
      await this.checkSessionBudget(userId, modelSelection);

      // Get or create provider instance
      const provider = await this.getProviderInstance(modelSelection);

      // Execute the operation
      let result: AISuggestion[] | AIQualityReport;

      if (operation === 'suggest') {
        const [sourceSystem, targetSystem, sampleData] = args;
        result = await provider.suggest(sourceSystem as string, targetSystem as string, sampleData as unknown[]);
      } else if (operation === 'assessQuality') {
        const [suggestions] = args;
        result = await provider.assessQuality(suggestions as AISuggestion[]);
      } else {
        throw new Error(`Unsupported operation: ${operation}`);
      }

      const executionTime = Date.now() - startTime;

      // Track token usage if available
      let tokenUsage: unknown = undefined;
      if ('getLastTokenUsage' in provider) {
        const usage = (provider as any).getLastTokenUsage();
        if (usage) {
          tokenUsage = {
            promptTokens: usage.promptTokens || usage.inputTokens || 0,
            completionTokens: usage.completionTokens || usage.outputTokens || usage.candidatesTokens || 0,
            totalTokens: usage.totalTokens || 0,
            estimatedCost: usage.estimatedCost || 0
          };

          // Update session costs
          const currentCost = this.sessionCosts.get(userId) || 0;
          this.sessionCosts.set(userId, currentCost + (tokenUsage as any).estimatedCost);
        }
      }

      // Log usage for analytics and cost tracking
      await this.logTaskExecution(
        userId,
        context,
        modelSelection,
        operation,
        executionTime,
        tokenUsage,
        true,
        Array.isArray(result) ? result.length : 1
      );

      const executionResult: ProviderExecutionResult = {
        result,
        providerType: modelSelection.providerType,
        modelVersion: modelSelection.modelVersion,
        executionTime,
        tokenUsage: tokenUsage as any,
        success: true
      };

      this.logger.info('AI task executed successfully', {
        userId: String(userId),
        taskType: context.taskType,
        provider: modelSelection.providerType,
        model: modelSelection.modelVersion,
        executionTime,
        cost: (tokenUsage as any)?.estimatedCost || 0
      });

      return executionResult;

    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.logger.error('AI task execution failed', {
        userId: String(userId),
        taskType: context.taskType,
        error: error.message,
        executionTime
      });

      // Log failed execution
      try {
        const modelSelection = await this.getOptimalTaskConfig(userId, context);
        if (modelSelection) {
          await this.logTaskExecution(
            userId,
            context,
            modelSelection,
            operation,
            executionTime,
            undefined,
            false,
            0,
            error.message
          );
        }
      } catch (logError) {
        this.logger.warn('Failed to log task execution failure', { logError: logError.message });
      }

      return {
        result: operation === 'suggest' ? [] : { overallScore: 0, totalMappings: 0 },
        providerType: 'rule-based',
        modelVersion: 'fallback',
        executionTime,
        success: false,
        errorMessage: error.message
      };
    }
  }

  /**
   * Execute field mapping with task-specific configuration
   */
  async executeFieldMapping(
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[],
    context: Omit<TaskContext, 'taskType'>
  ): Promise<ProviderExecutionResult> {
    return this.executeTask(
      { ...context, taskType: 'field_mapping' },
      'suggest',
      sourceSystem,
      targetSystem,
      sampleData
    );
  }

  /**
   * Execute quality assessment with task-specific configuration
   */
  async executeQualityAssessment(
    suggestions: AISuggestion[],
    context: Omit<TaskContext, 'taskType'>
  ): Promise<ProviderExecutionResult> {
    return this.executeTask(
      { ...context, taskType: 'quality_assessment' },
      'assessQuality',
      suggestions
    );
  }

  /**
   * Execute data validation with task-specific configuration
   */
  async executeDataValidation(
    data: unknown[],
    validationRules: unknown[],
    context: Omit<TaskContext, 'taskType'>
  ): Promise<ProviderExecutionResult> {
    // This would be implemented when data validation providers are added
    return this.executeTask(
      { ...context, taskType: 'data_validation' },
      'suggest', // For now, treat as suggestion task
      'validation',
      'quality',
      data
    );
  }

  /**
   * Get optimal task configuration based on user preferences and context
   */
  private async getOptimalTaskConfig(
    userId: number,
    context: TaskContext
  ): Promise<TaskModelSelection | null> {
    try {
      // Get user's configured model for this task type
      const taskConfig = await this.configService.getTaskModelConfig(userId, context.taskType);

      if (!taskConfig) {
        this.logger.info('No task-specific configuration found, using default routing', {
          userId: String(userId),
          taskType: context.taskType
        });
        return null;
      }

      // Apply context-based optimizations
      if (context.complexity === 'high' && taskConfig.providerType !== 'claude') {
        // For high complexity, prefer Claude if available
        const claudeConfig = await this.configService.getTaskModelConfig(userId, context.taskType);
        // Would implement fallback to Claude if available
      }

      if (context.urgency === 'high' && context.complexity === 'low') {
        // For urgent, simple tasks, prefer Gemini for speed
        // Would implement routing optimization here
      }

      return taskConfig;

    } catch (error) {
      this.logger.error('Failed to get optimal task configuration', {
        userId: String(userId),
        taskType: context.taskType,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get or create provider instance for specific configuration
   */
  private async getProviderInstance(modelSelection: TaskModelSelection): Promise<AIProvider> {
    const instanceKey = `${modelSelection.providerConfigId ?? 'shared'}:${modelSelection.providerType}:${modelSelection.modelVersion}`;

    // Return cached instance if available
    if (this.providerInstances.has(instanceKey)) {
      const instance = this.providerInstances.get(instanceKey)!;
      if (instance.isAvailable) {
        return instance;
      }
    }

    // Create new provider instance
    let provider: AIProvider;

    switch (modelSelection.providerType) {
      case 'openai':
        if (!modelSelection.apiKey) {
          throw new Error('OpenAI API key not configured');
        }
        provider = new OpenAIProvider(this.logger, {
          apiKey: modelSelection.apiKey,
          model: modelSelection.modelVersion,
          baseURL: 'https://api.openai.com/v1',
          maxTokens: modelSelection.modelParameters.maxTokens || 1000,
          temperature: modelSelection.modelParameters.temperature || 0.3
        }, this.outboundGovernance);
        break;

      case 'claude':
        if (!modelSelection.apiKey) {
          throw new Error('Claude API key not configured');
        }
        const claudeConfiguration = (modelSelection.configuration || {}) as {
          authMode?: ClaudeAuthMode;
        };
        const claudeMaxTokens = normalizePositiveInteger(
          modelSelection.modelParameters.maxTokens,
          1000,
        ) ?? 1000;
        provider = new ClaudeProvider(this.logger, {
          apiKey: modelSelection.apiKey,
          model: modelSelection.modelVersion,
          baseURL: modelSelection.endpointUrl || 'https://api.anthropic.com/v1',
          maxTokens: claudeMaxTokens,
          temperature: modelSelection.modelParameters.temperature ?? 0.1,
          authMode: claudeConfiguration.authMode ?? (process.env.ANTHROPIC_AUTH_MODE as ClaudeAuthMode | undefined)
        }, this.outboundGovernance);
        break;

      case 'gemini':
        if (!modelSelection.apiKey) {
          throw new Error('Gemini API key not configured');
        }
        provider = new GeminiProvider(this.logger, {
          apiKey: modelSelection.apiKey,
          model: modelSelection.modelVersion as 'gemini-1.5-flash',
          baseURL: 'https://generativelanguage.googleapis.com/v1beta',
          maxTokens: modelSelection.modelParameters.maxTokens || 1000,
          temperature: modelSelection.modelParameters.temperature || 0.4
        }, this.outboundGovernance);
        break;

      case 'lmstudio':
        provider = new LMStudioProvider(this.logger, {
          baseURL: modelSelection.endpointUrl?.trim()
            ? canonicalizeLMStudioBaseUrl(modelSelection.endpointUrl)
            : resolveLMStudioBaseUrl(process.env.LMSTUDIO_BASE_URL),
          model: modelSelection.modelVersion,
          maxTokens: modelSelection.modelParameters.maxTokens || 1000,
          temperature: modelSelection.modelParameters.temperature || 0.3
        }, this.outboundGovernance);
        break;

      case 'openrouter': {
        if (!modelSelection.apiKey) {
          throw new Error('OpenRouter API key not configured');
        }
        const providerConfiguration = (modelSelection.configuration || {}) as {
          siteUrl?: string;
          siteName?: string;
          timeout?: number;
        };
        const maxTokens = normalizePositiveInteger(modelSelection.modelParameters.maxTokens);
        const timeout = normalizePositiveInteger(
          providerConfiguration.timeout ?? process.env.OPENROUTER_TIMEOUT,
          30000,
        ) ?? 30000;
        const openRouterConfig: OpenRouterConfig = {
          apiKey: modelSelection.apiKey,
          model: modelSelection.modelVersion,
          baseURL: normalizeOpenRouterBaseUrl(modelSelection.endpointUrl || 'https://openrouter.ai/api/v1'),
          maxTokens,
          temperature: modelSelection.modelParameters.temperature ?? 0.1,
          siteUrl: providerConfiguration.siteUrl || process.env.OPENROUTER_SITE_URL,
          siteName: providerConfiguration.siteName || process.env.OPENROUTER_SITE_NAME || 'SuiteCentral',
          timeout,
        };
        provider = new OpenRouterProvider(this.logger, openRouterConfig, this.outboundGovernance);
        break;
      }

      case 'rule-based':
      default:
        provider = new RuleBasedProvider(this.logger);
        break;
    }

    // Test provider availability
    const testResult = await provider.testConnection();
    if (!testResult.ok) {
      throw new Error(`Provider ${modelSelection.providerType} not available: ${testResult.message}`);
    }

    // Cache the instance
    this.providerInstances.set(instanceKey, provider);

    this.logger.info('Provider instance created', {
      providerType: modelSelection.providerType,
      modelVersion: modelSelection.modelVersion,
      instanceKey,
      available: provider.isAvailable
    });

    return provider;
  }

  /**
   * Check session budget and prevent overspending
   */
  private async checkSessionBudget(userId: number, modelSelection: TaskModelSelection): Promise<void> {
    const currentSessionCost = this.sessionCosts.get(userId) || 0;

    if (currentSessionCost >= this.sessionBudget) {
      this.logger.warn('Session budget exceeded, switching to local provider', {
        userId: String(userId),
        currentCost: currentSessionCost,
        budget: this.sessionBudget,
        originalProvider: modelSelection.providerType
      });

      // Override with local provider if budget exceeded
      if (modelSelection.providerType !== 'lmstudio' && modelSelection.providerType !== 'rule-based') {
        throw new Error('Session budget exceeded. Please use local provider or increase budget.');
      }
    }
  }

  /**
   * Log task execution for analytics and cost tracking
   */
  private async logTaskExecution(
    userId: number,
    context: TaskContext,
    modelSelection: TaskModelSelection,
    operation: string,
    executionTime: number,
    tokenUsage?: unknown,
    success = true,
    recordsProcessed = 0,
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.configService.logUsage({
        userId,
        organizationId: undefined,
  providerConfigId: modelSelection.providerConfigId || 0,
  taskModelConfigId: modelSelection.taskModelConfigId || 0,
        taskType: context.taskType,
        providerType: modelSelection.providerType,
        modelVersion: modelSelection.modelVersion,
        promptTokens: (tokenUsage as any)?.promptTokens || 0,
        completionTokens: (tokenUsage as any)?.completionTokens || 0,
        totalTokens: (tokenUsage as any)?.totalTokens || 0,
        estimatedCost: (tokenUsage as any)?.estimatedCost || 0,
        requestType: operation,
        sessionId: context.sessionId,
        executionTimeMs: executionTime,
        success,
        errorMessage,
        recordsProcessed,
        fieldsAnalyzed: recordsProcessed
      });
    } catch (error) {
      this.logger.error('Failed to log task execution', {
        userId: String(userId),
        taskType: context.taskType,
        error: error.message
      });
    }
  }

  /**
   * Get session cost summary for user
   */
  getSessionCostSummary(userId: number): {
    totalCost: number;
    budgetRemaining: number;
    budgetUtilization: number;
  } {
    const totalCost = this.sessionCosts.get(userId) || 0;

    return {
      totalCost,
      budgetRemaining: Math.max(0, this.sessionBudget - totalCost),
      budgetUtilization: totalCost / this.sessionBudget
    };
  }

  /**
   * Set session budget for cost control
   */
  setSessionBudget(budget: number): void {
    this.sessionBudget = Math.max(0, budget);
    this.logger.info('Session budget updated', { budget: this.sessionBudget });
  }

  /**
   * Reset session costs for user
   */
  resetSessionCosts(userId: number): void {
    this.sessionCosts.delete(userId);
    this.logger.info('Session costs reset', { userId: String(userId) });
  }

  /**
   * Get available providers for user with their configurations
   */
  async getAvailableProviders(userId: number): Promise<{
    providerType: AIProviderType;
    providerName: string;
    isActive: boolean;
    taskConfigurations: {
      taskType: AITaskType;
      modelVersion: string;
      priority: number;
    }[];
  }[]> {
    try {
      const configs = await this.configService.getProviderConfigs(userId);

      const providersWithTasks = await Promise.all(
        configs.map(async (config) => {
          // Get task configurations for this provider
          const taskTypes: AITaskType[] = ['field_mapping', 'quality_assessment', 'data_validation', 'transformation_suggestion'];
          const taskConfigs = await Promise.all(
            taskTypes.map(async (taskType) => {
              const taskConfig = await this.configService.getTaskModelConfig(userId, taskType);
              return taskConfig && taskConfig.providerType === config.providerType ? {
                taskType,
                modelVersion: taskConfig.modelVersion,
                priority: taskConfig.priority
              } : null;
            })
          );

          return {
            providerType: config.providerType,
            providerName: config.providerName,
            isActive: config.isActive,
            taskConfigurations: taskConfigs.filter(Boolean) as NonNullable<typeof taskConfigs[number]>[]
          };
        })
      );

      return providersWithTasks;
    } catch (error) {
      this.logger.error('Failed to get available providers', {
        userId: String(userId),
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get task-specific routing recommendations
   */
  async getTaskRoutingRecommendations(
    userId: number,
    taskType: AITaskType,
    context?: Partial<TaskContext>
  ): Promise<{
    recommendedProvider: AIProviderType;
    recommendedModel: string;
    reasoning: string;
    alternatives: {
      provider: AIProviderType;
      model: string;
      reason: string;
    }[];
    costEstimate: number;
  }> {
    try {
      const taskConfig = await this.configService.getTaskModelConfig(userId, taskType);
      const sessionSummary = this.getSessionCostSummary(userId);

      let recommendedProvider: AIProviderType = 'rule-based';
      let recommendedModel = 'rule-based-v1';
      let reasoning = 'Default fallback provider';
      let costEstimate = 0;

      if (taskConfig) {
        recommendedProvider = taskConfig.providerType;
        recommendedModel = taskConfig.modelVersion;
        reasoning = 'User-configured task-specific model';

        // Estimate cost based on provider
        if (taskConfig.providerType !== 'rule-based' && taskConfig.providerType !== 'lmstudio') {
          costEstimate = 0.002; // Rough estimate
        }
      }

      // Apply context-based adjustments
      if (sessionSummary.budgetUtilization > 0.8) {
        recommendedProvider = 'lmstudio';
        recommendedModel = 'llama-3.1-8b-instruct';
        reasoning = 'Budget threshold exceeded - routing to local provider';
        costEstimate = 0;
      } else if (context?.complexity === 'high') {
        recommendedProvider = 'claude';
        recommendedModel = 'claude-sonnet-4-6';
        reasoning = 'High complexity task - using premium provider';
        costEstimate = 0.006;
      } else if (context?.urgency === 'high' && context?.complexity === 'low') {
        recommendedProvider = 'gemini';
        recommendedModel = 'gemini-1.5-flash';
        reasoning = 'High urgency, low complexity - using fast economy provider';
        costEstimate = 0.0001;
      }

      const alternatives = [
        { provider: 'openai' as AIProviderType, model: 'gpt-5.4-mini', reason: 'Balanced performance and cost' },
        { provider: 'claude' as AIProviderType, model: 'claude-sonnet-4-6', reason: 'Best for complex reasoning' },
        { provider: 'gemini' as AIProviderType, model: 'gemini-1.5-flash', reason: 'Most cost-effective' },
        { provider: 'openrouter' as AIProviderType, model: 'anthropic/claude-3.5-sonnet', reason: 'Multi-model access via single API key' },
        { provider: 'lmstudio' as AIProviderType, model: 'llama-3.1-8b-instruct', reason: 'Local processing, no API costs' }
      ].filter(alt => alt.provider !== recommendedProvider);

      return {
        recommendedProvider,
        recommendedModel,
        reasoning,
        alternatives,
        costEstimate
      };

    } catch (error) {
      this.logger.error('Failed to get task routing recommendations', {
        userId: String(userId),
        taskType,
        error: error.message
      });

      return {
        recommendedProvider: 'rule-based',
        recommendedModel: 'rule-based-v1',
        reasoning: 'Error occurred, using safe fallback',
        alternatives: [],
        costEstimate: 0
      };
    }
  }
}
