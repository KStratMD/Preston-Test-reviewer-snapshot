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
  tenantId: string;
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
 * Canonical audience values — runtime set is derived from this tuple so the
 * type and the validator can never drift.
 * 'public' — no authentication required.
 * 'internal' — requires a real (non-system) identity, i.e.
 *   `!isSystemIdentity(extractIdentityContext(req))`. A populated `req.user`
 *   alone is NOT sufficient: a JWT lacking a valid tenantId/userId resolves to
 *   SYSTEM_IDENTITY and is treated as anonymous by both the route and service.
 */
export const HELP_AUDIENCES = ['public', 'internal'] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];

/**
 * Optional context supplied by the caller to scope retrieval.
 */
export interface HelpChatContext {
  /** Originating surface, e.g. 'code-architecture-dashboard'. */
  surface?: string;
  /** Architecture graph node ID being viewed, e.g. 'auth-service'. */
  nodeId?: string;
  /** Audience scope — defaults to 'public'. 'internal' requires authentication. */
  audience?: HelpAudience;
  /** Explicit corpus filter — at most 10 entries, each ≤ 80 characters. */
  corpus?: string[];
}

/**
 * Evidence source that carries audience metadata for internal responses.
 */
export interface HelpEvidenceSource extends DocumentSource {
  reason: string;
  audience: HelpAudience;
}

/**
 * Help chat request
 */
export interface HelpChatRequest {
  message: string;
  sessionId?: string;
  /** Optional retrieval context — omit for backward-compatible behaviour. */
  context?: HelpChatContext;
}

/**
 * Help chat response
 */
export interface HelpChatResponse {
  response: string;
  sources: DocumentSource[];
  sessionId: string;
  timestamp: Date;
  /** Effective audience; present when a known architecture node enriched the answer. */
  audience?: HelpAudience;
  /** Architecture node ID echoed from the request context. */
  nodeId?: string;
  /** Audience-gated evidence sources. */
  evidence?: HelpEvidenceSource[];
  /** Related architecture graph node IDs. */
  relatedNodes?: string[];
  /** Suggested follow-up questions. */
  suggestedFollowUps?: string[];
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
