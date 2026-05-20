/**
 * Help Chat System Types
 * Natural language documentation help powered by RAG
 */

/**
 * A stored documentation chunk in the knowledge base
 */
export interface DocumentChunk {
  id: string;
  filePath: string;
  title: string;
  section: string;
  content: string;
  tokenCount: number;
  metadata: {
    fileType: string;
    category: string;
    lastModified: Date;
  };
  createdAt: Date;
}

/**
 * Documentation retrieval result with similarity score
 */
export interface DocumentRetrievalResult {
  chunk: DocumentChunk;
  similarity: number;
  rank: number;
}

/**
 * Help chat message
 */
export interface HelpChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: DocumentSource[];
  timestamp: Date;
}

/**
 * Source citation for AI responses
 */
export interface DocumentSource {
  filePath: string;
  title: string;
  section: string;
  similarity: number;
}

/**
 * Help chat session
 */
export interface HelpChatSession {
  id: string;
  messages: HelpChatMessage[];
  createdAt: Date;
  lastActivityAt: Date;
}

/**
 * Documentation indexing progress
 */
export interface IndexingProgress {
  total: number;
  indexed: number;
  failed: number;
  status: 'initializing' | 'indexing' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  errors: string[];
}

/**
 * Documentation knowledge base statistics
 */
export interface DocumentationStats {
  totalChunks: number;
  totalDocuments: number;
  byCategory: Record<string, number>;
  lastIndexedAt: Date;
  freshness: 'ok' | 'stale' | 'unknown';
}

/**
 * Help chat request
 */
export interface HelpChatRequest {
  message: string;
  sessionId?: string;
}

/**
 * Help chat response
 */
export interface HelpChatResponse {
  response: string;
  sources: DocumentSource[];
  sessionId: string;
  timestamp: Date;
}

/**
 * Documentation indexing configuration
 */
export interface DocumentationIndexConfig {
  docsPath: string;
  chunkSize: number; // Target token count per chunk
  chunkOverlap: number; // Token overlap between chunks
  excludePatterns?: string[]; // Glob patterns to exclude
  includePatterns?: string[]; // Glob patterns to include (default: **/*.md)
}
