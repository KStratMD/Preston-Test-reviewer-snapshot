/**
 * Base Agent Implementation - Common functionality for all AI agents
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { logger, type Logger } from '../../../utils/Logger';
import type {
  Agent,
  AgentExecutionContext,
  AgentResult,
  AgentSchema
} from './interfaces';
import { getElapsedMs } from './timing';

export interface BaseAgentConfig {
  name: string;
  version: string;
  capabilities: string[];
  dependencies: string[];
  maxExecutionTime?: number;
  confidenceThreshold?: number;
  enableValidation?: boolean;
}

export abstract class BaseAgent implements Agent {
  public readonly name: string;
  public readonly version: string;
  public readonly capabilities: string[];
  public readonly dependencies: string[];

  protected config: BaseAgentConfig;
  protected logger: Logger;

  constructor(config: BaseAgentConfig, logger?: Logger) {
    this.config = {
      maxExecutionTime: 30000, // 30 seconds default
      confidenceThreshold: 0.5,
      enableValidation: true,
      ...config
    };

    this.name = config.name;
    this.version = config.version;
    this.capabilities = config.capabilities;
    this.dependencies = config.dependencies;
    this.logger = logger || console as any;

    this.validateConfig();
  }

  /**
   * Execute the agent with the given context and input
   */
  async execute(context: AgentExecutionContext, input: unknown): Promise<AgentResult> {
    const executionId = `${this.name}-${Date.now()}`;
    const startTime = Date.now();
    this.logger.debug(`Starting execution for agent: ${this.name}`, { executionId });

    try {
      this.validateExecutionContext(context);

      // Validate input
      const isValidInput = await this.validateInput(input);
      if (!isValidInput) {
        this.logger.warn(`Input validation failed for agent: ${this.name}`, { executionId });
        throw new Error('Input validation failed');
      }

      // Create execution timeout
      const timeoutPromise = new Promise<AgentResult>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Agent execution timeout after ${context.maxExecutionTime}ms`)),
          context.maxExecutionTime
        );
      });

      const executionPromise = this.executeInternal(context, input);
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // Validate output if enabled
      if (this.config.enableValidation && result.data) {
        const isValidOutput = await this.validateOutput(result.data);
        if (!isValidOutput) {
          result.warnings = result.warnings || [];
          result.warnings.push('Output validation failed');
        }
      }

      // Apply confidence threshold
      if (result.confidence < (context.confidenceThreshold || this.config.confidenceThreshold!)) {
        result.warnings = result.warnings || [];
        result.warnings.push(`Confidence ${result.confidence} below threshold`);
      }

      // Calculate execution time
      result.executionTime = getElapsedMs(startTime);

      this.logger.info('Agent execution completed', {
        agent: this.name,
        executionId,
        sessionId: context.sessionId,
        success: result.success,
        confidence: result.confidence,
        executionTime: result.executionTime
      });

      return result;

    } catch (error) {
      const executionTime = getElapsedMs(startTime);

      this.logger.error('Agent execution failed', {
        agent: this.name,
        executionId,
        sessionId: context.sessionId,
        error: String(error),
        executionTime
      });

      return {
        success: false,
        confidence: 0,
        reasoning: `Agent execution failed: ${error}`,
        errors: [String(error)],
        executionTime,
        hallucination_risk: 'high',
        governance_flags: ['execution_failure']
      };
    }
  }

  /**
   * Validate input data - override in subclasses for specific validation
   */
  async validateInput(input: unknown): Promise<boolean> {
    try {
      // Basic validation - check if input is provided
      if (input === null || input === undefined) {
        return false;
      }

      // Delegate to specific validation
      return await this.validateInputInternal(input);

    } catch (error) {
      this.logger.warn('Input validation error', {
        agent: this.name,
        error: String(error)
      });
      return false;
    }
  }

  /**
   * Get agent schema - override in subclasses
   */
  abstract getSchema(): AgentSchema;

  /**
   * Internal execution logic - implement in subclasses
   */
  protected abstract executeInternal(
    context: AgentExecutionContext,
    input: unknown
  ): Promise<AgentResult>;

  /**
   * Internal input validation - implement in subclasses
   */
  protected abstract validateInputInternal(input: unknown): Promise<boolean>;

  /**
   * Validate output data - override in subclasses for specific validation
   */
  protected async validateOutput(output: unknown): Promise<boolean> {
    try {
      // Basic validation - check if output is provided
      if (output === null || output === undefined) {
        return false;
      }

      return true;

    } catch (error) {
      this.logger.warn('Output validation error', {
        agent: this.name,
        error: String(error)
      });
      return false;
    }
  }

  /**
   * Create a standard success result
   */
  protected createSuccessResult(
    data: unknown,
    confidence: number,
    reasoning: string
  ): AgentResult {
    return {
      success: true,
      data,
      confidence: Math.max(0, Math.min(1, confidence)), // Clamp to 0-1
      reasoning,
      executionTime: 0, // Will be set by execute method
      hallucination_risk: this.assessHallucinationRisk(confidence),
      governance_flags: []
    };
  }

  /**
   * Create a standard error result
   */
  protected createErrorResult(
    error: string,
    details?: string[]
  ): AgentResult {
    return {
      success: false,
      confidence: 0,
      reasoning: `Agent failed: ${error}`,
      errors: [error, ...(details || [])],
      executionTime: 0, // Will be set by execute method
      hallucination_risk: 'high',
      governance_flags: ['execution_failure']
    };
  }

  /**
   * Create a partial success result (with warnings)
   */
  protected createPartialResult(
    data: unknown,
    confidence: number,
    reasoning: string,
    warnings: string[]
  ): AgentResult {
    return {
      success: true,
      data,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning,
      warnings,
      executionTime: 0,
      hallucination_risk: this.assessHallucinationRisk(confidence),
      governance_flags: warnings.length > 0 ? ['partial_success'] : []
    };
  }

  /**
   * Assess hallucination risk based on confidence and other factors
   */
  protected assessHallucinationRisk(confidence: number): 'low' | 'medium' | 'high' {
    if (confidence >= 0.8) {
      return 'low';
    } else if (confidence >= 0.5) {
      return 'medium';
    } else {
      return 'high';
    }
  }

  /**
   * Check if agent has specific capability
   */
  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability);
  }

  /**
   * Check if all dependencies are met
   */
  checkDependencies(availableAgents: string[]): boolean {
    return this.dependencies.every(dep => availableAgents.includes(dep));
  }

  /**
   * Get agent metadata
   */
  getMetadata(): {
    name: string;
    version: string;
    capabilities: string[];
    dependencies: string[];
    maxExecutionTime: number;
    confidenceThreshold: number;
  } {
    return {
      name: this.name,
      version: this.version,
      capabilities: this.capabilities,
      dependencies: this.dependencies,
      maxExecutionTime: this.config.maxExecutionTime!,
      confidenceThreshold: this.config.confidenceThreshold!
    };
  }

  /**
   * Utility method to safely extract nested properties
   */
  protected safeGet(obj: unknown, path: string, defaultValue?: unknown): unknown {
    try {
      return path.split('.').reduce((current: unknown, key) => {
        const record = current as Record<string, unknown> | null | undefined;
        return record && record[key] !== undefined ? record[key] : defaultValue;
      }, obj);
    } catch {
      return defaultValue;
    }
  }

  /**
   * Utility method to calculate confidence based on multiple factors
   */
  protected calculateConfidence(factors: {
    factor: string;
    value: number;
    weight: number;
  }[]): number {
    if (factors.length === 0) return 0;

    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    if (totalWeight === 0) return 0;

    const weightedSum = factors.reduce((sum, f) => sum + (f.value * f.weight), 0);
    return Math.max(0, Math.min(1, weightedSum / totalWeight));
  }

  /**
   * Utility method to merge reasoning from multiple sources
   */
  protected mergeReasoning(reasoningParts: string[]): string {
    return reasoningParts
      .filter(part => part && part.trim().length > 0)
      .map((part, index) => `${index + 1}. ${part}`)
      .join(' ');
  }

  /**
   * Utility method to format error messages consistently
   */
  protected formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    } else if (typeof error === 'string') {
      return error;
    } else {
      return String(error);
    }
  }

  // Private methods

  private validateConfig(): void {
    if (!this.config.name || typeof this.config.name !== 'string') {
      throw new Error('Agent must have a valid name');
    }

    if (!this.config.version || typeof this.config.version !== 'string') {
      throw new Error('Agent must have a valid version');
    }

    if (!Array.isArray(this.config.capabilities)) {
      throw new Error('Agent must have a capabilities array');
    }

    if (!Array.isArray(this.config.dependencies)) {
      throw new Error('Agent must have a dependencies array');
    }

    if (this.config.maxExecutionTime &&
        (typeof this.config.maxExecutionTime !== 'number' || this.config.maxExecutionTime <= 0)) {
      throw new Error('maxExecutionTime must be a positive number');
    }

    if (this.config.confidenceThreshold &&
        (typeof this.config.confidenceThreshold !== 'number' ||
         this.config.confidenceThreshold < 0 || this.config.confidenceThreshold > 1)) {
      throw new Error('confidenceThreshold must be a number between 0 and 1');
    }
  }

  private validateExecutionContext(context: AgentExecutionContext): void {
    if (!context.sessionId) {
      throw new Error('Execution context must have a sessionId');
    }

    if (!context.sourceSystem || !context.targetSystem) {
      throw new Error('Execution context must have sourceSystem and targetSystem');
    }

    if (typeof context.confidenceThreshold !== 'number' ||
        context.confidenceThreshold < 0 || context.confidenceThreshold > 1) {
      throw new Error('confidenceThreshold must be a number between 0 and 1');
    }

    if (typeof context.maxExecutionTime !== 'number' || context.maxExecutionTime <= 0) {
      throw new Error('maxExecutionTime must be a positive number');
    }
  }
}
