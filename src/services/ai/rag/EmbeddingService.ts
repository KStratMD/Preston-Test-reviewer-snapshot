/**
 * Embedding Service - Phase 4 AI Accuracy Improvements
 * Generates vector embeddings for text using OpenAI API or local fallback
 */

import { logger } from "../../../utils/Logger";
import type { IEmbeddingService } from "./types";

export interface EmbeddingServiceConfig {
  useOpenAI?: boolean;
  openaiApiKey?: string;
  openaiModel?: string; // Default: 'text-embedding-3-small'
  cacheEnabled?: boolean;
  cacheTTL?: number; // milliseconds
}

/**
 * Cache entry for embeddings
 */
interface CacheEntry {
  embedding: number[];
  timestamp: Date;
}

export class EmbeddingService implements IEmbeddingService {
  private config: Required<EmbeddingServiceConfig>;
  private cache = new Map<string, CacheEntry>();
  private logger = logger;
  private openAIDisabledAtRuntime = false;

  constructor(config: EmbeddingServiceConfig = {}) {
    const disableOpenAIEmbeddings = (process.env.DISABLE_OPENAI_EMBEDDINGS || '').toLowerCase() === '1'
      || (process.env.DISABLE_OPENAI_EMBEDDINGS || '').toLowerCase() === 'true';
    this.config = {
      useOpenAI: config.useOpenAI ?? (!!process.env.OPENAI_API_KEY && !disableOpenAIEmbeddings),
      openaiApiKey: config.openaiApiKey || process.env.OPENAI_API_KEY || "",
      openaiModel: config.openaiModel || "text-embedding-3-small",
      cacheEnabled: config.cacheEnabled ?? true,
      cacheTTL: config.cacheTTL ?? 86400000, // 24 hours default
    };

    if (disableOpenAIEmbeddings && process.env.OPENAI_API_KEY) {
      this.logger.info("OpenAI embeddings disabled via DISABLE_OPENAI_EMBEDDINGS; using local embeddings");
    }
  }

  /**
   * Generate embedding vector for text
   */
  async embed(text: string): Promise<number[]> {
    // Check cache first
    if (this.config.cacheEnabled) {
      const cached = this.getFromCache(text);
      if (cached) {
        this.logger.debug("Embedding retrieved from cache", { textLength: text.length });
        return cached;
      }
    }

    let embedding: number[];

    if (this.config.useOpenAI && this.config.openaiApiKey && !this.openAIDisabledAtRuntime) {
      embedding = await this.embedWithOpenAI(text);
    } else {
      embedding = this.embedLocally(text);
    }

    // Cache the result
    if (this.config.cacheEnabled) {
      this.addToCache(text, embedding);
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.config.useOpenAI && this.config.openaiApiKey && !this.openAIDisabledAtRuntime) {
      return this.embedBatchWithOpenAI(texts);
    } else {
      // For local embeddings, process individually
      return Promise.all(texts.map(text => this.embed(text)));
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  similarity(vector1: number[], vector2: number[]): number {
    if (vector1.length !== vector2.length) {
      this.logger.warn("Vector dimension mismatch - returning 0 similarity", {
        vector1Length: vector1.length,
        vector2Length: vector2.length,
      });
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vector1.length; i++) {
      dotProduct += vector1[i] * vector2[i];
      norm1 += vector1[i] * vector1[i];
      norm2 += vector2[i] * vector2[i];
    }

    const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);

    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
  }

  /**
   * Generate embedding using OpenAI API
   */
  private async embedWithOpenAI(text: string): Promise<number[]> {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: text,
          model: this.config.openaiModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { data: { embedding: number[] }[] };
      const embedding = data.data[0].embedding;

      this.logger.debug("Generated OpenAI embedding", {
        textLength: text.length,
        embeddingDim: embedding.length,
        model: this.config.openaiModel,
      });

      return embedding;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimit = message.includes("429");
      if (isRateLimit) {
        this.disableOpenAIAtRuntime(message);
      } else {
        this.logger.warn("OpenAI embedding failed, falling back to local", {
          error: message,
        });
      }
      return this.embedLocally(text);
    }
  }

  /**
   * Generate embeddings for multiple texts using OpenAI API (batch)
   */
  private async embedBatchWithOpenAI(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: this.config.openaiModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { data: { embedding: number[] }[] };
      const embeddings = data.data.map((item) => item.embedding);

      this.logger.debug("Generated OpenAI embeddings (batch)", {
        count: texts.length,
        embeddingDim: embeddings[0].length,
        model: this.config.openaiModel,
      });

      return embeddings;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimit = message.includes("429");
      if (isRateLimit) {
        this.disableOpenAIAtRuntime(message);
      } else {
        this.logger.warn("OpenAI batch embedding failed, falling back to local", {
          error: message,
          count: texts.length,
        });
      }
      return Promise.all(texts.map(text => this.embedLocally(text)));
    }
  }

  private disableOpenAIAtRuntime(reason: string): void {
    if (this.openAIDisabledAtRuntime) {
      return;
    }
    this.openAIDisabledAtRuntime = true;
    this.logger.warn("OpenAI embedding rate-limited; disabling OpenAI embeddings for this process and using local fallback", {
      error: reason,
    });
  }

  /**
   * Generate embedding using local algorithm (fallback)
   * Uses character n-grams and TF-IDF-like weighting
   */
  private embedLocally(text: string): number[] {
    const normalized = text.toLowerCase().trim();

    // Create a fixed-size embedding vector (384 dimensions to match small models)
    const embeddingSize = 384;
    const embedding = new Array(embeddingSize).fill(0);

    // Extract character trigrams
    const trigrams = this.extractNGrams(normalized, 3);

    // Hash each trigram to a position in the embedding vector
    trigrams.forEach(trigram => {
      const hash = this.hashString(trigram);
      const index = Math.abs(hash) % embeddingSize;
      embedding[index] += 1;
    });

    // Normalize the vector
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    this.logger.debug("Generated local embedding", {
      textLength: text.length,
      trigramCount: trigrams.length,
      embeddingDim: embeddingSize,
    });

    return embedding;
  }

  /**
   * Extract character n-grams from text
   */
  private extractNGrams(text: string, n: number): string[] {
    const ngrams: string[] = [];

    // Add padding
    const padded = "#".repeat(n - 1) + text + "#".repeat(n - 1);

    for (let i = 0; i < padded.length - n + 1; i++) {
      ngrams.push(padded.substring(i, i + n));
    }

    return ngrams;
  }

  /**
   * Simple string hash function
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  /**
   * Get embedding from cache
   */
  private getFromCache(text: string): number[] | null {
    const entry = this.cache.get(text);
    if (!entry) {
      return null;
    }

    // Check if cache entry has expired
    const age = Date.now() - entry.timestamp.getTime();
    if (age > this.config.cacheTTL) {
      this.cache.delete(text);
      return null;
    }

    return entry.embedding;
  }

  /**
   * Add embedding to cache
   */
  private addToCache(text: string, embedding: number[]): void {
    this.cache.set(text, {
      embedding,
      timestamp: new Date(),
    });

    // Limit cache size (keep most recent 1000 entries)
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.info("Embedding cache cleared");
  }

  /**
   * Report whether OpenAI embeddings are currently enabled
   */
  isOpenAIEnabled(): boolean {
    return this.config.useOpenAI && !!this.config.openaiApiKey && !this.openAIDisabledAtRuntime;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: 1000,
    };
  }
}
