/**
 * Mapping Knowledge Base - Phase 4 AI Accuracy Improvements
 * High-level service for storing and retrieving field mappings using RAG
 */

import { uuidv4 } from '../../../utils/uuid';
import { logger } from '../../../utils/Logger';
import type { IEmbeddingService, IVectorStore, StoredMapping, RetrievalResult, RAGContext, RAGConfig, KnowledgeBaseStats } from './types';
import type { AISuggestion } from '../providers/types';

export interface MappingInput {
  sourceField: string;
  targetField: string;
  sourceSystem: string;
  targetSystem: string;
  transformationType: string;
  confidence: number;
  reasoning?: string;
  sourceFieldType?: string;
  targetFieldType?: string;
  sampleValues?: string[];
  wasValidated?: boolean;
  validationScore?: number;
}

/**
 * Mapping Knowledge Base - Stores and retrieves field mappings using RAG
 */
export class MappingKnowledgeBase {
  private embeddingService: IEmbeddingService;
  private vectorStore: IVectorStore;
  private config: Required<RAGConfig>;
  private logger = logger;

  constructor(
    embeddingService: IEmbeddingService,
    vectorStore: IVectorStore,
    config: RAGConfig = {}
  ) {
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
    this.config = {
      enabled: config.enabled ?? true,
      topK: config.topK ?? 5,
      minSimilarity: config.minSimilarity ?? 0.7,
      minConfidenceToStore: config.minConfidenceToStore ?? 0.75,
      useOpenAIEmbeddings: config.useOpenAIEmbeddings ?? false,
      vectorStoreType: config.vectorStoreType ?? 'memory',
      vectorStoreUrl: config.vectorStoreUrl ?? '',
      embeddingModel: config.embeddingModel ?? 'text-embedding-3-small',
      cacheEmbeddings: config.cacheEmbeddings ?? true
    };
  }

  /**
   * Add a mapping to the knowledge base
   */
  async addMapping(input: MappingInput): Promise<string> {
    // Check if confidence meets threshold
    if (input.confidence < this.config.minConfidenceToStore) {
      this.logger.debug('Mapping confidence below storage threshold', {
        confidence: input.confidence,
        threshold: this.config.minConfidenceToStore
      });
      throw new Error(`Mapping confidence (${input.confidence}) below storage threshold (${this.config.minConfidenceToStore})`);
    }

    // Create stored mapping
    const mapping: StoredMapping = {
      id: uuidv4(),
      sourceField: input.sourceField,
      targetField: input.targetField,
      sourceSystem: input.sourceSystem,
      targetSystem: input.targetSystem,
      transformationType: input.transformationType,
      confidence: input.confidence,
      reasoning: input.reasoning,
      sourceFieldType: input.sourceFieldType,
      targetFieldType: input.targetFieldType,
      sampleValues: input.sampleValues,
      wasValidated: input.wasValidated ?? false,
      validationScore: input.validationScore,
      createdAt: new Date(),
      usageCount: 0
    };

    // Generate text representation for embedding
    const text = this.mappingToText(mapping);

    // Generate embedding
    const embedding = await this.embeddingService.embed(text);

    // Store in vector store
    await this.vectorStore.store(mapping, embedding);

    this.logger.info('Added mapping to knowledge base', {
      mappingId: mapping.id,
      sourceField: input.sourceField,
      targetField: input.targetField,
      confidence: input.confidence
    });

    return mapping.id;
  }

  /**
   * Add multiple mappings in batch
   */
  async addMappingBatch(inputs: MappingInput[]): Promise<string[]> {
    const ids: string[] = [];

    for (const input of inputs) {
      try {
        const id = await this.addMapping(input);
        ids.push(id);
      } catch (error) {
        this.logger.warn('Failed to add mapping to batch', {
          error: error instanceof Error ? error.message : String(error),
          sourceField: input.sourceField,
          targetField: input.targetField
        });
      }
    }

    this.logger.info('Added batch of mappings to knowledge base', {
      total: inputs.length,
      successful: ids.length,
      failed: inputs.length - ids.length
    });

    return ids;
  }

  /**
   * Find similar mappings for a given field mapping context
   */
  async findSimilarMappings(
    sourceField: string,
    sourceSystem: string,
    targetSystem: string,
    context?: {
      sourceFieldType?: string;
      targetFieldType?: string;
      sampleValues?: string[];
    }
  ): Promise<RetrievalResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    // Build query text
    const queryText = this.buildQueryText(sourceField, sourceSystem, targetSystem, context);

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.embed(queryText);

    // Retrieve similar mappings
    const results = await this.vectorStore.retrieve(
      queryEmbedding,
      this.config.topK,
      {
        sourceSystem,
        targetSystem,
        minConfidence: this.config.minConfidenceToStore
      }
    );

    // Filter by minimum similarity threshold
    const filteredResults = results.filter(result => result.similarity >= this.config.minSimilarity);

    // Update usage statistics for retrieved mappings
    for (const result of filteredResults) {
      await this.vectorStore.updateUsage(result.mapping.id);
    }

    this.logger.debug('Retrieved similar mappings', {
      sourceField,
      sourceSystem,
      targetSystem,
      resultsFound: results.length,
      resultsAfterFiltering: filteredResults.length,
      minSimilarity: this.config.minSimilarity
    });

    return filteredResults;
  }

  /**
   * Build RAG context for AI prompt injection
   */
  async buildRAGContext(
    sourceField: string,
    sourceSystem: string,
    targetSystem: string,
    context?: {
      sourceFieldType?: string;
      targetFieldType?: string;
      sampleValues?: string[];
    }
  ): Promise<RAGContext> {
    const startTime = Date.now();

    const similarMappings = await this.findSimilarMappings(
      sourceField,
      sourceSystem,
      targetSystem,
      context
    );

    const retrievalTime = Date.now() - startTime;

    const embeddingMethod = this.config.useOpenAIEmbeddings ? 'openai' : 'local';

    return {
      similarMappings,
      retrievalTime,
      embeddingMethod
    };
  }

  /**
   * Convert AI suggestions to stored mappings and add to knowledge base
   */
  async learnFromSuggestions(
    suggestions: AISuggestion[],
    sourceSystem: string,
    targetSystem: string,
    validated = false,
    validationScore?: number
  ): Promise<string[]> {
    const inputs: MappingInput[] = suggestions.map(suggestion => ({
      sourceField: suggestion.sourceField,
      targetField: suggestion.targetField,
      sourceSystem,
      targetSystem,
      transformationType: suggestion.transformationType,
      confidence: suggestion.confidence || 0.8,
      reasoning: suggestion.reasoning,
      sourceFieldType: (suggestion as any).sourceFieldType,
      targetFieldType: (suggestion as any).targetFieldType,
      sampleValues: (suggestion as any).sampleValues,
      wasValidated: validated,
      validationScore
    }));

    return this.addMappingBatch(inputs);
  }

  /**
   * Get knowledge base statistics
   */
  async getStats(): Promise<KnowledgeBaseStats> {
    return this.vectorStore.getStats();
  }

  /**
   * Clear knowledge base
   */
  async clear(): Promise<void> {
    await this.vectorStore.clear();
    this.logger.info('Cleared mapping knowledge base');
  }

  /**
   * Get mapping by ID
   */
  async getMappingById(id: string): Promise<StoredMapping | null> {
    return this.vectorStore.getById(id);
  }

  /**
   * Delete mapping by ID
   */
  async deleteMapping(id: string): Promise<void> {
    await this.vectorStore.delete(id);
    this.logger.info('Deleted mapping from knowledge base', { mappingId: id });
  }

  /**
   * Export knowledge base to JSON
   */
  async export(): Promise<string> {
    return this.vectorStore.exportToJSON();
  }

  /**
   * Import knowledge base from JSON
   */
  async import(json: string): Promise<void> {
    await this.vectorStore.importFromJSON(json);
    this.logger.info('Imported mapping knowledge base from JSON');
  }

  /**
   * Convert mapping to text representation for embedding
   */
  private mappingToText(mapping: StoredMapping): string {
    const parts: string[] = [];

    // Core mapping info
    parts.push(`Source: ${mapping.sourceSystem} field "${mapping.sourceField}"`);
    parts.push(`Target: ${mapping.targetSystem} field "${mapping.targetField}"`);
    parts.push(`Transformation: ${mapping.transformationType}`);

    // Field types
    if (mapping.sourceFieldType) {
      parts.push(`Source type: ${mapping.sourceFieldType}`);
    }
    if (mapping.targetFieldType) {
      parts.push(`Target type: ${mapping.targetFieldType}`);
    }

    // Sample values
    if (mapping.sampleValues && mapping.sampleValues.length > 0) {
      parts.push(`Sample values: ${mapping.sampleValues.slice(0, 3).join(', ')}`);
    }

    // Reasoning
    if (mapping.reasoning) {
      parts.push(`Reasoning: ${mapping.reasoning}`);
    }

    return parts.join('. ');
  }

  /**
   * Build query text for similarity search
   */
  private buildQueryText(
    sourceField: string,
    sourceSystem: string,
    targetSystem: string,
    context?: {
      sourceFieldType?: string;
      targetFieldType?: string;
      sampleValues?: string[];
    }
  ): string {
    const parts: string[] = [];

    parts.push(`Source: ${sourceSystem} field "${sourceField}"`);
    parts.push(`Target system: ${targetSystem}`);

    if (context?.sourceFieldType) {
      parts.push(`Source type: ${context.sourceFieldType}`);
    }

    if (context?.targetFieldType) {
      parts.push(`Target type: ${context.targetFieldType}`);
    }

    if (context?.sampleValues && context.sampleValues.length > 0) {
      parts.push(`Sample values: ${context.sampleValues.slice(0, 3).join(', ')}`);
    }

    return parts.join('. ');
  }

  /**
   * Get configuration
   */
  getConfig(): Required<RAGConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RAGConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Updated RAG configuration', { config });
  }
}
