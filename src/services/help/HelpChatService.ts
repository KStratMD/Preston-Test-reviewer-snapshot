/**
 * Help Chat Service
 * Orchestrates AI-powered help chat using RAG and ProviderRegistry
 */

import { uuidv4 } from '../../utils/uuid';
import { logger } from '../../utils/Logger';
import { DocumentationKnowledgeBase } from './DocumentationKnowledgeBase';
import { WikiContentIndex } from './WikiContentIndex';
import { ProviderRegistry } from '../ai/ProviderRegistry';
import { SYSTEM_IDENTITY, isSystemIdentity, type IdentityContext } from '../governance/identityContext';
import {
  getArchitectureKnowledgeNode,
  type ArchitectureKnowledgeNode,
} from './architectureKnowledgeManifest';
import {
  DEPLOYMENT_OPTIONS_DASHBOARD_SURFACE,
  getDeploymentOptionsKnowledgeNode,
  type DeploymentOptionsKnowledgeNode,
} from './deploymentOptionsKnowledgeManifest';
import type {
  HelpChatMessage,
  HelpChatSession,
  HelpChatRequest,
  HelpChatResponse,
  HelpAudience,
  HelpEvidenceSource,
  DocumentChunk,
  DocumentSource
} from './types';

const ARCHITECTURE_DASHBOARD_SURFACE = 'code-architecture-dashboard';

type DashboardKnowledgeNode = ArchitectureKnowledgeNode | DeploymentOptionsKnowledgeNode;

/**
 * Thrown when a request asks for the `internal` audience but the resolved
 * identity is absent or the system/anonymous fallback. Typed so the route
 * layer can `instanceof`-discriminate it (→ 403) without matching on message
 * strings. This is defense-in-depth behind the route-level
 * `isSystemIdentity(extractIdentityContext(req))` check.
 */
export class InternalAudienceAuthorizationError extends Error {
  constructor(message = 'Internal audience requires an authenticated identity') {
    super(message);
    this.name = 'InternalAudienceAuthorizationError';
  }
}

/**
 * True when the identity is absent OR when either its tenantId or userId
 * matches the system/anonymous sentinel (a deliberate OR, not full equality —
 * see isSystemIdentity). Delegates to the exported `isSystemIdentity` predicate
 * in identityContext.ts so this service, the route layer, and /audiences all
 * share the exact same definition.
 */
function isAnonymousOrSystem(ctx: IdentityContext | undefined): boolean {
  return isSystemIdentity(ctx);
}

/**
 * Aggregated retrieval inputs derived from a dashboard knowledge node (either
 * dashboard surface), ready to be folded into the prompt context and the
 * response evidence.
 */
interface DashboardEnrichment {
  node: DashboardKnowledgeNode;
  audience: HelpAudience;
  /** Extra query terms appended to the vector search query. */
  expandedQuery: string;
  /** Exact-path boosted chunks from the node's docPaths. */
  exactPathChunks: DocumentChunk[];
  /** Pre-rendered context blocks (public node summary, internal markers, wiki). */
  contextBlocks: string[];
  evidence: HelpEvidenceSource[];
  suggestedFollowUps: string[];
}

/**
 * Convert a raw wiki slug or filePath (e.g. `pages/concepts/embedded-intelligence`,
 * `pages/concepts/embedded-intelligence.md`, or `/wiki/pages/concepts/foo.html`)
 * to the served absolute URL `/wiki/<slug>.html`.
 *
 * Applied only to wiki evidence items so the anchor `href` rendered by the
 * dashboard resolves to the live Quartz-built page rather than a bare slug.
 */
function normalizeWikiEvidencePath(raw: string): string {
  let slug = raw.trim();
  // Strip leading slash
  slug = slug.replace(/^\/+/, '');
  // Strip a leading wiki/ prefix to avoid /wiki/wiki/...
  if (slug.startsWith('wiki/')) {
    slug = slug.slice('wiki/'.length);
  }
  // Strip trailing .md or .html extension
  slug = slug.replace(/\.(md|html)$/i, '');
  return `/wiki/${slug}.html`;
}

function getDashboardKnowledgeNode(surface: string, nodeId: string): DashboardKnowledgeNode | undefined {
  if (surface === ARCHITECTURE_DASHBOARD_SURFACE) {
    return getArchitectureKnowledgeNode(nodeId);
  }
  if (surface === DEPLOYMENT_OPTIONS_DASHBOARD_SURFACE) {
    return getDeploymentOptionsKnowledgeNode(nodeId);
  }
  return undefined;
}

function dashboardContextLabel(surface: string): string {
  return surface === DEPLOYMENT_OPTIONS_DASHBOARD_SURFACE
    ? 'DEPLOYMENT OPTION'
    : 'ARCHITECTURE';
}

/**
 * Session store for help chat conversations
 */
class HelpChatSessionStore {
  private sessions = new Map<string, HelpChatSession>();
  private readonly SESSION_TTL = 15 * 60 * 1000; // 15 minutes

  constructor() {
    // Cleanup expired sessions every 5 minutes
    const cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  getSession(sessionId: string, tenantId: string): HelpChatSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      return undefined;
    }
    session.lastActivityAt = new Date();
    return session;
  }

  createSession(tenantId: string): HelpChatSession {
    const session: HelpChatSession = {
      id: uuidv4(),
      tenantId,
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSession(sessionId: string, tenantId: string, messages: HelpChatMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (session && session.tenantId === tenantId) {
      session.messages = messages;
      session.lastActivityAt = new Date();
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() > this.SESSION_TTL) {
        expiredSessions.push(id);
      }
    }

    for (const id of expiredSessions) {
      this.sessions.delete(id);
    }

    if (expiredSessions.length > 0) {
      logger.debug(`Cleaned up ${expiredSessions.length} expired help chat sessions`);
    }
  }
}

export class HelpChatService {
  private knowledgeBase: DocumentationKnowledgeBase;
  private providerRegistry: ProviderRegistry;
  private sessionStore: HelpChatSessionStore;
  private wikiIndex: WikiContentIndex;

  constructor(
    knowledgeBase: DocumentationKnowledgeBase,
    providerRegistry: ProviderRegistry,
    wikiIndex: WikiContentIndex = new WikiContentIndex()
  ) {
    this.knowledgeBase = knowledgeBase;
    this.providerRegistry = providerRegistry;
    this.wikiIndex = wikiIndex;
    this.sessionStore = new HelpChatSessionStore();
  }

  /**
   * Process a help chat message
   */
  async processMessage(request: HelpChatRequest, ctx?: IdentityContext): Promise<HelpChatResponse> {
    const startTime = Date.now();

    // Derive the tenant once and thread it through session lookups/creation so
    // a leaked sessionId can't be read or appended to across tenants.
    const tenantId = ctx?.tenantId ?? SYSTEM_IDENTITY.tenantId;

    // Get or create session
    let session: HelpChatSession;
    if (request.sessionId) {
      session = this.sessionStore.getSession(request.sessionId, tenantId)
        ?? this.sessionStore.createSession(tenantId);
    } else {
      session = this.sessionStore.createSession(tenantId);
    }

    // Add user message to session
    const userMessage: HelpChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: request.message,
      timestamp: new Date()
    };
    session.messages.push(userMessage);

    try {
      // Compute effective audience and enforce the internal-audience guard
      // BEFORE any retrieval. Defense-in-depth behind the route-level check.
      const audience: HelpAudience = request.context?.audience ?? 'public';
      if (audience === 'internal' && isAnonymousOrSystem(ctx)) {
        throw new InternalAudienceAuthorizationError();
      }

      // Build dashboard-node enrichment when the request targets a registered
      // dashboard surface with a known node. Unknown node → undefined
      // (ordinary help retrieval, no throw).
      const enrichment = this.buildDashboardEnrichment(request, audience);

      // Check if knowledge base is ready
      if (!this.knowledgeBase.isReady()) {
        const progress = this.knowledgeBase.getIndexingProgress();
        throw new Error(`Documentation is still being indexed (${progress.indexed}/${progress.total}). Please try again in a moment.`);
      }

      // Retrieve relevant documentation chunks using RAG. When an architecture
      // node is in play, expand the query with node label / summary / related
      // labels / seeds so vector retrieval is steered toward the node.
      const retrievalQuery = enrichment ? enrichment.expandedQuery : request.message;
      logger.debug('Retrieving similar documentation for query', { query: retrievalQuery });
      const similarChunks = await this.knowledgeBase.findSimilarChunks(retrievalQuery, 5, 0.5);

      // Architecture path: even with zero vector hits, exact-path boosted chunks
      // can carry the answer — so only short-circuit on "no results" when there
      // is also no enrichment.
      if (similarChunks.length === 0 && !enrichment) {
        // No relevant documentation found
        const noResultsResponse = "I couldn't find specific documentation related to your question. Could you please rephrase your question or ask about a specific feature of the Integration Hub?";

        const assistantMessage: HelpChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: noResultsResponse,
          sources: [],
          timestamp: new Date()
        };
        session.messages.push(assistantMessage);
        this.sessionStore.updateSession(session.id, session.tenantId, session.messages);

        return {
          response: noResultsResponse,
          sources: [],
          sessionId: session.id,
          timestamp: new Date()
        };
      }

      // Merge exact-path boosted chunks (architecture path) with vector
      // results, de-duplicated by chunk ID. Boosted chunks lead so they are
      // never dropped by downstream slicing.
      const vectorChunks = similarChunks.map(r => r.chunk);
      const mergedChunks = enrichment
        ? this.mergeChunksById(enrichment.exactPathChunks, vectorChunks)
        : vectorChunks;

      // Build context from retrieved chunk content, then prepend any
      // enrichment context blocks (public node summary; internal markers; wiki
      // excerpts). Internal data ONLY enters here when audience === 'internal'
      // (the blocks are constructed audience-aware), so the public path stays
      // free of internal file paths BY CONSTRUCTION.
      const chunkContext = this.buildContext(mergedChunks.map(c => c.content));
      const context = enrichment
        ? [...enrichment.contextBlocks, chunkContext].filter(Boolean).join('\n\n---\n\n')
        : chunkContext;

      // Get AI response using direct OpenAI API call
      logger.debug('Generating AI response for help chat');
      const aiResponse = await this.generateResponse(
        request.message,
        context,
        session.messages.slice(0, -1),
        ctx ?? SYSTEM_IDENTITY
      );

      // Extract sources from vector matches (top 3, unchanged behaviour).
      const sources: DocumentSource[] = similarChunks.slice(0, 3).map(result => ({
        filePath: result.chunk.filePath,
        title: result.chunk.title,
        section: result.chunk.section,
        similarity: result.similarity
      }));

      // Add assistant message to session
      const assistantMessage: HelpChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: aiResponse,
        sources,
        timestamp: new Date()
      };
      session.messages.push(assistantMessage);
      this.sessionStore.updateSession(session.id, session.tenantId, session.messages);

      const duration = Date.now() - startTime;
      logger.info('Help chat response generated', {
        chunksRetrieved: similarChunks.length,
        duration
      });

      const response: HelpChatResponse = {
        response: aiResponse,
        sources,
        sessionId: session.id,
        timestamp: new Date()
      };

      if (enrichment) {
        const vectorEvidence: HelpEvidenceSource[] = sources.map(source => ({
          ...source,
          reason: 'vector match',
          audience: enrichment.audience,
        }));
        response.audience = enrichment.audience;
        response.nodeId = enrichment.node.id;
        response.evidence = [...enrichment.evidence, ...vectorEvidence];
        response.relatedNodes = [...enrichment.node.relatedNodeIds];
        response.suggestedFollowUps = enrichment.suggestedFollowUps;
      }

      return response;
    } catch (error) {
      logger.error('Failed to process help chat message', { error });

      // Add error message to session
      const errorMessage: HelpChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: `I encountered an error processing your question: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
        sources: [],
        timestamp: new Date()
      };
      session.messages.push(errorMessage);
      this.sessionStore.updateSession(session.id, session.tenantId, session.messages);

      throw error;
    }
  }

  /**
   * Generate AI response using ProviderRegistry and configured task routing
   */
  private async generateResponse(
    question: string,
    context: string,
    conversationHistory: HelpChatMessage[],
    ctx: IdentityContext
  ): Promise<string> {
    const systemMessage = 'You are a helpful documentation assistant for the Integration Hub platform. Answer user questions based on the provided documentation.';
    const userPrompt = this.buildPrompt(question, context, conversationHistory);

    // Get an available provider from the registry
    // In the future, this could check AIConfigurationService for help_chat task-specific config
    const providerResult = await this.providerRegistry.getAvailableProvider();

    if (!providerResult) {
      logger.warn('No AI providers available for help_chat task, using fallback');
      return `I'm here to help with the Integration Hub documentation. However, AI providers are not configured. Please refer to the documentation directly or configure an AI provider in the AI Configuration Dashboard.

Here are the relevant sections I found:
${context.substring(0, 500)}...`;
    }

    const { provider, id: providerId } = providerResult;

    try {
      // Build message array for chat() method
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt }
      ];

      // Use the provider's chat() method
      logger.info('Calling help_chat provider', {
        providerId,
        providerName: provider.name,
        messageCount: messages.length
      });

      // Cast to access chat() method (it's on the actual provider implementation)
      const chatProvider = provider as any;
      if (typeof chatProvider.chat !== 'function') {
        throw new Error(`Provider ${providerId} does not support chat() method`);
      }

      const response = await chatProvider.chat(messages, {
        maxTokens: 1000,
        temperature: 0.7
      }, ctx);

      return response.content;

    } catch (error) {
      logger.error('Help chat provider call failed', {
        providerId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Fallback to context-only response
      return `I encountered an error while generating a response. Here are the relevant documentation sections I found:

${context.substring(0, 500)}...

Please try again or refer to the documentation directly.`;
    }
  }

  /**
   * Build context string from retrieved documentation chunks
   */
  private buildContext(chunks: string[]): string {
    return chunks
      .map((chunk, index) => `[Document ${index + 1}]\n${chunk}`)
      .join('\n\n---\n\n');
  }

  /**
   * Build prompt for AI provider
   */
  private buildPrompt(question: string, context: string, conversationHistory: HelpChatMessage[]): string {
    let prompt = `You are a helpful assistant for the Integration Hub platform. Answer user questions based on the provided documentation.

DOCUMENTATION CONTEXT:
${context}

`;

    // Add conversation history if available
    if (conversationHistory.length > 0) {
      prompt += `CONVERSATION HISTORY:\n`;
      for (const msg of conversationHistory.slice(-4)) { // Last 4 messages for context
        prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      }
      prompt += '\n';
    }

    prompt += `CURRENT QUESTION:
${question}

INSTRUCTIONS:
- Answer the question based on the documentation context provided above
- Be concise and helpful
- If the documentation doesn't contain the answer, say so clearly
- Use markdown formatting for code examples and lists
- Do NOT mention the document numbers or context structure in your response
`;

    return prompt;
  }

  /**
   * Build dashboard-node enrichment for a registered dashboard surface
   * request. Returns undefined for any non-dashboard request or an unknown
   * nodeId (caller falls back to ordinary retrieval — never throws here).
   *
   * Public vs internal is decided HERE: internal markers (internalSummary,
   * sourceFiles, testFiles, proofCards, auditCommands) are only ever added to
   * the context/evidence when audience === 'internal'. The public path simply
   * never receives them, so public answers are internal-path-free by
   * construction rather than by post-hoc redaction.
   */
  private buildDashboardEnrichment(
    request: HelpChatRequest,
    audience: HelpAudience
  ): DashboardEnrichment | undefined {
    const ctx = request.context;
    if (!ctx || !ctx.surface || !ctx.nodeId) {
      return undefined;
    }
    // Capture guard-narrowed surface so it survives into the .map closure below.
    const surface = ctx.surface;

    const node = getDashboardKnowledgeNode(surface, ctx.nodeId);
    if (!node) {
      logger.debug('Unknown dashboard nodeId; falling back to ordinary retrieval', {
        surface: ctx.surface,
        nodeId: ctx.nodeId,
      });
      return undefined;
    }

    const isInternal = audience === 'internal';
    const relatedLabels = node.relatedNodeIds
      .map(id => getDashboardKnowledgeNode(surface, id)?.label)
      .filter((label): label is string => typeof label === 'string');
    const seeds = isInternal ? node.internalQuestionSeeds : node.publicQuestionSeeds;

    // Steer vector retrieval toward the node.
    const expandedQuery = [
      request.message,
      node.label,
      node.publicSummary,
      ...relatedLabels,
      ...seeds.slice(0, 2),
    ].join(' ');

    // Exact-path boosted chunks from the node's docPaths.
    const exactPathChunks = this.knowledgeBase.getChunksByFilePaths(node.docPaths, 2);

    // Wiki excerpts from the node's wikiPaths.
    const wikiEntries = this.wikiIndex.findEntriesByPaths(node.wikiPaths);

    const contextBlocks: string[] = [];
    const evidence: HelpEvidenceSource[] = [];

    // Public node summary always present.
    contextBlocks.push(
      `${dashboardContextLabel(ctx.surface)} NODE: ${node.label}\n${node.publicSummary}`
    );

    // Internal-only enrichment.
    if (isInternal) {
      const internalLines: string[] = [`INTERNAL DETAIL — ${node.label}`, node.internalSummary];
      if (node.sourceFiles.length > 0) {
        internalLines.push(`Source files: ${node.sourceFiles.join(', ')}`);
      }
      if (node.testFiles.length > 0) {
        internalLines.push(`Test files: ${node.testFiles.join(', ')}`);
      }
      if (node.proofCards.length > 0) {
        internalLines.push(`Proof cards: ${node.proofCards.join(', ')}`);
      }
      if (node.auditCommands.length > 0) {
        internalLines.push(`Audit commands: ${node.auditCommands.join(', ')}`);
      }
      contextBlocks.push(internalLines.join('\n'));
    }

    // Exact-path boosted chunks → context + evidence.
    for (const chunk of exactPathChunks) {
      evidence.push({
        filePath: chunk.filePath,
        title: chunk.title,
        section: chunk.section,
        similarity: 1,
        reason: 'exact-path boost',
        audience,
      });
    }

    // Wiki excerpts → context + evidence.
    for (const entry of wikiEntries) {
      if (entry.excerpt) {
        contextBlocks.push(`WIKI: ${entry.title}\n${entry.excerpt}`);
        evidence.push({
          filePath: normalizeWikiEvidencePath(entry.slug || entry.filePath),
          title: entry.title,
          section: 'wiki',
          similarity: 1,
          reason: 'wiki index',
          audience,
        });
      }
    }

    return {
      node,
      audience,
      expandedQuery,
      exactPathChunks,
      contextBlocks,
      evidence,
      suggestedFollowUps: [...seeds],
    };
  }

  /**
   * Merge two chunk lists de-duplicated by chunk ID, preserving the order of
   * `primary` (the boosted set) ahead of `secondary` (vector matches).
   */
  private mergeChunksById(
    primary: DocumentChunk[],
    secondary: DocumentChunk[]
  ): DocumentChunk[] {
    const seen = new Set<string>();
    const merged: DocumentChunk[] = [];
    for (const chunk of [...primary, ...secondary]) {
      if (seen.has(chunk.id)) {
        continue;
      }
      seen.add(chunk.id);
      merged.push(chunk);
    }
    return merged;
  }

  /**
   * Get session by ID, scoped to the caller's tenant (SYSTEM_IDENTITY's
   * tenant when no identity context is supplied). Prevents a leaked
   * sessionId from being read across tenants.
   */
  getSession(sessionId: string, ctx?: IdentityContext): HelpChatSession | undefined {
    return this.sessionStore.getSession(sessionId, ctx?.tenantId ?? SYSTEM_IDENTITY.tenantId);
  }
}
