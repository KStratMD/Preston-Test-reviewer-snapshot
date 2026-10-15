import type { DocumentChunk } from '../../../../src/services/help/types';
import { DocumentationKnowledgeBase } from '../../../../src/services/help/DocumentationKnowledgeBase';

function chunk(id: string, content: string): DocumentChunk {
  return {
    id,
    filePath: `docs/${id}.md`,
    title: id,
    section: 'Guide',
    content,
    tokenCount: content.split(/\s+/).length,
    metadata: {
      fileType: 'markdown',
      category: 'guide',
      lastModified: new Date('2026-01-01T00:00:00Z'),
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('DocumentationKnowledgeBase.findSimilarChunksLocalOnly', () => {
  const chunks = [
    chunk('mapping-guide', 'Configure field mapping transformations and validate mapping suggestions.'),
    chunk('connector-guide', 'Configure connector credentials and test the connector connection.'),
    chunk('mapping-reference', 'Mapping validation explains confidence scores and transformation rules.'),
  ];
  const indexer = {
    indexDocumentation: jest.fn<Promise<DocumentChunk[]>, []>().mockResolvedValue(chunks),
  };
  const embedding = {
    embed: jest.fn<Promise<number[]>, [string]>().mockResolvedValue([0.1, 0.2]),
    isOpenAIEnabled: jest.fn().mockReturnValue(false),
    clearCache: jest.fn(),
  };
  const vectorStore = {
    store: jest.fn().mockResolvedValue(undefined),
    retrieve: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  let knowledgeBase: DocumentationKnowledgeBase;

  beforeEach(async () => {
    jest.clearAllMocks();
    indexer.indexDocumentation.mockResolvedValue(chunks);
    knowledgeBase = new DocumentationKnowledgeBase(indexer as never, embedding as never, vectorStore as never);
    await knowledgeBase.indexDocumentation();
    embedding.embed.mockClear();
  });

  it('returns lexically relevant chunks without generating a request-time embedding', () => {
    const results = knowledgeBase.findSimilarChunksLocalOnly('mapping transformation validation', 2);

    expect(results.map(result => result.id)).toEqual(['mapping-reference', 'mapping-guide']);
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(vectorStore.retrieve).not.toHaveBeenCalled();
  });

  it('returns the same insertion-order-stable IDs for identical queries', () => {
    const first = knowledgeBase.findSimilarChunksLocalOnly('configure', 3).map(result => result.id);
    const second = knowledgeBase.findSimilarChunksLocalOnly('configure', 3).map(result => result.id);

    expect(first).toEqual(['mapping-guide', 'connector-guide']);
    expect(second).toEqual(first);
  });

  it.each(['', '   ', 'zzqx wvut'])('returns no chunks for query %p', query => {
    expect(knowledgeBase.findSimilarChunksLocalOnly(query)).toEqual([]);
  });

  it('returns no chunks for a nonpositive limit', () => {
    expect(knowledgeBase.findSimilarChunksLocalOnly('mapping', 0)).toEqual([]);
    expect(knowledgeBase.findSimilarChunksLocalOnly('mapping', -1)).toEqual([]);
  });
});
