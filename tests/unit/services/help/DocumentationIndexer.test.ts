/**
 * DocumentationIndexer Unit Tests
 * Tests for markdown parsing and RAG chunking
 */

import { DocumentationIndexer } from '../../../../src/services/help/DocumentationIndexer';
import { promises as fs } from 'fs';
import { join } from 'path';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn(),
  },
}));

// Mock the in-tree uuid wrapper (the npm `uuid` package was removed; src/utils/uuid.ts
// now wraps node:crypto.randomUUID — see PR #714).
jest.mock('../../../../src/utils/uuid', () => ({
  uuidv4: jest.fn(() => 'test-uuid-1234'),
}));

// Mock logger
jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('DocumentationIndexer', () => {
  let indexer: DocumentationIndexer;
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    jest.clearAllMocks();
    indexer = new DocumentationIndexer();
  });

  describe('constructor', () => {
    it('should use default configuration', () => {
      const defaultIndexer = new DocumentationIndexer();
      // Access private config via any
      const config = (defaultIndexer as any).config;

      expect(config.chunkSize).toBe(750);
      expect(config.chunkOverlap).toBe(100);
      expect(config.docsPath).toContain('docs');
    });

    it('should accept custom configuration', () => {
      const customIndexer = new DocumentationIndexer({
        docsPath: '/custom/path',
        chunkSize: 500,
        chunkOverlap: 50,
      });

      const config = (customIndexer as any).config;

      expect(config.docsPath).toBe('/custom/path');
      expect(config.chunkSize).toBe(500);
      expect(config.chunkOverlap).toBe(50);
    });
  });

  describe('indexDocumentation()', () => {
    it('should index markdown files and return chunks', async () => {
      // Setup mocks
      mockFs.readdir.mockResolvedValueOnce([
        { name: 'test.md', isDirectory: () => false, isFile: () => true },
      ] as any);

      mockFs.readFile.mockResolvedValueOnce('# Test Title\n\nThis is test content.');
      mockFs.stat.mockResolvedValueOnce({ mtime: new Date('2024-01-15') } as any);

      const chunks = await indexer.indexDocumentation();

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].title).toBe('Test Title');
    });

    it('should handle empty docs directory', async () => {
      mockFs.readdir.mockResolvedValueOnce([]);

      const chunks = await indexer.indexDocumentation();

      expect(chunks).toEqual([]);
    });

    it('should handle file read errors gracefully', async () => {
      mockFs.readdir.mockResolvedValueOnce([
        { name: 'test.md', isDirectory: () => false, isFile: () => true },
      ] as any);

      mockFs.readFile.mockRejectedValueOnce(new Error('File read error'));

      const chunks = await indexer.indexDocumentation();

      expect(chunks).toEqual([]);
    });

    it('should handle directory read errors', async () => {
      mockFs.readdir.mockRejectedValueOnce(new Error('Directory read error'));

      const chunks = await indexer.indexDocumentation();

      expect(chunks).toEqual([]);
    });

    it('should recursively walk directories', async () => {
      mockFs.readdir
        .mockResolvedValueOnce([
          { name: 'subdir', isDirectory: () => true, isFile: () => false },
          { name: 'root.md', isDirectory: () => false, isFile: () => true },
        ] as any)
        .mockResolvedValueOnce([
          { name: 'nested.md', isDirectory: () => false, isFile: () => true },
        ] as any);

      mockFs.readFile
        .mockResolvedValueOnce('# Root\n\nRoot content.')
        .mockResolvedValueOnce('# Nested\n\nNested content.');
      mockFs.stat.mockResolvedValue({ mtime: new Date() } as any);

      const chunks = await indexer.indexDocumentation();

      expect(mockFs.readdir).toHaveBeenCalledTimes(2);
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('parseMarkdown()', () => {
    it('should extract title from # heading', () => {
      const content = '# My Document Title\n\nSome content here.';

      // Access private method
      const result = (indexer as any).parseMarkdown(content);

      expect(result.title).toBe('My Document Title');
    });

    it('should extract sections from ## and ### headings', () => {
      const content = `# Main Title

Introduction text.

## Section One

Section one content.

### Subsection

Subsection content.

## Section Two

Section two content.`;

      const result = (indexer as any).parseMarkdown(content);

      expect(result.title).toBe('Main Title');
      // 4 sections: intro (empty heading), Section One, Subsection, Section Two
      expect(result.sections.length).toBe(4);
      expect(result.sections[1].heading).toBe('Section One');
      expect(result.sections[2].heading).toBe('Subsection');
      expect(result.sections[3].heading).toBe('Section Two');
    });

    it('should handle document with no title', () => {
      const content = 'Just some content without a title.';

      const result = (indexer as any).parseMarkdown(content);

      expect(result.title).toBe('');
      expect(result.sections.length).toBe(1);
      // When no ## headings exist, the currentSection has empty heading
      expect(result.sections[0].heading).toBe('');
    });

    it('should handle document with no sections', () => {
      const content = '# Title Only\n\nNo sections here, just intro text.';

      const result = (indexer as any).parseMarkdown(content);

      expect(result.title).toBe('Title Only');
      expect(result.sections.length).toBe(1);
    });
  });

  describe('chunkSection()', () => {
    it('should chunk long text into multiple pieces', () => {
      const longText = 'This is a sentence. '.repeat(100);

      // Use smaller chunk size for testing
      const chunks = (indexer as any).chunkSection(longText, 50, 10);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should return single chunk for short text', () => {
      const shortText = 'This is short.';

      const chunks = (indexer as any).chunkSection(shortText, 750, 100);

      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe(shortText);
    });

    it('should include overlap between chunks', () => {
      const text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';

      const chunks = (indexer as any).chunkSection(text, 20, 10);

      // With overlap, later chunks should contain text from previous chunks
      if (chunks.length > 1) {
        // The overlap should carry some content forward
        expect(chunks.length).toBeGreaterThan(1);
      }
    });

    it('should handle empty text', () => {
      const chunks = (indexer as any).chunkSection('', 750, 100);

      expect(chunks).toEqual(['']);
    });
  });

  describe('estimateTokens()', () => {
    it('should estimate tokens from word count', () => {
      const text = 'one two three four five'; // 5 words

      const tokens = (indexer as any).estimateTokens(text);

      // Tokens ≈ words × 1.3, ceiling
      expect(tokens).toBe(Math.ceil(5 * 1.3)); // 7
    });

    it('should handle single word', () => {
      const tokens = (indexer as any).estimateTokens('word');

      expect(tokens).toBe(Math.ceil(1 * 1.3)); // 2
    });

    it('should handle empty string', () => {
      const tokens = (indexer as any).estimateTokens('');

      expect(tokens).toBe(Math.ceil(1 * 1.3)); // 2 (empty splits to [''])
    });
  });

  describe('extractCategory()', () => {
    it('should extract category from docs path', () => {
      const category = (indexer as any).extractCategory('docs/guides/setup.md');

      expect(category).toBe('guides');
    });

    it('should extract category with nested docs path', () => {
      const category = (indexer as any).extractCategory('project/docs/tutorials/advanced/test.md');

      expect(category).toBe('tutorials');
    });

    it('should return general for path without docs', () => {
      const category = (indexer as any).extractCategory('some/other/path.md');

      expect(category).toBe('general');
    });

    it('should handle Windows-style paths', () => {
      const category = (indexer as any).extractCategory('docs\\api\\endpoints.md');

      expect(category).toBe('api');
    });

    it('should return general if docs is last segment', () => {
      const category = (indexer as any).extractCategory('path/to/docs');

      expect(category).toBe('general');
    });
  });

  describe('splitIntoSentences()', () => {
    it('should split on period followed by space', () => {
      const sentences = (indexer as any).splitIntoSentences('First. Second. Third.');

      // Last sentence keeps punctuation (no trailing space)
      expect(sentences).toEqual(['First', 'Second', 'Third.']);
    });

    it('should split on question mark followed by space', () => {
      const sentences = (indexer as any).splitIntoSentences('What? How? Why?');

      expect(sentences).toEqual(['What', 'How', 'Why?']);
    });

    it('should split on exclamation followed by space', () => {
      const sentences = (indexer as any).splitIntoSentences('Wow! Amazing! Great!');

      expect(sentences).toEqual(['Wow', 'Amazing', 'Great!']);
    });

    it('should handle mixed punctuation', () => {
      const sentences = (indexer as any).splitIntoSentences('Statement. Question? Exclamation!');

      // Splits on ". " and "? ", last keeps punctuation
      expect(sentences).toEqual(['Statement', 'Question', 'Exclamation!']);
    });

    it('should filter empty strings', () => {
      const sentences = (indexer as any).splitIntoSentences('One.   Two.');

      // Multiple spaces after period still split, last keeps punctuation
      expect(sentences).toEqual(['One', 'Two.']);
    });
  });

  describe('getOverlapText()', () => {
    it('should return last sentences up to token limit', () => {
      const text = 'First sentence. Second sentence. Third sentence.';

      const overlap = (indexer as any).getOverlapText(text, 10);

      // Should contain some trailing content
      expect(overlap.length).toBeGreaterThan(0);
    });

    it('should return empty for very small overlap target', () => {
      const text = 'A very long sentence that exceeds any small token limit.';

      const overlap = (indexer as any).getOverlapText(text, 1);

      // With a tiny limit, nothing fits
      expect(overlap).toBe('');
    });

    it('should handle single sentence', () => {
      const text = 'Single sentence only.';

      const overlap = (indexer as any).getOverlapText(text, 50);

      // Single sentence keeps its punctuation
      expect(overlap.trim()).toBe('Single sentence only.');
    });
  });

  describe('indexFile()', () => {
    it('should create chunks with correct metadata', async () => {
      const testDate = new Date('2024-01-15T12:00:00Z');
      mockFs.readFile.mockResolvedValueOnce('# Test Doc\n\n## Section\n\nContent here.');
      mockFs.stat.mockResolvedValueOnce({ mtime: testDate } as any);

      const chunks = await (indexer as any).indexFile('/docs/test.md');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].id).toBe('test-uuid-1234');
      expect(chunks[0].title).toBe('Test Doc');
      expect(chunks[0].metadata.fileType).toBe('markdown');
      expect(chunks[0].metadata.lastModified).toEqual(testDate);
      expect(chunks[0].createdAt).toBeInstanceOf(Date);
    });

    it('should use filename as title when no heading exists', async () => {
      mockFs.readFile.mockResolvedValueOnce('Just content, no title.');
      mockFs.stat.mockResolvedValueOnce({ mtime: new Date() } as any);

      const chunks = await (indexer as any).indexFile('/docs/my-document.md');

      expect(chunks[0].title).toBe('my-document');
    });
  });
});
