/**
 * Vector Store Service - Phase 4 AI Accuracy Improvements
 * In-memory vector database for storing and retrieving field mapping embeddings
 */

import { logger } from '../../../utils/Logger';
import type { IVectorStore, StoredMapping, RetrievalResult, MappingEmbedding, KnowledgeBaseStats } from './types';
import type { IEmbeddingService } from './types';

export interface VectorStoreConfig {
  maxSize?: number; // Maximum number of mappings to store
  embeddingService: IEmbeddingService; // Required for similarity calculations
}

/**
 * In-memory vector store implementation
 * For production, consider using ChromaDB or Pinecone
 */
export class VectorStoreService implements IVectorStore {
  private mappings = new Map<string, StoredMapping>();
  private embeddings = new Map<string, number[]>();
  private config: Required<VectorStoreConfig>;
  private logger = logger;

  constructor(config: VectorStoreConfig) {
    this.config = {
      maxSize: config.maxSize ?? 10000,
      embeddingService: config.embeddingService
    };
  }

  /**
   * Store a single mapping with its embedding
   */
  async store(mapping: StoredMapping, embedding: number[]): Promise<void> {
    // Enforce size limit (LRU-style eviction)
    if (this.mappings.size >= this.config.maxSize && !this.mappings.has(mapping.id)) {
      await this.evictOldest();
    }

    this.mappings.set(mapping.id, mapping);
    this.embeddings.set(mapping.id, embedding);

    this.logger.debug('Stored mapping in vector store', {
      mappingId: mapping.id,
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      embeddingDim: embedding.length
    });
  }

  /**
   * Store multiple mappings in batch
   */
  async storeBatch(mappings: StoredMapping[], embeddings: number[][]): Promise<void> {
    if (mappings.length !== embeddings.length) {
      throw new Error('Mappings and embeddings arrays must have the same length');
    }

    for (let i = 0; i < mappings.length; i++) {
      await this.store(mappings[i], embeddings[i]);
    }

    this.logger.info('Stored batch of mappings in vector store', {
      count: mappings.length
    });
  }

  /**
   * Retrieve similar mappings using vector similarity search
   */
  async retrieve(
    queryEmbedding: number[],
    topK: number,
    filters?: {
      sourceSystem?: string;
      targetSystem?: string;
      minConfidence?: number;
    }
  ): Promise<RetrievalResult[]> {
    const results: { mapping: StoredMapping; similarity: number }[] = [];

    // Calculate similarity for all mappings (with optional filtering)
    for (const [mappingId, mapping] of this.mappings.entries()) {
      // Apply filters
      if (filters?.sourceSystem && mapping.sourceSystem !== filters.sourceSystem) {
        continue;
      }
      if (filters?.targetSystem && mapping.targetSystem !== filters.targetSystem) {
        continue;
      }
      if (filters?.minConfidence && mapping.confidence < filters.minConfidence) {
        continue;
      }

      // Calculate similarity
      const embedding = this.embeddings.get(mappingId);
      if (!embedding) {
        this.logger.warn('Missing embedding for mapping', { mappingId });
        continue;
      }

      const similarity = this.config.embeddingService.similarity(queryEmbedding, embedding);
      results.push({ mapping, similarity });
    }

    // Sort by similarity (descending) and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, topK);

    // Convert to RetrievalResult format with rank
    const retrievalResults: RetrievalResult[] = topResults.map((result, index) => ({
      mapping: result.mapping,
      similarity: result.similarity,
      rank: index + 1
    }));

    this.logger.debug('Retrieved similar mappings', {
      queryDim: queryEmbedding.length,
      totalCandidates: this.mappings.size,
      filteredCandidates: results.length,
      topK,
      resultsReturned: retrievalResults.length
    });

    return retrievalResults;
  }

  /**
   * Get mapping by ID
   */
  async getById(id: string): Promise<StoredMapping | null> {
    return this.mappings.get(id) || null;
  }

  /**
   * Delete a mapping
   */
  async delete(id: string): Promise<void> {
    this.mappings.delete(id);
    this.embeddings.delete(id);
    this.logger.debug('Deleted mapping from vector store', { mappingId: id });
  }

  /**
   * Clear all mappings
   */
  async clear(): Promise<void> {
    this.mappings.clear();
    this.embeddings.clear();
    this.logger.info('Cleared vector store');
  }

  /**
   * Get knowledge base statistics
   */
  async getStats(): Promise<KnowledgeBaseStats> {
    const mappingsArray = Array.from(this.mappings.values());

    // Count by source system
    const bySourceSystem: Record<string, number> = {};
    const byTargetSystem: Record<string, number> = {};
    let totalConfidence = 0;

    for (const mapping of mappingsArray) {
      // Count by source system
      bySourceSystem[mapping.sourceSystem] = (bySourceSystem[mapping.sourceSystem] || 0) + 1;

      // Count by target system
      byTargetSystem[mapping.targetSystem] = (byTargetSystem[mapping.targetSystem] || 0) + 1;

      // Sum confidence
      totalConfidence += mapping.confidence;
    }

    // Calculate average confidence
    const averageConfidence = mappingsArray.length > 0 ? totalConfidence / mappingsArray.length : 0;

    // Get most used mappings (top 10)
    const mostUsedMappings = mappingsArray
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 10);

    return {
      totalMappings: this.mappings.size,
      bySourceSystem,
      byTargetSystem,
      averageConfidence,
      mostUsedMappings
    };
  }

  /**
   * Evict the oldest mapping (least recently used)
   */
  private async evictOldest(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = new Date();

    for (const [id, mapping] of this.mappings.entries()) {
      const lastUsed = mapping.lastUsedAt || mapping.createdAt;
      if (lastUsed < oldestTime) {
        oldestTime = lastUsed;
        oldestId = id;
      }
    }

    if (oldestId) {
      await this.delete(oldestId);
      this.logger.debug('Evicted oldest mapping due to size limit', {
        mappingId: oldestId,
        lastUsedAt: oldestTime
      });
    }
  }

  /**
   * Get vector store size
   */
  getSize(): number {
    return this.mappings.size;
  }

  /**
   * Get maximum size
   */
  getMaxSize(): number {
    return this.config.maxSize;
  }

  /**
   * Update mapping usage statistics
   */
  async updateUsage(id: string): Promise<void> {
    const mapping = this.mappings.get(id);
    if (mapping) {
      mapping.usageCount++;
      mapping.lastUsedAt = new Date();
      this.mappings.set(id, mapping);

      this.logger.debug('Updated mapping usage', {
        mappingId: id,
        usageCount: mapping.usageCount
      });
    }
  }

  /**
   * Find mappings by source field pattern
   */
  async findBySourceField(pattern: string): Promise<StoredMapping[]> {
    const results: StoredMapping[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const mapping of this.mappings.values()) {
      if (mapping.sourceField.toLowerCase().includes(lowerPattern)) {
        results.push(mapping);
      }
    }

    return results;
  }

  /**
   * Find mappings by target field pattern
   */
  async findByTargetField(pattern: string): Promise<StoredMapping[]> {
    const results: StoredMapping[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const mapping of this.mappings.values()) {
      if (mapping.targetField.toLowerCase().includes(lowerPattern)) {
        results.push(mapping);
      }
    }

    return results;
  }

  /**
   * Get all mappings (useful for debugging/export)
   */
  async getAllMappings(): Promise<StoredMapping[]> {
    return Array.from(this.mappings.values());
  }

  /**
   * Export vector store to JSON (for persistence/backup)
   */
  async exportToJSON(): Promise<string> {
    const data = {
      mappings: Array.from(this.mappings.entries()),
      embeddings: Array.from(this.embeddings.entries()),
      exportedAt: new Date().toISOString()
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Import vector store from JSON (for persistence/restoration)
   */
  async importFromJSON(json: string): Promise<void> {
    try {
      const data = JSON.parse(json);

      if (!data.mappings || !data.embeddings) {
        throw new Error('Invalid JSON format: missing mappings or embeddings');
      }

      // Clear existing data
      await this.clear();

      // Import mappings
      for (const [id, mapping] of data.mappings) {
        this.mappings.set(id, mapping);
      }

      // Import embeddings
      for (const [id, embedding] of data.embeddings) {
        this.embeddings.set(id, embedding);
      }

      this.logger.info('Imported vector store from JSON', {
        mappingsCount: this.mappings.size,
        embeddingsCount: this.embeddings.size,
        exportedAt: data.exportedAt
      });
    } catch (error) {
      this.logger.error('Failed to import vector store from JSON', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
