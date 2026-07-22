/**
 * Documentation Knowledge Base
 * Stores and retrieves documentation chunks using RAG (Retrieval-Augmented Generation)
 */

import { logger } from "../../utils/Logger";
import type { DocumentationIndexer } from "./DocumentationIndexer";
import type { EmbeddingService } from "../ai/rag/EmbeddingService";
import type { VectorStoreService } from "../ai/rag/VectorStoreService";
import type {
  DocumentChunk,
  DocumentRetrievalResult,
  DocumentationStats,
  IndexingProgress,
} from "./types";
import type { StoredMapping } from "../ai/rag/types";

export class DocumentationKnowledgeBase {
  private indexer: DocumentationIndexer;
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStoreService;
  private chunks = new Map<string, DocumentChunk>();
  private indexingProgress: IndexingProgress;
  private lastIndexedAt?: Date;

  constructor(
    indexer: DocumentationIndexer,
    embeddingService: EmbeddingService,
    vectorStore: VectorStoreService,
  ) {
    this.indexer = indexer;
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
    this.indexingProgress = {
      total: 0,
      indexed: 0,
      failed: 0,
      status: "initializing",
      startedAt: new Date(),
      errors: [],
    };
  }

  /**
   * Index all documentation (background process)
   */
  async indexDocumentation(): Promise<void> {
    this.indexingProgress = {
      total: 0,
      indexed: 0,
      failed: 0,
      status: "indexing",
      startedAt: new Date(),
      errors: [],
    };

    logger.info("🚀 Starting documentation indexing...");

    try {
      // Parse and chunk all markdown files
      const chunks = await this.indexer.indexDocumentation();
      this.indexingProgress.total = chunks.length;

      logger.info(`📚 Parsed ${chunks.length} documentation chunks, generating embeddings...`);

      // Generate embeddings and store chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
          // Generate embedding
          const embedding = await this.embeddingService.embed(chunk.content);

          // Convert DocumentChunk to StoredMapping format (reuse existing vector store)
          const mappingRecord: StoredMapping = {
            id: chunk.id,
            sourceField: chunk.title,
            targetField: chunk.section,
            sourceSystem: chunk.metadata.category,
            targetSystem: "documentation",
            transformationType: "reference",
            confidence: 1.0,
            reasoning: chunk.filePath,
            sourceFieldType: chunk.metadata.fileType,
            targetFieldType: "markdown",
            sampleValues: [chunk.content.substring(0, 200)],
            wasValidated: true,
            validationScore: 1.0,
            createdAt: chunk.createdAt,
            usageCount: 0,
          };

          // Store in vector store
          await this.vectorStore.store(mappingRecord, embedding);

          // Store chunk in local map
          this.chunks.set(chunk.id, chunk);

          this.indexingProgress.indexed++;

          // Stream progress logs every 50 chunks
          if ((i + 1) % 50 === 0 || i === chunks.length - 1) {
            const percent = Math.round((this.indexingProgress.indexed / this.indexingProgress.total) * 100);
            logger.info(`📊 Indexing progress: ${this.indexingProgress.indexed}/${this.indexingProgress.total} (${percent}%)`);
          }
        } catch (error) {
          this.indexingProgress.failed++;
          this.indexingProgress.errors.push(`Failed to index chunk ${chunk.id}: ${error instanceof Error ? error.message : "Unknown error"}`);
          logger.warn(`Failed to index chunk ${chunk.id}`, { error });
        }
      }

      this.indexingProgress.status = "completed";
      this.indexingProgress.completedAt = new Date();
      this.lastIndexedAt = new Date();

      const durationMs = this.indexingProgress.completedAt.getTime() - this.indexingProgress.startedAt.getTime();
      logger.info("✅ Documentation indexing completed", {
        indexed: this.indexingProgress.indexed,
        total: this.indexingProgress.total,
        durationSeconds: Math.round(durationMs / 1000),
      });

      if (this.indexingProgress.failed > 0) {
        logger.warn(`⚠️ ${this.indexingProgress.failed} chunks failed to index`);
      }
    } catch (error) {
      this.indexingProgress.status = "failed";
      this.indexingProgress.completedAt = new Date();
      logger.error("❌ Documentation indexing failed", { error });
      throw error;
    }
  }

  /**
   * Find similar documentation chunks for a query
   */
  async findSimilarChunks(
    query: string,
    topK = 5,
    minSimilarity = 0.5,
  ): Promise<DocumentRetrievalResult[]> {
    const effectiveMinSimilarity = this.embeddingService.isOpenAIEnabled() ? minSimilarity : Math.min(minSimilarity, 0.15);
    if (effectiveMinSimilarity !== minSimilarity) {
      logger.debug("Using relaxed similarity threshold due to local embeddings", {
        requestedMinSimilarity: minSimilarity,
        effectiveMinSimilarity,
      });
    }
    // Generate embedding for query
    const queryEmbedding = await this.embeddingService.embed(query);

    // Retrieve similar documents from vector store
    const results = await this.vectorStore.retrieve(queryEmbedding, topK, {
      targetSystem: "documentation",
    });

    // Convert to DocumentRetrievalResult and filter by similarity
    const documentResults: DocumentRetrievalResult[] = results
      .map(result => {
        const chunk = this.chunks.get(result.mapping.id);
        if (!chunk) return null;

        return {
          chunk,
          similarity: result.similarity,
          rank: result.rank,
        };
      })
      .filter((r): r is DocumentRetrievalResult => r !== null && r.similarity >= effectiveMinSimilarity);

    logger.debug(`Found ${documentResults.length} similar chunks for query`, {
      queryLength: query.length,
      topK,
      minSimilarity: effectiveMinSimilarity,
    });

    return documentResults;
  }

  /**
   * Get indexing progress
   */
  getIndexingProgress(): IndexingProgress {
    return { ...this.indexingProgress };
  }

  /**
   * Get knowledge base statistics
   */
  async getStats(): Promise<DocumentationStats> {
    const chunks = Array.from(this.chunks.values());
    const uniqueFiles = new Set(chunks.map(c => c.filePath));

    // Count by category
    const byCategory: Record<string, number> = {};
    for (const chunk of chunks) {
      const category = chunk.metadata.category;
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    // Calculate freshness
    let freshness: "ok" | "stale" | "unknown" = "unknown";
    if (this.lastIndexedAt) {
      const hoursSinceIndex = (Date.now() - this.lastIndexedAt.getTime()) / (1000 * 60 * 60);
      freshness = hoursSinceIndex < 24 ? "ok" : "stale";
    }

    return {
      totalChunks: chunks.length,
      totalDocuments: uniqueFiles.size,
      byCategory,
      lastIndexedAt: this.lastIndexedAt || new Date(0),
      freshness,
    };
  }

  /**
   * Check if documentation is indexed and ready
   */
  isReady(): boolean {
    return this.indexingProgress.status === "completed" && this.chunks.size > 0;
  }

  /**
   * Get chunk by ID
   */
  getChunkById(id: string): DocumentChunk | undefined {
    return this.chunks.get(id);
  }

  /**
   * Exact-path retrieval — return indexed chunks whose `filePath` matches one
   * of the supplied paths exactly. Used to boost architecture-node retrieval
   * with the node's authoritative `docPaths`, independent of vector similarity.
   *
   * Output is grouped in the order of the requested `filePaths`, up to
   * `limitPerFile` chunks per path (insertion order within each file is
   * preserved). Duplicate paths in `filePaths` are deduplicated — each
   * requested path appears at most once in the output. Returns an empty array
   * before indexing, for an empty path list, or when no path matches.
   */
  getChunksByFilePaths(filePaths: readonly string[], limitPerFile = 2): DocumentChunk[] {
    if (filePaths.length === 0) {
      return [];
    }

    // Single pass: collect all matching chunks per file, preserving insertion order.
    const wanted = new Set(filePaths);
    const byFile = new Map<string, DocumentChunk[]>();
    for (const chunk of this.chunks.values()) {
      if (!wanted.has(chunk.filePath)) {
        continue;
      }
      const bucket = byFile.get(chunk.filePath);
      if (bucket) {
        bucket.push(chunk);
      } else {
        byFile.set(chunk.filePath, [chunk]);
      }
    }

    // Emit in the order of the requested filePaths, deduplicating path repeats.
    const seen = new Set<string>();
    const result: DocumentChunk[] = [];
    for (const filePath of filePaths) {
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      const chunks = byFile.get(filePath);
      if (chunks) {
        const limit = Math.min(chunks.length, limitPerFile);
        for (let i = 0; i < limit; i++) {
          result.push(chunks[i]);
        }
      }
    }

    return result;
  }

  /**
   * Clear all indexed documentation
   */
  async clear(): Promise<void> {
    await this.vectorStore.clear();
    this.embeddingService.clearCache();
    this.chunks.clear();
    this.lastIndexedAt = undefined;
    this.indexingProgress = {
      total: 0,
      indexed: 0,
      failed: 0,
      status: "initializing",
      startedAt: new Date(),
      errors: [],
    };
    logger.info("Documentation knowledge base cleared");
  }
}
