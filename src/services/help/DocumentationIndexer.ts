/**
 * Documentation Indexer
 * Parses markdown files and chunks them for RAG indexing
 */

import { promises as fs } from 'fs';
import { join, relative, basename } from 'path';
import { uuidv4 } from '../../utils/uuid';
import { logger } from '../../utils/Logger';
import type { DocumentChunk, DocumentationIndexConfig } from './types';

export class DocumentationIndexer {
  private config: Required<DocumentationIndexConfig>;

  constructor(config: Partial<DocumentationIndexConfig> = {}) {
    this.config = {
      docsPath: config.docsPath || join(process.cwd(), 'docs'),
      chunkSize: config.chunkSize || 750, // ~750 tokens
      chunkOverlap: config.chunkOverlap || 100, // ~100 token overlap
      excludePatterns: config.excludePatterns || ['**/node_modules/**', '**/archive/**'],
      includePatterns: config.includePatterns || ['**/*.md']
    };
  }

  /**
   * Index all markdown files in the docs directory
   */
  async indexDocumentation(): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];

    try {
      const files = await this.findMarkdownFiles();
      logger.info(`Found ${files.length} markdown files to index`);

      for (const file of files) {
        try {
          const fileChunks = await this.indexFile(file);
          chunks.push(...fileChunks);
          logger.debug(`Indexed ${fileChunks.length} chunks from ${file}`);
        } catch (error) {
          logger.error(`Failed to index file ${file}`, { error });
        }
      }

      logger.info(`Indexed ${chunks.length} total chunks from ${files.length} files`);
      return chunks;
    } catch (error) {
      logger.error('Failed to index documentation', { error });
      throw error;
    }
  }

  /**
   * Find all markdown files in docs directory
   */
  private async findMarkdownFiles(): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        logger.warn(`Failed to read directory ${dir}`, { error });
      }
    }

    await walk(this.config.docsPath);
    return files;
  }

  /**
   * Index a single markdown file
   */
  private async indexFile(filePath: string): Promise<DocumentChunk[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    const stats = await fs.stat(filePath);
    const relativePath = relative(process.cwd(), filePath);

    // Parse markdown to extract title and sections
    const sections = this.parseMarkdown(content);
    const category = this.extractCategory(relativePath);
    const title = sections.title || basename(filePath, '.md');

    // Chunk the content
    const chunks: DocumentChunk[] = [];

    for (const section of sections.sections) {
      const sectionChunks = this.chunkSection(section.content, this.config.chunkSize, this.config.chunkOverlap);

      for (let i = 0; i < sectionChunks.length; i++) {
        chunks.push({
          id: uuidv4(),
          filePath: relativePath,
          title,
          section: section.heading || 'Introduction',
          content: sectionChunks[i],
          tokenCount: this.estimateTokens(sectionChunks[i]),
          metadata: {
            fileType: 'markdown',
            category,
            lastModified: stats.mtime
          },
          createdAt: new Date()
        });
      }
    }

    return chunks;
  }

  /**
   * Parse markdown content into title and sections
   */
  private parseMarkdown(content: string): { title: string; sections: { heading: string; content: string }[] } {
    const lines = content.split('\n');
    let title = '';
    const sections: { heading: string; content: string }[] = [];
    let currentSection = { heading: '', content: '' };

    for (const line of lines) {
      // Extract title (first # heading)
      if (!title && line.startsWith('# ')) {
        title = line.replace(/^#\s+/, '').trim();
        continue;
      }

      // New section (## or ### heading)
      if (line.match(/^#{2,3}\s+/)) {
        if (currentSection.content.trim()) {
          sections.push(currentSection);
        }
        currentSection = {
          heading: line.replace(/^#+\s+/, '').trim(),
          content: line + '\n'
        };
      } else {
        currentSection.content += line + '\n';
      }
    }

    // Add last section
    if (currentSection.content.trim()) {
      sections.push(currentSection);
    }

    // If no sections, treat entire content as one section
    if (sections.length === 0) {
      sections.push({
        heading: 'Content',
        content: content
      });
    }

    return { title, sections };
  }

  /**
   * Chunk text content by token count
   * Uses word-based estimation: tokens ≈ words × 1.3
   */
  private chunkSection(text: string, targetTokens: number, overlapTokens: number): string[] {
    const chunks: string[] = [];
    const sentences = this.splitIntoSentences(text);

    let currentChunk = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = this.estimateTokens(sentence);

      // If adding this sentence exceeds target, save current chunk and start new one
      if (currentTokens + sentenceTokens > targetTokens && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());

        // Start new chunk with overlap (last few sentences)
        const overlapText = this.getOverlapText(currentChunk, overlapTokens);
        currentChunk = overlapText + sentence + ' ';
        currentTokens = this.estimateTokens(currentChunk);
      } else {
        currentChunk += sentence + ' ';
        currentTokens += sentenceTokens;
      }
    }

    // Add final chunk
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Split text into sentences
   */
  private splitIntoSentences(text: string): string[] {
    // Simple sentence splitting (can be improved with nlp library)
    return text
      .split(/[.!?]+\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * Get overlap text from end of chunk
   */
  private getOverlapText(text: string, targetOverlapTokens: number): string {
    const sentences = this.splitIntoSentences(text);
    let overlap = '';
    let tokens = 0;

    // Add sentences from the end until we reach target overlap
    for (let i = sentences.length - 1; i >= 0; i--) {
      const sentenceTokens = this.estimateTokens(sentences[i]);
      if (tokens + sentenceTokens > targetOverlapTokens) {
        break;
      }
      overlap = sentences[i] + ' ' + overlap;
      tokens += sentenceTokens;
    }

    return overlap;
  }

  /**
   * Estimate token count using word count heuristic
   * Tokens ≈ words × 1.3 (conservative estimate for English text)
   */
  private estimateTokens(text: string): number {
    const words = text.trim().split(/\s+/).length;
    return Math.ceil(words * 1.3);
  }

  /**
   * Extract category from file path
   */
  private extractCategory(filePath: string): string {
    const parts = filePath.split(/[/\\]/);

    // Find 'docs' in path and return next segment as category
    const docsIndex = parts.findIndex(p => p === 'docs');
    if (docsIndex >= 0 && docsIndex < parts.length - 1) {
      return parts[docsIndex + 1];
    }

    return 'general';
  }
}
