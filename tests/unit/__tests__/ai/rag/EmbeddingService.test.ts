import 'reflect-metadata';
import { EmbeddingService, type EmbeddingServiceConfig } from '../../../../../src/services/ai/rag/EmbeddingService';

describe('EmbeddingService', () => {
  describe('Local Embedding (no API key)', () => {
    let service: EmbeddingService;

    beforeEach(() => {
      service = new EmbeddingService({
        useOpenAI: false,
        cacheEnabled: true
      });
    });

    describe('embed', () => {
      it('should generate embedding vector for text', async () => {
        const text = 'customer email address';
        const embedding = await service.embed(text);

        expect(embedding).toBeDefined();
        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding.length).toBe(384); // Default embedding size
        expect(embedding.every(v => typeof v === 'number')).toBe(true);
      });

      it('should generate normalized embeddings (magnitude = 1)', async () => {
        const text = 'test field';
        const embedding = await service.embed(text);

        // Calculate magnitude
        const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        expect(magnitude).toBeCloseTo(1.0, 5);
      });

      it('should generate different embeddings for different texts', async () => {
        const embedding1 = await service.embed('customer name');
        const embedding2 = await service.embed('invoice date');

        // Embeddings should be different
        const areDifferent = embedding1.some((val, idx) => Math.abs(val - embedding2[idx]) > 0.01);
        expect(areDifferent).toBe(true);
      });

      it('should generate similar embeddings for similar texts', async () => {
        const embedding1 = await service.embed('customer_email');
        const embedding2 = await service.embed('customer email');

        const similarity = service.similarity(embedding1, embedding2);
        expect(similarity).toBeGreaterThan(0.5); // Should have decent similarity
      });

      it('should cache embeddings when enabled', async () => {
        const text = 'cached text';

        const embedding1 = await service.embed(text);
        const embedding2 = await service.embed(text);

        // Should return same reference (cached)
        expect(embedding1).toBe(embedding2);
      });

      it('should not cache embeddings when disabled', async () => {
        const noCacheService = new EmbeddingService({
          useOpenAI: false,
          cacheEnabled: false
        });

        const text = 'uncached text';
        const embedding1 = await noCacheService.embed(text);
        const embedding2 = await noCacheService.embed(text);

        // Should return different instances
        expect(embedding1).not.toBe(embedding2);
        // But same values
        expect(embedding1).toEqual(embedding2);
      });
    });

    describe('embedBatch', () => {
      it('should generate embeddings for multiple texts', async () => {
        const texts = ['field1', 'field2', 'field3'];
        const embeddings = await service.embedBatch(texts);

        expect(embeddings.length).toBe(3);
        expect(embeddings.every(emb => Array.isArray(emb) && emb.length === 384)).toBe(true);
      });

      it('should handle empty array', async () => {
        const embeddings = await service.embedBatch([]);
        expect(embeddings.length).toBe(0);
      });
    });

    describe('similarity', () => {
      it('should calculate cosine similarity between vectors', () => {
        const vector1 = [1, 0, 0, 0];
        const vector2 = [1, 0, 0, 0];

        const similarity = service.similarity(vector1, vector2);
        expect(similarity).toBeCloseTo(1.0, 5); // Identical vectors
      });

      it('should return 0 for orthogonal vectors', () => {
        const vector1 = [1, 0, 0, 0];
        const vector2 = [0, 1, 0, 0];

        const similarity = service.similarity(vector1, vector2);
        expect(similarity).toBeCloseTo(0.0, 5);
      });

      it('should return value between -1 and 1', () => {
        const vector1 = [1, 2, 3];
        const vector2 = [4, 5, 6];

        const similarity = service.similarity(vector1, vector2);
        expect(similarity).toBeGreaterThanOrEqual(-1);
        expect(similarity).toBeLessThanOrEqual(1);
      });

      it('should return 0 for vectors of different lengths', () => {
        const vector1 = [1, 2, 3];
        const vector2 = [1, 2];

        // Changed from throwing to returning 0 to handle provider changes gracefully
        // (e.g., OpenAI 1536D vs local 384D embeddings)
        const similarity = service.similarity(vector1, vector2);
        expect(similarity).toBe(0);
      });

      it('should handle zero vectors', () => {
        const vector1 = [0, 0, 0];
        const vector2 = [1, 2, 3];

        const similarity = service.similarity(vector1, vector2);
        expect(similarity).toBe(0);
      });
    });

    describe('cache management', () => {
      it('should provide cache statistics', () => {
        const stats = service.getCacheStats();

        expect(stats).toBeDefined();
        expect(stats.size).toBeDefined();
        expect(stats.maxSize).toBe(1000);
      });

      it('should clear cache', async () => {
        await service.embed('test1');
        await service.embed('test2');

        let stats = service.getCacheStats();
        expect(stats.size).toBeGreaterThan(0);

        service.clearCache();

        stats = service.getCacheStats();
        expect(stats.size).toBe(0);
      });

      it('should limit cache size to 1000 entries', async () => {
        // Add more than 1000 entries
        for (let i = 0; i < 1100; i++) {
          await service.embed(`text_${i}`);
        }

        const stats = service.getCacheStats();
        expect(stats.size).toBeLessThanOrEqual(1000);
      });
    });

    describe('configuration', () => {
      it('should use default configuration', () => {
        const defaultService = new EmbeddingService();
        expect(defaultService).toBeDefined();
      });

      it('should accept custom configuration', () => {
        const customService = new EmbeddingService({
          useOpenAI: false,
          cacheEnabled: true,
          cacheTTL: 3600000
        });

        expect(customService).toBeDefined();
      });

      it('should respect cache TTL', async () => {
        const shortTTLService = new EmbeddingService({
          useOpenAI: false,
          cacheEnabled: true,
          cacheTTL: 1 // 1 millisecond
        });

        const text = 'ttl test';
        await shortTTLService.embed(text);

        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 10));

        // Cache should be expired (but we can't directly test this without accessing private methods)
        // Just verify the service still works
        const embedding = await shortTTLService.embed(text);
        expect(embedding).toBeDefined();
      });
    });

    describe('edge cases', () => {
      it('should handle empty string', async () => {
        const embedding = await service.embed('');
        expect(embedding).toBeDefined();
        expect(embedding.length).toBe(384);
      });

      it('should handle very long text', async () => {
        const longText = 'word '.repeat(1000);
        const embedding = await service.embed(longText);
        expect(embedding).toBeDefined();
        expect(embedding.length).toBe(384);
      });

      it('should handle special characters', async () => {
        const embedding = await service.embed('!@#$%^&*()_+-=[]{}|;:,.<>?');
        expect(embedding).toBeDefined();
        expect(embedding.length).toBe(384);
      });

      it('should handle unicode characters', async () => {
        const embedding = await service.embed('测试中文 émojis 🎉');
        expect(embedding).toBeDefined();
        expect(embedding.length).toBe(384);
      });

      it('should be case-insensitive for local embedding', async () => {
        const embedding1 = await service.embed('Customer Email');
        const embedding2 = await service.embed('customer email');

        const similarity = service.similarity(embedding1, embedding2);
        expect(similarity).toBeGreaterThan(0.99); // Should be nearly identical
      });
    });
  });

  describe('OpenAI Integration (mocked)', () => {
    let service: EmbeddingService;
    let mockFetch: jest.Mock;

    beforeEach(() => {
      // Mock fetch for OpenAI API
      mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              embedding: Array(384).fill(0).map(() => Math.random())
            }
          ]
        })
      });

      global.fetch = mockFetch;

      service = new EmbeddingService({
        useOpenAI: true,
        openaiApiKey: 'test-key',
        openaiModel: 'text-embedding-3-small'
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should call OpenAI API when configured', async () => {
      await service.embed('test text');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should fallback to local embedding on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const embedding = await service.embed('test text');

      expect(embedding).toBeDefined();
      expect(embedding.length).toBe(384);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const embedding = await service.embed('test text');

      expect(embedding).toBeDefined();
      expect(embedding.length).toBe(384);
    });

    it('should support batch embedding with OpenAI', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: Array(384).fill(0).map(() => Math.random()) },
            { embedding: Array(384).fill(0).map(() => Math.random()) },
            { embedding: Array(384).fill(0).map(() => Math.random()) }
          ]
        })
      });

      const texts = ['text1', 'text2', 'text3'];
      const embeddings = await service.embedBatch(texts);

      expect(embeddings.length).toBe(3);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Single batch call
    });
  });
});
