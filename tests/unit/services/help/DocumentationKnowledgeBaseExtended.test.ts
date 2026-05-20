/**
 * Comprehensive unit tests for DocumentationKnowledgeBase
 * Covers: indexDocumentation, findSimilarChunks, getIndexingProgress,
 *         getStats, isReady, getChunkById, clear
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { DocumentationKnowledgeBase } from '../../../../src/services/help/DocumentationKnowledgeBase';

function makeChunk(overrides: Record<string, any> = {}) {
  return {
    id: 'chunk-1',
    title: 'Getting Started',
    section: 'Introduction',
    content: 'This is the getting started guide for SuiteCentral.',
    filePath: 'docs/getting-started.md',
    createdAt: new Date(),
    metadata: {
      category: 'guide',
      fileType: 'markdown',
    },
    ...overrides,
  };
}

function makeMockIndexer(chunks: any[] = [makeChunk()]) {
  return {
    indexDocumentation: jest.fn().mockResolvedValue(chunks),
  } as any;
}

function makeMockEmbedding() {
  return {
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    isOpenAIEnabled: jest.fn().mockReturnValue(false),
    clearCache: jest.fn(),
  } as any;
}

function makeMockVectorStore() {
  return {
    store: jest.fn().mockResolvedValue(undefined),
    retrieve: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('DocumentationKnowledgeBase', () => {
  let kb: DocumentationKnowledgeBase;
  let mockIndexer: any;
  let mockEmbedding: any;
  let mockVectorStore: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIndexer = makeMockIndexer();
    mockEmbedding = makeMockEmbedding();
    mockVectorStore = makeMockVectorStore();
    kb = new DocumentationKnowledgeBase(mockIndexer, mockEmbedding, mockVectorStore);
  });

  describe('constructor', () => {
    it('should initialize with pending status', () => {
      const progress = kb.getIndexingProgress();
      expect(progress.status).toBe('initializing');
      expect(progress.total).toBe(0);
      expect(progress.indexed).toBe(0);
    });
  });

  describe('indexDocumentation', () => {
    it('should index all chunks from indexer', async () => {
      const chunks = [makeChunk({ id: 'c1' }), makeChunk({ id: 'c2' })];
      mockIndexer.indexDocumentation.mockResolvedValue(chunks);

      await kb.indexDocumentation();

      expect(mockIndexer.indexDocumentation).toHaveBeenCalled();
      expect(mockEmbedding.embed).toHaveBeenCalledTimes(2);
      expect(mockVectorStore.store).toHaveBeenCalledTimes(2);

      const progress = kb.getIndexingProgress();
      expect(progress.status).toBe('completed');
      expect(progress.total).toBe(2);
      expect(progress.indexed).toBe(2);
      expect(progress.failed).toBe(0);
    });

    it('should handle embedding failures gracefully', async () => {
      const chunks = [makeChunk({ id: 'c1' }), makeChunk({ id: 'c2' })];
      mockIndexer.indexDocumentation.mockResolvedValue(chunks);
      mockEmbedding.embed
        .mockResolvedValueOnce([0.1, 0.2])
        .mockRejectedValueOnce(new Error('Embedding failed'));

      await kb.indexDocumentation();

      const progress = kb.getIndexingProgress();
      expect(progress.indexed).toBe(1);
      expect(progress.failed).toBe(1);
      expect(progress.errors.length).toBe(1);
    });

    it('should propagate indexer errors', async () => {
      mockIndexer.indexDocumentation.mockRejectedValue(new Error('Parse error'));
      await expect(kb.indexDocumentation()).rejects.toThrow('Parse error');

      const progress = kb.getIndexingProgress();
      expect(progress.status).toBe('failed');
    });

    it('should set completed timestamps', async () => {
      await kb.indexDocumentation();
      const progress = kb.getIndexingProgress();
      expect(progress.completedAt).toBeInstanceOf(Date);
    });
  });

  describe('findSimilarChunks', () => {
    it('should return matching chunks above similarity threshold', async () => {
      // Index first
      await kb.indexDocumentation();

      const chunk = makeChunk({ id: 'chunk-1' });
      mockVectorStore.retrieve.mockResolvedValue([
        { mapping: { id: 'chunk-1' }, similarity: 0.85, rank: 1 },
      ]);

      const results = await kb.findSimilarChunks('getting started', 5, 0.5);
      expect(mockEmbedding.embed).toHaveBeenCalledWith('getting started');
      expect(results.length).toBe(1);
      expect(results[0].similarity).toBe(0.85);
    });

    it('should filter below similarity threshold', async () => {
      await kb.indexDocumentation();

      mockVectorStore.retrieve.mockResolvedValue([
        { mapping: { id: 'chunk-1' }, similarity: 0.3, rank: 1 },
      ]);

      // Local embedding uses relaxed threshold: min(0.5, 0.15) = 0.15
      // Since 0.3 > 0.15, it should be included with local embeddings
      const results = await kb.findSimilarChunks('query', 5, 0.5);
      expect(results.length).toBe(1); // 0.3 >= 0.15 (relaxed threshold)
    });

    it('should use relaxed threshold for local embeddings', async () => {
      await kb.indexDocumentation();
      mockEmbedding.isOpenAIEnabled.mockReturnValue(false);

      mockVectorStore.retrieve.mockResolvedValue([
        { mapping: { id: 'chunk-1' }, similarity: 0.12, rank: 1 },
      ]);

      const results = await kb.findSimilarChunks('query', 5, 0.5);
      // 0.12 < 0.15 (relaxed), should be filtered
      expect(results.length).toBe(0);
    });

    it('should use normal threshold for OpenAI embeddings', async () => {
      await kb.indexDocumentation();
      mockEmbedding.isOpenAIEnabled.mockReturnValue(true);

      mockVectorStore.retrieve.mockResolvedValue([
        { mapping: { id: 'chunk-1' }, similarity: 0.3, rank: 1 },
      ]);

      const results = await kb.findSimilarChunks('query', 5, 0.5);
      // 0.3 < 0.5 (normal threshold), should be filtered
      expect(results.length).toBe(0);
    });

    it('should skip chunks not in local map', async () => {
      mockVectorStore.retrieve.mockResolvedValue([
        { mapping: { id: 'unknown-chunk' }, similarity: 0.9, rank: 1 },
      ]);

      const results = await kb.findSimilarChunks('query');
      expect(results.length).toBe(0);
    });
  });

  describe('getIndexingProgress', () => {
    it('should return a copy of progress', () => {
      const p1 = kb.getIndexingProgress();
      const p2 = kb.getIndexingProgress();
      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2); // Different objects
    });
  });

  describe('getStats', () => {
    it('should return empty stats before indexing', async () => {
      const stats = await kb.getStats();
      expect(stats.totalChunks).toBe(0);
      expect(stats.totalDocuments).toBe(0);
      expect(stats.freshness).toBe('unknown');
    });

    it('should return stats after indexing', async () => {
      const chunks = [
        makeChunk({ id: 'c1', filePath: 'docs/a.md', metadata: { category: 'guide', fileType: 'md' } }),
        makeChunk({ id: 'c2', filePath: 'docs/a.md', metadata: { category: 'guide', fileType: 'md' } }),
        makeChunk({ id: 'c3', filePath: 'docs/b.md', metadata: { category: 'api', fileType: 'md' } }),
      ];
      mockIndexer.indexDocumentation.mockResolvedValue(chunks);

      await kb.indexDocumentation();
      const stats = await kb.getStats();

      expect(stats.totalChunks).toBe(3);
      expect(stats.totalDocuments).toBe(2); // 2 unique file paths
      expect(stats.byCategory.guide).toBe(2);
      expect(stats.byCategory.api).toBe(1);
      expect(stats.freshness).toBe('ok');
    });
  });

  describe('isReady', () => {
    it('should return false before indexing', () => {
      expect(kb.isReady()).toBe(false);
    });

    it('should return true after successful indexing', async () => {
      await kb.indexDocumentation();
      expect(kb.isReady()).toBe(true);
    });
  });

  describe('getChunkById', () => {
    it('should return undefined for unknown ID', () => {
      expect(kb.getChunkById('unknown')).toBeUndefined();
    });

    it('should return chunk after indexing', async () => {
      await kb.indexDocumentation();
      const chunk = kb.getChunkById('chunk-1');
      expect(chunk).toBeDefined();
      expect(chunk!.title).toBe('Getting Started');
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      await kb.indexDocumentation();
      expect(kb.isReady()).toBe(true);

      await kb.clear();
      expect(kb.isReady()).toBe(false);
      expect(mockVectorStore.clear).toHaveBeenCalled();
      expect(mockEmbedding.clearCache).toHaveBeenCalled();

      const stats = await kb.getStats();
      expect(stats.totalChunks).toBe(0);
    });
  });
});
