import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { IAIProvider, ISemanticProvider, IPatternProvider, INLPProvider, IMLProvider } from './interfaces/IAIProvider';
import { RuleBasedAIProvider } from './providers/RuleBasedAIProvider';
import { CloudAIProvider } from './providers/CloudAIProvider';

export type AIProviderType = 'rule-based' | 'cloud-api' | 'local-ml' | 'hybrid';

export interface AIProviderConfig {
  primary: AIProviderType;
  fallback?: AIProviderType;
  cloudConfig?: {
    apiKey?: string;
    baseUrl?: string;
    modelName?: string;
    provider?: 'openai' | 'google' | 'aws' | 'azure';
  };
  localMLConfig?: {
    modelPath?: string;
    deviceType?: 'cpu' | 'gpu';
    memoryLimit?: number;
  };
  hybridConfig?: {
    semanticProvider?: AIProviderType;
    patternProvider?: AIProviderType;
    nlpProvider?: AIProviderType;
    mlProvider?: AIProviderType;
  };
}

/**
 * Factory for creating and managing AI providers.
 * This allows switching between different AI implementations
 * (rule-based, cloud APIs, local ML models) based on configuration.
 */
@injectable()
export class AIProviderFactory {
  private logger: Logger;
  private providers = new Map<AIProviderType, IAIProvider>();
  private currentConfig?: AIProviderConfig;

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    this.initializeProviders();
  }

  /**
   * Initialize all available AI providers
   */
  private initializeProviders(): void {
    try {
      // Always initialize rule-based provider (no dependencies)
      const ruleBasedProvider = new RuleBasedAIProvider(this.logger);
      this.providers.set('rule-based', ruleBasedProvider);

      // Initialize cloud provider (may not be available without config)
      const cloudProvider = new CloudAIProvider(this.logger);
      this.providers.set('cloud-api', cloudProvider as any);

      // TODO: Initialize local ML provider when implemented
      // const localMLProvider = new LocalMLProvider(this.logger);
      // this.providers.set('local-ml', localMLProvider);

      this.logger.info('AI providers initialized', {
        availableProviders: Array.from(this.providers.keys()),
        ruleBasedAvailable: ruleBasedProvider.isAvailable,
        cloudAvailable: (cloudProvider as any).isAvailable || false,
      });
    } catch (error) {
      this.logger.error('Error initializing AI providers', error);
      throw error;
    }
  }

  /**
   * Configure the AI provider factory
   */
  configure(config: AIProviderConfig): void {
    this.currentConfig = config;

    // Configure cloud provider if specified
    if (config.cloudConfig && this.providers.has('cloud-api')) {
      const cloudProvider = this.providers.get('cloud-api') as any;

      if (config.cloudConfig.apiKey && cloudProvider.setApiKey) {
        cloudProvider.setApiKey(config.cloudConfig.apiKey);
      }
      if (config.cloudConfig.baseUrl && cloudProvider.setBaseUrl) {
        cloudProvider.setBaseUrl(config.cloudConfig.baseUrl);
      }
      if (config.cloudConfig.modelName && cloudProvider.setModelName) {
        cloudProvider.setModelName(config.cloudConfig.modelName);
      }
    }

    this.logger.info('AI provider factory configured', {
      primary: config.primary,
      fallback: config.fallback,
      cloudConfigured: !!config.cloudConfig?.apiKey,
    });
  }

  /**
   * Get the primary AI provider based on current configuration
   */
  getPrimaryProvider(): IAIProvider {
    const providerType = this.currentConfig?.primary || 'rule-based';
    const provider = this.providers.get(providerType);

    if (!provider) {
      throw new Error(`AI provider '${providerType}' not found`);
    }

    if (!provider.isAvailable) {
      // Try fallback provider
      const fallbackType = this.currentConfig?.fallback || 'rule-based';
      const fallbackProvider = this.providers.get(fallbackType);

      if (fallbackProvider?.isAvailable) {
        this.logger.warn(`Primary AI provider '${providerType}' not available, using fallback '${fallbackType}'`);
        return fallbackProvider;
      }

      throw new Error(`AI provider '${providerType}' not available and no suitable fallback found`);
    }

    return provider;
  }

  /**
   * Get semantic analysis provider
   */
  getSemanticProvider(): ISemanticProvider {
    const hybridConfig = this.currentConfig?.hybridConfig;

    if (hybridConfig?.semanticProvider) {
      const provider = this.providers.get(hybridConfig.semanticProvider) as ISemanticProvider;
      if (provider?.isAvailable) {
        return provider;
      }
    }

    const primaryProvider = this.getPrimaryProvider() as ISemanticProvider;
    if (!primaryProvider.analyzeSemanticSimilarity) {
      throw new Error('Primary provider does not support semantic analysis');
    }

    return primaryProvider;
  }

  /**
   * Get pattern analysis provider
   */
  getPatternProvider(): IPatternProvider {
    const hybridConfig = this.currentConfig?.hybridConfig;

    if (hybridConfig?.patternProvider) {
      const provider = this.providers.get(hybridConfig.patternProvider) as IPatternProvider;
      if (provider?.isAvailable) {
        return provider;
      }
    }

    const primaryProvider = this.getPrimaryProvider() as IPatternProvider;
    if (!primaryProvider.analyzeFieldPattern) {
      throw new Error('Primary provider does not support pattern analysis');
    }

    return primaryProvider;
  }

  /**
   * Get NLP provider
   */
  getNLPProvider(): INLPProvider {
    const hybridConfig = this.currentConfig?.hybridConfig;

    if (hybridConfig?.nlpProvider) {
      const provider = this.providers.get(hybridConfig.nlpProvider) as INLPProvider;
      if (provider?.isAvailable) {
        return provider;
      }
    }

    const primaryProvider = this.getPrimaryProvider() as INLPProvider;
    if (!primaryProvider.analyzeFieldDescription) {
      throw new Error('Primary provider does not support NLP analysis');
    }

    return primaryProvider;
  }

  /**
   * Get ML provider (if available)
   */
  getMLProvider(): IMLProvider | null {
    const hybridConfig = this.currentConfig?.hybridConfig;

    if (hybridConfig?.mlProvider) {
      const provider = this.providers.get(hybridConfig.mlProvider) as IMLProvider;
      if (provider?.isAvailable) {
        return provider;
      }
    }

    const primaryProvider = this.getPrimaryProvider();
    if ('trainModel' in primaryProvider) {
      return primaryProvider as IMLProvider;
    }

    return null;
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): { type: AIProviderType; provider: IAIProvider }[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.isAvailable)
      .map(([type, provider]) => ({ type, provider }));
  }

  /**
   * Test provider connectivity and capabilities
   */
  async testProvider(providerType: AIProviderType): Promise<{
    available: boolean;
    capabilities: string[];
    performance?: {
      responseTime: number;
      accuracy?: number;
    };
    errors: string[];
  }> {
    const provider = this.providers.get(providerType);

    if (!provider) {
      return {
        available: false,
        capabilities: [],
        errors: [`Provider '${providerType}' not found`],
      };
    }

    const errors: string[] = [];
    const capabilities: string[] = [];
    let responseTime: number;

    try {
      const startTime = Date.now();

      // Test semantic analysis
      if ('analyzeSemanticSimilarity' in provider) {
        try {
          await (provider as ISemanticProvider).analyzeSemanticSimilarity('test', 'test');
          capabilities.push('semantic-analysis');
        } catch (error) {
          errors.push(`Semantic analysis failed: ${error.message}`);
        }
      }

      // Test pattern recognition
      if ('analyzeFieldPattern' in provider) {
        try {
          await (provider as IPatternProvider).analyzeFieldPattern('test', ['test']);
          capabilities.push('pattern-recognition');
        } catch (error) {
          errors.push(`Pattern recognition failed: ${error.message}`);
        }
      }

      // Test NLP
      if ('analyzeFieldDescription' in provider) {
        try {
          await (provider as INLPProvider).analyzeFieldDescription('test description');
          capabilities.push('nlp');
        } catch (error) {
          errors.push(`NLP analysis failed: ${error.message}`);
        }
      }

      // Test ML
      if ('trainModel' in provider) {
        try {
          await (provider as IMLProvider).getModelMetrics();
          capabilities.push('machine-learning');
        } catch (error) {
          errors.push(`ML capabilities failed: ${error.message}`);
        }
      }

      responseTime = Date.now() - startTime;

      return {
        available: provider.isAvailable && errors.length === 0,
        capabilities,
        performance: {
          responseTime,
        },
        errors,
      };
    } catch (error) {
      return {
        available: false,
        capabilities,
        errors: [`Provider test failed: ${error.message}`],
      };
    }
  }

  /**
   * Get current configuration
   */
  getCurrentConfig(): AIProviderConfig | undefined {
    return this.currentConfig;
  }

  /**
   * Reset to default configuration (rule-based)
   */
  resetToDefault(): void {
    this.currentConfig = {
      primary: 'rule-based',
      fallback: 'rule-based',
    };

    this.logger.info('AI provider factory reset to default configuration');
  }
}
