/**
 * RAG (Retrieval-Augmented Generation) Types - Phase 4 AI Accuracy Improvements
 * Type definitions for vector-based knowledge retrieval system
 */

import type { AISuggestion } from '../providers/types';

/**
 * A stored mapping in the knowledge base
 */
export interface StoredMapping {
  id: string;
  sourceField: string;
  targetField: string;
  sourceSystem: string;
  targetSystem: string;
  transformationType: string;
  confidence: number;
  reasoning?: string;

  // Metadata for retrieval
  sourceFieldType?: string;
  targetFieldType?: string;
  sampleValues?: string[];

  // Validation info
  wasValidated: boolean;
  validationScore?: number;

  // Timestamps
  createdAt: Date;
  usageCount: number;
  lastUsedAt?: Date;
}

/**
 * Vector embedding for a mapping
 */
export interface MappingEmbedding {
  mappingId: string;
  vector: number[];
  metadata: {
    sourceField: string;
    targetField: string;
    sourceSystem: string;
    targetSystem: string;
    confidence: number;
  };
}

/**
 * Retrieval result with similarity score
 */
export interface RetrievalResult {
  mapping: StoredMapping;
  similarity: number;
  rank: number;
}

/**
 * RAG configuration
 */
export interface RAGConfig {
  // Enable RAG
  enabled?: boolean;

  // Number of similar mappings to retrieve
  topK?: number;

  // Minimum similarity threshold (0-1)
  minSimilarity?: number;

  // Minimum confidence to store in knowledge base
  minConfidenceToStore?: number;

  // Use OpenAI embeddings (requires API key)
  useOpenAIEmbeddings?: boolean;

  // Vector store type
  vectorStoreType?: 'memory' | 'chromadb' | 'pinecone';

  // Vector store connection string (for ChromaDB, Pinecone, etc.)
  vectorStoreUrl?: string;

  // Embedding model
  embeddingModel?: string;

  // Cache embeddings
  cacheEmbeddings?: boolean;
}

/**
 * RAG context to inject into AI prompts
 */
export interface RAGContext {
  similarMappings: RetrievalResult[];
  retrievalTime: number;
  embeddingMethod: 'openai' | 'local' | 'none';
}

/**
 * Knowledge base statistics
 */
export interface KnowledgeBaseStats {
  totalMappings: number;
  bySourceSystem: Record<string, number>;
  byTargetSystem: Record<string, number>;
  averageConfidence: number;
  mostUsedMappings: StoredMapping[];
}

/**
 * Embedding service interface
 */
export interface IEmbeddingService {
  /**
   * Generate embedding vector for text
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts
   */
  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Calculate similarity between two vectors (cosine similarity)
   */
  similarity(vector1: number[], vector2: number[]): number;
}

/**
 * Vector store interface
 */
export interface IVectorStore {
  /**
   * Store a mapping with its embedding
   */
  store(mapping: StoredMapping, embedding: number[]): Promise<void>;

  /**
   * Store multiple mappings
   */
  storeBatch(mappings: StoredMapping[], embeddings: number[][]): Promise<void>;

  /**
   * Retrieve similar mappings
   */
  retrieve(
    queryEmbedding: number[],
    topK: number,
    filters?: {
      sourceSystem?: string;
      targetSystem?: string;
      minConfidence?: number;
    }
  ): Promise<RetrievalResult[]>;

  /**
   * Get mapping by ID
   */
  getById(id: string): Promise<StoredMapping | null>;

  /**
   * Delete mapping
   */
  delete(id: string): Promise<void>;

  /**
   * Clear all mappings
   */
  clear(): Promise<void>;

  /**
   * Get statistics
   */
  getStats(): Promise<KnowledgeBaseStats>;

  /**
   * Update mapping usage statistics
   */
  updateUsage(id: string): Promise<void>;

  /**
   * Export vector store to JSON
   */
  exportToJSON(): Promise<string>;

  /**
   * Import vector store from JSON
   */
  importFromJSON(json: string): Promise<void>;
}
