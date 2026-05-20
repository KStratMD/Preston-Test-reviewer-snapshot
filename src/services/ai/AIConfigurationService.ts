/**
 * AI Configuration Service - Task-Specific Model Selection
 * Manages AI provider configurations with support for different models per task type
 */

import { injectable, inject } from "inversify";
import type { Insertable, Kysely } from "kysely";
import { sql } from "kysely";
import { logger } from "../../utils/Logger";
import { encryptionService } from "../security/EncryptionService";
import { validateUrlForSsrfSync } from "../../utils/urlValidator";
import type { DatabaseService } from "../../database/DatabaseService";
import type {
  AIProviderConfig as AIProviderConfigSelectable,
  AITaskModelConfig as AITaskModelConfigSelectable,
  AIProviderConfigsTable,
  AITaskModelConfigsTable,
  Database,
} from "../../database/types";
import { TYPES } from "../../inversify/types";
import type { ModelCatalogService } from "./ModelCatalogService";
import { type ModelInfo, type ProviderId } from "./ModelCatalogService";
import {
  buildClaudeHeaders,
  normalizeClaudeBaseUrl,
} from "./utils/claude";
import type { ClaudeAuthMode } from "./utils/claude";
import { normalizeOpenRouterBaseUrl } from "./utils/openRouter";

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
interface ModelParameters extends JsonObject {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export type AITaskType = "field_mapping" | "quality_assessment" | "data_validation" | "transformation_suggestion" | "help_chat";
export type AIProviderType = "openai" | "claude" | "gemini" | "grok" | "lmstudio" | "openrouter" | "rule-based";


export interface ProviderModelInfo {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  inputCostPer1K?: number;
  outputCostPer1K?: number;
  tags?: string[];
  providerType: AIProviderType;
}

export interface AIProviderConfig {
  id?: number;
  userId: number;
  organizationId?: number;
  providerType: AIProviderType;
  providerName: string;
  apiKey?: string; // Will be encrypted in storage
  endpointUrl?: string;
  isActive: boolean;
  isDefault: boolean;
  configuration: JsonObject;
  hasApiKey?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AITaskModelConfig {
  id?: number;
  userId: number;
  organizationId?: number;
  taskType: AITaskType;
  providerConfigId: number | string;
  providerType?: AIProviderType;
  modelVersion: string;
  modelParameters: ModelParameters;
  isActive: boolean;
  priority: number; // 1 = highest priority for fallback
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AIUsageLog {
  id?: number;
  userId: number;
  organizationId?: number;
  providerConfigId: number;
  taskModelConfigId: number;
  taskType: AITaskType;
  providerType: AIProviderType;
  modelVersion: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  requestType: string;
  sessionId?: string;
  executionTimeMs: number;
  success: boolean;
  errorMessage?: string;
  recordsProcessed: number;
  fieldsAnalyzed: number;
  createdAt?: Date;
}

export interface AIUsageStatsRow {
  task_type: string;
  provider_type: string;
  model_version: string;
  request_count: number | string | bigint | null;
  total_tokens: number | string | bigint | null;
  total_cost: number | string | null;
  avg_execution_time: number | string | null;
  success_count: number | string | bigint | null;
}

export interface TaskModelSelection {
  taskModelConfigId?: number;
  providerConfigId?: number;
  providerType: AIProviderType;
  providerName: string;
  modelVersion: string;
  modelParameters: ModelParameters;
  apiKey?: string;
  endpointUrl?: string;
  configuration?: JsonObject;
  priority: number;
}

// Database row types for proper typing
type AIProviderConfigRow = AIProviderConfigSelectable;
type AITaskModelConfigRow = AITaskModelConfigSelectable;

type TaskModelSelectionRow = AITaskModelConfigRow & {
  provider_type: string;
  provider_name: string;
  encrypted_api_key: string | null;
  endpoint_url: string | null;
  provider_config: JsonValue | null;
};

interface ModelPreset {
  name: string;
  description?: string;
  inputCostPer1K?: number;
  outputCostPer1K?: number;
  contextWindow?: number;
  tags?: string[];
}

const MODEL_PRESETS: Record<AIProviderType, Record<string, ModelPreset>> = {
  openai: {
    "gpt-4o": {
      name: "GPT-4o",
      description: "Flagship multimodal model",
      inputCostPer1K: 0.005,
      outputCostPer1K: 0.015,
      contextWindow: 128_000,
      tags: ["recommended", "multimodal"],
    },
    "gpt-4o-mini": {
      name: "GPT-4o Mini",
      description: "Balanced quality with lower cost",
      inputCostPer1K: 0.0006,
      outputCostPer1K: 0.0024,
      contextWindow: 128_000,
      tags: ["budget", "fast"],
    },
    "gpt-4-turbo": {
      name: "GPT-4 Turbo",
      description: "Legacy GPT-4 Turbo variant",
      inputCostPer1K: 0.01,
      outputCostPer1K: 0.03,
      contextWindow: 128_000,
      tags: ["legacy"],
    },
    "gpt-4": {
      name: "GPT-4",
      description: "Original GPT-4 model",
      inputCostPer1K: 0.015,
      outputCostPer1K: 0.05,
      contextWindow: 8_192,
      tags: ["legacy"],
    },
    "gpt-3.5-turbo": {
      name: "GPT-3.5 Turbo",
      description: "Economical for lightweight use cases",
      inputCostPer1K: 0.001,
      outputCostPer1K: 0.002,
      contextWindow: 16_385,
      tags: ["budget", "fast"],
    },
  },
  claude: {
    "claude-3-5-sonnet-20241022": {
      name: "Claude 3.5 Sonnet",
      description: "Latest Claude model with high reasoning quality",
      inputCostPer1K: 0.003,
      outputCostPer1K: 0.015,
      contextWindow: 200_000,
      tags: ["recommended", "reasoning"],
    },
    "claude-3-opus-20240229": {
      name: "Claude 3 Opus",
      description: "Premium flagship Claude model",
      inputCostPer1K: 0.015,
      outputCostPer1K: 0.075,
      contextWindow: 200_000,
      tags: ["premium"],
    },
    "claude-3-haiku-20240307": {
      name: "Claude 3 Haiku",
      description: "Fastest and most affordable Claude 3 model",
      inputCostPer1K: 0.0008,
      outputCostPer1K: 0.004,
      contextWindow: 200_000,
      tags: ["budget", "fast"],
    },
  },
  gemini: {
    "gemini-1.5-pro": {
      name: "Gemini 1.5 Pro",
      description: "Enterprise-grade multimodal reasoning",
      inputCostPer1K: 0.0035,
      outputCostPer1K: 0.0105,
      contextWindow: 2_000_000,
      tags: ["recommended", "multimodal"],
    },
    "gemini-1.5-flash": {
      name: "Gemini 1.5 Flash",
      description: "Fast and cost-efficient for high-volume workloads",
      inputCostPer1K: 0.0005,
      outputCostPer1K: 0.0015,
      contextWindow: 1_000_000,
      tags: ["budget", "fast"],
    },
  },
  grok: {
    "grok-beta": {
      name: "Grok Beta",
      description: "General purpose xAI assistant optimized for reasoning",
      inputCostPer1K: 0.002,
      outputCostPer1K: 0.01,
      contextWindow: 128_000,
      tags: ["reasoning"],
    },
    "grok-vision-beta": {
      name: "Grok Vision Beta",
      description: "Multimodal Grok variant with vision support",
      inputCostPer1K: 0.003,
      outputCostPer1K: 0.012,
      contextWindow: 128_000,
      tags: ["vision", "beta"],
    },
  },
  openrouter: {
    "anthropic/claude-3.5-sonnet": {
      name: "Claude 3.5 Sonnet (via OpenRouter)",
      description: "Anthropic Claude routed through OpenRouter",
      inputCostPer1K: 0.003,
      outputCostPer1K: 0.015,
      contextWindow: 200_000,
      tags: ["recommended", "reasoning"],
    },
    "openai/gpt-4o": {
      name: "GPT-4o (via OpenRouter)",
      description: "OpenAI GPT-4o routed through OpenRouter",
      inputCostPer1K: 0.005,
      outputCostPer1K: 0.015,
      contextWindow: 128_000,
      tags: ["multimodal"],
    },
    "openrouter/free": {
      name: "Free Router",
      description: "Zero-cost auto-routed free model",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      contextWindow: 8_192,
      tags: ["free", "budget"],
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      name: "Nemotron 3 Super 120B",
      description: "NVIDIA reasoning model routed through OpenRouter",
      inputCostPer1K: 0.0003,
      outputCostPer1K: 0.0003,
      contextWindow: 131_072,
      tags: ["reasoning"],
    },
  },
  lmstudio: {
    "llama-3.1-8b-instruct": {
      name: "Llama 3.1 8B Instruct (GGUF)",
      description: "Local open-weight model tuned for instructions",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      contextWindow: 8_192,
      tags: ["local", "open-source"],
    },
    "mistral-7b-instruct": {
      name: "Mistral 7B Instruct",
      description: "Compact and fast instruction model for local inference",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      contextWindow: 8_192,
      tags: ["local", "fast"],
    },
    "codellama-7b-instruct": {
      name: "CodeLlama 7B Instruct",
      description: "Code-specialized open model suitable for LM Studio",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      contextWindow: 8_192,
      tags: ["local", "code"],
    },
    "custom": {
      name: "Custom Model",
      description: "Any LM Studio compatible GGUF model",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      tags: ["local", "bring-your-own"],
    },
  },
  "rule-based": {
    "rule-based-v1": {
      name: "Rule-Based Engine v1",
      description: "Deterministic algorithm with zero token cost",
      inputCostPer1K: 0,
      outputCostPer1K: 0,
      tags: ["deterministic", "fallback"],
    },
  },
};

const PROVIDER_TO_CATALOG: Record<AIProviderType, ProviderId | null> = {
  openai: "openai",
  claude: "anthropic",
  gemini: "gemini",
  grok: "grok",
  lmstudio: "lmstudio",
  openrouter: "openrouter",
  "rule-based": null,
};

@injectable()
export class AIConfigurationService {
  private db: Kysely<Database>;

  constructor(
    @inject(TYPES.DatabaseService) private dbService: DatabaseService,
    @inject(TYPES.ModelCatalogService) private modelCatalogService: ModelCatalogService,
  ) {
    this.db = this.dbService.getDatabase();
  }

  private getDbType(): "sqlite" | "postgres" {
    const dbType = process.env.DB_TYPE;
    return dbType === "postgres" ? "postgres" : "sqlite";
  }

  private isSqlite(): boolean {
    return this.getDbType() === "sqlite";
  }

  /**
   * Convert boolean value to database-compatible format
   */
  private convertBooleanValue(value: boolean): boolean {
    return value;
  }

  private normalizeBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      return value !== 0;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0") {
        return false;
      }
    }

    return fallback;
  }

  /**
   * Recursively convert boolean values in nested objects for SQLite compatibility
   */
  private convertNestedBooleans(value: JsonValue | undefined): JsonValue | undefined {
    if (!this.isSqlite()) {
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.convertNestedBooleans(item) ?? null);
    }

    if (typeof value === "object") {
      const converted: JsonObject = {};
      for (const [key, nested] of Object.entries(value)) {
        converted[key] = this.convertNestedBooleans(nested) ?? null;
      }
      return converted;
    }

    return value;
  }

  private parseJsonObject(
    value: unknown,
    fallback: JsonObject = {},
    logContext?: Record<string, unknown>,
  ): JsonObject {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as JsonObject;
        }
      } catch (error) {
        logger.warn("Failed to parse JSON string", {
          ...logContext,
          error: (error as Error).message,
        });
        return fallback;
      }
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonObject;
    }

    if (logContext && value !== undefined && value !== null) {
      logger.warn("Expected JSON object value", {
        ...logContext,
        valueType: typeof value,
      });
    }

    return fallback;
  }

  private parseModelParameters(
    value: unknown,
    logContext?: Record<string, unknown>,
  ): ModelParameters {
    return this.parseJsonObject(value, {}, logContext);
  }

  private ensureJsonObject(value: JsonValue | undefined): JsonObject {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonObject;
    }

    return {};
  }

  /**
   * Extract a user-provided API key, ignoring masked placeholders from the UI
   */
  private extractProvidedApiKey(rawKey?: string): string | undefined {
    if (!rawKey) {
      return undefined;
    }

    const trimmed = rawKey.trim();
    if (!trimmed) {
      return undefined;
    }

    const maskedPatterns = [
      /^•+$/u,
      /^\*+$/u,
      /^x+$/iu,
      /^sk-[•\*x]+$/iu,
      /^__?unchanged__?$/iu,
    ];

    if (maskedPatterns.some(pattern => pattern.test(trimmed))) {
      return undefined;
    }

    return trimmed;
  }

  /**
   * Normalize provider identifiers so aliases map to canonical provider ids
   */
  public normalizeProviderType(providerType: string | null | undefined): AIProviderType {
    if (!providerType) {
      logger.warn('[AI Config] normalizeProviderType received null/undefined, defaulting to openai', {
        providedValue: providerType,
        stackTrace: new Error().stack
      });
      return "openai";
    }

    const value = providerType.toLowerCase();

    switch (value) {
      case "openai":
        return "openai";
      case "anthropic":
      case "claude":
        return "claude";
      case "gemini":
        return "gemini";
      case "grok":
      case "xai":
        return "grok";
      case "openrouter":
      case "open-router":
      case "open_router":
        return "openrouter";
      case "lmstudio":
      case "local-ai":
      case "local_ai":
      case "localai":
        logger.debug('[AI Config] normalizeProviderType matched lmstudio', { originalValue: providerType });
        return "lmstudio";
      case "rule-based":
      case "rulebased":
        return "rule-based";
      default:
        logger.error('[AI Config] Unknown provider type, defaulting to OpenAI - THIS MAY BE A BUG', {
          providedValue: providerType,
          lowercaseValue: value,
          stackTrace: new Error().stack
        });
        return "openai";
    }
  }

  /**
   * Get current timestamp for database operations
   */
  private getCurrentTimestamp(): Date {
    return new Date();
  }

  /**
   * Save AI provider configuration with encrypted API key
   */
  async saveProviderConfig(config: AIProviderConfig): Promise<AIProviderConfig> {
    try {
      // Normalize provider type aliases before processing
      config.providerType = this.normalizeProviderType(config.providerType);

      const providedApiKey = this.extractProvidedApiKey(config.apiKey);

      if (config.providerType === "lmstudio" && !config.endpointUrl) {
        config.endpointUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234";
      }

      if (config.providerType === "openrouter" && !config.endpointUrl) {
        config.endpointUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
      }

      // SSRF validation: block private/internal URLs in production
      if (config.endpointUrl && config.providerType !== "lmstudio") {
        const ssrfCheck = validateUrlForSsrfSync(config.endpointUrl);
        if (!ssrfCheck.valid) {
          throw new Error(`Endpoint URL rejected: ${ssrfCheck.error}`);
        }
      }

      const existingRecord = await this.db
        .selectFrom("ai_provider_configs")
        .select(["id", "encrypted_api_key"])
        .where("user_id", "=", config.userId)
        .where("provider_type", "=", config.providerType)
        .executeTakeFirst();

      // Validate API key format if provided
      if (providedApiKey) {
        const validation = encryptionService.validateApiKeyFormat(config.providerType, providedApiKey);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }

      // Encrypt API key if provided, otherwise keep existing encrypted key
      let encryptedApiKey: string | undefined = existingRecord?.encrypted_api_key || undefined;
      if (providedApiKey) {
        encryptedApiKey = await encryptionService.encryptForStorage(providedApiKey);
        logger.info("API key encrypted for storage", {
          provider: config.providerType,
          maskedKey: encryptionService.maskApiKey(providedApiKey),
        });
      }

      // Ensure boolean fields have proper defaults before conversion
      const isActive = config.isActive !== undefined ? config.isActive : true;
      const isDefault = config.isDefault !== undefined ? config.isDefault : false;

      // If setting as default, unset other defaults for this user
      if (isDefault) {
        await this.db
          .updateTable("ai_provider_configs")
          .set({ is_default: this.convertBooleanValue(false) })
          .where("user_id", "=", config.userId)
          .where("is_default", "=", this.convertBooleanValue(true))
          .execute();
      }

      // Insert or update provider configuration using insertable type
      const configurationPayload = this.ensureJsonObject(
        this.convertNestedBooleans(config.configuration ?? {}),
      );

      const insertData: Insertable<AIProviderConfigsTable> = {
        user_id: config.userId,
        organization_id: config.organizationId ?? null,
        provider_type: config.providerType,
        provider_name: config.providerName,
        encrypted_api_key: encryptedApiKey ?? null,
        endpoint_url: config.endpointUrl ?? null,
        is_active: this.convertBooleanValue(isActive),
        is_default: this.convertBooleanValue(isDefault),
        configuration: JSON.stringify(configurationPayload),
      };

      // Debug logging to identify boolean binding issues
      logger.debug("Saving AI provider config - insertData debug", {
        insertData: JSON.stringify(insertData, null, 2),
        configOriginal: JSON.stringify(config, null, 2),
        configIsActive: config.isActive,
        configIsDefault: config.isDefault,
        convertedIsActive: this.convertBooleanValue(config.isActive),
        convertedIsDefault: this.convertBooleanValue(config.isDefault),
        dbType: process.env.DB_TYPE,
        insertDataTypes: Object.keys(insertData).map(key => {
          const data = insertData as Record<string, unknown>;
          return {
            key,
            value: data[key],
            type: typeof data[key],
            constructor: (data[key] as { constructor?: { name?: string } } | null | undefined)?.constructor?.name,
          };
        }),
      });

      const result = await this.db
        .insertInto("ai_provider_configs")
        .values(insertData)
        .onConflict((oc) => oc
          .columns(["user_id", "provider_type"])
          .doUpdateSet({
            provider_name: (eb) => eb.ref("excluded.provider_name"),
            encrypted_api_key: (eb) => eb.ref("excluded.encrypted_api_key"),
            endpoint_url: (eb) => eb.ref("excluded.endpoint_url"),
            is_active: (eb) => eb.ref("excluded.is_active"),
            is_default: (eb) => eb.ref("excluded.is_default"),
            configuration: (eb) => eb.ref("excluded.configuration"),
            updated_at: this.getCurrentTimestamp(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      const savedConfig = result;

      // Log configuration change with converted boolean values for SQLite compatibility
      const auditConfig = {
        ...config,
        apiKey: providedApiKey ? "[UPDATED]" : "[UNCHANGED]",
        isActive: isActive,
        isDefault: isDefault,
      };
      await this.logConfigurationChange(
        config.userId,
        "provider",
        savedConfig.id,
        "upsert",
        null,
        auditConfig,
      );

      logger.info("AI provider configuration saved", {
        userId: String(config.userId),
        provider: config.providerType,
        configId: String(savedConfig.id),
      });

      return this.mapDbRowToProviderConfig(savedConfig);
    } catch (error) {
      logger.error("Failed to save provider configuration", {
        userId: config.userId,
        provider: config.providerType,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get AI provider configurations for a user
   */
  async getProviderConfigs(userId: number, providerType?: AIProviderType): Promise<AIProviderConfig[]> {
    try {
      let query = this.db
        .selectFrom("ai_provider_configs")
        .selectAll()
        .where("user_id", "=", userId)
        .where("is_active", "=", this.convertBooleanValue(true));

      if (providerType) {
        query = query.where("provider_type", "=", providerType);
      }

      const rows = await query.execute();
      const configs = await Promise.all(
        rows.map(row => this.mapDbRowToProviderConfig(row)),
      );

      // Dynamic Override: If running in Docker/Env specified, force the correct infrastructure URL
      // This solves the issue where DB has 'localhost' but Docker needs 'host.docker.internal'
      if (process.env.LMSTUDIO_BASE_URL) {
        for (const config of configs) {
          if (config.providerType === 'lmstudio') {
            config.endpointUrl = process.env.LMSTUDIO_BASE_URL;
            // Also update the nested configuration object if it exists to keep UI consistent
            if (config.configuration) {
              config.configuration.baseURL = process.env.LMSTUDIO_BASE_URL;
              config.configuration.baseUrl = process.env.LMSTUDIO_BASE_URL; // Handle both casings
            }
          }
        }
      }

      logger.debug("Retrieved provider configurations", {
        userId: String(userId),
        providerType,
        count: configs.length,
      });

      return configs;
    } catch (error) {
      logger.error("Failed to get provider configurations", {
        userId,
        providerType,
        error: error.message,
      });
      throw error;
    }
  }

  async getProviderConfig(userId: number, providerType: AIProviderType): Promise<AIProviderConfig | null> {
    const normalized = this.normalizeProviderType(providerType);
    logger.debug('[AI Config] getProviderConfig called', {
      requestedType: providerType,
      normalizedType: normalized,
      userId: String(userId)
    });

    const configs = await this.getProviderConfigs(userId, normalized);
    logger.debug('[AI Config] Found provider configs', {
      count: configs.length,
      configs: configs.map(c => ({
        id: c.id,
        providerType: c.providerType,
        providerName: c.providerName,
        isActive: c.isActive,
        isDefault: c.isDefault
      }))
    });

    return configs.length > 0 ? configs[0] : null;
  }

  /**
   * Configure task-specific model selection
   */
  async saveTaskModelConfig(config: AITaskModelConfig): Promise<AITaskModelConfig> {
    logger.info('[AI Config] saveTaskModelConfig called', {
      taskType: config.taskType,
      userId: String(config.userId),
      providedConfigId: config.providerConfigId,
      providedProviderType: config.providerType
    });

    try {
      const providerType = await this.determineProviderType(config);
      if (!providerType) {
        throw new Error("Provider configuration not found or not active");
      }

      logger.debug('[AI Config] Determined provider type', { providerType });
      config.providerType = providerType;

      // Ensure we have a valid provider configuration ID (resolve environment-backed providers if needed)
      const resolvedProviderConfigId = await this.resolveProviderConfigId(config, providerType);
      logger.info('[AI Config] Resolved provider config ID', {
        resolvedConfigId: resolvedProviderConfigId,
        providerType,
        taskType: config.taskType
      });
      config.providerConfigId = resolvedProviderConfigId;

      // Verify provider config exists
      const providerConfig = await this.db
        .selectFrom("ai_provider_configs")
        .select("id")
        .where("id", "=", resolvedProviderConfigId)
        .where("user_id", "=", config.userId)
        .where("is_active", "=", this.convertBooleanValue(true))
        .executeTakeFirst();

      if (!providerConfig) {
        throw new Error("Provider configuration not found or not active");
      }

      // Handle priority conflicts
      if (config.priority) {
        await this.db
          .updateTable("ai_task_model_configs")
          .set({
            priority: sql`priority + 1`,
          })
          .where("user_id", "=", config.userId)
          .where("task_type", "=", config.taskType)
          .where("priority", ">=", config.priority)
          .where("id", "!=", config.id || 0)
          .execute();
      }

      // Insert or update task model configuration
      // Ensure boolean fields have proper defaults before conversion
      const isActive = config.isActive !== undefined ? config.isActive : true;

      const modelParametersPayload = this.parseModelParameters(
        this.convertNestedBooleans(config.modelParameters ?? {}),
      );

      const insertData: Insertable<AITaskModelConfigsTable> = {
        user_id: config.userId,
        organization_id: config.organizationId ?? null,
        task_type: config.taskType,
        provider_config_id: config.providerConfigId,
        model_version: config.modelVersion,
        model_parameters: JSON.stringify(modelParametersPayload),
        is_active: this.convertBooleanValue(isActive),
        priority: config.priority || 1,
      };

      const savedConfig = await this.db
        .insertInto("ai_task_model_configs")
        .values(insertData)
        .onConflict((oc) => oc
          .columns(["user_id", "task_type", "priority"])
          .doUpdateSet({
            provider_config_id: (eb) => eb.ref("excluded.provider_config_id"),
            model_version: (eb) => eb.ref("excluded.model_version"),
            model_parameters: (eb) => eb.ref("excluded.model_parameters"),
            is_active: (eb) => eb.ref("excluded.is_active"),
            updated_at: this.getCurrentTimestamp(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      // Log configuration change
      await this.logConfigurationChange(
        config.userId,
        "task_model",
        savedConfig.id,
        "upsert",
        null,
        config,
      );

      logger.info("Task model configuration saved", {
        userId: String(config.userId),
        taskType: config.taskType,
        model: config.modelVersion,
        priority: config.priority,
      });

      return this.mapDbRowToTaskModelConfig(savedConfig);
    } catch (error) {
      logger.error("Failed to save task model configuration", {
        userId: config.userId,
        taskType: config.taskType,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Resolve a provider configuration identifier for task assignment.
   * Supports synthetic environment-backed IDs (e.g. "env-openai") by
   * locating or creating a persisted configuration for the current user.
   */
  private async resolveProviderConfigId(config: AITaskModelConfig, providerType: AIProviderType): Promise<number> {
    logger.debug('[AI Config] resolveProviderConfigId called', {
      requestedProvider: providerType,
      userId: String(config.userId),
      taskType: config.taskType,
      providedConfigId: config.providerConfigId
    });

    const numericId = typeof config.providerConfigId === "number"
      ? config.providerConfigId
      : Number(config.providerConfigId);

    if (Number.isFinite(numericId) && numericId > 0) {
      logger.debug('[AI Config] Using provided numeric config ID', { configId: numericId });
      return numericId;
    }

    // Attempt to reuse an existing active configuration for this provider type
    logger.debug('[AI Config] Looking for existing provider config', { providerType, userId: String(config.userId) });
    const existingConfig = await this.getProviderConfig(config.userId, providerType);
    if (existingConfig?.id) {
      logger.info('[AI Config] Found existing provider config', {
        configId: existingConfig.id,
        providerType: existingConfig.providerType,
        providerName: existingConfig.providerName
      });
      return existingConfig.id;
    }

    logger.warn('[AI Config] No existing provider config found, will create from environment', { providerType });

    // Fall back to environment key (if present) to materialize a stored configuration
    const envApiKey = this.getEnvironmentApiKey(providerType);
    const lmstudioEndpoint = providerType === "lmstudio"
      ? process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234"
      : undefined;

    // For LMStudio, we only need the endpoint URL, no API key required
    if (!envApiKey && !lmstudioEndpoint) {
      throw new Error("Provider configuration not found or not active, and no environment API key is configured");
    }

    const displayName = `${this.getProviderDisplayName(providerType)} (Environment)`;
    const defaultModel = this.getDefaultModelForProvider(providerType);

    const savedConfig = await this.saveProviderConfig({
      userId: config.userId,
      providerType,
      providerName: displayName,
      apiKey: envApiKey,
      endpointUrl: lmstudioEndpoint,
      isActive: true,
      isDefault: false,
      configuration: {
        model: defaultModel,
      },
    } as AIProviderConfig);

    if (!savedConfig.id) {
      throw new Error("Failed to persist provider configuration for task assignment");
    }

    return savedConfig.id;
  }

  private async determineProviderType(config: AITaskModelConfig): Promise<AIProviderType | undefined> {
    if (config.providerType) {
      return this.normalizeProviderType(config.providerType);
    }

    if (typeof config.providerConfigId === "string") {
      const envMatch = /^env-([a-z0-9-]+)/i.exec(config.providerConfigId);
      if (envMatch?.[1]) {
        return this.normalizeProviderType(envMatch[1]);
      }
    }

    const numericId = Number(config.providerConfigId);
    if (Number.isFinite(numericId) && numericId > 0) {
      const existing = await this.db
        .selectFrom("ai_provider_configs")
        .select("provider_type")
        .where("id", "=", numericId)
        .executeTakeFirst();

      if (existing?.provider_type) {
        return this.normalizeProviderType(existing.provider_type);
      }
    }

    return undefined;
  }

  private getProviderDisplayName(providerType: AIProviderType): string {
    switch (providerType) {
      case "openai":
        return "OpenAI";
      case "claude":
        return "Anthropic Claude";
      case "gemini":
        return "Google Gemini";
      case "grok":
        return "xAI Grok";
      case "openrouter":
        return "OpenRouter";
      case "lmstudio":
        return "Local LM Studio";
      case "rule-based":
      default:
        return "Rule-Based Engine";
    }
  }

  private getDefaultModelForProvider(providerType: AIProviderType): string {
    const presets = MODEL_PRESETS[providerType];
    if (!presets) {
      return "rule-based-v1";
    }

    const recommended = Object.entries(presets).find(([, preset]) => preset.tags?.includes("recommended"));
    if (recommended) {
      return recommended[0];
    }

    const [firstModel] = Object.keys(presets);
    return firstModel || "rule-based-v1";
  }

  /**
   * Get the best model configuration for a specific task
   */
  async getTaskModelConfig(userId: number, taskType: AITaskType): Promise<TaskModelSelection | null> {
    try {
      const row = await this.db
        .selectFrom("ai_task_model_configs as tmc")
        .innerJoin("ai_provider_configs as pc", "tmc.provider_config_id", "pc.id")
        .select([
          "tmc.id",
          "tmc.user_id",
          "tmc.organization_id",
          "tmc.task_type",
          "tmc.provider_config_id",
          "tmc.model_version",
          "tmc.model_parameters",
          "tmc.is_active",
          "tmc.priority",
          "tmc.created_at",
          "tmc.updated_at",
          "pc.provider_type",
          "pc.provider_name",
          "pc.encrypted_api_key",
          "pc.endpoint_url",
          "pc.configuration as provider_config",
        ])
        .where("tmc.user_id", "=", userId)
        .where("tmc.task_type", "=", taskType)
        .where("tmc.is_active", "=", this.convertBooleanValue(true))
        .where("pc.is_active", "=", this.convertBooleanValue(true))
        .orderBy("tmc.priority", "asc")
        .orderBy("tmc.created_at", "desc") // Use most recent when priorities are equal
        .executeTakeFirst();

      if (!row) {
        // Fallback to default provider
        return await this.getDefaultTaskModelConfig(userId, taskType);
      }

      const rowWithProvider = row as TaskModelSelectionRow;
      const taskConfig = this.mapDbRowToTaskModelConfig(rowWithProvider);

      let apiKey: string | undefined;
      if (rowWithProvider.encrypted_api_key) {
        apiKey = await encryptionService.decryptFromStorage(rowWithProvider.encrypted_api_key);
      }

      const selection: TaskModelSelection = {
        taskModelConfigId: taskConfig.id,
        providerConfigId: Number(taskConfig.providerConfigId),
        providerType: taskConfig.providerType
          ?? this.normalizeProviderType(rowWithProvider.provider_type),
        providerName: rowWithProvider.provider_name,
        modelVersion: taskConfig.modelVersion,
        modelParameters: taskConfig.modelParameters,
        apiKey,
        endpointUrl: rowWithProvider.endpoint_url ?? undefined,
        configuration: this.parseJsonObject(
          rowWithProvider.provider_config as unknown,
          {},
          { taskModelConfigId: rowWithProvider.id, field: "provider configuration" },
        ),
        priority: taskConfig.priority,
      };

      logger.debug("Retrieved task model configuration", {
        userId: String(userId),
        taskType,
        provider: selection.providerType,
        model: selection.modelVersion,
        priority: selection.priority,
      });

      return selection;
    } catch (error) {
      logger.error("Failed to get task model configuration", {
        userId,
        taskType,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get fallback configuration when no task-specific model is configured
   */
  private async getDefaultTaskModelConfig(userId: number, taskType: AITaskType): Promise<TaskModelSelection | null> {
    try {
      // Try to get default provider
      const providerConfigRow = await this.db
        .selectFrom("ai_provider_configs")
        .selectAll()
        .where("user_id", "=", userId)
        .where("is_active", "=", this.convertBooleanValue(true))
        .orderBy("is_default", "desc")
        .orderBy(sql`provider_type = 'rule-based'`, "desc")
        .executeTakeFirst();

      if (!providerConfigRow) {
        logger.warn("No AI provider configurations found for user", { userId: String(userId), taskType });
        return null;
      }

      const providerConfig = await this.mapDbRowToProviderConfig(providerConfigRow);
      if (!providerConfig.id) {
        logger.error("Provider configuration row missing identifier", {
          userId: String(userId),
          taskType,
        });
        return null;
      }

      const modelVersion = this.getDefaultModelForProvider(providerConfig.providerType);

      const selection: TaskModelSelection = {
        providerConfigId: providerConfig.id,
        providerType: providerConfig.providerType,
        providerName: providerConfig.providerName,
        modelVersion,
        modelParameters: {},
        apiKey: providerConfig.apiKey,
        endpointUrl: providerConfig.endpointUrl,
        configuration: providerConfig.configuration,
        priority: 999, // Low priority fallback
      };

      logger.info("Using default provider configuration for task", {
        userId: String(userId),
        taskType,
        provider: selection.providerType,
        model: selection.modelVersion,
      });

      return selection;
    } catch (error) {
      logger.error("Failed to get default task model configuration", {
        userId,
        taskType,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Discover available models for a provider. Falls back to curated lists when live discovery fails.
   */
  async listProviderModels(
    providerType: AIProviderType,
    options: { refresh?: boolean } = {},
  ): Promise<{ providerType: AIProviderType; models: ProviderModelInfo[]; source: "live" | "fallback" }> {
    const normalized = this.normalizeProviderType(providerType);
    const catalogId = PROVIDER_TO_CATALOG[normalized];

    if (!this.modelCatalogService || !catalogId) {
      return {
        providerType: normalized,
        models: this.getFallbackModels(normalized),
        source: "fallback",
      };
    }

    try {
      const catalogModels = await this.modelCatalogService.listModels(catalogId, { refresh: options.refresh });
      const mapped = catalogModels.map(model => this.mapModelInfoToProviderModelInfo(model, normalized));
      const merged = this.mergeFallbackModels(normalized, mapped);

      logger.debug("Discovered models for provider", {
        providerType: normalized,
        modelCount: merged.length,
        source: "live",
      });

      return {
        providerType: normalized,
        models: merged,
        source: "live",
      };
    } catch (error) {
      logger.warn("Dynamic model discovery failed, using fallback list", {
        providerType: normalized,
        error: error.message,
      });
      return {
        providerType: normalized,
        models: this.getFallbackModels(normalized),
        source: "fallback",
      };
    }
  }

  private mergeFallbackModels(providerType: AIProviderType, models: ProviderModelInfo[]): ProviderModelInfo[] {
    const existingIds = new Set(models.map(model => model.id));
    const merged = [...models];
    for (const fallbackModel of this.getFallbackModels(providerType)) {
      if (!existingIds.has(fallbackModel.id)) {
        merged.push({
          ...fallbackModel,
          tags: Array.from(new Set([...(fallbackModel.tags || []), "fallback"])),
        });
      }
    }

    return merged.sort((a, b) => {
      const preferred = (info: ProviderModelInfo) => (info.tags || []).includes("recommended") ? 0 : 1;
      const diff = preferred(a) - preferred(b);
      if (diff !== 0) {
        return diff;
      }

      const costA = (a.inputCostPer1K || 0) + (a.outputCostPer1K || 0);
      const costB = (b.inputCostPer1K || 0) + (b.outputCostPer1K || 0);

      if (costA !== costB) {
        if (costA === 0) return -1;
        if (costB === 0) return 1;
        return costA - costB;
      }

      return a.id.localeCompare(b.id);
    });
  }

  private mapModelInfoToProviderModelInfo(model: ModelInfo, providerType: AIProviderType): ProviderModelInfo {
    const preset = this.resolveModelPreset(providerType, model.id);
    const tags = new Set<string>();
    preset?.tags?.forEach(tag => tags.add(tag));
    if (model.supports) {
      model.supports.forEach(tag => tags.add(tag));
    }

    return {
      id: model.id,
      name: preset?.name || model.id,
      description: preset?.description || model.family,
      contextWindow: model.contextWindow || preset?.contextWindow,
      inputCostPer1K: preset?.inputCostPer1K,
      outputCostPer1K: preset?.outputCostPer1K,
      tags: Array.from(tags),
      providerType,
    };
  }

  private resolveModelPreset(providerType: AIProviderType, modelId: string): ModelPreset | undefined {
    const presets = MODEL_PRESETS[providerType];
    if (!presets) {
      return undefined;
    }

    const normalizedId = modelId.toLowerCase();
    if (presets[normalizedId]) {
      return presets[normalizedId];
    }

    const partialMatch = Object.entries(presets).find(([key]) => normalizedId.includes(key));
    return partialMatch ? partialMatch[1] : undefined;
  }

  private getFallbackModels(providerType: AIProviderType): ProviderModelInfo[] {
    const presets = MODEL_PRESETS[providerType] || {};
    return Object.entries(presets).map(([id, preset]) => ({
      id,
      name: preset.name || id,
      description: preset.description,
      contextWindow: preset.contextWindow,
      inputCostPer1K: preset.inputCostPer1K,
      outputCostPer1K: preset.outputCostPer1K,
      tags: preset.tags,
      providerType,
    }));
  }

  /**
   * Log AI usage for cost tracking and analytics
   */
  async logUsage(usage: AIUsageLog): Promise<void> {
    try {
      await sql`
        INSERT INTO ai_usage_logs (
          user_id, organization_id, provider_config_id, task_model_config_id,
          task_type, provider_type, model_version, prompt_tokens, completion_tokens,
          total_tokens, estimated_cost, request_type, session_id, execution_time_ms,
          success, error_message, records_processed, fields_analyzed
        ) VALUES (
          ${usage.userId}, ${usage.organizationId}, ${usage.providerConfigId},
          ${usage.taskModelConfigId}, ${usage.taskType}, ${usage.providerType},
          ${usage.modelVersion}, ${usage.promptTokens}, ${usage.completionTokens},
          ${usage.totalTokens}, ${usage.estimatedCost}, ${usage.requestType},
          ${usage.sessionId}, ${usage.executionTimeMs}, ${usage.success},
          ${usage.errorMessage}, ${usage.recordsProcessed}, ${usage.fieldsAnalyzed}
        )
      `.execute(this.db);

      logger.debug("AI usage logged", {
        userId: String(usage.userId),
        taskType: usage.taskType,
        provider: usage.providerType,
        tokens: usage.totalTokens,
        cost: usage.estimatedCost,
      });
    } catch (error) {
      logger.error("Failed to log AI usage", {
        userId: usage.userId,
        taskType: usage.taskType,
        error: error.message,
      });
      // Don't throw - usage logging failure shouldn't break the main flow
    }
  }

  /**
   * Get usage statistics for cost monitoring
   */
  async getUsageStats(userId: number, startDate?: Date, endDate?: Date): Promise<AIUsageStatsRow[]> {
    try {
      let query = sql`
        SELECT
          task_type,
          provider_type,
          model_version,
          COUNT(*) as request_count,
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          AVG(execution_time_ms) as avg_execution_time,
          SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count
        FROM ai_usage_logs
        WHERE user_id = ${userId}
      `;

      if (startDate) {
        query = sql`${query} AND created_at >= ${startDate}`;
      }

      if (endDate) {
        query = sql`${query} AND created_at <= ${endDate}`;
      }

      query = sql`
        ${query}
        GROUP BY task_type, provider_type, model_version
        ORDER BY total_cost DESC
      `;

      const result = await query.execute(this.db);
      return result.rows as AIUsageStatsRow[];
    } catch (error) {
      logger.error("Failed to get usage statistics", {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Test connection to AI provider
   */
  async testProviderConnection(config: AIProviderConfig): Promise<{ success: boolean; message: string; responseTime?: number }> {
    try {
      const startTime = Date.now();

      // For rule-based provider, always return success
      if (config.providerType === "rule-based") {
        return {
          success: true,
          message: "Rule-based provider is always available",
          responseTime: 1,
        };
      }

      // For LMStudio, test the endpoint
      if (config.providerType === "lmstudio") {
        const endpointUrl = config.endpointUrl || process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234";
        try {
          const response = await fetch(`${endpointUrl}/v1/models`, {
            method: "GET",
            signal: AbortSignal.timeout(5000),
          });

          const responseTime = Date.now() - startTime;

          if (response.ok) {
            return {
              success: true,
              message: "LMStudio connection successful",
              responseTime,
            };
          } else {
            return {
              success: false,
              message: `LMStudio returned ${response.status}: ${response.statusText}`,
            };
          }
        } catch (error) {
          return {
            success: false,
            message: `LMStudio connection failed: ${error.message}`,
          };
        }
      }

      // For cloud providers, test with a simple API call
      if (!config.apiKey) {
        return {
          success: false,
          message: "API key is required for cloud providers",
        };
      }

      if (config.providerType === "openai") {
        try {
          const response = await fetch("https://api.openai.com/v1/models", {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
            signal: AbortSignal.timeout(6000),
          });

          const responseTime = Date.now() - startTime;

          if (response.ok) {
            return {
              success: true,
              message: "OpenAI connection successful",
              responseTime,
            };
          }

          const errorBody = await response.text().catch(() => "");
          return {
            success: false,
            message: `OpenAI returned ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `OpenAI connection failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      if (config.providerType === "claude") {
        try {
          const claudeConfiguration = (config.configuration || {}) as {
            authMode?: ClaudeAuthMode;
          };
          const baseUrl = normalizeClaudeBaseUrl(
            config.endpointUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
          );
          const response = await fetch(`${baseUrl}/models`, {
            method: "GET",
            headers: buildClaudeHeaders(config.apiKey, {
              baseURL: baseUrl,
              authMode: claudeConfiguration.authMode
                ?? (process.env.ANTHROPIC_AUTH_MODE as ClaudeAuthMode | undefined),
            }),
            signal: AbortSignal.timeout(6000),
          });

          const responseTime = Date.now() - startTime;

          if (response.ok) {
            return {
              success: true,
              message: "Anthropic Claude connection successful",
              responseTime,
            };
          }

          const errorBody = await response.text().catch(() => "");
          return {
            success: false,
            message: `Anthropic returned ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `Anthropic connection failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      if (config.providerType === "openrouter") {
        try {
          const baseUrl = normalizeOpenRouterBaseUrl(
            config.endpointUrl || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
          );
          const modelsUrl = `${baseUrl}/models`;
          const response = await fetch(modelsUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
            signal: AbortSignal.timeout(6000),
          });

          const responseTime = Date.now() - startTime;

          if (response.ok) {
            return {
              success: true,
              message: "OpenRouter connection successful",
              responseTime,
            };
          }

          const errorBody = await response.text().catch(() => "");
          return {
            success: false,
            message: `OpenRouter returned ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
          };
        } catch (error) {
          return {
            success: false,
            message: `OpenRouter connection failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      // Default to simulated success for other providers until endpoints are implemented
      const responseTime = Date.now() - startTime;
      return {
        success: true,
        message: `${config.providerName} connection test simulated (implement actual API test)`,
        responseTime,
      };

    } catch (error) {
      logger.error("Provider connection test failed", {
        provider: config.providerType,
        error: error.message,
      });

      return {
        success: false,
        message: `Connection test failed: ${error.message}`,
      };
    }
  }

  /**
   * Helper methods for database mapping
   */
  private async mapDbRowToProviderConfig(row: AIProviderConfigRow): Promise<AIProviderConfig> {
    const configuration = this.parseJsonObject(
      row.configuration as unknown,
      {},
      { configId: row.id, field: "provider configuration" },
    );

    const config: AIProviderConfig = {
      id: Number(row.id),
      userId: Number(row.user_id),
      organizationId: row.organization_id ?? undefined,
      providerType: this.normalizeProviderType(row.provider_type),
      providerName: row.provider_name,
      endpointUrl: row.endpoint_url ?? undefined,
      isActive: this.normalizeBoolean(row.is_active, true),
      isDefault: this.normalizeBoolean(row.is_default),
      configuration,
      hasApiKey: Boolean(row.encrypted_api_key),
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    };

    if (row.encrypted_api_key) {
      try {
        config.apiKey = await encryptionService.decryptFromStorage(row.encrypted_api_key);
      } catch (error) {
        logger.error("Failed to decrypt API key", {
          configId: row.id,
          error: (error as Error).message,
        });
      }
    }

    if (!config.apiKey) {
      const envApiKey = this.getEnvironmentApiKey(config.providerType);
      if (envApiKey) {
        config.apiKey = envApiKey;
        config.hasApiKey = true;
        logger.debug("Using environment API key fallback for provider", {
          providerType: config.providerType,
          configId: config.id,
        });
      }
    }

    return config;
  }

  private getEnvironmentApiKey(providerType: AIProviderType): string | undefined {
    switch (providerType) {
      case "openai":
        return process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_FALLBACK;
      case "claude":
        return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      case "gemini":
        return process.env.GEMINI_API_KEY;
      case "grok":
        return process.env.GROK_API_KEY || process.env.XAI_GROK_API_KEY || process.env.XAI_API_KEY;
      case "openrouter":
        return process.env.OPENROUTER_API_KEY;
      default:
        return undefined;
    }
  }

  private mapDbRowToTaskModelConfig(row: AITaskModelConfigRow | TaskModelSelectionRow): AITaskModelConfig {
    const modelParameters = this.parseModelParameters(
      row.model_parameters as unknown,
      { taskModelConfigId: row.id, field: "model parameters" },
    );

    const config: AITaskModelConfig = {
      id: row.id ? Number(row.id) : undefined,
      userId: Number(row.user_id),
      organizationId: row.organization_id ?? undefined,
      taskType: row.task_type as AITaskType,
      providerConfigId: Number(row.provider_config_id),
      modelVersion: row.model_version,
      modelParameters,
      isActive: this.normalizeBoolean(row.is_active, true),
      priority: row.priority ?? 1,
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    };

    if ("provider_type" in row && typeof row.provider_type === "string") {
      config.providerType = this.normalizeProviderType(row.provider_type);
    }

    return config;
  }

  /**
   * Log configuration changes for audit trail
   */
  private async logConfigurationChange(
    userId: number,
    configType: "provider" | "task_model",
    configId: number,
    action: string,
    oldValues: unknown,
    newValues: unknown,
  ): Promise<void> {
    try {
      await sql`
        INSERT INTO ai_config_audit_log (
          user_id, config_type, config_id, action, old_values, new_values
        ) VALUES (
          ${userId}, ${configType}, ${configId}, ${action},
          ${oldValues ? JSON.stringify(oldValues) : null},
          ${newValues ? JSON.stringify(newValues) : null}
        )
      `.execute(this.db);
    } catch (error) {
      logger.error("Failed to log configuration change", {
        userId,
        configType,
        configId,
        action,
        error: error.message,
      });
      // Don't throw - audit logging failure shouldn't break the main flow
    }
  }
}
