/**
 * Secure AI Service - Server-side AI operations with protected credentials
 * Replaces client-side AI provider access with secure backend proxy
 * Phase 1 Implementation: Addresses client-side secret exposure
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';
import { ProviderRegistry, type MappingContext, type AISuggestion, type DataContext, type QualityAssessment } from './ProviderRegistry';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { OpenAIProviderAdapter } from './providers/OpenAIProviderAdapter';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { LMStudioProvider } from './providers/LMStudioProvider';
import { OutboundGovernanceService } from '../governance/OutboundGovernanceService';

export interface SecureAIConfig {
  providers: {
    openai?: {
      apiKey: string;
      model?: string;
      enabled: boolean;
    };
    anthropic?: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      enabled: boolean;
    };
    lmstudio?: {
      baseUrl: string;
      model?: string;
      apiKey?: string;
      enabled: boolean;
    };
    // Add other providers as needed
  };
  defaultProvider: string;
  fallbackOrder: string[];
}

export interface AIServiceRequest {
  providerId?: string;
  operation: 'mapping' | 'quality';
  context: MappingContext | DataContext;
  data?: unknown[];
  userId?: string; // For audit and rate limiting
}

export interface AIServiceResponse {
  success: boolean;
  providerId: string;
  data?: AISuggestion[] | QualityAssessment;
  error?: string;
  metadata: {
    tokensUsed?: number;
    responseTime: number;
    requestId: string;
  };
}

@injectable()
export class SecureAIService {
  private readonly config: SecureAIConfig;
  private initialized = false;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ProviderRegistry) private registry: ProviderRegistry,
    @inject(TYPES.OutboundGovernanceService) private outboundGovernance: OutboundGovernanceService
  ) {
    this.config = this.loadConfiguration();
  }

  /**
   * Initialize the AI service with secure provider configuration
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.setupProviders();
      this.setupFallbackOrder();
      this.initialized = true;

      this.logger.info('SecureAIService initialized successfully', {
        providersConfigured: Object.keys(this.config.providers).filter(
          p => (this.config.providers as Record<string, { enabled?: boolean } | undefined>)[p]?.enabled
        ).length
      });
    } catch (error) {
      this.logger.error('Failed to initialize SecureAIService', error);
      throw new Error(`AI service initialization failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Generate field mapping suggestions using configured AI providers
   */
  async generateMappingSuggestions(request: AIServiceRequest): Promise<AIServiceResponse> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      this.validateRequest(request, 'mapping');

      const result = await this.registry.getAvailableProvider(request.providerId || this.config.defaultProvider);

      if (!result) {
        throw new Error('No AI providers available');
      }

      const { provider, id: providerId } = result;

      this.logger.info('Generating AI mapping suggestions', {
        providerId,
        requestId,
        sourceSystem: (request.context as MappingContext).sourceSystem,
        targetSystem: (request.context as MappingContext).targetSystem
      });

      const suggestions = await provider.generateMappingSuggestions(request.context as MappingContext);

      const responseTime = Date.now() - startTime;

      // Audit successful AI usage
      this.auditAIUsage(request.userId, providerId, 'mapping', true, responseTime);

      return {
        success: true,
        providerId,
        data: suggestions,
        metadata: {
          responseTime,
          requestId
        }
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('AI mapping suggestions failed', {
        error: error.message,
        requestId,
        responseTime
      });

      // Audit failed AI usage
      this.auditAIUsage(request.userId, request.providerId || 'unknown', 'mapping', false, responseTime);

      return {
        success: false,
        providerId: request.providerId || 'unknown',
        error: error.message,
        metadata: {
          responseTime,
          requestId
        }
      };
    }
  }

  /**
   * Analyze data quality using configured AI providers
   */
  async analyzeDataQuality(request: AIServiceRequest): Promise<AIServiceResponse> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      this.validateRequest(request, 'quality');

      const result = await this.registry.getAvailableProvider(request.providerId || this.config.defaultProvider);

      if (!result) {
        throw new Error('No AI providers available');
      }

      const { provider, id: providerId } = result;

      this.logger.info('Analyzing data quality with AI', {
        providerId,
        requestId,
        dataSize: request.data?.length || 0
      });

      const assessment = await provider.analyzeDataQuality(
        request.data || [],
        request.context as DataContext
      );

      const responseTime = Date.now() - startTime;

      // Audit successful AI usage
      this.auditAIUsage(request.userId, providerId, 'quality', true, responseTime);

      return {
        success: true,
        providerId,
        data: assessment,
        metadata: {
          responseTime,
          requestId
        }
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('AI data quality analysis failed', {
        error: error.message,
        requestId,
        responseTime
      });

      // Audit failed AI usage
      this.auditAIUsage(request.userId, request.providerId || 'unknown', 'quality', false, responseTime);

      return {
        success: false,
        providerId: request.providerId || 'unknown',
        error: error.message,
        metadata: {
          responseTime,
          requestId
        }
      };
    }
  }

  /**
   * Test connectivity to configured providers
   */
  async testProviders(): Promise<{ [providerId: string]: { ok: boolean; message?: string } }> {
    const results: { [providerId: string]: { ok: boolean; message?: string } } = {};

    for (const [providerId, provider] of this.registry['providers']) {
      try {
        results[providerId] = await provider.testConnection();
      } catch (error) {
        results[providerId] = {
          ok: false,
          message: `Test failed: ${error.message}`
        };
      }
    }

    return results;
  }

  /**
   * Get available providers (for admin/diagnostic purposes)
   */
  getAvailableProviders(): { id: string; name: string; version: string }[] {
    return this.registry.listProviders().map(p => ({
      id: p.id,
      name: p.name,
      version: p.version
    }));
  }

  /**
   * Call an AI provider with raw messages for semantic analysis
   * Used by SemanticAnalysisEngine and other advanced AI operations
   * 
   * @param options Provider call options including messages, temperature, and token limits
   * @returns Structured response with content, provider info, cost, and token usage
   */
  async callProvider(options: {
    provider?: string;
    model?: string;
    messages: { role: string; content: string }[];
    temperature: number;
    maxTokens: number;
  }): Promise<{
    content: string;
    provider: string;
    model: string;
    cost?: number;
    tokensUsed?: { prompt: number; completion: number; total: number };
  }> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    const providerId = options.provider || this.config.defaultProvider;

    try {
      this.logger.info('Calling AI provider for raw completion', {
        providerId,
        requestId,
        messageCount: options.messages.length,
        temperature: options.temperature,
        maxTokens: options.maxTokens
      });

      // Get provider from registry
      const result = await this.registry.getAvailableProvider(providerId);
      
      if (!result) {
        throw new Error(`No AI provider available for: ${providerId}`);
      }

      const { provider, id: actualProviderId } = result;

      // Build the prompt from messages
      let prompt = '';
      for (const msg of options.messages) {
        if (msg.role === 'system') {
          prompt += `System: ${msg.content}\n\n`;
        } else if (msg.role === 'user') {
          prompt += `User: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
          prompt += `Assistant: ${msg.content}\n\n`;
        }
      }

      // Call the provider based on type
      let response: unknown;
      let content: string;
      let tokensUsed: { prompt: number; completion: number; total: number } | undefined;
      let cost: number | undefined;

      // Check if it's an LMStudio provider
      if (actualProviderId === 'lmstudio' && 'callLMStudio' in (provider as any)) {
        const lmProvider = provider as any;
        const lmResponse = await lmProvider.callLMStudio(prompt, {
          maxTokens: options.maxTokens,
          temperature: options.temperature
        });
        
        content = lmResponse.choices?.[0]?.message?.content || '';
        
        if (lmResponse.usage) {
          tokensUsed = {
            prompt: lmResponse.usage.prompt_tokens,
            completion: lmResponse.usage.completion_tokens,
            total: lmResponse.usage.total_tokens
          };
          cost = 0; // LMStudio is free (local)
        }
      }
      // Check if provider has a generic chat/completion method
      else if ('generateCompletion' in provider) {
        response = await (provider as any).generateCompletion(prompt, {
          maxTokens: options.maxTokens,
          temperature: options.temperature
        });
        content = (response as any).content || (response as any).text || '';
        tokensUsed = (response as any).tokensUsed;
        cost = (response as any).cost;
      }
      // Fallback: Use mapping suggestions method (not ideal but works)
      else {
        this.logger.warn('Provider does not support direct completion, using fallback method', {
          providerId: actualProviderId
        });
        
        // Create a minimal context for the mapping method
        const mappingContext = {
          sourceSystem: 'generic',
          targetSystem: 'generic',
          sourceFields: [{ name: 'input', type: 'string' }],
          targetFields: [{ name: 'output', type: 'string' }],
          customPrompt: prompt
        };
        
        const suggestions = await provider.generateMappingSuggestions(mappingContext as any);
        content = JSON.stringify(suggestions);
      }

      const responseTime = Date.now() - startTime;

      this.logger.info('AI provider call completed', {
        providerId: actualProviderId,
        requestId,
        responseTime,
        tokensUsed: tokensUsed?.total,
        cost
      });

      // Audit the usage
      this.auditAIUsage(undefined, actualProviderId, 'raw_completion', true, responseTime);

      return {
        content,
        provider: actualProviderId,
        model: options.model || this.getProviderConfig(actualProviderId)?.model || 'default',
        cost,
        tokensUsed
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('AI provider call failed', {
        providerId,
        requestId,
        responseTime,
        error: error instanceof Error ? error.message : String(error)
      });

      // Audit the failure
      this.auditAIUsage(undefined, providerId, 'raw_completion', false, responseTime);

      throw new Error(`AI provider call failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Check if the service supports embeddings
   * Used by SemanticAnalysisEngine for fast, low-cost similarity calculations
   * 
   * @returns true if any configured provider supports embeddings
   */
  supportsEmbeddings(): boolean {
    // Check if any configured provider supports embeddings
    const providers = this.registry.listProviders();
    
    for (const providerInfo of providers) {
      const providerId = providerInfo.id.toLowerCase();
      
      // OpenAI supports embeddings (text-embedding-ada-002, text-embedding-3-*)
      if (providerId === 'openai' && this.config.providers.openai?.enabled) {
        return true;
      }
      
      // LMStudio can support embeddings if an embedding model is loaded
      // For now, we'll return false for LMStudio until we verify embedding model support
      // TODO: Add method to LMStudioProvider to check if embedding model is loaded
      
      // Claude does not natively support embeddings
      
      // Gemini supports embeddings (embedding-001)
      if (providerId === 'gemini' && (this.config.providers as Record<string, { enabled?: boolean } | undefined>)['gemini']?.enabled) {
        return true;
      }
    }
    
    return false;
  }

  private loadConfiguration(): SecureAIConfig {
    const normalizeProviderId = (providerId: string): string => {
      return providerId === 'anthropic' ? 'claude' : providerId;
    };

    // In production, load from secure environment variables or secret store
    return {
      providers: {
        openai: {
          apiKey: process.env.OPENAI_API_KEY || '',
          model: process.env.OPENAI_MODEL || 'gpt-4',
          enabled: !!process.env.OPENAI_API_KEY
        },
        anthropic: {
          apiKey: process.env.ANTHROPIC_API_KEY || '',
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
          baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
          enabled: !!process.env.ANTHROPIC_API_KEY
        },
        lmstudio: {
          baseUrl: process.env.LMSTUDIO_BASE_URL || '',
          model: process.env.LMSTUDIO_MODEL || process.env.LMSTUDIO_MODEL_OVERRIDE || '',
          apiKey: process.env.LMSTUDIO_API_KEY || '',
          enabled: !!process.env.LMSTUDIO_BASE_URL
        }
      },
      defaultProvider: normalizeProviderId(process.env.DEFAULT_AI_PROVIDER || 'openai'),
      fallbackOrder: (process.env.AI_FALLBACK_ORDER || 'openai,anthropic,lmstudio')
        .split(',')
        .map(providerId => normalizeProviderId(providerId.trim()))
    };
  }

  private resolveProviderConfigKey(providerId: string): keyof SecureAIConfig['providers'] | undefined {
    switch (providerId) {
      case 'openai':
        return 'openai';
      case 'claude':
      case 'anthropic':
        return 'anthropic';
      case 'lmstudio':
        return 'lmstudio';
      default:
        return undefined;
    }
  }

  private getProviderConfig(providerId: string) {
    const configKey = this.resolveProviderConfigKey(providerId);
    return configKey ? this.config.providers[configKey] : undefined;
  }

  private async setupProviders(): Promise<void> {
    // Register OpenAI provider if configured
    if (this.config.providers.openai?.enabled) {
      if (!this.registry.getProvider('openai')) {
        const rawModel = this.config.providers.openai.model || 'gpt-4o';
        const normalizedModel = rawModel === 'gpt-4' ? 'gpt-4o' : rawModel;
        const openaiProvider = new OpenAIProvider(this.logger, {
          apiKey: this.config.providers.openai.apiKey,
          model: normalizedModel as 'gpt-4o' | 'gpt-4o-mini'
        }, this.outboundGovernance);
        const adapter = new OpenAIProviderAdapter(this.logger, openaiProvider);
        this.registry.register('openai', adapter as any);
      }
    }

    // Register Anthropic/Claude provider if configured
    if (this.config.providers.anthropic?.enabled) {
      if (!this.registry.getProvider('claude')) {
        const claudeConfig: ConstructorParameters<typeof ClaudeProvider>[1] = {
          apiKey: this.config.providers.anthropic.apiKey,
          model: this.config.providers.anthropic.model as 'claude-3-5-sonnet-20241022'
        };
        if (this.config.providers.anthropic.baseUrl) {
          claudeConfig.baseURL = this.config.providers.anthropic.baseUrl;
        }
        if (process.env.ANTHROPIC_AUTH_MODE) {
          claudeConfig.authMode = process.env.ANTHROPIC_AUTH_MODE as 'auto' | 'anthropic' | 'bearer';
        }
        const claudeProvider = new ClaudeProvider(this.logger, claudeConfig, this.outboundGovernance);
        this.registry.register('claude', claudeProvider as any); // Register as 'claude' to match standard naming
      }
      this.logger.info('Claude provider registered successfully');
    }

    if (this.config.providers.lmstudio?.enabled) {
      if (!this.registry.getProvider('lmstudio')) {
        const lmstudioProvider = new LMStudioProvider(this.logger, {
          baseURL: this.config.providers.lmstudio.baseUrl,
          model: this.config.providers.lmstudio.model || 'gpt-oss-20b',
          apiKey: this.config.providers.lmstudio.apiKey,
          maxTokens: parseInt(process.env.LMSTUDIO_MAX_TOKENS || '1500'),
          temperature: parseFloat(process.env.LMSTUDIO_TEMPERATURE || '0.2'),
          timeout: parseInt(process.env.LMSTUDIO_TIMEOUT || '30000')
        }, this.outboundGovernance);
        this.registry.register('lmstudio', lmstudioProvider as any);
      }
      this.logger.info('LM Studio provider registered successfully');
    }

    // Always register rule-based fallback
    // const ruleBasedProvider = new RuleBasedProvider(this.logger);
    // this.registry.register('rule-based', ruleBasedProvider);
  }

  private setupFallbackOrder(): void {
    this.registry.setFallbackOrder(this.config.fallbackOrder);
  }

  private validateRequest(request: AIServiceRequest, expectedOperation: string): void {
    if (!request.operation || request.operation !== expectedOperation) {
      throw new Error(`Invalid operation: expected ${expectedOperation}`);
    }

    if (!request.context) {
      throw new Error('Request context is required');
    }

    if (expectedOperation === 'quality' && !request.data?.length) {
      throw new Error('Data array is required for quality analysis');
    }
  }

  private generateRequestId(): string {
    return `ai_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
  }

  private auditAIUsage(
    userId: string | undefined,
    providerId: string,
    operation: string,
    success: boolean,
    responseTime: number
  ): void {
    // In production, this would write to audit log/database
    this.logger.info('AI usage audit', {
      userId: userId || 'anonymous',
      providerId,
      operation,
      success,
      responseTime,
      timestamp: new Date().toISOString()
    });
  }
}
